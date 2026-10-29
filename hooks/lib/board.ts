import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";

import type { SessionAction, SessionCard } from "../../types";
import { classify } from "./classify";
import {
  ARCHIVE_SESSION,
  ANSWER_CHECK_MS,
  ANSWER_PICKUP_MS,
  inboxDir,
  host,
  PANE,
  PANE_COLUMNS,
  PENDING_MS,
  PREVIEW_REPLY_CHARS,
  READ_CONCURRENCY,
  READS_PER_POLL,
  STORE_KEYS,
  log,
  instanceKey,
  findInstance,
  LEASE_EXPIRES_MS,
  LEASE_SETTLE_MS,
  LEGACY_ENDS_KEY,
  LOAD_DEBOUNCE_MS,
  MINUTE_MS,
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
import type { Ranking } from "./ranking";
import {
  hasRankingFile,
  loadRanking,
  readingFingerprintOf,
  writeRanking,
} from "./ranking";
import type { LeaseFile } from "./lease";
import { holdLease, isLease } from "./lease";
import type { Live } from "./transcript";
import {
  loadLive,
  projectOf,
  sessionDirs,
  ticketOf,
  titleOf,
  transcriptPath,
} from "./transcript";
import type { VerdictContext, VerdictStore } from "./verdict";
import {
  SILENT_STOP,
  judge,
  readVerdicts,
  verdictKeyOf,
  writeVerdicts,
} from "./verdict";

export const cards = atom({ plugin: "claudetower", key: "cards" } as const, []);
export const isOpen = atom(
  { plugin: "claudetower", key: "isOpen" } as const,
  true,
);
export const previewed = atom(
  { plugin: "claudetower", key: "previewed" } as const,
  "",
);
export const draft = atom({ plugin: "claudetower", key: "draft" } as const, "");
export const composing = atom(
  { plugin: "claudetower", key: "composing" } as const,
  "",
);
export const needsSetup = atom(
  { plugin: "claudetower", key: "needsSetup" } as const,
  false,
);
export const collapsedGroups = atom(
  { plugin: "claudetower", key: "collapsedGroups" } as const,
  {},
);
export const clickLayersFailedAt = atom(
  { plugin: "claudetower", key: "clickLayersFailedAt" } as const,
  0,
);
export const pending = atom(
  { plugin: "claudetower", key: "pending" } as const,
  {},
);

type Stores = {
  verdicts: VerdictStore;
  tickets: TicketStore;
  prs: PrStore;
  projects: Record<string, ProjectProfile>;
  ranking: Ranking;
};

type Enriched = Live & { context: VerdictContext; ticket: string };

const reading = new Set<string>();
let isLoading = false;
let isDirty = false;
let isLeader = false;
let boardSeenAt = 0;
let inboxSeenAt = -1;
let watched: string[] = [];
let lastSeen = "";

const fromParagraphStart = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const cut = text.slice(-limit);
  const paragraph = cut.indexOf("\n\n");
  return paragraph >= 0 ? cut.slice(paragraph + 2) : cut;
};

async function readStores($: EngineInterface): Promise<Stores> {
  const [verdicts, tickets, prs, projects, ranking] = await Promise.all([
    readVerdicts($),
    readTickets($),
    readPrs($),
    readProjects($),
    loadRanking($),
  ]);
  return { verdicts, tickets, prs, projects, ranking };
}

const enrich = (live: Live[], stores: Stores): Enriched[] => {
  const rankingFingerprint = readingFingerprintOf(stores.ranking);
  return live.map((one) => {
    const project = stores.projects[projectRootOf(one.s)];
    const openPrs = prBadgesOf(one.s.prs, stores.prs)
      .filter((pr) => isOpenPr(pr.state))
      .map((pr) => pr.number);
    const ticket = ticketOf(one.s, ticketPatternOf(project));
    const info = stores.tickets[ticket];
    return {
      ...one,
      ticket,
      context: {
        openPrs,
        project,
        ticket: ticket && info ? { ...info, id: ticket } : null,
        ranking: stores.ranking,
        rankingFingerprint,
      },
    };
  });
};

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
  return classify(
    {
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
      lastAt: end.lastAt,
      verdict: current ?? stored?.verdict ?? null,
      isRereading: end.isStopped && current === null,
    },
    stores.ranking,
  );
};

async function prunePending(
  $: EngineInterface,
  shown: SessionCard[],
  now: number,
) {
  await update($, pending, (current) =>
    Object.fromEntries(
      Object.entries(current).filter(
        ([id, at]) =>
          now - at < PENDING_MS &&
          (shown.find((card) => card.id === id)?.lastAt ?? 0) < at,
      ),
    ),
  );
}

async function build($: EngineInterface, live: Live[], now: number) {
  const stores = await readStores($);
  const enriched = enrich(live, stores);
  const built = enriched
    .map((one) => cardOf(one, now, stores))
    .sort((a, b) => b.score - a.score);
  await update($, cards, () => built);
  await prunePending($, built, now);
  return { stores, enriched, built };
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

const runningInBackground = new Set<string>();

function inBackground(
  $: EngineInterface,
  name: string,
  work: () => Promise<void>,
) {
  if (runningInBackground.has(name)) return;
  runningInBackground.add(name);
  void work()
    .catch((error: unknown) =>
      log($, `${name} refresh failed: ${String(error)}`),
    )
    .finally(() => runningInBackground.delete(name));
}

export async function load($: EngineInterface) {
  if (!(await findInstance($))) return;
  if (!isLeader) {
    await followBoard($);
    return;
  }
  if (isLoading) {
    isDirty = true;
    return;
  }
  isLoading = true;
  try {
    await loadAsLeader($);
  } finally {
    isLoading = false;
  }
  if (isDirty) {
    isDirty = false;
    await $.clock.sleep(LOAD_DEBOUNCE_MS);
    await load($);
  }
}

async function loadAsLeader($: EngineInterface) {
  const now = Date.now();
  const live = await loadLive($, now);
  const { stores, enriched, built } = await build($, live, now);
  await writeBoard($, built);
  inBackground($, "projects", () => refreshProjects($, live));
  inBackground($, "tickets", () =>
    refreshTickets(
      $,
      enriched.flatMap((one) =>
        one.ticket && one.context.project
          ? [{ id: one.ticket, profile: one.context.project }]
          : [],
      ),
    ),
  );
  inBackground($, "prs", () => refreshPrs($, live));
  inBackground($, "verdicts", async () => {
    const fresh = await readNewVerdicts($, enriched, stores.verdicts);
    if (Object.keys(fresh).length === 0) return;
    await writeVerdicts($, fresh, new Set(live.map(({ s }) => s.sessionId)));
    await load($);
  });
  watched = [
    ...(await sessionDirs($)),
    ...live.map(({ s }) => transcriptPath(s)),
  ];
}

export async function loadOnChange($: EngineInterface) {
  if (!isLeader || watched.length === 0 || isLoading) return;
  const stats = await $.process.run(["/usr/bin/stat", "-f", "%Fm", ...watched]);
  const seen = stats.stdout;
  if (seen === lastSeen) return;
  const isFirst = lastSeen === "";
  lastSeen = seen;
  if (!isFirst) await load($);
}

const leasePath = () =>
  `${host.home}/.claude/claudetower/leases/${host.instance}.json`;
const boardPath = () =>
  `${host.home}/.claude/claudetower/boards/${host.instance}.json`;

async function makeParentDir($: EngineInterface, path: string) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (await $.fs.exists(dir)) return;
  const made = await $.process.run(["/bin/mkdir", "-p", dir]);
  if (made.exitCode !== 0)
    log($, `could not create ${dir}: ${made.stderr.trim()}`);
}

async function readJson($: EngineInterface, path: string) {
  if (!(await $.fs.exists(path))) return null;
  const text = await $.fs.read(path);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    log($, `ignoring unreadable ${path}: ${String(error)}`);
    return null;
  }
}

function leaseFileOf($: EngineInterface): LeaseFile {
  return {
    read: async () => {
      const value = await readJson($, leasePath());
      return isLease(value) ? value : null;
    },
    write: async (lease) => {
      await makeParentDir($, leasePath());
      await $.fs.write(leasePath(), JSON.stringify(lease));
    },
    settle: () => $.clock.sleep(LEASE_SETTLE_MS),
  };
}

export async function leaseTick($: EngineInterface) {
  if (!host.selfCliId || !(await findInstance($))) return;
  const wasLeader = isLeader;
  isLeader = await holdLease(
    leaseFileOf($),
    host.selfCliId,
    Date.now(),
    LEASE_EXPIRES_MS,
  );
  if (!isLeader) return;
  if (!wasLeader) {
    log($, "leading the board for this instance");
    await $.store.delete(instanceKey(LEGACY_ENDS_KEY));
  }
  const refresh = wasLeader ? loadOnChange($) : load($);
  void refresh.catch((error: unknown) =>
    log($, `could not refresh the board: ${String(error)}`),
  );
}

async function writeBoard($: EngineInterface, built: SessionCard[]) {
  const path = boardPath();
  const draft = `${path}.${host.selfCliId}.tmp`;
  await makeParentDir($, path);
  await $.fs.write(draft, JSON.stringify({ at: Date.now(), cards: built }));
  const moved = await $.process.run(["/bin/mv", "-f", draft, path]);
  if (moved.exitCode !== 0)
    log($, `could not publish the board: ${moved.stderr.trim()}`);
}

async function showCards($: EngineInterface, shown: SessionCard[]) {
  await update($, cards, () => shown);
  await prunePending($, shown, Date.now());
}

export async function followBoard($: EngineInterface) {
  if (isLeader || !host.instance) return;
  const path = boardPath();
  if (!(await $.fs.exists(path))) return;
  const { mtimeMs } = await $.fs.stat(path);
  if (mtimeMs === boardSeenAt) return;
  const board = (await readJson($, path)) as { cards?: SessionCard[] } | null;
  if (!board?.cards) return;
  boardSeenAt = mtimeMs;
  await showCards($, board.cards);
}

const SEND_URL_TO_PID = `ObjC.import("AppKit");
function run(argv) {
  const pid = Number(argv[0]);
  const code = (text) => [...text].reduce((n, c) => (n << 8) | c.charCodeAt(0), 0);
  const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
    code("GURL"), code("GURL"), $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid), -1, 0);
  event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(argv[1]), code("----"));
  const error = Ref();
  event.sendEventWithOptionsTimeoutError(1, 10, error);
  if (error[0] && !error[0].isNil()) throw new Error(ObjC.unwrap(error[0].localizedDescription));
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app.isNil()) app.activateWithOptions(0);
}`;

async function openInOwnApp($: EngineInterface, url: string) {
  if (!host.appPid) return false;
  const sent = await $.process.run([
    "/usr/bin/osascript",
    "-l",
    "JavaScript",
    "-e",
    SEND_URL_TO_PID,
    host.appPid,
    url,
  ]);
  if (sent.exitCode !== 0)
    log($, `could not open ${url} in this app: ${sent.stderr.trim()}`);
  return sent.exitCode === 0;
}

export async function openSession($: EngineInterface, id: string) {
  const url = `claude://claude.ai/epitaxy/${id}`;
  if (await openInOwnApp($, url)) return;
  const opened = await $.process.run(["open", url]);
  if (opened.exitCode !== 0)
    $.ui.toast(`Could not open the session: ${opened.stderr.trim()}`);
}

const ARCHIVE_ACTION: SessionAction = {
  label: "Archive",
  message: "Archive this session.",
};

async function archiveDirectly($: EngineInterface, card: SessionCard) {
  const input = {
    session_id: card.id,
    reason: card.verdict?.waitingFor || "Finished with nothing left to do",
  };
  const { decision } = await $.tool.check({ tool: ARCHIVE_SESSION, input });
  if (decision !== "allow") return false;
  const archived = await $.tool.call({ tool: ARCHIVE_SESSION, ...input });
  if (archived.deny !== undefined || archived.isError) {
    log(
      $,
      `could not archive "${card.title}": ${archived.deny ?? archived.text ?? "no answer"}`,
    );
    return false;
  }
  await update($, cards, (list) => list.filter((one) => one.id !== card.id));
  return true;
}

export async function archiveSession($: EngineInterface, card: SessionCard) {
  const isArchived = await archiveDirectly($, card).catch((error: unknown) => {
    log($, `could not archive "${card.title}": ${String(error)}`);
    return false;
  });
  if (!isArchived) startAction($, card, ARCHIVE_ACTION);
}

export function togglePreview($: EngineInterface, id: string) {
  return update($, previewed, (current) => (current === id ? "" : id));
}

export async function setPaneOpen($: EngineInterface, value: boolean) {
  await update($, isOpen, () => value);
  await $.store.set(instanceKey(STORE_KEYS.isOpen), value);
}

export async function openPane($: EngineInterface) {
  await setPaneOpen($, true);
  await $.ui.open({ id: PANE, title: "claudetower", columns: PANE_COLUMNS });
}

async function refreshSetupState($: EngineInterface) {
  const isNeeded = (await findInstance($)) !== "" && !(await hasRankingFile($));
  await update($, needsSetup, () => isNeeded);
  return isNeeded;
}

let isPanelAsked = false;

export function markPanelAsked() {
  isPanelAsked = true;
}

async function showSetupBand($: EngineInterface, isUp: boolean) {
  if (!isPanelAsked && isUp) await $.ui.close({ id: PANE });
}

export function readNeedsSetup($: EngineInterface) {
  return read($, needsSetup);
}

export async function followOtherSessions($: EngineInterface) {
  const isSettingUp = await refreshSetupState($);
  const isUp = (await $.ui.panes()).some((pane) => pane.id === PANE);
  if (isSettingUp) {
    await showSetupBand($, isUp);
  } else {
    const wantsOpen =
      (await $.store.get(instanceKey(STORE_KEYS.isOpen))) !== false;
    if (wantsOpen && !isUp && (await $.session.surfaces()).length > 0)
      await openPane($);
    if (!wantsOpen && isUp) await $.ui.close({ id: PANE });
  }
  await followCollapsedGroups($);
  const isShown = (await $.ui.panes()).some((pane) => pane.id === PANE);
  await update($, isOpen, () => isShown);
}

export async function poll($: EngineInterface) {
  await followOtherSessions($);
  if (isLeader) await load($);
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

const inboxPathOf = (cliId: string) => `${inboxDir()}/${cliId}.json`;

async function removeFile($: EngineInterface, path: string) {
  const removed = await $.process.run(["/bin/rm", "-f", path]);
  if (removed.exitCode !== 0)
    log($, `could not remove ${path}: ${removed.stderr.trim()}`);
}

export function readPending($: EngineInterface) {
  return read($, pending);
}

async function markPending($: EngineInterface, id: string) {
  await update($, composing, () => "");
  await update($, draft, () => "");
  await update($, pending, (current) => ({ ...current, [id]: Date.now() }));
}

function clearPending($: EngineInterface, id: string) {
  return update($, pending, (current) =>
    Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
  );
}

async function sendAction(
  $: EngineInterface,
  card: SessionCard,
  action: SessionAction,
) {
  await markPending($, card.id);
  if (card.cliId === host.selfCliId) {
    await $.prompt.submit({ text: action.message, asUser: true });
    return;
  }
  const path = inboxPathOf(card.cliId);
  await $.fs.write(
    path,
    JSON.stringify({ text: action.message, at: Date.now() }),
  );
  for (let waited = 0; waited < ANSWER_PICKUP_MS; waited += ANSWER_CHECK_MS) {
    await $.clock.sleep(ANSWER_CHECK_MS);
    if (!(await $.fs.exists(path))) return;
  }
  await removeFile($, path);
  await clearPending($, card.id);
  $.ui.toast(`"${card.title}" isn't running, so it opened instead`);
  await openSession($, card.id);
}

export async function checkInbox($: EngineInterface) {
  const dir = inboxDir();
  if (!host.selfCliId || !(await $.fs.exists(dir))) return;
  const { mtimeMs } = await $.fs.stat(dir);
  if (mtimeMs === inboxSeenAt) return;
  inboxSeenAt = mtimeMs;
  const path = inboxPathOf(host.selfCliId);
  if (!(await $.fs.exists(path))) return;
  const raw = await $.fs.read(path);
  await removeFile($, path);
  const { text, at } = JSON.parse(raw) as { text?: string; at?: number };
  if (!text || Date.now() - (at ?? 0) > ANSWER_PICKUP_MS) return;
  await $.prompt.submit({ text, asUser: true });
}

export function readComposing($: EngineInterface) {
  return read($, composing);
}

export async function toggleCompose($: EngineInterface, id: string) {
  await update($, draft, () => "");
  const opened = await update($, composing, (current) =>
    current === id ? "" : id,
  );
  if (opened !== id) return;
  const focused = await $.ui.focus({ requestId: PANE, key: `compose-${id}` });
  if (focused.deny !== undefined)
    log($, `could not focus the message box: ${focused.deny}`);
}

export function readDraft($: EngineInterface) {
  return read($, draft);
}

export function setDraft($: EngineInterface, text: string) {
  return update($, draft, () => text);
}

export function startAction(
  $: EngineInterface,
  card: SessionCard,
  action: SessionAction,
) {
  void sendAction($, card, action).catch(async (error: unknown) => {
    log($, `could not send to "${card.title}": ${String(error)}`);
    $.ui.toast(`Could not send to "${card.title}"`);
    await clearPending($, card.id);
  });
}

export function sendText($: EngineInterface, card: SessionCard, text: string) {
  const message = text.trim();
  if (message !== "") startAction($, card, { label: message, message });
}

const SETUP_MESSAGE =
  "Start a new session that sets up claudetower with its claudetower:ranking skill.";

export async function startSetup($: EngineInterface) {
  await $.prompt.submit({ text: SETUP_MESSAGE, asUser: true });
}

export async function useDefaultRanking($: EngineInterface) {
  await writeRanking($, {});
  await refreshSetupState($);
  await openPane($);
  await load($);
}

export function readCollapsedGroups($: EngineInterface) {
  return read($, collapsedGroups);
}

export async function toggleGroup($: EngineInterface, id: string) {
  const next = await update($, collapsedGroups, (current) => ({
    ...current,
    [id]: !current[id],
  }));
  await $.store.set(instanceKey(STORE_KEYS.collapsedGroups), next);
}

async function followCollapsedGroups($: EngineInterface) {
  const saved = (await $.store.get(instanceKey(STORE_KEYS.collapsedGroups))) as
    Record<string, boolean> | undefined;
  if (saved) await update($, collapsedGroups, () => saved);
}

const CLICK_LAYER_RETRY_MS = 2 * MINUTE_MS;

export async function areClickLayersHealthy($: EngineInterface) {
  return (
    Date.now() - (await read($, clickLayersFailedAt)) > CLICK_LAYER_RETRY_MS
  );
}

export async function noteClickLayerFailure(
  $: EngineInterface,
  reason: string,
) {
  log($, `a click layer failed, using buttons for now: ${reason}`);
  await update($, clickLayersFailedAt, () => Date.now());
}
