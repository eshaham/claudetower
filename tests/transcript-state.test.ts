import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyText,
  byteLengthOf,
  emptyState,
  readingOf,
  splitChunk,
} from "../hooks/lib/transcript-state";
import {
  answerLine,
  lastPromptLine,
  limits,
  questionLine,
  promptLine,
  replyLine,
  toolCallLine,
  toolResultLine,
  wrapUpLine,
} from "./helpers";

const NOW = Date.UTC(2026, 9, 29, 12);
const transcript = [
  promptLine("First ask", 1),
  replyLine("First answer", 2),
  promptLine("Fix the bug", 3),
  toolCallLine(4),
  toolResultLine(5),
  replyLine("Fixed it.", 6, null),
  wrapUpLine(7),
  toolResultLine(8),
  replyLine("Ready.", 9),
  lastPromptLine("Fix the bug"),
].join("\n");

const readAll = (text: string) => applyText(emptyState(), text, limits);

describe("transcript state", () => {
  it("shows a question until the user answers it", () => {
    const asked = [promptLine("Go", 1), questionLine(2, "call-1")].join("\n");
    const waiting = readingOf(readAll(`${asked}\n`), NOW, NOW, limits);
    assert.equal(waiting.question, "Which one?");
    assert.equal(waiting.options.length, 2);
    const answered = [
      asked,
      answerLine(3, "call-1"),
      replyLine("Done.", 4),
    ].join("\n");
    const done = readingOf(readAll(`${answered}\n`), NOW, NOW, limits);
    assert.equal(done.question, "");
    assert.deepEqual(done.options, []);
  });

  it("counts a session asking a question as stopped, not working", () => {
    const asked = [promptLine("Go", 1), questionLine(2, "call-1")].join("\n");
    const waiting = readingOf(readAll(`${asked}\n`), NOW, NOW, limits);
    assert.equal(waiting.isStopped, true);
    assert.equal(waiting.isAsking, true);
    const working = [promptLine("Go", 1), toolCallLine(2)].join("\n");
    const running = readingOf(readAll(`${working}\n`), NOW, NOW, limits);
    assert.equal(running.isStopped, false);
    assert.equal(running.isAsking, false);
  });

  it("keeps a question when a different tool's result comes back", () => {
    const text = [
      promptLine("Go", 1),
      questionLine(2, "call-1"),
      answerLine(3, "other"),
    ].join("\n");
    const reading = readingOf(readAll(`${text}\n`), NOW, NOW, limits);
    assert.equal(reading.question, "Which one?");
  });

  it("reads the last turn, its prompt and the offered actions", () => {
    const reading = readingOf(readAll(`${transcript}\n`), NOW, NOW, limits);
    assert.equal(reading.prompt, "Fix the bug");
    assert.equal(reading.promptAt, Date.UTC(2026, 9, 29, 10, 3));
    assert.equal(reading.lastText, "Fixed it.\n\nReady.");
    assert.equal(reading.lastAssistantId, "a9");
    assert.equal(reading.question, "Ship it?");
    assert.deepEqual(reading.options, [
      { label: "Yes", message: "Ship it." },
      { label: "No", message: "No" },
    ]);
    assert.equal(reading.isStopped, true);
  });

  it("gives the same reading when the lines arrive in pieces", () => {
    const whole = readAll(`${transcript}\n`);
    const lines = `${transcript}\n`.split(/(?<=\n)/);
    for (let cut = 1; cut < lines.length; cut += 1) {
      const first = readAll(lines.slice(0, cut).join(""));
      const both = applyText(first, lines.slice(cut).join(""), limits);
      assert.deepEqual(both, whole, `split after line ${cut}`);
    }
  });

  it("starts a new turn on each prompt and drops the old offer", () => {
    const state = readAll(
      `${transcript}\n${promptLine("Thanks", 8)}\n${replyLine("Welcome", 9)}\n`,
    );
    const reading = readingOf(state, NOW, NOW, limits);
    assert.equal(reading.lastText, "Welcome");
    assert.equal(reading.question, "");
    assert.deepEqual(reading.options, []);
  });

  it("starts a new turn on a prompt that follows a system reminder", () => {
    const remindedPrompt = JSON.stringify({
      type: "user",
      uuid: "u8",
      timestamp: new Date(Date.UTC(2026, 9, 29, 10, 8)).toISOString(),
      message: {
        content: [
          {
            type: "text",
            text: "<system-reminder>\nLinked sessions now\n</system-reminder>\n\n",
          },
          { type: "text", text: "status?" },
        ],
      },
    });
    const state = readAll(
      `${transcript}\n${remindedPrompt}\n${replyLine("Still running", 9)}\n${lastPromptLine("Fix the bug")}\n`,
    );
    const reading = readingOf(state, NOW, NOW, limits);
    assert.equal(reading.prompt, "status?");
    assert.equal(reading.lastText, "Still running");
    assert.equal(reading.question, "");
    assert.deepEqual(reading.options, []);
  });

  it("treats a session waiting on a tool as running until its grace ends", () => {
    const state = readAll(`${promptLine("Run it", 1)}\n${toolCallLine(2)}\n`);
    const mtime = NOW - 60_000;
    assert.equal(readingOf(state, mtime, NOW, limits).isStopped, false);
    const later = mtime + limits.toolGraceMs + 1;
    assert.equal(readingOf(state, mtime, later, limits).isStopped, true);
  });

  it("decides stopped from time alone, without reading again", () => {
    const state = readAll(
      `${promptLine("Go", 1)}\n${replyLine("…", 2, null)}\n`,
    );
    const mtime = NOW;
    assert.equal(readingOf(state, mtime, NOW, limits).isStopped, false);
    assert.equal(
      readingOf(state, mtime, NOW + limits.runningGraceMs + 1, limits)
        .isStopped,
      true,
    );
  });

  it("keeps only the newest characters of a long turn", () => {
    const long = "x".repeat(4000);
    const state = readAll(
      `${promptLine("Go", 1)}\n${replyLine(long, 2)}\n${replyLine(long, 3)}\n`,
    );
    assert.equal(state.turnText.length, limits.lastTextChars);
  });

  it("counts unreadable lines instead of failing", () => {
    const state = readAll(`${promptLine("Go", 1)}\n{not json\n`);
    assert.equal(state.skippedLines, 1);
    assert.equal(state.prompts.length, 1);
  });
});

describe("splitting a read into whole lines", () => {
  it("holds back a partial last line and counts its bytes", () => {
    const chunk = splitChunk('{"a":1}\n{"b":"héllo', false);
    assert.equal(chunk.complete, '{"a":1}\n');
    assert.equal(chunk.tailBytes, byteLengthOf('{"b":"héllo'));
  });

  it("drops the cut first line of a tail read", () => {
    const chunk = splitChunk('t":1}\n{"a":2}\n', true);
    assert.equal(chunk.complete, '{"a":2}\n');
    assert.equal(chunk.tailBytes, 0);
  });

  it("returns nothing whole when no line has ended", () => {
    assert.deepEqual(splitChunk('{"a":', false), {
      complete: "",
      tailBytes: 5,
    });
  });
});
