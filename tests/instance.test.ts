import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { EngineInterface } from "claude-code";

import {
  INSTANCE_SEARCH_RETRY_MS,
  findInstance,
  host,
  resetInstanceSearch,
} from "../hooks/lib/config";

const HOME = "/home";
const ROOT = `${HOME}/Library/Application Support/Claude/claude-code-sessions`;

const engineWith = (grepOutput: () => string) => {
  const greps: string[][] = [];
  const $ = {
    fs: {
      list: async () => [{ name: "Claude", kind: "dir" }],
      exists: async () => true,
    },
    process: {
      run: async (argv: string[]) => {
        greps.push(argv);
        return { exitCode: 0, stdout: grepOutput(), stderr: "" };
      },
    },
  } as unknown as EngineInterface;
  return { $, greps };
};

describe("finding the Desktop instance by session id", () => {
  beforeEach(() => {
    resetInstanceSearch();
    Object.assign(host, {
      home: HOME,
      selfCliId: "self",
      instance: "",
      appPid: "",
    });
  });

  it("does not search the session files again right after a miss", async () => {
    const { $, greps } = engineWith(() => "");
    assert.equal(await findInstance($, 0), "");
    assert.equal(await findInstance($, 5_000), "");
    assert.equal(await findInstance($, 60_000), "");
    assert.equal(greps.length, 1);
  });

  it("searches again once the retry interval has passed", async () => {
    let output = "";
    const { $, greps } = engineWith(() => output);
    assert.equal(await findInstance($, 0), "");
    output = `${ROOT}/a/b/local_1.json\n`;
    assert.equal(await findInstance($, INSTANCE_SEARCH_RETRY_MS), "Claude");
    assert.equal(greps.length, 2);
  });

  it("keeps a found instance without searching again", async () => {
    const { $, greps } = engineWith(() => `${ROOT}/a/b/local_1.json\n`);
    assert.equal(await findInstance($, 0), "Claude");
    assert.equal(await findInstance($, 1), "Claude");
    assert.equal(greps.length, 1);
  });
});
