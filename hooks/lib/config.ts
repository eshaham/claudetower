import type { EngineInterface } from "claude-code";

export const PLUGIN = "claudetower";
export const PANE = "claudetower";

const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const FRESH_MS = 3 * DAY_MS;
export const LOOKBACK_MS = 30 * DAY_MS;
export const RUNNING_GRACE_MS = 15 * MINUTE_MS;
export const TOOL_GRACE_MS = 2 * HOUR_MS;
export const PROJECT_TTL_MS = 7 * DAY_MS;
export const CLAIM_MS = 5 * MINUTE_MS;
export const ANSWER_CHECK_MS = SECOND_MS;
export const ANSWER_PICKUP_MS = 10 * SECOND_MS;
export const INBOX_POLL_MS = 2 * SECOND_MS;
export const POLL_MS = 15 * SECOND_MS;
export const PENDING_MS = 2 * MINUTE_MS;

export const TAIL_BYTES = 1500000;
export const LAST_TEXT_CHARS = 6000;
export const PREVIEW_REPLY_CHARS = 2500;
export const PROMPT_CHARS = 800;

export const READS_PER_POLL = 6;
export const READ_CONCURRENCY = 3;
export const MAX_FOLLOW_UPS = 3;

export const PANE_COLUMNS = 50;
export const BOARD_MIN_COLUMNS = 100;
export const CARD_LIMIT = 30;
export const LINE_LIMIT = 8;
export const CARDS_PER_LANE = 8;

export const VERDICT_MODEL = "sonnet";

export const STORE_KEYS = {
  verdicts: "verdicts-v9",
  claims: "claims",
  tickets: "tickets-v2",
  prs: "prs",
  ends: "transcript-ends-v1",
  projects: "projects-v1",
  isOpen: "isOpen",
} as const;

export const TICKET_TTL_MS = 30 * MINUTE_MS;
export const TICKET_LOOKUPS_PER_POLL = 4;
export const PR_TTL_MS = 5 * MINUTE_MS;
export const PR_LOOKUPS_PER_POLL = 4;
export const GH_TIMEOUT_MS = 15 * SECOND_MS;

export const ARCHIVE_SESSION = "mcp__ccd_session_mgmt__archive_session";

const APP_SUPPORT = "Library/Application Support";
const SESSIONS_DIR = "claude-code-sessions";

export type McpToolName = `mcp__${string}__${string}`;

export const isMcpToolName = (name: string): name is McpToolName =>
  /^mcp__.+__.+$/.test(name);

export type ToolSummary = { name: string; description: string };

export const host: {
  home: string;
  gh: string;
  selfCliId: string;
  instance: string;
  appPid: string;
  tools: ToolSummary[];
  ticketPrefixOverride: string[];
} = {
  home: "",
  gh: "",
  selfCliId: "",
  instance: "",
  appPid: "",
  tools: [],
  ticketPrefixOverride: [],
};

export function log($: EngineInterface, message: string) {
  $.ui.log(`${PLUGIN}: ${message}`, { to: "debug" });
}

export const isTicketPrefix = (prefix: string) =>
  /^[A-Za-z][A-Za-z0-9]*$/.test(prefix);

export const setTicketPrefixes = (prefixes: string) => {
  host.ticketPrefixOverride = prefixes
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(isTicketPrefix);
};

const GH_CANDIDATES = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
];

const FIND_APP_PID =
  'p=$PPID; while [ "$p" -gt 1 ]; do q=$(ps -o ppid= -p "$p" | tr -d " "); [ "$q" = 1 ] && case "$(ps -o comm= -p "$p")" in */Contents/MacOS/Claude) echo "$p"; exit 0;; *) exit 1;; esac; p=$q; done; exit 1';

async function findAppPid($: EngineInterface) {
  const found = await $.process.run(["/bin/sh", "-c", FIND_APP_PID]);
  return found.exitCode === 0 ? found.stdout.trim() : "";
}

async function findGh($: EngineInterface) {
  for (const path of GH_CANDIDATES) if (await $.fs.exists(path)) return path;
  const found = await $.process.run(["/bin/sh", "-c", "command -v gh"]);
  return found.exitCode === 0 ? found.stdout.trim() : "";
}

export async function discoverHost($: EngineInterface) {
  const [home, gh, selfCliId, appPid] = await Promise.all([
    $.process.run(["/usr/bin/printenv", "HOME"]),
    findGh($),
    $.session.id(),
    findAppPid($),
  ]);
  host.home = home.stdout.trim();
  host.gh = gh;
  host.selfCliId = selfCliId;
  host.appPid = appPid;
  await findInstance($);
  if (!host.gh) log($, "gh not found; PR details are off");
}

export async function loadTools($: EngineInterface) {
  if (host.tools.length > 0) return;
  host.tools = (await $.tool.list())
    .filter((tool) => tool.mcp)
    .map((tool) => ({ name: tool.name, description: tool.description }));
}

const sessionsRootOf = (instance: string) =>
  `${host.home}/${APP_SUPPORT}/${instance}/${SESSIONS_DIR}`;

export const sessionsRoot = () => sessionsRootOf(host.instance);

export const instanceKey = (key: string) => `${host.instance}/${key}`;

export async function findInstance($: EngineInterface) {
  if (host.instance || !host.selfCliId) return host.instance;
  const candidates = (await $.fs.list(`${host.home}/${APP_SUPPORT}`))
    .filter((entry) => entry.kind === "dir")
    .map((entry) => entry.name);
  const instances = (
    await Promise.all(
      candidates.map(async (name) =>
        (await $.fs.exists(sessionsRootOf(name))) ? [name] : [],
      ),
    )
  ).flat();
  if (instances.length === 0) return "";
  const found = await $.process.run([
    "/usr/bin/grep",
    "-rlF",
    "--include=local_*.json",
    `"cliSessionId":"${host.selfCliId}"`,
    ...instances.map(sessionsRootOf),
  ]);
  const match = found.stdout.split("\n").find(Boolean) ?? "";
  host.instance =
    instances.find((name) => match.startsWith(`${sessionsRootOf(name)}/`)) ??
    "";
  return host.instance;
}

export const inboxDir = () => `${host.home}/.claude/claudetower/inbox`;
