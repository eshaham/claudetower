import type { SessionAction, SessionCard } from "../../types";
import { MINUTE_MS } from "./config";

export type AutoFinishMarks = Record<string, number>;

export type Nudge = {
  forTurn: number;
  at: number;
  count: number;
  isDelivered: boolean;
  hasStarted?: boolean;
  hasTriedArchive?: boolean;
};

export type Nudges = Record<string, Nudge>;

export type AutoFinishStep = "archive" | "nudge" | "wait";

export const MAX_NUDGES = 12;
export const NUDGE_RETRY_MS = 10 * MINUTE_MS;

export const AUTO_FINISH_ACTION: SessionAction = {
  label: "Auto-finish",
  message:
    "Auto-finish (claudetower): take this session the rest of the way on your own with the claudetower:auto-finish skill. Start by telling me in one line that auto-finish is on and what is left. If you need my answer on anything that changes what you do next, ask me again with the AskUserQuestion tool, even if you asked before. Don't ask me whether to keep waiting: if all that is left is CI or a review that is already requested, turn on auto-merge if it isn't on yet, say in one line what it waits on, and end the turn. Otherwise finish and verify the work, open or update the PR, then turn on Auto-fix, auto-merge and archive-on-merge for it. I consent to merging this session's PR once its checks pass. Stop and ask me only for what you cannot decide or do yourself.",
};

export const isAutoFinishing = (
  card: Pick<SessionCard, "isAutoFinish" | "verdict">,
) => card.isAutoFinish && card.verdict?.canFinishAlone === true;

export const isAutoFinishPaused = (
  card: Pick<
    SessionCard,
    "verdict" | "canArchive" | "isRunning" | "isScheduled" | "isRereading"
  >,
) =>
  !card.isRunning &&
  !card.isScheduled &&
  !card.isRereading &&
  !card.canArchive &&
  card.verdict?.status === "needs_you" &&
  !card.verdict.canFinishAlone;

export const isWaitingOnChildren = (
  card: Pick<SessionCard, "canArchive" | "childIds">,
) => card.canArchive && card.childIds.length > 0;

const isHandled = (nudge: Nudge | undefined, card: SessionCard, now: number) =>
  nudge?.forTurn === card.lastAt &&
  (nudge.isDelivered || now - nudge.at < NUDGE_RETRY_MS);

export const autoFinishStepOf = (
  card: SessionCard,
  nudge: Nudge | undefined,
  now: number,
): AutoFinishStep => {
  if (
    !card.isAutoFinish ||
    card.isRunning ||
    card.isScheduled ||
    isHandled(nudge, card, now)
  )
    return "wait";
  if (card.canArchive && !isWaitingOnChildren(card))
    return nudge?.hasTriedArchive ? "wait" : "archive";
  if (!nudge?.hasStarted) return "nudge";
  if (card.isRereading || card.verdict === null || card.canArchive)
    return "wait";
  if (!card.verdict.canFinishAlone) return "wait";
  if (card.verdict.status === "waiting_on_others" && nudge.count > 0)
    return "wait";
  return nudge.count >= MAX_NUDGES ? "wait" : "nudge";
};

export const nudgeAfter = (
  previous: Nudge | undefined,
  card: SessionCard,
  step: AutoFinishStep,
  isDelivered: boolean,
  now: number,
): Nudge => ({
  forTurn: card.lastAt,
  at: now,
  count:
    (previous?.count ?? 0) +
    (step === "nudge" && previous?.forTurn !== card.lastAt ? 1 : 0),
  isDelivered,
  hasStarted:
    previous?.hasStarted === true || (step === "nudge" && isDelivered),
  hasTriedArchive: previous?.hasTriedArchive === true || step === "archive",
});
