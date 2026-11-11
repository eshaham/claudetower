import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionCard, Verdict } from "../types";
import type { Nudge } from "../hooks/lib/auto-finish";
import {
  isAutoFinishOn,
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

const MERGED = [
  {
    number: 7,
    state: "merged" as const,
    additions: 1,
    deletions: 1,
    failing: 0,
    pending: 0,
  },
];

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

const STARTED = (overrides: Partial<Nudge> = {}): Nudge => ({
  forTurn: TURN - 1,
  at: NOW - NUDGE_RETRY_MS,
  count: 1,
  isDelivered: true,
  hasStarted: true,
  ...overrides,
});

const nudge = (overrides: Partial<Nudge> = {}): Nudge => ({
  forTurn: TURN,
  at: NOW - 1000,
  count: 1,
  isDelivered: true,
  hasStarted: true,
  ...overrides,
});

describe("auto-finish steps", () => {
  it("messages the session as soon as auto-finish is switched on, even when it needs the user", () => {
    const blocked = cardOf({ verdict: verdictOf({ canFinishAlone: false }) });
    assert.equal(autoFinishStepOf(blocked, undefined, NOW), "nudge");
    assert.equal(
      autoFinishStepOf(cardOf({ verdict: null }), undefined, NOW),
      "nudge",
    );
    assert.equal(
      autoFinishStepOf(cardOf({ isRunning: true }), undefined, NOW),
      "wait",
    );
  });

  it("marks the session started only once the first message is picked up", () => {
    const card = cardOf();
    assert.equal(
      nudgeAfter(undefined, card, "nudge", false, NOW).hasStarted,
      false,
    );
    assert.equal(
      nudgeAfter(undefined, card, "nudge", true, NOW).hasStarted,
      true,
    );
  });

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
      autoFinishStepOf(cardOf({ isRereading: true }), STARTED(), NOW),
      "wait",
    );
    assert.equal(
      autoFinishStepOf(cardOf({ verdict: null }), STARTED(), NOW),
      "wait",
    );
  });

  it("waits when the session needs the user", () => {
    const card = cardOf({ verdict: verdictOf({ canFinishAlone: false }) });
    assert.equal(autoFinishStepOf(card, STARTED(), NOW), "wait");
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
      prs: MERGED,
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
    assert.equal(autoFinishStepOf(card, STARTED(), NOW), "wait");
  });

  it("is not paused while the session works or its reading is redone", () => {
    const blocked = verdictOf({ canFinishAlone: false });
    assert.equal(
      isAutoFinishPaused(cardOf({ verdict: blocked, isRunning: true })),
      false,
    );
    assert.equal(
      isAutoFinishPaused(cardOf({ verdict: blocked, isRereading: true })),
      false,
    );
  });

  it("is not paused while it waits on others", () => {
    const waiting = verdictOf({
      status: "waiting_on_others",
      kind: null,
      canFinishAlone: false,
    });
    assert.equal(isAutoFinishPaused(cardOf({ verdict: waiting })), false);
  });

  it("is not paused when it can finish alone or has no verdict yet", () => {
    assert.equal(isAutoFinishPaused(cardOf()), false);
    assert.equal(isAutoFinishPaused(cardOf({ verdict: null })), false);
  });
});

describe("auto-finish with started sessions", () => {
  const finished = (childIds: string[]) =>
    cardOf({
      prs: MERGED,
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
    assert.equal(autoFinishStepOf(card, STARTED(), NOW), "wait");
  });

  it("archives once every started session is archived", () => {
    assert.equal(autoFinishStepOf(finished([]), undefined, NOW), "archive");
  });
});

describe("auto-finish archiving", () => {
  it("tries to archive only once", () => {
    const card = cardOf({
      prs: MERGED,
      verdict: verdictOf({
        status: "done",
        kind: null,
        isFinished: true,
        canFinishAlone: false,
      }),
    });
    const tried = nudgeAfter(STARTED(), card, "archive", false, NOW);
    assert.equal(tried.hasTriedArchive, true);
    const nextTurn = cardOf({
      prs: MERGED,
      lastAt: TURN + 60_000,
      verdict: card.verdict,
    });
    assert.equal(
      autoFinishStepOf(nextTurn, tried, NOW + NUDGE_RETRY_MS),
      "wait",
    );
  });
});

describe("auto-finish without a PR", () => {
  it("never archives a finished session that had no PR", () => {
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
    assert.notEqual(autoFinishStepOf(card, STARTED(), NOW), "archive");
  });
});

describe("auto-finish set up in the app", () => {
  it("is on when the app finishes the session, unless switched off", () => {
    assert.equal(isAutoFinishOn({}, "a", true), true);
    assert.equal(isAutoFinishOn({ a: -1 }, "a", true), false);
    assert.equal(isAutoFinishOn({ a: 1 }, "a", false), true);
    assert.equal(isAutoFinishOn({}, "a", false), false);
  });

  it("skips the kickoff message for a session the app already finishes", () => {
    const card = cardOf({
      isSetUpInApp: true,
      verdict: verdictOf({ canFinishAlone: false }),
    });
    assert.equal(autoFinishStepOf(card, undefined, NOW), "wait");
  });
});
