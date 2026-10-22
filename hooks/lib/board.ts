import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";

import type { SessionCard, TicketInfo } from "../../types";
import { classify } from "./classify";
import {
  ARCHIVE_SESSION,
  PANE,
  PANE_COLUMNS,
  PREVIEW_REPLY_CHARS,
  READ_CONCURRENCY,
  READS_PER_POLL,
  STORE_KEYS,
  log,
} from "./config";
import { prBadgesOf, readTickets, refreshPrs, refreshTickets } from "./enrich";
import type { Live } from "./transcript";
import { loadLive, projectOf, ticketOf, titleOf } from "./transcript";
import type { VerdictStore } from "./verdict";
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

const reading = new Set<string>();
let isLoading = false;

const fromParagraphStart = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const cut = text.slice(-limit);
  const paragraph = cut.indexOf("\n\n");
  return paragraph >= 0 ? cut.slice(paragraph + 2) : cut;
};

const cardOf = (
  live: Live,
  now: number,
  verdicts: VerdictStore,
  tickets: Record<string, TicketInfo>,
): SessionCard => {
  const { s, end } = live;
  const stored = verdicts[s.sessionId];
  const current =
    stored?.key === verdictKeyOf(live)
      ? stored.verdict
      : end.isStopped && end.lastText === ""
        ? SILENT_STOP
        : null;
  const ticket = ticketOf(s);
  const info = tickets[ticket];
  return classify({
    id: s.sessionId,
    cliId: s.cliSessionId ?? "",
    title: titleOf(s),
    project: projectOf(s),
    ticket,
    ticketStatus: info?.status ?? "",
    ticketPriority: info?.isOpen ? info.priority : 0,
    prs: prBadgesOf(s.prs),
    uncommittedFiles: end.uncommittedFiles,
    lastAsk: end.prompt,
    lastAskAgoMs: end.promptAt ? now - end.promptAt : 0,
    lastReply: fromParagraphStart(end.lastText, PREVIEW_REPLY_CHARS),
    isRunning: !end.isStopped,
    isScheduled: Boolean(s.scheduledTaskId),
    ageMs: now - end.lastAt,
    verdict: current ?? stored?.verdict ?? null,
    isRereading: end.isStopped && current === null,
  });
};

async function build($: EngineInterface, live: Live[], now: number) {
  const [verdicts, tickets] = await Promise.all([
    readVerdicts($),
    readTickets($),
  ]);
  const built = live
    .map((one) => cardOf(one, now, verdicts, tickets))
    .sort((a, b) => b.score - a.score);
  await update($, cards, () => built);
  return verdicts;
}

async function readNewVerdicts(
  $: EngineInterface,
  live: Live[],
  verdicts: VerdictStore,
) {
  const unread = live
    .filter(
      (one) =>
        one.end.isStopped &&
        one.end.lastText !== "" &&
        verdicts[one.s.sessionId]?.key !== verdictKeyOf(one) &&
        !reading.has(one.s.sessionId),
    )
    .sort((a, b) => b.end.lastAt - a.end.lastAt)
    .slice(0, READS_PER_POLL);
  const fresh: VerdictStore = {};
  for (let index = 0; index < unread.length; index += READ_CONCURRENCY)
    await Promise.all(
      unread.slice(index, index + READ_CONCURRENCY).map(async (one) => {
        reading.add(one.s.sessionId);
        try {
          const verdict = await judge($, one);
          if (verdict)
            fresh[one.s.sessionId] = { key: verdictKeyOf(one), verdict };
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
    const verdicts = await build($, live, now);
    const [, , fresh] = await Promise.all([
      refreshTickets($, live.map(({ s }) => ticketOf(s)).filter(Boolean)),
      refreshPrs($, live),
      readNewVerdicts($, live, verdicts),
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
  await load($);
  await followOtherSessions($);
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
