import type { EngineInterface } from "claude-code";

import type { AskKind, Priority, Verdict, VerdictStatus } from "../../types";
import {
  HOUR_MS,
  MAX_FOLLOW_UPS,
  STORE_KEYS,
  VERDICT_MODEL,
  log,
  instanceKey,
} from "./config";
import type { ProjectProfile } from "./project";
import type { Live, SessionFile, TranscriptEnd } from "./transcript";
import { digestOf, startedFrom, transcriptPath } from "./transcript";

export type StoredVerdict = { key: string; verdict: Verdict };
export type VerdictStore = Record<string, StoredVerdict>;

const KINDS: AskKind[] = ["do", "decide", "review"];
const PRIORITIES: Priority[] = ["critical", "high", "normal", "low"];
const STATUSES: VerdictStatus[] = ["needs_you", "waiting_on_others", "done"];

const SESSION_RULES = `You read how a Claude Code session ended and tell its user where it stands.
Answer with one JSON object and nothing else:
{"status": "needs_you" | "waiting_on_others" | "done", "kind": "do" | "decide" | "review" | null, "priority": "critical" | "high" | "normal" | "low", "waitingFor": string, "followUps": string[], "isFinished": boolean}
- needs_you: the session cannot usefully go on until the user acts, answers, decides or reviews. kind says which: do = act outside the session (create a credential, set a secret, run or approve something elsewhere); decide = a choice, approval or go-ahead; review = look at something the session produced.
- waiting_on_others: it waits on CI, a bot review, a deploy, another session, a teammate or a later time.
- done: the work is finished and nothing is pending.
- kind is null unless status is needs_you.
- Use sessionHistory (the first ask, your user's later messages, and the session's earlier replies) to understand what the session is for and how much is at stake; sessionsLastWords say where it stands now.
- The session's last words can be overtaken by what happened after them. sessionsStartedFromThis lists sessions the user started from this one (for example by clicking a proposed-session card), and openPullRequests is the live PR state. If the ask was to start a session and one was started, or to merge a PR that is no longer open, that ask is done.
- If what the session waits for was due at a time that is already past (compare with now), it is not waiting anymore: the user should check the outcome, so it is needs_you with kind review.
- priority is how much the task matters now, using project.criticalSignals and project.summary to judge what is serious for this project:
  - critical: a P0 emergency happening now: a production service or app down or crashing for users (not a single error), data loss, a security incident, or something blocking the rest of the team, such as the main branch's CI broken or deploys blocked.
  - high: real impact soon or on part of the users, a deadline today, or a teammate waiting on this.
  - low: exploration, cleanup or nice-to-haves.
  - normal: everything else.
- priority is about now: something that has waited for days with no consequence is not critical or high, whatever its words say.
- suggestedActions are the options the session itself offered the user at the end, if any; use them to understand what it is asking.
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
  priority: "normal",
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
    priority:
      raw.priority && PRIORITIES.includes(raw.priority)
        ? raw.priority
        : "normal",
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
    priority: raw.problem ? "high" : "normal",
    isFinished: false,
  };
};

const PROFILES = {
  session: { rules: SESSION_RULES, parse: parseSessionVerdict },
  run: { rules: RUN_RULES, parse: parseRunVerdict },
};

const profileOf = (s: SessionFile) =>
  s.scheduledTaskId ? PROFILES.run : PROFILES.session;

export type VerdictContext = {
  openPrs: number[];
  project: ProjectProfile | undefined;
};

export const verdictKeyOf = ({ s, end }: Live, context: VerdictContext) =>
  [
    end.lastAssistantId,
    `started${startedFrom.get(s.sessionId)?.length ?? 0}`,
    `open${context.openPrs.join(",")}`,
    `project${context.project?.checkedAt ?? 0}`,
    s.scheduledTaskId ? "run" : "",
  ].join(":");

export async function readVerdicts($: EngineInterface) {
  return ((await $.store.get(instanceKey(STORE_KEYS.verdicts))) ??
    {}) as VerdictStore;
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
  await $.store.set(instanceKey(STORE_KEYS.verdicts), merged);
}

async function promptOf(
  $: EngineInterface,
  s: SessionFile,
  end: TranscriptEnd,
  context: VerdictContext,
) {
  return JSON.stringify({
    title: s.title ?? "",
    project: context.project && {
      summary: context.project.summary,
      criticalSignals: context.project.criticalSignals,
      services: context.project.services,
    },
    openPullRequests: context.openPrs,
    suggestedActions: end.question
      ? { question: end.question, options: end.options }
      : null,
    uncommittedFiles: end.uncommittedFiles,
    sessionsStartedFromThis: startedFrom.get(s.sessionId) ?? [],
    userAskedLast: end.prompt,
    sessionsLastWords: end.lastText,
    endedHoursAgo: Math.round((Date.now() - end.lastAt) / HOUR_MS),
    now: new Date().toISOString(),
    sessionHistory: await digestOf($, transcriptPath(s)),
  });
}

export async function judge(
  $: EngineInterface,
  { s, end }: Live,
  context: VerdictContext,
) {
  const profile = profileOf(s);
  const answer = await $.model.complete({
    model: VERDICT_MODEL,
    system: [{ text: profile.rules, cache: true }],
    prompt: await promptOf($, s, end, context),
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
