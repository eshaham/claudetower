import type { SessionAction } from "../../types";

export type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: {
    ask?: string;
    actions?: { label?: string; message?: string }[];
    questions?: { question?: string; options?: { label?: string }[] }[];
  };
};

export type TranscriptLine = {
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

type PromptSeen = { text: string; at: number };

export type TranscriptState = {
  recordedPrompt: string;
  prompts: PromptSeen[];
  last: {
    type: string;
    at: number;
    isWaitingOnTool: boolean;
    isAsking?: boolean;
    stopReason: string | null | undefined;
  } | null;
  turnText: string;
  turnLastId: string;
  question: string;
  options: SessionAction[];
  questionCallId?: string;
  skippedLines: number;
};

export type TranscriptReading = {
  lastAt: number;
  isStopped: boolean;
  lastAssistantId: string;
  prompt: string;
  promptAt: number;
  lastText: string;
  question: string;
  options: SessionAction[];
  isAsking: boolean;
};

export type Limits = {
  lastTextChars: number;
  promptChars: number;
  runningGraceMs: number;
  toolGraceMs: number;
};

const REPLY_MARKER = /<!--\s*reply[^>]*-->/gi;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const SUGGESTION_TOOLS = /(__wrap_up|^AskUserQuestion)$/;
const QUESTION_TOOL = "AskUserQuestion";
const PROMPTS_KEPT = 20;

export const emptyState = (): TranscriptState => ({
  recordedPrompt: "",
  prompts: [],
  last: null,
  turnText: "",
  turnLastId: "",
  question: "",
  options: [],
  skippedLines: 0,
});

export const textOf = (line: TranscriptLine) => {
  const content = line.message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
};

export const promptTextOf = (line: TranscriptLine) =>
  textOf(line).replace(SYSTEM_REMINDER, "").trim();

const hasBlock = (line: TranscriptLine, type: string) => {
  const content = line.message?.content;
  return Array.isArray(content) && content.some((block) => block.type === type);
};

export const withoutQuotedReplies = (text: string) => {
  const unmarked = text.replace(REPLY_MARKER, "");
  const own = unmarked
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
  return own || unmarked.trim();
};

export const isPrompt = (line: TranscriptLine) => {
  if (line.type !== "user" || hasBlock(line, "tool_result")) return false;
  const text = promptTextOf(line);
  return text !== "" && (!text.startsWith("<") || text.startsWith("<!--"));
};

const timeOf = (line: TranscriptLine) =>
  line.timestamp ? Date.parse(line.timestamp) : 0;

const suggestionOf = (line: TranscriptLine) => {
  const blocks = Array.isArray(line.message?.content)
    ? line.message.content
    : [];
  const call = blocks.findLast(
    (block) =>
      block.type === "tool_use" && SUGGESTION_TOOLS.test(block.name ?? ""),
  );
  if (!call) return null;
  const input = call.input;
  const asked = input?.questions?.[0];
  return {
    callId: call.name === QUESTION_TOOL ? (call.id ?? "") : "",
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

const isAskingCall = (line: TranscriptLine) => {
  const content = line.message?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) => block.type === "tool_use" && block.name === QUESTION_TOOL,
    )
  );
};

const isAnswered = (line: TranscriptLine, callId: string | undefined) => {
  const content = line.message?.content;
  return (
    !!callId &&
    Array.isArray(content) &&
    content.some(
      (block) => block.type === "tool_result" && block.tool_use_id === callId,
    )
  );
};

function applyLine(
  state: TranscriptState,
  line: TranscriptLine,
  limits: Limits,
): TranscriptState {
  if (line.type === "last-prompt" && line.lastPrompt)
    return { ...state, recordedPrompt: line.lastPrompt };
  if (line.isSidechain || (line.type !== "user" && line.type !== "assistant"))
    return state;
  const isWaitingOnTool =
    line.type === "assistant" && hasBlock(line, "tool_use");
  const last = {
    type: line.type,
    at: timeOf(line),
    isWaitingOnTool,
    isAsking: isWaitingOnTool && isAskingCall(line),
    stopReason: line.message?.stop_reason,
  };
  if (isPrompt(line))
    return {
      ...state,
      last,
      prompts: [
        ...state.prompts,
        { text: promptTextOf(line), at: timeOf(line) },
      ].slice(-PROMPTS_KEPT),
      turnText: "",
      turnLastId: "",
      question: "",
      options: [],
      questionCallId: "",
    };
  if (line.type !== "assistant")
    return isAnswered(line, state.questionCallId)
      ? { ...state, last, question: "", options: [], questionCallId: "" }
      : { ...state, last };
  const text = textOf(line);
  const suggestion = suggestionOf(line);
  return {
    ...state,
    last,
    turnText: text
      ? (state.turnText ? `${state.turnText}\n\n${text}` : text).slice(
          -limits.lastTextChars,
        )
      : state.turnText,
    turnLastId: line.uuid ?? state.turnLastId,
    question: suggestion ? suggestion.question : state.question,
    options: suggestion ? suggestion.options : state.options,
    questionCallId: suggestion ? suggestion.callId : state.questionCallId,
  };
}

export function applyText(
  state: TranscriptState,
  text: string,
  limits: Limits,
): TranscriptState {
  let next = state;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      next = { ...next, skippedLines: next.skippedLines + 1 };
      continue;
    }
    next = applyLine(next, line, limits);
  }
  return next;
}

export type Chunk = { complete: string; tailBytes: number };

const encoder = new TextEncoder();

export const byteLengthOf = (text: string) => encoder.encode(text).length;

export function splitChunk(text: string, skipFirstLine: boolean): Chunk {
  const end = text.lastIndexOf("\n");
  const tail = end < 0 ? text : text.slice(end + 1);
  const whole = end < 0 ? "" : text.slice(0, end + 1);
  const start = skipFirstLine ? whole.indexOf("\n") + 1 : 0;
  return { complete: whole.slice(start), tailBytes: byteLengthOf(tail) };
}

export function readingOf(
  state: TranscriptState,
  mtimeMs: number,
  now: number,
  limits: Limits,
): TranscriptReading {
  const recorded = state.recordedPrompt.trim();
  const latest = state.prompts[state.prompts.length - 1];
  const recordedSeen =
    recorded && state.prompts.findLast((seen) => seen.text.trim() === recorded);
  const isRecordedStale = !!recordedSeen && recordedSeen !== latest;
  const promptSeen = (!isRecordedStale && recordedSeen) || latest;
  const promptText = isRecordedStale
    ? latest.text
    : state.recordedPrompt || promptSeen?.text || "";
  const last = state.last;
  const endedCleanly =
    last?.type === "assistant" &&
    (last.isAsking === true ||
      (!last.isWaitingOnTool && last.stopReason !== null));
  const grace = last?.isWaitingOnTool
    ? limits.toolGraceMs
    : limits.runningGraceMs;
  return {
    lastAt: last?.at || mtimeMs,
    isStopped: endedCleanly || now - mtimeMs > grace,
    lastAssistantId: state.turnLastId,
    prompt: withoutQuotedReplies(promptText)
      .replace(/\s+/g, " ")
      .slice(0, limits.promptChars),
    promptAt: promptSeen?.at ?? 0,
    lastText: state.turnText,
    question: state.question,
    options: state.options,
    isAsking: last?.isAsking === true,
  };
}

export const hasPrompt = (state: TranscriptState) =>
  state.prompts.length > 0 || state.recordedPrompt !== "";
