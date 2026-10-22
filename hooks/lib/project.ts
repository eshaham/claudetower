import type { EngineInterface } from "claude-code";

import {
  CLAIM_MS,
  PROJECT_TTL_MS,
  STORE_KEYS,
  VERDICT_MODEL,
  host,
  isMcpToolName,
  isTicketPrefix,
  loadTools,
  log,
} from "./config";
import type { McpToolName } from "./config";
import type { Live, SessionFile } from "./transcript";

export type ProjectProfile = {
  summary: string;
  ticketPrefixes: string[];
  issueLookup: { tool: McpToolName; idArgument: string } | null;
  criticalSignals: string[];
  services: string[];
  checkedAt: number;
};

type ProjectStore = Record<string, ProjectProfile>;
type ClaimStore = Record<string, { by: string; until: number }>;

const README_CHARS = 3000;
const INSTRUCTIONS_CHARS = 5000;
const BRANCHES = 40;
const ISSUE_TOOL_HINT = /issue|ticket|task|story|bug/i;

const PROJECT_RULES = `You profile a software project for a tool that triages the user's Claude Code sessions. You get facts about the repo and the tools the user's Claude Code can call. Name only what the facts support; never assume a service the facts don't show.
Answer with one JSON object and nothing else:
{"summary": string, "ticketPrefixes": string[], "issueLookup": {"tool": string, "idArgument": string} | null, "criticalSignals": string[], "services": string[]}
- summary: at most 20 words. What the project is.
- ticketPrefixes: issue-key prefixes this project's branches and session titles use (for "ENG-123", "ENG"). Empty when there are none.
- issueLookup: the tool from availableIssueTools that fetches one issue of this project's tracker by its key, and the name of that tool's argument for the key. null when none fits.
- criticalSignals: up to 6 short phrases saying what a P0 emergency looks like for this project specifically (for example "production API down for users", "main branch CI broken, nobody can merge", "payments failing"). Base them on what the project runs and deploys.
- services: external services the project depends on (error tracking, hosting, CI, issue tracker, payments...), as named in the facts.`;

export const projectRootOf = (s: SessionFile) => {
  const path = s.originCwd ?? s.cwd ?? "";
  return path.split("/.claude/worktrees/")[0] ?? path;
};

export async function readProjects($: EngineInterface) {
  return ((await $.store.get(STORE_KEYS.projects)) ?? {}) as ProjectStore;
}

async function readFileStart($: EngineInterface, path: string, chars: number) {
  if (!(await $.fs.exists(path))) return "";
  const stat = await $.fs.stat(path);
  if (stat.kind !== "file") return "";
  return (await $.fs.read(path)).slice(0, chars);
}

async function run($: EngineInterface, argv: string[]) {
  const result = await $.process.run(argv);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

async function factsOf($: EngineInterface, root: string, titles: string[]) {
  await loadTools($);
  const [remote, branches, entries, workflows, readme, instructions] =
    await Promise.all([
      run($, ["git", "-C", root, "remote", "get-url", "origin"]),
      run($, [
        "git",
        "-C",
        root,
        "for-each-ref",
        `--count=${BRANCHES}`,
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/heads",
      ]),
      $.fs.list(root),
      $.fs
        .exists(`${root}/.github/workflows`)
        .then((exists) =>
          exists ? $.fs.list(`${root}/.github/workflows`) : [],
        ),
      readFileStart($, `${root}/README.md`, README_CHARS),
      readFileStart($, `${root}/CLAUDE.md`, INSTRUCTIONS_CHARS),
    ]);
  return {
    gitRemote: remote,
    recentBranches: branches.split("\n").filter(Boolean),
    sessionTitles: titles,
    topLevelEntries: entries.map((entry) => entry.name),
    ciWorkflows: workflows.map((entry) => entry.name),
    readme,
    claudeInstructions: instructions,
    availableIssueTools: host.tools.filter(
      (tool) =>
        ISSUE_TOOL_HINT.test(tool.name) ||
        ISSUE_TOOL_HINT.test(tool.description),
    ),
  };
}

const textList = (value: unknown, limit: number) =>
  Array.isArray(value) ? value.map(String).slice(0, limit) : [];

function parseProfile(text: string): ProjectProfile | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  const raw = JSON.parse(json) as {
    summary?: unknown;
    ticketPrefixes?: unknown;
    issueLookup?: { tool?: unknown; idArgument?: unknown } | null;
    criticalSignals?: unknown;
    services?: unknown;
  };
  const tool = String(raw.issueLookup?.tool ?? "");
  const idArgument = String(raw.issueLookup?.idArgument ?? "");
  return {
    summary: String(raw.summary ?? ""),
    ticketPrefixes: textList(raw.ticketPrefixes, 10).filter(isTicketPrefix),
    issueLookup:
      isMcpToolName(tool) &&
      idArgument &&
      host.tools.some((known) => known.name === tool)
        ? { tool, idArgument }
        : null,
    criticalSignals: textList(raw.criticalSignals, 6),
    services: textList(raw.services, 15),
    checkedAt: Date.now(),
  };
}

async function profileProject(
  $: EngineInterface,
  root: string,
  titles: string[],
) {
  const answer = await $.model.complete({
    model: VERDICT_MODEL,
    system: [{ text: PROJECT_RULES, cache: true }],
    prompt: JSON.stringify(await factsOf($, root, titles)),
    maxTokens: 800,
  });
  if (!answer.isAnswered) {
    log($, `could not profile ${root}: ${answer.reason}`);
    return null;
  }
  const profile = parseProfile(answer.text);
  if (!profile) log($, `unusable project profile for ${root}`);
  return profile;
}

export async function claim($: EngineInterface, key: string) {
  const claims = ((await $.store.get(STORE_KEYS.claims)) ?? {}) as ClaimStore;
  const now = Date.now();
  const held = claims[key];
  if (held && held.by !== host.selfCliId && held.until > now) return false;
  const live = Object.fromEntries(
    Object.entries(claims).filter(([, value]) => value.until > now),
  );
  await $.store.set(STORE_KEYS.claims, {
    ...live,
    [key]: { by: host.selfCliId, until: now + CLAIM_MS },
  });
  return true;
}

export async function refreshProjects($: EngineInterface, live: Live[]) {
  const projects = await readProjects($);
  const titlesByRoot = new Map<string, string[]>();
  for (const { s } of live)
    titlesByRoot.set(projectRootOf(s), [
      ...(titlesByRoot.get(projectRootOf(s)) ?? []),
      s.title ?? "",
    ]);
  const stale = [...titlesByRoot.keys()].find(
    (root) => Date.now() - (projects[root]?.checkedAt ?? 0) > PROJECT_TTL_MS,
  );
  if (!stale || !(await claim($, `project:${stale}`))) return;
  try {
    const profile = await profileProject(
      $,
      stale,
      (titlesByRoot.get(stale) ?? []).slice(0, 30),
    );
    if (!profile) return;
    await $.store.set(STORE_KEYS.projects, {
      ...(await readProjects($)),
      [stale]: profile,
    });
  } catch (error) {
    log($, `could not profile ${stale}: ${String(error)}`);
  }
}

export const ticketPatternOf = (profile: ProjectProfile | undefined) => {
  const prefixes = host.ticketPrefixOverride.length
    ? host.ticketPrefixOverride
    : (profile?.ticketPrefixes ?? []);
  return prefixes.length > 0
    ? new RegExp(`\\b(?:${prefixes.join("|")})-\\d+\\b`, "i")
    : null;
};
