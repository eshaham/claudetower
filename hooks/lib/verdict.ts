import type { EngineInterface } from "claude-code";

import type { AskKind, Urgency, Verdict, VerdictStatus } from "../../types";
import {
  HOUR_MS,
  MAX_FOLLOW_UPS,
  STORE_KEYS,
  VERDICT_MODEL,
  log,
} from "./config";
import type { Live, SessionFile, TranscriptEnd } from "./transcript";
import { digestOf, startedFrom, transcriptPath } from "./transcript";

export type StoredVerdict = { key: string; verdict: Verdict };
export type VerdictStore = Record<string, StoredVerdict>;

const KINDS: AskKind[] = ["do", "decide", "review"];
const URGENCIES: Urgency[] = ["high", "normal", "low"];
const STATUSES: VerdictStatus[] = ["needs_you", "waiting_on_others", "done"];

const SESSION_RULES = `You read how a Claude Code session ended and tell its user where it stands.
Answer with one JSON object and nothing else:
{"status": "needs_you" | "waiting_on_others" | "done", "kind": "do" | "decide" | "review" | null, "urgency": "high" | "normal" | "low", "waitingFor": string, "followUps": string[], "isFinished": boolean}
- needs_you: the session cannot usefully go on until the user acts, answers, decides or reviews. kind says which: do = act outside the session (create a credential, set a secret, run or approve something elsewhere); decide = a choice, approval or go-ahead; review = look at something the session produced.
- waiting_on_others: it waits on CI, a bot review, a deploy, another session, a teammate or a later time.
- done: the work is finished and nothing is pending.
- kind is null unless status is needs_you.
- Use sessionHistory (the first ask, your user's later messages, and the session's earlier replies) to understand what the session is for and how much is at stake; sessionsLastWords say where it stands now.
- The session's last words can be overtaken by what happened after them. sessionsStartedFromThis lists sessions the user started from this one (for example by clicking a proposed-session card), and openPullRequests is the live PR state. If the ask was to start a session and one was started, or to merge a PR that is no longer open, that ask is done.
- If what the session waits for was due at a time that is already past (compare with now), it is not waiting anymore: the user should check the outcome, so it is needs_you with kind review.
- urgency is about now: something that has waited for days with no consequence is not high, whatever its words say.
- urgency: high when production, members, money or security are affected right now, a deadline is today, or other people are blocked; low for exploration, cleanup or nice-to-haves; normal otherwise.
- waitingFor: at most 12 words. What it waits for; for done, what it achieved.
- followUps: up to 3 things the user can do right now that need this session's work, at most 15 words each (merge a ready PR, ask a reviewer). Never a step that depends on something that has not happened yet; that belongs in waitingFor. Never "archive this session". Empty when there are none.
- isFinished: true when this session has nothing left to do and the user could archive it now: its task is complete, any PR it opened has merged or been closed, and nothing it is waiting for will bring it back. A session that hands remaining work to another session, ticket or person is finished. When in doubt, false.`;

const RUN_RULES = `You read how one run of a recurring scheduled Claude Code task ended. Routine output (a report, a digest, a list of findings or emails for the user) is the task working as designed, not a problem.
Answer with one JSON object and nothing else:
{"problem": boolean, "summary": string, "fix": string[]}
- problem: true only when the run itself failed, errored, could not finish, was blocked (missing access, expired login, broken tool) or produced broken output that someone has to fix.
- summary: at most 12 words. The problem when there is one; otherwise what the run did.
- fix: up to 3 things the user must do to fix the problem, at most 15 words each. Empty when there is no problem.`;

export const SILENT_STOP: Verdict = {
  status: "needs_you",
  kind: "review",
  waitingFor: "Stopped without a closing message",
  followUps: [],
  urgency: "normal",
  isFinished: false,
};

const jsonObjectOf = <T>(text: string): T | null => {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  return json ? (JSON.parse(json) as T) : null;
};

const stringsOf = (value: unknown) =>
  Array.isArray(value) ? value.map(String).slice(0, MAX_FOLLOW_UPS) : [];

const parseSessionVerdict = (text: string): Verdict | null => {
  const raw = jsonObjectOf<Partial<Verdict>>(text);
  if (!raw?.status || !STATUSES.includes(raw.status)) return null;
  const kind = raw.kind && KINDS.includes(raw.kind) ? raw.kind : null;
  return {
    status: raw.status,
    kind: raw.status === "needs_you" ? (kind ?? "decide") : null,
    waitingFor: String(raw.waitingFor ?? ""),
    followUps: stringsOf(raw.followUps),
    urgency:
      raw.urgency && URGENCIES.includes(raw.urgency) ? raw.urgency : "normal",
    isFinished: raw.isFinished === true,
  };
};

const parseRunVerdict = (text: string): Verdict | null => {
  const raw = jsonObjectOf<{
    problem?: boolean;
    summary?: string;
    fix?: unknown;
  }>(text);
  if (typeof raw?.problem !== "boolean") return null;
  return {
    status: raw.problem ? "needs_you" : "done",
    kind: raw.problem ? "do" : null,
    waitingFor: String(raw.summary ?? ""),
    followUps: raw.problem ? stringsOf(raw.fix) : [],
    urgency: "normal",
    isFinished: false,
  };
};

const PROFILES = {
  session: { rules: SESSION_RULES, parse: parseSessionVerdict },
  run: { rules: RUN_RULES, parse: parseRunVerdict },
};

const profileOf = (s: SessionFile) =>
  s.scheduledTaskId ? PROFILES.run : PROFILES.session;

export const openPrNumbers = (s: SessionFile) =>
  (s.prs ?? []).filter((pr) => pr.state === "OPEN").map((pr) => pr.prNumber);

export const verdictKeyOf = ({ s, end }: Live) =>
  [
    end.lastAssistantId,
    `started${startedFrom.get(s.sessionId)?.length ?? 0}`,
    `open${openPrNumbers(s).length}`,
    s.scheduledTaskId ? "run" : "",
  ].join(":");

export async function readVerdicts($: EngineInterface) {
  return ((await $.store.get(STORE_KEYS.verdicts)) ?? {}) as VerdictStore;
}

export async function writeVerdicts(
  $: EngineInterface,
  fresh: VerdictStore,
  liveIds: Set<string>,
) {
  const stored = await readVerdicts($);
  const merged = Object.fromEntries(
    Object.entries({ ...stored, ...fresh }).filter(([id]) => liveIds.has(id)),
  );
  await $.store.set(STORE_KEYS.verdicts, merged);
}

async function promptOf(
  $: EngineInterface,
  s: SessionFile,
  end: TranscriptEnd,
) {
  return JSON.stringify({
    title: s.title ?? "",
    openPullRequests: openPrNumbers(s),
    uncommittedFiles: end.uncommittedFiles,
    sessionsStartedFromThis: startedFrom.get(s.sessionId) ?? [],
    userAskedLast: end.prompt,
    sessionsLastWords: end.lastText,
    endedHoursAgo: Math.round((Date.now() - end.lastAt) / HOUR_MS),
    now: new Date().toISOString(),
    sessionHistory: await digestOf($, transcriptPath(s)),
  });
}

export async function judge($: EngineInterface, { s, end }: Live) {
  const profile = profileOf(s);
  const answer = await $.model.complete({
    model: VERDICT_MODEL,
    system: [{ text: profile.rules, cache: true }],
    prompt: await promptOf($, s, end),
    maxTokens: 500,
  });
  if (!answer.isAnswered) {
    log($, `could not read "${s.title}": ${answer.reason}`);
    return null;
  }
  const verdict = profile.parse(answer.text);
  if (!verdict) log($, `unusable verdict for "${s.title}"`);
  return verdict;
}
