import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionCard, Verdict } from "../types";
import type { Nudge } from "../hooks/lib/auto-pilot";
import {
  MAX_NUDGES,
  NUDGE_RETRY_MS,
  autoPilotStepOf,
  nudgeAfter,
} from "../hooks/lib/auto-pilot";
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
      lastAsk: "",
      lastAskAgoMs: 0,
      lastReply: "",
      question: "",
      options: [],
      isRunning: false,
      isScheduled: false,
      ageMs: 60_000,
      lastAt: TURN,
      verdict: verdictOf(),
      isRereading: false,
      isAutoPilot: true,
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

describe("auto-pilot steps", () => {
  it("nudges an idle auto-pilot session that can finish alone", () => {
    assert.equal(autoPilotStepOf(cardOf(), undefined, NOW), "nudge");
  });

  it("leaves sessions that are not on auto-pilot alone", () => {
    assert.equal(
      autoPilotStepOf(cardOf({ isAutoPilot: false }), undefined, NOW),
      "wait",
    );
  });

  it("waits while the session runs, is being read, or has no reading", () => {
    assert.equal(
      autoPilotStepOf(cardOf({ isRunning: true }), undefined, NOW),
      "wait",
    );
    assert.equal(
      autoPilotStepOf(cardOf({ isRereading: true }), undefined, NOW),
      "wait",
    );
    assert.equal(
      autoPilotStepOf(cardOf({ verdict: null }), undefined, NOW),
      "wait",
    );
  });

  it("waits when the session needs the user", () => {
    const card = cardOf({ verdict: verdictOf({ canFinishAlone: false }) });
    assert.equal(autoPilotStepOf(card, undefined, NOW), "wait");
    assert.equal(card.lane, "answer");
  });

  it("nudges once per turn", () => {
    assert.equal(autoPilotStepOf(cardOf(), nudge(), NOW), "wait");
    assert.equal(
      autoPilotStepOf(cardOf(), nudge({ forTurn: TURN - 1 }), NOW),
      "nudge",
    );
  });

  it("retries a nudge the session did not pick up, after a while", () => {
    const missed = nudge({ isDelivered: false });
    assert.equal(autoPilotStepOf(cardOf(), missed, NOW), "wait");
    assert.equal(
      autoPilotStepOf(cardOf(), missed, NOW + NUDGE_RETRY_MS),
      "nudge",
    );
  });

  it("leaves a nudged session that only waits on its checks to Auto-fix", () => {
    const waiting = cardOf({
      verdict: verdictOf({ status: "waiting_on_others", kind: null }),
    });
    assert.equal(autoPilotStepOf(waiting, undefined, NOW), "nudge");
    assert.equal(
      autoPilotStepOf(waiting, nudge({ forTurn: TURN - 1 }), NOW),
      "wait",
    );
  });

  it("stops nudging after too many turns", () => {
    const many = nudge({ forTurn: TURN - 1, count: MAX_NUDGES });
    assert.equal(autoPilotStepOf(cardOf(), many, NOW), "wait");
  });

  it("archives a finished auto-pilot session", () => {
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
    assert.equal(autoPilotStepOf(card, undefined, NOW), "archive");
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

describe("auto-pilot cards", () => {
  it("shows a session finishing on its own as in flight, not in Finish", () => {
    const card = cardOf();
    assert.equal(card.lane, "in-flight");
    assert.equal(card.isFinishing, false);
  });

  it("keeps the usual lane when auto-pilot is off", () => {
    const card = cardOf({ isAutoPilot: false });
    assert.equal(card.lane, "answer");
    assert.equal(card.isFinishing, true);
  });
});
