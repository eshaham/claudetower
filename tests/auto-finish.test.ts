import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionCard, Verdict } from "../types";
import type { Nudge } from "../hooks/lib/auto-finish";
import {
  MAX_NUDGES,
  NUDGE_RETRY_MS,
  autoFinishStepOf,
  isAutoFinishPaused,
  isWaitingOnChildren,
  nudgeAfter,
} from "../hooks/lib/auto-finish";
import { classify } from "../hooks/lib/classify";
import type { CardFacts } from "../hooks/lib/classify";
import { DEFAULT_RANKING } from "../hooks/lib/ranking";

const NOW = 1_000_000_000;
const TURN = NOW - 60_000;

const verdictOf = (overrides: Partial<Verdict> = {}): Verdict => ({
  status: "needs_you",
  kind: "decide",
  waitingFor: "Go-ahead to merge PR",
  followUps: [],
  urgency: 50,
  labels: [],
  isLastMile: true,
  isFinished: false,
  canFinishAlone: true,
  ...overrides,
});

const cardOf = (overrides: Partial<CardFacts> = {}): SessionCard =>
  classify(
    {
      id: "local_a",
      cliId: "cli-a",
      title: "Add a thing",
      project: "proj",
      ticket: "",
      ticketStatus: "",
      ticketPriority: 0,
      prs: [
        {
          number: 7,
          state: "open",
          additions: 1,
          deletions: 1,
          failing: 0,
          pending: 0,
        },
      ],
      uncommittedFiles: 0,
      question: "",
      options: [],
      isRunning: false,
      isScheduled: false,
      ageMs: 60_000,
      lastAt: TURN,
      verdict: verdictOf(),
      isRereading: false,
      isAutoFinish: true,
      childIds: [],
      ...overrides,
    },
    DEFAULT_RANKING,
  );

const nudge = (overrides: Partial<Nudge> = {}): Nudge => ({
  forTurn: TURN,
  at: NOW - 1000,
  count: 1,
  isDelivered: true,
  ...overrides,
});

describe("auto-finish steps", () => {
  it("nudges an idle auto-finish session that can finish alone", () => {
    assert.equal(autoFinishStepOf(cardOf(), undefined, NOW), "nudge");
  });

  it("leaves sessions that are not on auto-finish alone", () => {
    assert.equal(
      autoFinishStepOf(cardOf({ isAutoFinish: false }), undefined, NOW),
      "wait",
    );
  });

  it("waits while the session runs, is being read, or has no reading", () => {
    assert.equal(
      autoFinishStepOf(cardOf({ isRunning: true }), undefined, NOW),
      "wait",
    );
    assert.equal(
      autoFinishStepOf(cardOf({ isRereading: true }), undefined, NOW),
      "wait",
    );
    assert.equal(
      autoFinishStepOf(cardOf({ verdict: null }), undefined, NOW),
      "wait",
    );
  });

  it("waits when the session needs the user", () => {
    const card = cardOf({ verdict: verdictOf({ canFinishAlone: false }) });
    assert.equal(autoFinishStepOf(card, undefined, NOW), "wait");
    assert.equal(card.lane, "answer");
  });

  it("nudges once per turn", () => {
    assert.equal(autoFinishStepOf(cardOf(), nudge(), NOW), "wait");
    assert.equal(
      autoFinishStepOf(cardOf(), nudge({ forTurn: TURN - 1 }), NOW),
      "nudge",
    );
  });

  it("retries a nudge the session did not pick up, after a while", () => {
    const missed = nudge({ isDelivered: false });
    assert.equal(autoFinishStepOf(cardOf(), missed, NOW), "wait");
    assert.equal(
      autoFinishStepOf(cardOf(), missed, NOW + NUDGE_RETRY_MS),
      "nudge",
    );
  });

  it("leaves a nudged session that only waits on its checks to Auto-fix", () => {
    const waiting = cardOf({
      verdict: verdictOf({ status: "waiting_on_others", kind: null }),
    });
    assert.equal(autoFinishStepOf(waiting, undefined, NOW), "nudge");
    assert.equal(
      autoFinishStepOf(waiting, nudge({ forTurn: TURN - 1 }), NOW),
      "wait",
    );
  });

  it("stops nudging after too many turns", () => {
    const many = nudge({ forTurn: TURN - 1, count: MAX_NUDGES });
    assert.equal(autoFinishStepOf(cardOf(), many, NOW), "wait");
  });

  it("archives a finished auto-finish session", () => {
    const card = cardOf({
      prs: [],
      verdict: verdictOf({
        status: "done",
        kind: null,
        isFinished: true,
        canFinishAlone: false,
      }),
    });
    assert.equal(card.canArchive, true);
    assert.equal(autoFinishStepOf(card, undefined, NOW), "archive");
  });

  it("counts a new turn's nudge but not a retry", () => {
    const card = cardOf();
    assert.equal(
      nudgeAfter(nudge({ forTurn: TURN - 1 }), card, "nudge", true, NOW).count,
      2,
    );
    assert.equal(nudgeAfter(nudge(), card, "nudge", true, NOW).count, 1);
  });
});

describe("auto-finish cards", () => {
  it("shows a session finishing on its own as in flight, not in Finish", () => {
    const card = cardOf();
    assert.equal(card.lane, "in-flight");
    assert.equal(card.isFinishing, false);
  });

  it("keeps the usual lane when auto-finish is off", () => {
    const card = cardOf({ isAutoFinish: false });
    assert.equal(card.lane, "answer");
    assert.equal(card.isFinishing, true);
  });
});

describe("auto-finish paused", () => {
  it("is paused when the session cannot finish alone", () => {
    const card = cardOf({ verdict: verdictOf({ canFinishAlone: false }) });
    assert.equal(isAutoFinishPaused(card), true);
    assert.equal(autoFinishStepOf(card, undefined, NOW), "wait");
  });

  it("is not paused when it can finish alone or has no verdict yet", () => {
    assert.equal(isAutoFinishPaused(cardOf()), false);
    assert.equal(isAutoFinishPaused(cardOf({ verdict: null })), false);
  });
});

describe("auto-finish with started sessions", () => {
  const finished = (childIds: string[]) =>
    cardOf({
      prs: [],
      childIds,
      verdict: verdictOf({
        status: "done",
        kind: null,
        isFinished: true,
        canFinishAlone: false,
      }),
    });

  it("waits to archive while a started session is still open", () => {
    const card = finished(["local_child"]);
    assert.equal(isWaitingOnChildren(card), true);
    assert.equal(isAutoFinishPaused(card), false);
    assert.equal(autoFinishStepOf(card, undefined, NOW), "wait");
  });

  it("archives once every started session is archived", () => {
    assert.equal(autoFinishStepOf(finished([]), undefined, NOW), "archive");
  });
});
