import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readTranscript } from "../hooks/lib/transcript";
import { applyText, emptyState } from "../hooks/lib/transcript-state";
import {
  fakeEngine,
  limits,
  promptLine,
  replyLine,
  toolCallLine,
} from "./helpers";

const fileWith = (text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "claudetower-")), "t.jsonl");
  writeFileSync(path, text);
  return path;
};

const statOf = (path: string) => {
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
};

const touch = (path: string, mtimeMs: number) => ({
  ...statOf(path),
  mtimeMs,
});

describe("reading a transcript as it grows", () => {
  it("reads only the bytes appended since the last read", async () => {
    const { $, calls } = fakeEngine();
    const path = fileWith(`${promptLine("Fix it", 1)}\n`);
    await readTranscript($, path, statOf(path));
    const before = statOf(path).size;
    appendFileSync(path, `${toolCallLine(2)}\n${replyLine("Done ✓", 3)}\n`);
    const read = await readTranscript($, path, touch(path, 2));
    const lastRead = calls[calls.length - 1]!;
    assert.equal(lastRead[4], String(before + 1));
    assert.equal(read.offset, statOf(path).size);
    assert.deepEqual(
      read.state,
      applyText(
        emptyState(),
        `${promptLine("Fix it", 1)}\n${toolCallLine(2)}\n${replyLine("Done ✓", 3)}\n`,
        limits,
      ),
    );
  });

  it("waits for a line that is still being written", async () => {
    const { $ } = fakeEngine();
    const line = replyLine("héllo wörld", 2);
    const path = fileWith(`${promptLine("Go", 1)}\n${line.slice(0, 20)}`);
    const first = await readTranscript($, path, statOf(path));
    assert.equal(first.state.last?.type, "user");
    appendFileSync(path, `${line.slice(20)}\n`);
    const second = await readTranscript($, path, touch(path, 2));
    assert.equal(second.state.turnText, "héllo wörld");
    assert.equal(second.offset, statOf(path).size);
  });

  it("does not read at all when the file has not changed", async () => {
    const { $, calls } = fakeEngine();
    const path = fileWith(`${promptLine("Go", 1)}\n`);
    await readTranscript($, path, statOf(path));
    const reads = calls.length;
    await readTranscript($, path, statOf(path));
    await readTranscript($, path, touch(path, 99));
    assert.equal(calls.length, reads);
  });

  it("reads from the end again when the file shrank", async () => {
    const { $ } = fakeEngine();
    const path = fileWith(
      `${promptLine("Old", 1)}\n${replyLine("Old answer", 2)}\n`,
    );
    await readTranscript($, path, statOf(path));
    writeFileSync(path, `${promptLine("New", 3)}\n`);
    const read = await readTranscript($, path, touch(path, 3));
    assert.equal(read.state.prompts.at(-1)?.text, "New");
    assert.equal(read.state.turnText, "");
  });

  it("reads further back when the first tail holds no prompt", async () => {
    const { $ } = fakeEngine();
    const filler = replyLine("y".repeat(1000), 2);
    const path = fileWith(
      `${promptLine("The real ask", 1)}\n${`${filler}\n`.repeat(400)}`,
    );
    const read = await readTranscript($, path, statOf(path));
    assert.equal(read.state.prompts.at(-1)?.text, "The real ask");
  });
});
