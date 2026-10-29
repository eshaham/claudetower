import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, resolve } from "node:path";

const [
  code,
  mode,
  sandbox,
  sessionsArg,
  changingArg,
  stimulus,
  tsxLoader,
  warmupArg = "60",
  durationArg = "90",
] = process.argv.slice(2);
if (!code || !mode || !sandbox || !sessionsArg || !changingArg || !tsxLoader)
  throw new Error(
    "usage: measure.ts <code> <old|new> <sandbox> <sessions> <changing> <touch|append|none> <tsx-loader> [warmup s] [duration s]",
  );

const INSTANCE = "Claude";
const sessions = Number(sessionsArg);
const changing = Number(changingArg);
const warmupMs = Number(warmupArg) * 1000;
const durationMs = Number(durationArg) * 1000;
const here = resolve(import.meta.dirname);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const cpuSecondsOf = (pid: number) => {
  let text = "";
  try {
    text = execFileSync("/bin/ps", ["-S", "-o", "time=", "-p", String(pid)])
      .toString()
      .trim();
  } catch (error) {
    console.error(`session ${pid} is gone: ${String(error)}`);
    return Number.NaN;
  }
  const parts = text.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};

const transcriptsOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? transcriptsOf(join(dir, entry.name))
      : entry.name.endsWith(".jsonl")
        ? [join(dir, entry.name)]
        : [],
  );

rmSync(join(sandbox, "store.json"), { force: true });
rmSync(join(sandbox, ".claude/claudetower"), { recursive: true, force: true });

const targets = transcriptsOf(join(sandbox, ".claude/projects"))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, changing);

const STAGGER_MS = 10_000;
let stopping = false;
process.on("exit", () => children.forEach((child) => child.kill()));
const ids = Array.from({ length: sessions }, (_, index) => `bench-${index}`);
const children = [];
for (const id of ids) {
  if (children.length > 0) await sleep(STAGGER_MS);
  children.push(
    spawn(
      process.execPath,
      [
        "--import",
        tsxLoader,
        join(here, "session.ts"),
        resolve(code),
        sandbox,
        INSTANCE,
        mode,
        id,
        join(sandbox, `${id}.counters.json`),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    ),
  );
}
children.forEach((child, index) =>
  child.on("exit", (code, signal) => {
    if (!stopping)
      console.error(
        `${ids[index]} exited early: code ${code}, signal ${signal}`,
      );
  }),
);

const countersOf = (id: string) => {
  const path = join(sandbox, `${id}.counters.json`);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, number>)
    : { reads: 0, git: 0, stat: 0, other: 0 };
};

const STIMULUS_LINE = `${JSON.stringify({
  type: "assistant",
  uuid: "bench",
  timestamp: new Date().toISOString(),
  message: { stop_reason: null, content: [{ type: "text", text: "working" }] },
})}\n`;

const stir = () => {
  const now = new Date();
  for (const path of targets)
    if (stimulus === "append") appendFileSync(path, STIMULUS_LINE);
    else if (stimulus === "touch") utimesSync(path, now, now);
};

await sleep(warmupMs);
const before = children.map((child, index) => ({
  cpu: cpuSecondsOf(child.pid!),
  counters: countersOf(ids[index]!),
}));
const stirring = setInterval(stir, 2000);
await sleep(durationMs);
clearInterval(stirring);
const after = children.map((child, index) => ({
  cpu: cpuSecondsOf(child.pid!),
  counters: countersOf(ids[index]!),
}));
const leasePath = join(sandbox, `.claude/claudetower/leases/${INSTANCE}.json`);
const leader = existsSync(leasePath)
  ? (JSON.parse(readFileSync(leasePath, "utf8")) as { id: string }).id
  : "";
stopping = true;
children.forEach((child) => child.kill());

const rows = ids.map((id, index) => {
  const delta = (key: string) =>
    (after[index]!.counters[key] ?? 0) - (before[index]!.counters[key] ?? 0);
  return {
    session: id === leader ? `${id} (leader)` : id,
    cpuPercent: Number(
      (
        ((after[index]!.cpu - before[index]!.cpu) / (durationMs / 1000)) *
        100
      ).toFixed(1),
    ),
    reads: delta("reads"),
    gitStatus: delta("git"),
    statCalls: delta("stat"),
  };
});
console.log(
  JSON.stringify({
    mode,
    sessions,
    changing,
    stimulus,
    seconds: durationMs / 1000,
    rows,
  }),
);
