import type { LaneId, PrBadge, SessionCard, Verdict } from "../../types";
import { HOUR_MS } from "./config";
import { isOpenPr } from "./enrich";
import type { Ranking } from "./ranking";
import { bandOf } from "./ranking";

export type CardFacts = Omit<
  SessionCard,
  "lane" | "canArchive" | "isFinishing" | "band" | "score"
>;

export const LANES: {
  id: LaneId;
  title: string;
  hint: string;
  color: string;
  asksYou: boolean;
}[] = [
  {
    id: "answer",
    title: "Answer",
    hint: "A question or a go-ahead only you can give",
    color: "suggestion",
    asksYou: true,
  },
  {
    id: "act",
    title: "Act",
    hint: "Something you do outside the session",
    color: "error",
    asksYou: true,
  },
  {
    id: "review",
    title: "Review",
    hint: "Look at what it produced",
    color: "warning",
    asksYou: true,
  },
  {
    id: "follow-up",
    title: "Follow up",
    hint: "Its part is done; a next step is yours",
    color: "claude",
    asksYou: true,
  },
  {
    id: "in-flight",
    title: "In flight",
    hint: "Running, or waiting on CI, a bot or someone else",
    color: "subtle",
    asksYou: false,
  },
  {
    id: "wrap-up",
    title: "Wrap up",
    hint: "Finished; archive, or clear what is left",
    color: "success",
    asksYou: false,
  },
];

const LANE_BY_ID = Object.fromEntries(LANES.map((lane) => [lane.id, lane]));
export const laneInfo = (id: LaneId) => LANE_BY_ID[id]!;

const UNREAD_URGENCY = 50;

const followUpOf = (verdict: Verdict | null) =>
  verdict && verdict.status !== "needs_you" ? (verdict.followUps[0] ?? "") : "";

const needsYou = (facts: CardFacts) =>
  !facts.isRunning &&
  (facts.verdict?.status === "needs_you" || followUpOf(facts.verdict) !== "");

const hasOpenPr = (prs: PrBadge[]) => prs.some((pr) => isOpenPr(pr.state));

const canArchiveOf = (facts: CardFacts) =>
  !facts.isRunning &&
  !facts.isScheduled &&
  facts.verdict?.isFinished === true &&
  !needsYou(facts) &&
  facts.uncommittedFiles === 0 &&
  !hasOpenPr(facts.prs);

const laneOf = (facts: CardFacts, canArchive: boolean): LaneId => {
  const verdict = facts.verdict;
  if (facts.isRunning) return "in-flight";
  if (verdict?.status === "needs_you")
    return verdict.kind === "do"
      ? "act"
      : verdict.kind === "review"
        ? "review"
        : "answer";
  if (followUpOf(verdict) !== "") return "follow-up";
  if (!canArchive && verdict?.status === "waiting_on_others")
    return "in-flight";
  return "wrap-up";
};

export const recencyOf = (ranking: Ranking, ageMs: number) =>
  ranking.recency.floor +
  (1 - ranking.recency.floor) *
    0.5 ** (ageMs / HOUR_MS / ranking.recency.halfLifeHours);

export const classify = (facts: CardFacts, ranking: Ranking): SessionCard => {
  const canArchive = canArchiveOf(facts);
  const lane = laneOf(facts, canArchive);
  const urgency = facts.verdict?.urgency ?? UNREAD_URGENCY;
  const band = bandOf(ranking, urgency);
  return {
    ...facts,
    lane,
    canArchive,
    isFinishing:
      !facts.isRunning &&
      !facts.isScheduled &&
      (canArchive || facts.verdict?.isLastMile === true),
    band:
      facts.verdict && band.color
        ? { name: band.name, color: band.color }
        : null,
    score: urgency * recencyOf(ranking, facts.ageMs) * ranking.lanes[lane],
  };
};

export const isAskingYou = (card: SessionCard) => laneInfo(card.lane).asksYou;

export const belongsInList = (card: SessionCard, ranking: Ranking) =>
  !card.isRunning &&
  card.verdict !== null &&
  !card.isRereading &&
  !(
    card.isScheduled &&
    ranking.scheduledTasks === "problems-only" &&
    card.verdict.status === "done"
  );

export const isUnread = (card: SessionCard) =>
  !card.isRunning && card.verdict === null;

export const reasonOf = (card: SessionCard) => {
  if (card.isRunning) return "Working now";
  const verdict = card.verdict;
  if (verdict?.status === "needs_you") return verdict.waitingFor;
  const followUp = followUpOf(verdict);
  if (followUp !== "") return followUp;
  const blockers = [
    hasOpenPr(card.prs) ? "PR still open" : "",
    card.uncommittedFiles > 0
      ? `${card.uncommittedFiles} uncommitted files`
      : "",
  ].filter(Boolean);
  const said = verdict?.waitingFor ?? "";
  return blockers.length > 0 ? `${said} · ${blockers.join(", ")}` : said;
};

export const badgeOf = (card: SessionCard) =>
  card.isRunning || card.lane === "wrap-up" ? null : laneInfo(card.lane);
