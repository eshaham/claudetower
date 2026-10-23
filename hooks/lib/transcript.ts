import type { EngineInterface } from "claude-code";

import type { SessionAction } from "../../types";
import {
  LAST_TEXT_CHARS,
  STORE_KEYS,
  LOOKBACK_MS,
  PROMPT_CHARS,
  RUNNING_GRACE_MS,
  TAIL_BYTES,
  TOOL_GRACE_MS,
  HOUR_MS,
  host,
  log,
  sessionsRoot,
  instanceKey,
} from "./config";

export type SessionPr = { prNumber?: number; state?: string; repo?: string };

export type SessionFile = {
  sessionId: string;
  cliSessionId?: string;
  title?: string;
  isArchived?: boolean;
  cwd?: string;
  originCwd?: string;
  branch?: string;
  prs?: SessionPr[];
  scheduledTaskId?: string;
  lastActivityAt?: number;
  spawnedFrom?: { sessionId?: string };
};

export type TranscriptEnd = {
  mtimeMs: number;
  lastAt: number;
  isStopped: boolean;
  lastAssistantId: string;
  prompt: string;
  promptAt: number;
  lastText: string;
  question: string;
  options: SessionAction[];
  uncommittedFiles: number;
};

export type Live = { s: SessionFile; end: TranscriptEnd };

export type StartedSession = {
  title: string;
  isArchived: boolean;
  hoursAgo: number;
};

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: {
    ask?: string;
    actions?: { label?: string; message?: string }[];
    questions?: { question?: string; options?: { label?: string }[] }[];
  };
};

type TranscriptLine = {
  lastPrompt?: string;
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    stop_reason?: string | null;
    content?: string | ContentBlock[];
  };
};

const REPLY_MARKER = /<!--\s*reply[^>]*-->/gi;

const sessionFiles = new Map<string, { mtimeMs: number; file: SessionFile }>();
const transcriptEnds = new Map<string, TranscriptEnd>();
export const startedFrom = new Map<string, StartedSession[]>();

export const projectOf = (s: SessionFile) => {
  const path = s.originCwd ?? s.cwd ?? "";
  const repoRoot = path.split("/.claude/worktrees/")[0] ?? path;
  return repoRoot.split("/").filter(Boolean).pop() ?? "unknown";
};

export const ticketOf = (s: SessionFile, pattern: RegExp | null) =>
  (pattern &&
    `${s.title ?? ""} ${s.branch ?? ""}`.match(pattern)?.[0]?.toUpperCase()) ||
  "";

export const titleOf = (s: SessionFile, ticket: string) => {
  const title = s.title ?? "Untitled";
  return ticket && title.toUpperCase().startsWith(`${ticket}:`)
    ? title.slice(ticket.length + 1).trim()
    : title;
};

export const transcriptPath = (s: SessionFile) =>
  `${host.home}/.claude/projects/${(s.cwd ?? "").replace(/[/.]/g, "-")}/${s.cliSessionId}.jsonl`;

const textOf = (line: TranscriptLine) => {
  const content = line.message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
};

const hasBlock = (line: TranscriptLine, type: string) => {
  const content = line.message?.content;
  return Array.isArray(content) && content.some((block) => block.type === type);
};

const withoutQuotedReplies = (text: string) => {
  const unmarked = text.replace(REPLY_MARKER, "");
  const own = unmarked
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
  return own || unmarked.trim();
};

const isPrompt = (line: TranscriptLine) => {
  if (line.type !== "user" || hasBlock(line, "tool_result")) return false;
  const text = textOf(line).trimStart();
  return text !== "" && (!text.startsWith("<") || text.startsWith("<!--"));
};

const SUGGESTION_TOOLS = /(__wrap_up|^AskUserQuestion)$/;

const suggestedActionsOf = (turn: TranscriptLine[]) => {
  const blocks = turn.flatMap((line) =>
    Array.isArray(line.message?.content) ? line.message.content : [],
  );
  const call = blocks.findLast(
    (block) =>
      block.type === "tool_use" && SUGGESTION_TOOLS.test(block.name ?? ""),
  );
  const input = call?.input;
  const asked = input?.questions?.[0];
  return {
    question: input?.ask ?? asked?.question ?? "",
    options: [
      ...(input?.actions ?? []).map((action) => ({
        label: action.label ?? "",
        message: action.message || action.label || "",
      })),
      ...(asked?.options ?? []).map((option) => ({
        label: option.label ?? "",
        message: option.label ?? "",
      })),
    ].filter((action) => action.label !== ""),
  };
};

const timeOf = (line: TranscriptLine | undefined) =>
  line?.timestamp ? Date.parse(line.timestamp) : 0;

async function countUncommitted($: EngineInterface, cwd: string) {
  if (!cwd.includes("/.claude/worktrees/") || !(await $.fs.exists(cwd)))
    return 0;
  const status = await $.process.run([
    "git",
    "-C",
    cwd,
    "status",
    "--porcelain",
  ]);
  if (status.exitCode !== 0) {
    log($, `git status failed in ${cwd}: ${status.stderr.trim()}`);
    return 0;
  }
  return status.stdout.split("\n").filter(Boolean).length;
}

function parseLines(
  $: EngineInterface,
  path: string,
  raw: string,
  isPartial: boolean,
) {
  const lines: TranscriptLine[] = [];
  let recordedPrompt = "";
  for (const text of raw.split("\n").slice(isPartial ? 1 : 0)) {
    if (text.trim() === "") continue;
    try {
      const line = JSON.parse(text) as TranscriptLine;
      if (line.type === "last-prompt" && line.lastPrompt)
        recordedPrompt = line.lastPrompt;
      if (
        !line.isSidechain &&
        (line.type === "user" || line.type === "assistant")
      )
        lines.push(line);
    } catch (error) {
      log(
        $,
        `skipped an unreadable transcript line in ${path}: ${String(error)}`,
      );
    }
  }
  return { lines, recordedPrompt };
}

async function readTranscriptEnd(
  $: EngineInterface,
  s: SessionFile,
  path: string,
  stat: { mtimeMs: number; size: number },
): Promise<TranscriptEnd> {
  const { mtimeMs } = stat;
  const tail = await $.process.run(["tail", "-c", String(TAIL_BYTES), path]);
  if (tail.exitCode !== 0) throw new Error(tail.stderr.trim());
  const { lines, recordedPrompt } = parseLines(
    $,
    path,
    tail.stdout,
    stat.size > TAIL_BYTES,
  );
  const last = lines[lines.length - 1];
  const promptIndex = lines.findLastIndex(isPrompt);
  const turn = lines
    .slice(promptIndex + 1)
    .filter((line) => line.type === "assistant");
  const promptLine =
    (recordedPrompt &&
      lines.findLast(
        (line) =>
          isPrompt(line) && textOf(line).trim() === recordedPrompt.trim(),
      )) ||
    lines[promptIndex];
  const isWaitingOnTool =
    last?.type === "assistant" && hasBlock(last, "tool_use");
  const endedCleanly =
    last?.type === "assistant" &&
    !isWaitingOnTool &&
    last.message?.stop_reason !== null;
  const isStopped =
    endedCleanly ||
    Date.now() - mtimeMs > (isWaitingOnTool ? TOOL_GRACE_MS : RUNNING_GRACE_MS);
  const { question, options } = suggestedActionsOf(turn);
  return {
    mtimeMs,
    lastAt: timeOf(last) || mtimeMs,
    isStopped,
    lastAssistantId: turn[turn.length - 1]?.uuid ?? "",
    prompt: withoutQuotedReplies(
      recordedPrompt || (promptLine ? textOf(promptLine) : ""),
    )
      .replace(/\s+/g, " ")
      .slice(0, PROMPT_CHARS),
    promptAt: timeOf(promptLine),
    lastText: turn
      .map(textOf)
      .filter(Boolean)
      .join("\n\n")
      .slice(-LAST_TEXT_CHARS),
    question,
    options,
    uncommittedFiles: isStopped ? await countUncommitted($, s.cwd ?? "") : 0,
  };
}

export async function sessionDirs($: EngineInterface) {
  const root = sessionsRoot();
  if (!(await $.fs.exists(root))) return [];
  const accounts = (await $.fs.list(root)).filter(
    (entry) => entry.kind === "dir",
  );
  const orgs = await Promise.all(
    accounts.map(async (account) =>
      (await $.fs.list(`${root}/${account.name}`))
        .filter((entry) => entry.kind === "dir")
        .map((org) => `${root}/${account.name}/${org.name}`),
    ),
  );
  return orgs.flat();
}

const recordStartedSessions = (files: SessionFile[], now: number) => {
  startedFrom.clear();
  for (const file of files) {
    const parent = file.spawnedFrom?.sessionId;
    if (!parent) continue;
    startedFrom.set(parent, [
      ...(startedFrom.get(parent) ?? []),
      {
        title: file.title ?? "",
        isArchived: file.isArchived === true,
        hoursAgo: Math.round((now - (file.lastActivityAt ?? now)) / HOUR_MS),
      },
    ]);
  }
};

export async function loadSessionFiles($: EngineInterface, now: number) {
  const listings = await Promise.all(
    (await sessionDirs($)).map(async (dir) =>
      (await $.fs.list(dir)).map((entry) => ({ dir, entry })),
    ),
  );
  const files = await Promise.all(
    listings
      .flat()
      .filter(
        ({ entry }) =>
          entry.name.startsWith("local_") && now - entry.mtimeMs <= LOOKBACK_MS,
      )
      .map(async ({ dir, entry }) => {
        const path = `${dir}/${entry.name}`;
        const cached = sessionFiles.get(path);
        if (cached?.mtimeMs === entry.mtimeMs) return cached.file;
        const file = JSON.parse(await $.fs.read(path)) as SessionFile;
        sessionFiles.set(path, { mtimeMs: entry.mtimeMs, file });
        return file;
      }),
  );
  recordStartedSessions(files, now);
  return files.filter((s) => !s.isArchived && s.cliSessionId && s.cwd);
}

const latestRunsOnly = (live: Live[]) => {
  const latest = new Map<string, number>();
  for (const { s, end } of live)
    if (s.scheduledTaskId)
      latest.set(
        s.scheduledTaskId,
        Math.max(latest.get(s.scheduledTaskId) ?? 0, end.lastAt),
      );
  return live.filter(
    ({ s, end }) =>
      !s.scheduledTaskId || latest.get(s.scheduledTaskId) === end.lastAt,
  );
};

type EndStore = Record<string, TranscriptEnd>;

async function transcriptEndOf(
  $: EngineInterface,
  s: SessionFile,
  now: number,
  shared: EndStore,
) {
  const path = transcriptPath(s);
  if (!(await $.fs.exists(path))) return null;
  const stat = await $.fs.stat(path);
  if (now - stat.mtimeMs > LOOKBACK_MS) return null;
  const cached = transcriptEnds.get(path) ?? shared[path];
  const isIdleRun =
    cached && !cached.isStopped && now - cached.mtimeMs > RUNNING_GRACE_MS;
  if (cached?.mtimeMs === stat.mtimeMs && !isIdleRun) {
    transcriptEnds.set(path, cached);
    return cached;
  }
  try {
    const end = await readTranscriptEnd($, s, path, stat);
    transcriptEnds.set(path, end);
    return end;
  } catch (error) {
    log($, `could not read the transcript of "${s.title}": ${String(error)}`);
    return null;
  }
}

async function shareEnds(
  $: EngineInterface,
  shared: EndStore,
  paths: string[],
) {
  const mine = Object.fromEntries(
    paths.flatMap((path) => {
      const end = transcriptEnds.get(path);
      return end ? [[path, end] as const] : [];
    }),
  );
  const changed = paths.some(
    (path) => mine[path] && mine[path].mtimeMs !== shared[path]?.mtimeMs,
  );
  if (changed || Object.keys(shared).some((path) => !paths.includes(path)))
    await $.store.set(instanceKey(STORE_KEYS.ends), mine);
}

export async function loadLive($: EngineInterface, now: number) {
  const files = await loadSessionFiles($, now);
  const shared = ((await $.store.get(instanceKey(STORE_KEYS.ends))) ??
    {}) as EndStore;
  const ends = await Promise.all(
    files.map((s) => transcriptEndOf($, s, now, shared)),
  );
  await shareEnds(
    $,
    shared,
    files.filter((_, index) => ends[index]).map(transcriptPath),
  );
  return latestRunsOnly(
    files.flatMap((s, index) => {
      const end = ends[index];
      return end ? [{ s, end }] : [];
    }),
  );
}

const FIRST_ASK_CHARS = 3000;
const DIGEST_PROMPT_CHARS = 400;
const DIGEST_REPLY_CHARS = 1200;
const DIGEST_PROMPTS = 40;
const DIGEST_REPLIES = 30;

const keepLast = <T>(list: T[], item: T, limit: number) => {
  list.push(item);
  if (list.length > limit * 2) list.splice(0, list.length - limit);
};

export async function digestOf($: EngineInterface, path: string) {
  let firstAsk = "";
  let promptCount = 0;
  const prompts: string[] = [];
  const replies: string[] = [];
  const take = (raw: string) => {
    if (raw.trim() === "") return;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch (error) {
      log(
        $,
        `skipped an unreadable transcript line in ${path}: ${String(error)}`,
      );
      return;
    }
    if (line.isSidechain) return;
    if (isPrompt(line)) {
      const text = withoutQuotedReplies(textOf(line));
      if (!firstAsk) firstAsk = text.slice(0, FIRST_ASK_CHARS);
      promptCount += 1;
      keepLast(prompts, text.slice(0, DIGEST_PROMPT_CHARS), DIGEST_PROMPTS);
    } else if (line.type === "assistant") {
      const text = textOf(line).trim();
      if (text)
        keepLast(replies, text.slice(-DIGEST_REPLY_CHARS), DIGEST_REPLIES);
    }
  };
  let pending = "";
  for await (const { stream, text } of $.process.spawn({
    argv: ["cat", path],
  })) {
    if (stream !== "stdout") continue;
    const parts = (pending + text).split("\n");
    pending = parts.pop() ?? "";
    parts.forEach(take);
  }
  take(pending);
  return {
    firstAsk,
    promptCount,
    recentPrompts: prompts.slice(-DIGEST_PROMPTS),
    recentReplies: replies.slice(-DIGEST_REPLIES),
  };
}
