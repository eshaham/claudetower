import type {
  LaneId,
  PrBadge,
  SessionCard,
  Urgency,
  Verdict,
} from "../../types";
import { HOUR_MS } from "./config";
import { isOpenPr } from "./enrich";

export type CardFacts = Omit<SessionCard, "lane" | "canArchive" | "score">;

export const LANES: {
  id: LaneId;
  title: string;
  hint: string;
  color: string;
  boost: number;
}[] = [
  {
    id: "answer",
    title: "Answer",
    hint: "A question or a go-ahead only you can give",
    color: "suggestion",
    boost: 60,
  },
  {
    id: "act",
    title: "Act",
    hint: "Something you do outside the session",
    color: "error",
    boost: 60,
  },
  {
    id: "review",
    title: "Review",
    hint: "Look at what it produced",
    color: "warning",
    boost: 60,
  },
  {
    id: "follow-up",
    title: "Follow up",
    hint: "Its part is done; a next step is yours",
    color: "claude",
    boost: 40,
  },
  {
    id: "in-flight",
    title: "In flight",
    hint: "Running, or waiting on CI, a bot or someone else",
    color: "subtle",
    boost: 0,
  },
  {
    id: "wrap-up",
    title: "Wrap up",
    hint: "Finished; archive, or clear what is left",
    color: "success",
    boost: 0,
  },
];

const LANE_BY_ID = Object.fromEntries(LANES.map((lane) => [lane.id, lane]));
export const laneInfo = (id: LaneId) => LANE_BY_ID[id]!;

const RECENCY_WEIGHT = 100;
const RECENCY_HALF_LIFE_HOURS = 48;
const TICKET_PRIORITY_BOOST: Record<number, number> = { 1: 80, 2: 50, 3: 20 };
const URGENCY_BOOST: Record<Urgency, number> = {
  high: 80,
  normal: 0,
  low: -30,
};

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

export const classify = (facts: CardFacts): SessionCard => {
  const canArchive = canArchiveOf(facts);
  const lane = laneOf(facts, canArchive);
  const score =
    RECENCY_WEIGHT * 0.5 ** (facts.ageMs / HOUR_MS / RECENCY_HALF_LIFE_HOURS) +
    (TICKET_PRIORITY_BOOST[facts.ticketPriority] ?? 0) +
    (facts.verdict ? URGENCY_BOOST[facts.verdict.urgency] : 0) +
    laneInfo(lane).boost;
  return { ...facts, lane, canArchive, score };
};

export const isAskingYou = (card: SessionCard) => laneInfo(card.lane).boost > 0;

export const belongsInList = (card: SessionCard) =>
  !card.isRunning &&
  card.verdict !== null &&
  !card.isRereading &&
  !(card.isScheduled && card.verdict.status === "done");

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
