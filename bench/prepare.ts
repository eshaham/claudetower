import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const [sandbox, instance = "Claude"] = process.argv.slice(2);
if (!sandbox) throw new Error("usage: prepare.ts <sandbox> [instance]");

const KEEP_BYTES = 2_000_000;
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const real = homedir();
const sessionsRoot = (home: string) =>
  join(home, "Library/Application Support", instance, "claude-code-sessions");

const keepMtime = (from: string, to: string) => {
  const stat = statSync(from);
  utimesSync(to, stat.atime, stat.mtime);
};

function copyTail(from: string, to: string) {
  const size = statSync(from).size;
  const length = Math.min(size, KEEP_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(from, "r");
  readSync(fd, buffer, 0, length, size - length);
  closeSync(fd);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, buffer);
  keepMtime(from, to);
}

let sessions = 0;
let transcripts = 0;
let bytes = 0;
const dirsIn = (path: string) =>
  readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

for (const account of dirsIn(sessionsRoot(real)))
  for (const org of dirsIn(join(sessionsRoot(real), account))) {
    const dir = join(sessionsRoot(real), account, org);
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("local_")) continue;
      const from = join(dir, name);
      if (Date.now() - statSync(from).mtimeMs > LOOKBACK_MS) continue;
      const to = join(sessionsRoot(sandbox), account, org, name);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      keepMtime(from, to);
      sessions += 1;
      const s = JSON.parse(readFileSync(from, "utf8")) as {
        cwd?: string;
        cliSessionId?: string;
        isArchived?: boolean;
      };
      if (s.isArchived || !s.cwd || !s.cliSessionId) continue;
      const relative = join(
        ".claude/projects",
        s.cwd.replace(/[/.]/g, "-"),
        `${s.cliSessionId}.jsonl`,
      );
      if (!existsSync(join(real, relative))) continue;
      copyTail(join(real, relative), join(sandbox, relative));
      transcripts += 1;
      bytes += statSync(join(sandbox, relative)).size;
    }
  }
console.log(
  `copied ${sessions} sessions and ${transcripts} transcripts (${Math.round(bytes / 1e6)} MB)`,
);
