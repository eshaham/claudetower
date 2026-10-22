export type VerdictStatus = "needs_you" | "waiting_on_others" | "done";

export type AskKind = "do" | "decide" | "review";

export type Priority = "critical" | "high" | "normal" | "low";

export type Verdict = {
  status: VerdictStatus;
  kind: AskKind | null;
  waitingFor: string;
  followUps: string[];
  priority: Priority;
  isFinished: boolean;
};

export type TicketInfo = {
  priority: number;
  status: string;
  isOpen: boolean;
  checkedAt: number;
};

export type PrState = "open" | "draft" | "merged" | "closed";

export type PrBadge = {
  number: number;
  state: PrState;
  additions: number;
  deletions: number;
  failing: number;
  pending: number;
};

export type SessionAction = { label: string; message: string };

export type LaneId =
  | "answer"
  | "act"
  | "review"
  | "follow-up"
  | "in-flight"
  | "wrap-up";

export type SessionCard = {
  id: string;
  cliId: string;
  title: string;
  project: string;
  ticket: string;
  ticketStatus: string;
  ticketPriority: number;
  prs: PrBadge[];
  uncommittedFiles: number;
  lastAsk: string;
  lastAskAgoMs: number;
  lastReply: string;
  question: string;
  options: SessionAction[];
  isRunning: boolean;
  isScheduled: boolean;
  ageMs: number;
  lastAt: number;
  verdict: Verdict | null;
  isRereading: boolean;
  lane: LaneId;
  canArchive: boolean;
  score: number;
};

export type CardHitMessage = {
  kind: "open" | "toggle" | "compose";
  id: string;
};

declare module "claude-code" {
  interface PluginState {
    claudtower: {
      cards: SessionCard[];
      isOpen: boolean;
      previewed: string;
      pending: Record<string, number>;
      composing: string;
      draft: string;
    };
  }
}
