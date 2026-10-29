import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

import type { EngineInterface } from "claude-code";

const run = promisify(execFile);

export const limits = {
  lastTextChars: 6000,
  promptChars: 800,
  runningGraceMs: 15 * 60_000,
  toolGraceMs: 2 * 60 * 60_000,
};

export const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 29, 10, minute)).toISOString();

export const promptLine = (text: string, minute: number) =>
  JSON.stringify({
    type: "user",
    uuid: `u${minute}`,
    timestamp: at(minute),
    message: { content: text },
  });

export const replyLine = (
  text: string,
  minute: number,
  stopReason: string | null = "end_turn",
) =>
  JSON.stringify({
    type: "assistant",
    uuid: `a${minute}`,
    timestamp: at(minute),
    message: { stop_reason: stopReason, content: [{ type: "text", text }] },
  });

export const toolCallLine = (minute: number) =>
  JSON.stringify({
    type: "assistant",
    uuid: `t${minute}`,
    timestamp: at(minute),
    message: {
      stop_reason: null,
      content: [{ type: "tool_use", name: "Bash", input: {} }],
    },
  });

export const toolResultLine = (minute: number) =>
  JSON.stringify({
    type: "user",
    uuid: `r${minute}`,
    timestamp: at(minute),
    message: { content: [{ type: "tool_result", content: "ok" }] },
  });

export const wrapUpLine = (minute: number) =>
  JSON.stringify({
    type: "assistant",
    uuid: `w${minute}`,
    timestamp: at(minute),
    message: {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "mcp__ccd_turn__wrap_up",
          input: {
            ask: "Ship it?",
            actions: [{ label: "Yes", message: "Ship it." }, { label: "No" }],
          },
        },
      ],
    },
  });

export const lastPromptLine = (text: string) =>
  JSON.stringify({ type: "last-prompt", lastPrompt: text });

export const fakeEngine = () => {
  const calls: string[][] = [];
  const engine = {
    fs: {
      exists: async (path: string) => existsSync(path),
      stat: async (path: string) => {
        const stat = statSync(path);
        return {
          kind: stat.isDirectory() ? "dir" : "file",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      },
      read: async (path: string) => readFileSync(path, "utf8"),
    },
    process: {
      run: async (argv: string[]) => {
        calls.push(argv);
        const [command, ...args] = argv;
        try {
          const { stdout, stderr } = await run(command!, args, {
            maxBuffer: 64 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error) {
          const failed = error as { code?: number; stderr?: string };
          return {
            exitCode: failed.code ?? 1,
            stdout: "",
            stderr: failed.stderr ?? String(error),
          };
        }
      },
    },
    ui: { log: () => undefined },
  };
  return { $: engine as unknown as EngineInterface, calls };
};
