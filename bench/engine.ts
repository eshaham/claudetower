import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Counters = {
  reads: number;
  git: number;
  stat: number;
  other: number;
};

const VERDICT = JSON.stringify({
  status: "needs_you",
  kind: "review",
  priority: "normal",
  urgency: 50,
  labels: [],
  waitingFor: "Benchmark",
  followUps: [],
  isLastMile: false,
  isFinished: false,
});

const categoryOf = (argv: string[]): keyof Counters => {
  const line = argv.join(" ");
  if (line.includes("tail -c")) return "reads";
  if (argv[0] === "git") return "git";
  if (argv[0] === "/usr/bin/stat") return "stat";
  return "other";
};

function readStore(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    console.warn(`unreadable bench store ${path}: ${String(error)}`);
    return {};
  }
}

function writeStore(path: string, store: Record<string, unknown>) {
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify(store));
  renameSync(draft, path);
}

export function makeEngine(storePath: string, sessionId: string) {
  const counters: Counters = { reads: 0, git: 0, stat: 0, other: 0 };
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
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map((entry) => {
          const stat = statSync(`${path}/${entry.name}`);
          return {
            name: entry.name,
            kind: entry.isDirectory() ? "dir" : "file",
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          };
        }),
      read: async (path: string) => readFileSync(path, "utf8"),
      write: async (path: string, text: string) => writeFileSync(path, text),
    },
    process: {
      run: async (argv: string[]) => {
        counters[categoryOf(argv)] += 1;
        const [command, ...args] = argv;
        try {
          const { stdout, stderr } = await run(command!, args, {
            maxBuffer: 256 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error) {
          const failed = error as { code?: number; stderr?: string };
          return {
            exitCode: typeof failed.code === "number" ? failed.code : 1,
            stdout: "",
            stderr: failed.stderr ?? String(error),
          };
        }
      },
      spawn: ({ argv }: { argv: string[] }) => {
        counters.other += 1;
        const child = spawn(argv[0]!, argv.slice(1));
        return (async function* () {
          for await (const chunk of child.stdout)
            yield { stream: "stdout", text: String(chunk) };
        })();
      },
    },
    store: {
      get: async (key: string) => readStore(storePath)[key],
      set: async (key: string, value: unknown) =>
        writeStore(storePath, { ...readStore(storePath), [key]: value }),
      delete: async (key: string) => {
        const store = readStore(storePath);
        delete store[key];
        writeStore(storePath, store);
      },
    },
    clock: {
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    model: {
      complete: async ({ system }: { system: { text: string }[] }) => {
        const rules = system.map((part) => part.text).join("\n");
        if (rules.includes("recurring scheduled"))
          return {
            isAnswered: true,
            text: '{"problem": false, "summary": "ran", "fix": []}',
          };
        return {
          isAnswered: true,
          text: rules.includes("Claude Code session ended") ? VERDICT : "{}",
        };
      },
    },
    tool: {
      list: async () => [],
      call: async () => ({ deny: "benchmark" }),
      check: async () => ({ decision: "ask" }),
    },
    session: { id: async () => sessionId, surfaces: async () => [] },
    prompt: { submit: async () => undefined },
    ui: {
      log: () => undefined,
      toast: () => undefined,
      panes: async () => [],
      open: async () => ({ isPlaced: false }),
      close: async () => undefined,
    },
  };
  return { engine, counters };
}
