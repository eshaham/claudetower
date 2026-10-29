import type { EngineInterface } from "claude-code";

import type { SessionAction } from "../../types";
import {
  FIRST_TAIL_BYTES,
  GIT_STATUS_TTL_MS,
  LAST_TEXT_CHARS,
  LOOKBACK_MS,
  PROMPT_CHARS,
  RUNNING_GRACE_MS,
  TAIL_BYTES,
  TOOL_GRACE_MS,
  HOUR_MS,
  host,
  log,
  sessionsRoot,
} from "./config";
import type {
  Limits,
  TranscriptLine,
  TranscriptState,
} from "./transcript-state";
import {
  applyText,
  emptyState,
  hasPrompt,
  isPrompt,
  readingOf,
  splitChunk,
  textOf,
  withoutQuotedReplies,
} from "./transcript-state";

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

const sessionFiles = new Map<string, { mtimeMs: number; file: SessionFile }>();
const transcripts = new Map<string, TranscriptCache>();
export const startedFrom = new Map<string, StartedSession[]>();

type TranscriptCache = {
  offset: number;
  size: number;
  mtimeMs: number;
  state: TranscriptState;
};

const LIMITS: Limits = {
  lastTextChars: LAST_TEXT_CHARS,
  promptChars: PROMPT_CHARS,
  runningGraceMs: RUNNING_GRACE_MS,
  toolGraceMs: TOOL_GRACE_MS,
};

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

type WorktreeStatus = {
  headMtimeMs: number;
  indexMtimeMs: number;
  checkedAt: number;
  count: number;
};

const gitDirs = new Map<string, string>();
const worktreeStatuses = new Map<string, WorktreeStatus>();

async function gitDirOf($: EngineInterface, cwd: string) {
  const known = gitDirs.get(cwd);
  if (known !== undefined) return known;
  const pointer = `${cwd}/.git`;
  const stat = await $.fs.stat(pointer);
  const dir =
    stat.kind === "dir"
      ? pointer
      : ((await $.fs.read(pointer)).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ??
        "");
  gitDirs.set(cwd, dir);
  return dir;
}

async function mtimeOf($: EngineInterface, path: string) {
  return (await $.fs.exists(path)) ? (await $.fs.stat(path)).mtimeMs : 0;
}

async function countUncommitted($: EngineInterface, cwd: string) {
  if (!cwd.includes("/.claude/worktrees/") || !(await $.fs.exists(cwd)))
    return 0;
  const gitDir = await gitDirOf($, cwd);
  const [headMtimeMs, indexMtimeMs] = gitDir
    ? await Promise.all([
        mtimeOf($, `${gitDir}/HEAD`),
        mtimeOf($, `${gitDir}/index`),
      ])
    : [0, 0];
  const known = worktreeStatuses.get(cwd);
  if (
    known &&
    known.headMtimeMs === headMtimeMs &&
    known.indexMtimeMs === indexMtimeMs &&
    Date.now() - known.checkedAt < GIT_STATUS_TTL_MS
  )
    return known.count;
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
  const count = status.stdout.split("\n").filter(Boolean).length;
  worktreeStatuses.set(cwd, {
    headMtimeMs,
    indexMtimeMs: await mtimeOf($, `${gitDir}/index`),
    checkedAt: Date.now(),
    count,
  });
  return count;
}

async function readRange(
  $: EngineInterface,
  path: string,
  start: number,
  end: number,
) {
  const read = await $.process.run([
    "/bin/sh",
    "-c",
    'tail -c +"$1" "$2" | head -c "$3"',
    "sh",
    String(start + 1),
    path,
    String(end - start),
  ]);
  if (read.exitCode !== 0) throw new Error(read.stderr.trim());
  return read.stdout;
}

function noteSkipped(
  $: EngineInterface,
  path: string,
  before: TranscriptState,
  after: TranscriptState,
) {
  if (after.skippedLines > before.skippedLines)
    log(
      $,
      `skipped ${after.skippedLines - before.skippedLines} unreadable transcript lines in ${path}`,
    );
}

async function readFromTail($: EngineInterface, path: string, size: number) {
  let state = emptyState();
  let tailBytes = 0;
  for (const bytes of [FIRST_TAIL_BYTES, TAIL_BYTES]) {
    const start = Math.max(0, size - bytes);
    const chunk = splitChunk(await readRange($, path, start, size), start > 0);
    const next = applyText(emptyState(), chunk.complete, LIMITS);
    noteSkipped($, path, state, next);
    state = next;
    tailBytes = chunk.tailBytes;
    if (start === 0 || hasPrompt(state)) break;
  }
  return { state, offset: size - tailBytes };
}

async function readAppended(
  $: EngineInterface,
  path: string,
  cached: TranscriptCache,
  size: number,
) {
  const chunk = splitChunk(
    await readRange($, path, cached.offset, size),
    false,
  );
  const state = applyText(cached.state, chunk.complete, LIMITS);
  noteSkipped($, path, cached.state, state);
  return { state, offset: size - chunk.tailBytes };
}

export async function readTranscript(
  $: EngineInterface,
  path: string,
  stat: { mtimeMs: number; size: number },
) {
  const cached = transcripts.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs)
    return cached;
  const read =
    cached && stat.size >= cached.offset
      ? stat.size === cached.offset
        ? { state: cached.state, offset: cached.offset }
        : await readAppended($, path, cached, stat.size)
      : await readFromTail($, path, stat.size);
  const next = { ...read, size: stat.size, mtimeMs: stat.mtimeMs };
  transcripts.set(path, next);
  return next;
}

async function transcriptEndOf(
  $: EngineInterface,
  s: SessionFile,
  now: number,
): Promise<TranscriptEnd | null> {
  const path = transcriptPath(s);
  if (!(await $.fs.exists(path))) return null;
  const stat = await $.fs.stat(path);
  if (now - stat.mtimeMs > LOOKBACK_MS) return null;
  try {
    const { state } = await readTranscript($, path, stat);
    const reading = readingOf(state, stat.mtimeMs, now, LIMITS);
    return {
      ...reading,
      mtimeMs: stat.mtimeMs,
      uncommittedFiles: reading.isStopped
        ? await countUncommitted($, s.cwd ?? "")
        : 0,
    };
  } catch (error) {
    log($, `could not read the transcript of "${s.title}": ${String(error)}`);
    return null;
  }
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

export async function loadLive($: EngineInterface, now: number) {
  const files = await loadSessionFiles($, now);
  const ends = await Promise.all(files.map((s) => transcriptEndOf($, s, now)));
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
