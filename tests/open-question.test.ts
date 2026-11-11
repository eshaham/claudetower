import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  answerOpenQuestion,
  answersOf,
  raceOpenQuestion,
} from "../hooks/lib/open-question";

describe("open question", () => {
  it("is answered by a choice from the board while the dialog waits", async () => {
    const dialog = new Promise<string>(() => undefined);
    const outcome = raceOpenQuestion(dialog);
    assert.equal(answerOpenQuestion("Archive now"), true);
    assert.deepEqual(await outcome, { answer: "Archive now" });
    assert.equal(answerOpenQuestion("Again"), false);
  });

  it("keeps the user's own answer from the dialog", async () => {
    const outcome = await raceOpenQuestion(Promise.resolve("picked"));
    assert.deepEqual(outcome, { result: "picked" });
    assert.equal(answerOpenQuestion("Late"), false);
  });

  it("answers the first question with the choice", () => {
    assert.deepEqual(
      answersOf([{ question: "Archive?" }, { question: "Why?" }], "Yes"),
      { "Archive?": "Yes" },
    );
  });
});
