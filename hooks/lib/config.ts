import type { EngineInterface } from "claude-code";

export const PLUGIN = "claudtower";
export const PANE = "claudtower";

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
export const ANSWER_TTL_MS = 10 * MINUTE_MS;
export const POLL_MS = 15 * SECOND_MS;

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
  answers: "answers",
  projects: "projects-v1",
  isOpen: "isOpen",
} as const;

export const TICKET_TTL_MS = 30 * MINUTE_MS;
export const TICKET_LOOKUPS_PER_POLL = 4;
export const PR_TTL_MS = 5 * MINUTE_MS;
export const PR_LOOKUPS_PER_POLL = 4;

export const ARCHIVE_SESSION = "mcp__ccd_session_mgmt__archive_session";

const SESSIONS_ROOT = "Library/Application Support/Claude/claude-code-sessions";

export type McpToolName = `mcp__${string}__${string}`;

export const isMcpToolName = (name: string): name is McpToolName =>
  /^mcp__.+__.+$/.test(name);

export type ToolSummary = { name: string; description: string };

export const host: {
  home: string;
  gh: string;
  selfCliId: string;
  tools: ToolSummary[];
  ticketPrefixOverride: string[];
} = { home: "", gh: "", selfCliId: "", tools: [], ticketPrefixOverride: [] };

export function log($: EngineInterface, message: string) {
  $.ui.log(`${PLUGIN}: ${message}`);
}

export const isTicketPrefix = (prefix: string) =>
  /^[A-Za-z][A-Za-z0-9]*$/.test(prefix);

export const setTicketPrefixes = (prefixes: string) => {
  host.ticketPrefixOverride = prefixes
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(isTicketPrefix);
};

export async function discoverHost($: EngineInterface) {
  const [home, gh, tools, selfCliId] = await Promise.all([
    $.process.run(["/usr/bin/printenv", "HOME"]),
    $.process.run(["/bin/sh", "-lc", "command -v gh"]),
    $.tool.list(),
    $.session.id(),
  ]);
  host.home = home.stdout.trim();
  host.gh = gh.exitCode === 0 ? gh.stdout.trim() : "";
  host.selfCliId = selfCliId;
  host.tools = tools
    .filter((tool) => tool.mcp)
    .map((tool) => ({ name: tool.name, description: tool.description }));
  if (!host.gh) log($, "gh not found; PR details are off");
}

export const sessionsRoot = () => `${host.home}/${SESSIONS_ROOT}`;
