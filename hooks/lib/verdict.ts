import type { EngineInterface } from "claude-code";

import type { AskKind, TicketInfo, Verdict, VerdictStatus } from "../../types";
import {
  HOUR_MS,
  MAX_FOLLOW_UPS,
  STORE_KEYS,
  VERDICT_MODEL,
  log,
  instanceKey,
} from "./config";
import type { ProjectProfile } from "./project";
import type { Ranking } from "./ranking";
import { allLabelsOf } from "./ranking";
import type { Live, SessionFile, TranscriptEnd } from "./transcript";
import { digestOf, startedFrom, transcriptPath } from "./transcript";

export type StoredVerdict = { key: string; verdict: Verdict };
export type VerdictStore = Record<string, StoredVerdict>;

const KINDS: AskKind[] = ["do", "decide", "review"];
const STATUSES: VerdictStatus[] = ["needs_you", "waiting_on_others", "done"];
const DEFAULT_URGENCY = 50;
const RUN_PROBLEM_URGENCY = 70;

const SESSION_RULES = `You read how a Claude Code session ended and tell its user where it stands.
Answer with one JSON object and nothing else:
{"status": "needs_you" | "waiting_on_others" | "done", "kind": "do" | "decide" | "review" | null, "urgency": number, "labels": string[], "waitingFor": string, "followUps": string[], "isLastMile": boolean, "isFinished": boolean}
- needs_you: the session cannot usefully go on until the user acts, answers, decides or reviews. kind says which: do = act outside the session (create a credential, set a secret, run or approve something elsewhere); decide = a choice, approval or go-ahead; review = look at something the session produced.
- waiting_on_others: it waits on CI, a bot review, a deploy, another session, a teammate or a later time.
- done: the work is finished and nothing is pending.
- kind is null unless status is needs_you.
- Use sessionHistory (the first ask, your user's later messages, and the session's earlier replies) to understand what the session is for and how much is at stake; sessionsLastWords say where it stands now.
- The session's last words can be overtaken by what happened after them. sessionsStartedFromThis lists sessions the user started from this one (for example by clicking a proposed-session card), and openPullRequests is the live PR state. If the ask was to start a session and one was started, or to merge a PR that is no longer open, that ask is done.
- If what the session waits for was due at a time that is already past (compare with now), it is not waiting anymore: the user should check the outcome, so it is needs_you with kind review.
- urgency: 0 to 100, how much the task matters now. Use project.criticalSignals and project.summary to judge what is serious for this project. Guidance:
  - 90-100: something live is broken for users, data is at risk, or there is a security incident.
  - 70-89: real impact soon or for some users, a deadline today, or someone else is waiting on the user.
  - 40-69: everyday work.
  - 0-39: exploration, cleanup, nice-to-haves.
- An open ticket linked to the session (ticket) is evidence of urgency, weighed with everything else. A closed ticket says nothing about urgency.
- Age alone does not lower urgency: lower it only when the wait has shown that nothing is at stake, or the problem resolved itself.
- suggestedActions are the options the session itself offered the user at the end, if any; use them to understand what it is asking.
- waitingFor: at most 12 words. What it waits for; for done, what it achieved.
- followUps: up to 3 things the user can do right now that need this session's work, at most 15 words each (merge a ready PR, ask a reviewer). Never a step that depends on something that has not happened yet; that belongs in waitingFor. Never "archive this session". Empty when there are none.
- isLastMile: true when the work is done or nearly done and only a small final step from the user is left: merge a ready PR, answer a last yes/no, glance at a finished change. False when real work remains.
- isFinished: true when this session has nothing left to do and the user could archive it now: its task is complete, any PR it opened has merged or been closed, and nothing it is waiting for will bring it back. A session that hands remaining work to another session, ticket or person is finished. When in doubt, false.`;

const urgencyRulesOf = (ranking: Ranking) =>
  ranking.rules.length === 0
    ? ""
    : `\nThe user's own urgency rules. Where they and the guidance above disagree, follow these:\n${ranking.rules.map((rule) => `- ${rule.rule}`).join("\n")}`;

const labelRulesOf = (ranking: Ranking) =>
  `\nlabels: every name from this list that applies, and no other names. Empty when none apply.\n${allLabelsOf(
    ranking,
  )
    .map((label) => `- ${label.name}: ${label.means}`)
    .join("\n")}`;

export const sessionRulesOf = (ranking: Ranking) =>
  `${SESSION_RULES}${urgencyRulesOf(ranking)}${labelRulesOf(ranking)}`;

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
  urgency: DEFAULT_URGENCY,
  labels: [],
  isLastMile: false,
  isFinished: false,
};

const jsonObjectOf = <T>(text: string): T | null => {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  return json ? (JSON.parse(json) as T) : null;
};

const stringsOf = (value: unknown) =>
  Array.isArray(value) ? value.map(String).slice(0, MAX_FOLLOW_UPS) : [];

const urgencyOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : DEFAULT_URGENCY;

const labelsOf = (value: unknown, ranking: Ranking) => {
  const known = new Set(allLabelsOf(ranking).map((label) => label.name));
  return Array.isArray(value)
    ? [...new Set(value.map(String).filter((name) => known.has(name)))]
    : [];
};

const parseSessionVerdict = (
  text: string,
  ranking: Ranking,
): Verdict | null => {
  const raw = jsonObjectOf<Partial<Record<keyof Verdict, unknown>>>(text);
  const status = raw?.status as VerdictStatus | undefined;
  if (!raw || !status || !STATUSES.includes(status)) return null;
  const kind = KINDS.includes(raw.kind as AskKind)
    ? (raw.kind as AskKind)
    : null;
  return {
    status,
    kind: status === "needs_you" ? (kind ?? "decide") : null,
    waitingFor: String(raw.waitingFor ?? ""),
    followUps: stringsOf(raw.followUps),
    urgency: urgencyOf(raw.urgency),
    labels: labelsOf(raw.labels, ranking),
    isLastMile: raw.isLastMile === true,
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
    urgency: raw.problem ? RUN_PROBLEM_URGENCY : 0,
    labels: [],
    isLastMile: false,
    isFinished: false,
  };
};

const isRun = (s: SessionFile) => Boolean(s.scheduledTaskId);

export type VerdictContext = {
  openPrs: number[];
  project: ProjectProfile | undefined;
  ticket: (TicketInfo & { id: string }) | null;
  ranking: Ranking;
  rankingFingerprint: string;
};

export const verdictKeyOf = ({ s, end }: Live, context: VerdictContext) =>
  [
    end.lastAssistantId,
    `started${startedFrom.get(s.sessionId)?.length ?? 0}`,
    `open${context.openPrs.join(",")}`,
    `project${context.project?.checkedAt ?? 0}`,
    isRun(s)
      ? "run"
      : `ticket${context.ticket ? `${context.ticket.priority}${context.ticket.isOpen ? "o" : "c"}` : ""}:rank${context.rankingFingerprint}`,
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
    ticket: context.ticket && {
      id: context.ticket.id,
      priority: context.ticket.priority,
      status: context.ticket.status,
      isOpen: context.ticket.isOpen,
    },
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

async function complete(
  $: EngineInterface,
  rules: string,
  prompt: string,
  title: string,
) {
  const answer = await $.model.complete({
    model: VERDICT_MODEL,
    system: [{ text: rules, cache: true }],
    prompt,
    maxTokens: 500,
  });
  if (!answer.isAnswered) {
    log($, `could not read "${title}": ${answer.reason}`);
    return null;
  }
  return answer.text;
}

export async function judge(
  $: EngineInterface,
  { s, end }: Live,
  context: VerdictContext,
) {
  const text = await complete(
    $,
    isRun(s) ? RUN_RULES : sessionRulesOf(context.ranking),
    await promptOf($, s, end, context),
    s.title ?? "",
  );
  if (text === null) return null;
  const verdict = isRun(s)
    ? parseRunVerdict(text)
    : parseSessionVerdict(text, context.ranking);
  if (!verdict) log($, `unusable verdict for "${s.title}"`);
  return verdict;
}

export async function judgeScenario(
  $: EngineInterface,
  ranking: Ranking,
  scenario: string,
) {
  const text = await complete(
    $,
    sessionRulesOf(ranking),
    JSON.stringify({
      note: "A described scenario, not a real transcript. Read it as the session's history and last words.",
      scenario,
      now: new Date().toISOString(),
    }),
    scenario.slice(0, 40),
  );
  return text === null ? null : parseSessionVerdict(text, ranking);
}
