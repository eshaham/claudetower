import type { EngineInterface } from "claude-code";

import type { PrBadge, PrState, TicketInfo } from "../../types";
import {
  PR_LOOKUPS_PER_POLL,
  PR_TTL_MS,
  STORE_KEYS,
  TICKET_LOOKUPS_PER_POLL,
  TICKET_TTL_MS,
  host,
  log,
} from "./config";
import type { McpToolName } from "./config";
import type { Live, SessionPr } from "./transcript";

type CheckRun = {
  conclusion?: string | null;
  state?: string | null;
  status?: string | null;
};

const FAILED = [
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
];
const PENDING = ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"];
const CLOSED_TICKET_TYPES = ["completed", "canceled", "duplicate"];

const prDetails = new Map<string, PrBadge & { checkedAt: number }>();

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

const failureOf = (result: {
  deny?: string;
  isError?: boolean;
  text?: string;
}) =>
  result.deny !== undefined || result.isError || !result.text
    ? (result.deny ?? result.text ?? "no answer")
    : null;

export async function readTickets($: EngineInterface) {
  return ((await $.store.get(STORE_KEYS.tickets)) ?? {}) as Record<
    string,
    TicketInfo
  >;
}

async function lookUpTicket($: EngineInterface, id: string, tool: McpToolName) {
  const called = await $.tool.call({
    tool,
    id,
    fields: ["priority", "status", "statusType"],
  });
  const failure = failureOf(called);
  if (failure !== null || !called.text) {
    log($, `could not look up ${id}: ${failure}`);
    return null;
  }
  const issue = JSON.parse(called.text) as {
    priority?: { value?: number };
    status?: string | { name?: string };
    statusType?: string;
  };
  const info: TicketInfo = {
    priority: issue.priority?.value ?? 0,
    status:
      typeof issue.status === "string"
        ? issue.status
        : (issue.status?.name ?? ""),
    isOpen: !CLOSED_TICKET_TYPES.includes(issue.statusType ?? ""),
    checkedAt: Date.now(),
  };
  return [id, info] as const;
}

export async function refreshTickets($: EngineInterface, ids: string[]) {
  const tool = host.issueTool;
  if (!tool) return;
  const tickets = await readTickets($);
  const stale = [...new Set(ids)]
    .filter((id) => isStale(tickets[id]?.checkedAt, TICKET_TTL_MS))
    .slice(0, TICKET_LOOKUPS_PER_POLL);
  if (stale.length === 0) return;
  const found = await Promise.all(
    stale.map((id) =>
      lookUpTicket($, id, tool).catch((error: unknown) => {
        log($, `could not look up ${id}: ${String(error)}`);
        return null;
      }),
    ),
  );
  await $.store.set(STORE_KEYS.tickets, {
    ...tickets,
    ...Object.fromEntries(found.filter((entry) => entry !== null)),
  });
}

async function lookUpPr($: EngineInterface, pr: SessionPr) {
  const viewed = await $.process.run([
    host.gh,
    "pr",
    "view",
    String(pr.prNumber),
    "--repo",
    pr.repo ?? "",
    "--json",
    "state,isDraft,additions,deletions,statusCheckRollup",
  ]);
  if (viewed.exitCode !== 0) {
    log($, `could not look up PR ${prKey(pr)}: ${viewed.stderr.trim()}`);
    return;
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
  prDetails.set(prKey(pr), {
    number: pr.prNumber ?? 0,
    state,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    failing: checks.filter((check) => has(check, FAILED)).length,
    pending: checks.filter(
      (check) => !has(check, FAILED) && has(check, PENDING),
    ).length,
    checkedAt: Date.now(),
  });
}

export async function refreshPrs($: EngineInterface, live: Live[]) {
  if (!host.gh) return;
  const stale = live
    .flatMap(({ s }) => s.prs ?? [])
    .filter((pr) => pr.prNumber && pr.repo)
    .filter((pr) => {
      const known = prDetails.get(prKey(pr));
      return (
        (!known || isOpenPr(known.state)) &&
        isStale(known?.checkedAt, PR_TTL_MS)
      );
    })
    .slice(0, PR_LOOKUPS_PER_POLL);
  await Promise.all(
    stale.map((pr) =>
      lookUpPr($, pr).catch((error: unknown) =>
        log($, `could not look up PR ${prKey(pr)}: ${String(error)}`),
      ),
    ),
  );
}

export const prBadgesOf = (prs: SessionPr[] = []): PrBadge[] =>
  prs
    .filter((pr) => pr.prNumber)
    .map(
      (pr) =>
        prDetails.get(prKey(pr)) ?? {
          number: pr.prNumber ?? 0,
          state: prStateOf(pr.state),
          additions: 0,
          deletions: 0,
          failing: 0,
          pending: 0,
        },
    );
