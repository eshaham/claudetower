import type { SessionAction, SessionCard } from "../../types";
import { MINUTE_MS } from "./config";

export type AutoFinishMarks = Record<string, number>;

export type Nudge = {
  forTurn: number;
  at: number;
  count: number;
  isDelivered: boolean;
};

export type Nudges = Record<string, Nudge>;

export type AutoFinishStep = "archive" | "nudge" | "wait";

export const MAX_NUDGES = 12;
export const NUDGE_RETRY_MS = 10 * MINUTE_MS;

export const AUTO_FINISH_ACTION: SessionAction = {
  label: "Auto-finish",
  message:
    "Auto-finish (claudetower): take this session the rest of the way on your own with the claudetower:auto-finish skill: finish and verify the work, open or update the PR, then turn on Auto-fix, auto-merge and archive-on-merge for it. I consent to merging this session's PR once its checks pass. Stop and ask me only for what you cannot decide or do yourself.",
};

export const isAutoFinishing = (
  card: Pick<SessionCard, "isAutoFinish" | "verdict">,
) => card.isAutoFinish && card.verdict?.canFinishAlone === true;

export const isAutoFinishPaused = (
  card: Pick<SessionCard, "verdict" | "canArchive">,
) => card.verdict?.canFinishAlone === false && !card.canArchive;

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
    card.isRereading ||
    card.verdict === null ||
    isHandled(nudge, card, now)
  )
    return "wait";
  if (card.canArchive) return "archive";
  if (!card.verdict.canFinishAlone) return "wait";
  if (card.verdict.status === "waiting_on_others" && (nudge?.count ?? 0) > 0)
    return "wait";
  return (nudge?.count ?? 0) >= MAX_NUDGES ? "wait" : "nudge";
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
});
