import type { EngineInterface } from "claude-code";

import type { PrBadge, PrState, TicketInfo } from "../../types";
import {
  GH_TIMEOUT_MS,
  PR_LOOKUPS_PER_POLL,
  PR_TTL_MS,
  STORE_KEYS,
  TICKET_LOOKUPS_PER_POLL,
  TICKET_TTL_MS,
  host,
  log,
} from "./config";
import type { ProjectProfile } from "./project";
import type { Live, SessionPr } from "./transcript";

type CheckRun = {
  conclusion?: string | null;
  state?: string | null;
  status?: string | null;
};

type StoredPr = PrBadge & { checkedAt: number };
export type PrStore = Record<string, StoredPr>;
export type TicketStore = Record<string, TicketInfo>;
export type TicketRequest = { id: string; profile: ProjectProfile };

const FAILED = [
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
];
const PENDING = ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"];
const CLOSED_TICKET =
  /^(completed|done|closed|resolved|canceled|cancelled|duplicate|won't do)$/i;
const PRIORITY_NAMES: Record<string, number> = {
  urgent: 1,
  highest: 1,
  critical: 1,
  p0: 1,
  high: 2,
  p1: 2,
  medium: 3,
  normal: 3,
  p2: 3,
  low: 4,
  lowest: 4,
  p3: 4,
};

export const prStateOf = (state?: string, isDraft = false): PrState =>
  state === "MERGED"
    ? "merged"
    : state === "CLOSED"
      ? "closed"
      : isDraft
        ? "draft"
        : "open";

export const isOpenPr = (state: PrState) =>
  state === "open" || state === "draft";

const prKey = (pr: SessionPr) => `${pr.repo}#${pr.prNumber}`;

const isStale = (checkedAt: number | undefined, ttl: number) =>
  Date.now() - (checkedAt ?? 0) > ttl;

export async function readTickets($: EngineInterface) {
  return ((await $.store.get(STORE_KEYS.tickets)) ?? {}) as TicketStore;
}

export async function readPrs($: EngineInterface) {
  return ((await $.store.get(STORE_KEYS.prs)) ?? {}) as PrStore;
}

const nameOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value && typeof value === "object" && "name" in value
      ? String(value.name)
      : "";

const priorityOf = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "value" in value)
    return Number(value.value) || 0;
  return PRIORITY_NAMES[nameOf(value).toLowerCase()] ?? 0;
};

async function lookUpTicket(
  $: EngineInterface,
  { id, profile }: TicketRequest,
) {
  const lookup = profile.issueLookup;
  if (!lookup) return null;
  const input = {
    tool: lookup.tool,
    [lookup.idArgument]: id,
  } as Parameters<EngineInterface["tool"]["call"]>[0];
  const called = await $.tool.call(input);
  if (called.deny !== undefined || called.isError || !called.text) {
    log(
      $,
      `could not look up ${id}: ${called.deny ?? called.text ?? "no answer"}`,
    );
    return null;
  }
  const issue = JSON.parse(called.text) as Record<string, unknown>;
  const status = nameOf(issue.status ?? issue.state);
  const statusType = nameOf(issue.statusType ?? issue.stateType ?? "");
  const info: TicketInfo = {
    priority: priorityOf(issue.priority),
    status,
    isOpen: !CLOSED_TICKET.test(statusType || status),
    checkedAt: Date.now(),
  };
  return [id, info] as const;
}

export async function refreshTickets(
  $: EngineInterface,
  requests: TicketRequest[],
) {
  const tickets = await readTickets($);
  const stale = requests
    .filter(
      (request, index) =>
        request.profile.issueLookup &&
        requests.findIndex((other) => other.id === request.id) === index &&
        isStale(tickets[request.id]?.checkedAt, TICKET_TTL_MS),
    )
    .slice(0, TICKET_LOOKUPS_PER_POLL);
  if (stale.length === 0) return;
  const found = await Promise.all(
    stale.map((request) =>
      lookUpTicket($, request).catch((error: unknown) => {
        log($, `could not look up ${request.id}: ${String(error)}`);
        return null;
      }),
    ),
  );
  const current = await readTickets($);
  const retryLater = Object.fromEntries(
    stale.map(({ id }) => [
      id,
      {
        ...(current[id] ?? { priority: 0, status: "", isOpen: true }),
        checkedAt: Date.now(),
      },
    ]),
  );
  await $.store.set(STORE_KEYS.tickets, {
    ...current,
    ...retryLater,
    ...Object.fromEntries(found.filter((entry) => entry !== null)),
  });
}

async function lookUpPr($: EngineInterface, pr: SessionPr) {
  const viewed = await $.process.run(
    [
      host.gh,
      "pr",
      "view",
      String(pr.prNumber),
      "--repo",
      pr.repo ?? "",
      "--json",
      "state,isDraft,additions,deletions,statusCheckRollup",
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (viewed.exitCode !== 0) {
    log($, `could not look up PR ${prKey(pr)}: ${viewed.stderr.trim()}`);
    return null;
  }
  const data = JSON.parse(viewed.stdout) as {
    state?: string;
    isDraft?: boolean;
    additions?: number;
    deletions?: number;
    statusCheckRollup?: CheckRun[];
  };
  const state = prStateOf(data.state, data.isDraft);
  const checks = isOpenPr(state) ? (data.statusCheckRollup ?? []) : [];
  const has = (check: CheckRun, values: string[]) =>
    [check.conclusion, check.state, check.status].some(
      (value) => value && values.includes(value),
    );
  const stored: StoredPr = {
    number: pr.prNumber ?? 0,
    state,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    failing: checks.filter((check) => has(check, FAILED)).length,
    pending: checks.filter(
      (check) => !has(check, FAILED) && has(check, PENDING),
    ).length,
    checkedAt: Date.now(),
  };
  return [prKey(pr), stored] as const;
}

export async function refreshPrs($: EngineInterface, live: Live[]) {
  if (!host.gh) return;
  const known = await readPrs($);
  const stale = live
    .flatMap(({ s }) => s.prs ?? [])
    .filter((pr) => pr.prNumber && pr.repo)
    .filter((pr) => {
      const entry = known[prKey(pr)];
      return (
        (!entry || isOpenPr(entry.state)) &&
        isStale(entry?.checkedAt, PR_TTL_MS)
      );
    })
    .slice(0, PR_LOOKUPS_PER_POLL);
  if (stale.length === 0) return;
  const found = await Promise.all(
    stale.map((pr) =>
      lookUpPr($, pr).catch((error: unknown) => {
        log($, `could not look up PR ${prKey(pr)}: ${String(error)}`);
        return null;
      }),
    ),
  );
  const current = await readPrs($);
  const retryLater = Object.fromEntries(
    stale.map((pr) => [
      prKey(pr),
      {
        ...(current[prKey(pr)] ?? {
          number: pr.prNumber ?? 0,
          state: prStateOf(pr.state),
          additions: 0,
          deletions: 0,
          failing: 0,
          pending: 0,
        }),
        checkedAt: Date.now(),
      },
    ]),
  );
  await $.store.set(STORE_KEYS.prs, {
    ...current,
    ...retryLater,
    ...Object.fromEntries(found.filter((entry) => entry !== null)),
  });
}

export const prBadgesOf = (prs: SessionPr[] = [], known: PrStore): PrBadge[] =>
  prs
    .filter((pr) => pr.prNumber)
    .map(
      (pr) =>
        known[prKey(pr)] ?? {
          number: pr.prNumber ?? 0,
          state: prStateOf(pr.state),
          additions: 0,
          deletions: 0,
          failing: 0,
          pending: 0,
        },
    );
