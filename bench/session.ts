import { writeFileSync } from "node:fs";

import { makeEngine } from "./engine";

const [code, home, instance, mode, id, countersPath] = process.argv.slice(2);
if (!code || !home || !instance || !id || !countersPath)
  throw new Error(
    "usage: session.ts <code> <home> <instance> <old|new> <id> <counters>",
  );

const config = await import(`${code}/hooks/lib/config.ts`);
const board = await import(`${code}/hooks/lib/board.ts`);

config.host.home = home;
config.host.instance = instance;
config.host.selfCliId = id;
config.host.gh = "";

const { engine, counters } = makeEngine(`${home}/store.json`, id);
const $ = engine as never;

const report = (name: string) => (error: unknown) =>
  console.warn(`${id} ${name}: ${String(error)}`);

const every = (ms: number, work: () => Promise<unknown>, name: string) =>
  setInterval(() => void work().catch(report(name)), ms);

setInterval(() => writeFileSync(countersPath, JSON.stringify(counters)), 1000);

if (mode === "old") {
  every(15_000, () => board.poll($), "poll");
  every(2_000, () => board.loadOnChange($), "change");
  every(2_000, () => board.checkInbox($), "inbox");
  void board.poll($).catch(report("poll"));
} else {
  every(15_000, () => board.poll($), "poll");
  every(5_000, () => board.leaseTick($), "lease");
  every(
    2_000,
    () => Promise.all([board.followBoard($), board.checkInbox($)]),
    "follow",
  );
  void board.leaseTick($).catch(report("lease"));
}
