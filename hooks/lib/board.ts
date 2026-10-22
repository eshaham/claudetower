import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";

import type { SessionAction, SessionCard } from "../../types";
import { classify } from "./classify";
import {
  ARCHIVE_SESSION,
  INBOX_CHECK_MS,
  INBOX_PICKUP_MS,
  host,
  PANE,
  PANE_COLUMNS,
  PREVIEW_REPLY_CHARS,
  READ_CONCURRENCY,
  READS_PER_POLL,
  STORE_KEYS,
  log,
} from "./config";
import type { PrStore, TicketStore } from "./enrich";
import {
  isOpenPr,
  prBadgesOf,
  readPrs,
  readTickets,
  refreshPrs,
  refreshTickets,
} from "./enrich";
import type { ProjectProfile } from "./project";
import {
  claim,
  projectRootOf,
  readProjects,
  refreshProjects,
  ticketPatternOf,
} from "./project";
import type { Live } from "./transcript";
import { loadLive, projectOf, ticketOf, titleOf } from "./transcript";
import type { VerdictContext, VerdictStore } from "./verdict";
import {
  SILENT_STOP,
  judge,
  readVerdicts,
  verdictKeyOf,
  writeVerdicts,
} from "./verdict";

export const cards = atom({ plugin: "claudtower", key: "cards" } as const, []);
export const isOpen = atom(
  { plugin: "claudtower", key: "isOpen" } as const,
  true,
);
export const previewed = atom(
  { plugin: "claudtower", key: "previewed" } as const,
  "",
);
export const sending = atom(
  { plugin: "claudtower", key: "sending" } as const,
  "",
);

type Inbox = Record<string, { id: string; text: string; at: number }>;

type Stores = {
  verdicts: VerdictStore;
  tickets: TicketStore;
  prs: PrStore;
  projects: Record<string, ProjectProfile>;
};

type Enriched = Live & { context: VerdictContext; ticket: string };

const reading = new Set<string>();
let isLoading = false;

const fromParagraphStart = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const cut = text.slice(-limit);
  const paragraph = cut.indexOf("\n\n");
  return paragraph >= 0 ? cut.slice(paragraph + 2) : cut;
};

async function readStores($: EngineInterface): Promise<Stores> {
  const [verdicts, tickets, prs, projects] = await Promise.all([
    readVerdicts($),
    readTickets($),
    readPrs($),
    readProjects($),
  ]);
  return { verdicts, tickets, prs, projects };
}

const enrich = (live: Live[], stores: Stores): Enriched[] =>
  live.map((one) => {
    const project = stores.projects[projectRootOf(one.s)];
    const openPrs = prBadgesOf(one.s.prs, stores.prs)
      .filter((pr) => isOpenPr(pr.state))
      .map((pr) => pr.number);
    return {
      ...one,
      ticket: ticketOf(one.s, ticketPatternOf(project)),
      context: { openPrs, project },
    };
  });

const keyOf = (one: Enriched) => verdictKeyOf(one, one.context);

const cardOf = (one: Enriched, now: number, stores: Stores): SessionCard => {
  const { s, end, ticket } = one;
  const stored = stores.verdicts[s.sessionId];
  const current =
    stored?.key === keyOf(one)
      ? stored.verdict
      : end.isStopped && end.lastText === ""
        ? SILENT_STOP
        : null;
  const info = stores.tickets[ticket];
  return classify({
    id: s.sessionId,
    cliId: s.cliSessionId ?? "",
    title: titleOf(s, ticket),
    project: projectOf(s),
    ticket,
    ticketStatus: info?.status ?? "",
    ticketPriority: info?.isOpen ? info.priority : 0,
    prs: prBadgesOf(s.prs, stores.prs),
    uncommittedFiles: end.uncommittedFiles,
    lastAsk: end.prompt,
    lastAskAgoMs: end.promptAt ? now - end.promptAt : 0,
    lastReply: fromParagraphStart(end.lastText, PREVIEW_REPLY_CHARS),
    question: end.question,
    options: end.options,
    isRunning: !end.isStopped,
    isScheduled: Boolean(s.scheduledTaskId),
    ageMs: now - end.lastAt,
    verdict: current ?? stored?.verdict ?? null,
    isRereading: end.isStopped && current === null,
  });
};

async function build($: EngineInterface, live: Live[], now: number) {
  const stores = await readStores($);
  const enriched = enrich(live, stores);
  const built = enriched
    .map((one) => cardOf(one, now, stores))
    .sort((a, b) => b.score - a.score);
  await update($, cards, () => built);
  return { stores, enriched };
}

async function readNewVerdicts(
  $: EngineInterface,
  enriched: Enriched[],
  verdicts: VerdictStore,
) {
  const unread = enriched
    .filter(
      (one) =>
        one.end.isStopped &&
        one.end.lastText !== "" &&
        verdicts[one.s.sessionId]?.key !== keyOf(one) &&
        !reading.has(one.s.sessionId),
    )
    .sort((a, b) => b.end.lastAt - a.end.lastAt)
    .slice(0, READS_PER_POLL);
  const fresh: VerdictStore = {};
  for (let index = 0; index < unread.length; index += READ_CONCURRENCY)
    await Promise.all(
      unread.slice(index, index + READ_CONCURRENCY).map(async (one) => {
        const key = keyOf(one);
        if (!(await claim($, `verdict:${one.s.sessionId}:${key}`))) return;
        reading.add(one.s.sessionId);
        try {
          const verdict = await judge($, one, one.context);
          if (verdict) fresh[one.s.sessionId] = { key, verdict };
        } catch (error) {
          log($, `could not read "${one.s.title}": ${String(error)}`);
        } finally {
          reading.delete(one.s.sessionId);
        }
      }),
    );
  return fresh;
}

export async function load($: EngineInterface) {
  if (isLoading) return;
  isLoading = true;
  try {
    const now = Date.now();
    const live = await loadLive($, now);
    const { stores, enriched } = await build($, live, now);
    const [, , , fresh] = await Promise.all([
      refreshProjects($, live),
      refreshTickets(
        $,
        enriched.flatMap((one) =>
          one.ticket && one.context.project
            ? [{ id: one.ticket, profile: one.context.project }]
            : [],
        ),
      ),
      refreshPrs($, live),
      readNewVerdicts($, enriched, stores.verdicts),
    ]);
    if (Object.keys(fresh).length > 0)
      await writeVerdicts($, fresh, new Set(live.map(({ s }) => s.sessionId)));
    await build($, live, now);
  } finally {
    isLoading = false;
  }
}

export async function openSession($: EngineInterface, id: string) {
  const opened = await $.process.run([
    "open",
    `claude://claude.ai/epitaxy/${id}`,
  ]);
  if (opened.exitCode !== 0)
    $.ui.toast(`Could not open the session: ${opened.stderr.trim()}`);
}

export async function archiveSession($: EngineInterface, card: SessionCard) {
  const archived = await $.tool.call({
    tool: ARCHIVE_SESSION,
    session_id: card.id,
    reason: card.verdict?.waitingFor || "Finished with nothing left to do",
  });
  if (archived.deny !== undefined || archived.isError) {
    $.ui.toast(
      `Could not archive "${card.title}": ${archived.deny ?? archived.text ?? "no answer"}`,
    );
    return;
  }
  await update($, cards, (list) => list.filter((one) => one.id !== card.id));
}

export function togglePreview($: EngineInterface, id: string) {
  return update($, previewed, (current) => (current === id ? "" : id));
}

export async function setPaneOpen($: EngineInterface, value: boolean) {
  await update($, isOpen, () => value);
  await $.store.set(STORE_KEYS.isOpen, value);
}

export async function openPane($: EngineInterface) {
  await setPaneOpen($, true);
  await $.ui.open({ id: PANE, title: "claudtower", columns: PANE_COLUMNS });
}

export async function followOtherSessions($: EngineInterface) {
  const wantsOpen = (await $.store.get(STORE_KEYS.isOpen)) !== false;
  const isUp = (await $.ui.panes()).some((pane) => pane.id === PANE);
  if (wantsOpen && !isUp) await openPane($);
  if (!wantsOpen && isUp) {
    await update($, isOpen, () => false);
    await $.ui.close({ id: PANE });
  }
}

export async function poll($: EngineInterface) {
  await followOtherSessions($);
  await load($);
}

export function readCards($: EngineInterface) {
  return read($, cards);
}

export function readPreviewed($: EngineInterface) {
  return read($, previewed);
}

export function isPaneOpen($: EngineInterface) {
  return read($, isOpen);
}

async function readInbox($: EngineInterface) {
  return ((await $.store.get(STORE_KEYS.inbox)) ?? {}) as Inbox;
}

export function readSending($: EngineInterface) {
  return read($, sending);
}

export async function sendAction(
  $: EngineInterface,
  card: SessionCard,
  action: SessionAction,
) {
  const id = crypto.randomUUID();
  await update($, sending, () => card.id);
  await $.store.set(STORE_KEYS.inbox, {
    ...(await readInbox($)),
    [card.cliId]: { id, text: action.message, at: Date.now() },
  });
  try {
    for (let waited = 0; waited < INBOX_PICKUP_MS; waited += INBOX_CHECK_MS) {
      await $.clock.sleep(INBOX_CHECK_MS);
      if ((await readInbox($))[card.cliId]?.id !== id) {
        await load($);
        return;
      }
    }
    const inbox = await readInbox($);
    await $.store.set(
      STORE_KEYS.inbox,
      Object.fromEntries(
        Object.entries(inbox).filter(([cliId]) => cliId !== card.cliId),
      ),
    );
    $.ui.toast(`"${card.title}" isn't running, so it opened instead`);
    await openSession($, card.id);
  } finally {
    await update($, sending, (current) => (current === card.id ? "" : current));
  }
}

export async function checkInbox($: EngineInterface) {
  const inbox = await readInbox($);
  const message = inbox[host.selfCliId];
  if (!message) return;
  await $.store.set(
    STORE_KEYS.inbox,
    Object.fromEntries(
      Object.entries(inbox).filter(([cliId]) => cliId !== host.selfCliId),
    ),
  );
  await $.prompt.submit({ text: message.text, asUser: true });
}
