export type VerdictStatus = "needs_you" | "waiting_on_others" | "done";

export type AskKind = "do" | "decide" | "review";

export type Verdict = {
  status: VerdictStatus;
  kind: AskKind | null;
  waitingFor: string;
  followUps: string[];
  urgency: number;
  labels: string[];
  isLastMile: boolean;
  isFinished: boolean;
};

export type BandBadge = { name: string; color?: string };

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
  "answer" | "act" | "review" | "follow-up" | "in-flight" | "wrap-up";

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
  isFinishing: boolean;
  band: BandBadge | null;
  score: number;
};

export type CardHitMessage = {
  kind: "open" | "toggle" | "compose";
  id: string;
};

export type RankingToolInput = {
  action: "show" | "preview" | "save";
  ranking?: Record<string, unknown>;
  scenarios?: {
    name: string;
    description: string;
    ageHours?: number;
    lane?: LaneId;
  }[];
};

declare module "claude-code" {
  interface McpToolInputs {
    mcp__claudetower__ranking: RankingToolInput;
  }
  interface PluginState {
    claudetower: {
      cards: SessionCard[];
      isOpen: boolean;
      previewed: string;
      pending: Record<string, number>;
      composing: string;
      draft: string;
    };
  }
}
