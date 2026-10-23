import type { EngineInterface } from "claude-code";

import type { RankingToolInput } from "../../types";
import { HOUR_MS, READ_CONCURRENCY, host } from "./config";
import type { Ranking } from "./ranking";
import {
  BUILT_IN_LABELS,
  DEFAULT_RANKING,
  bandOf,
  checkRanking,
  hasRankingFile,
  loadRanking,
  rankingOf,
  rankingPath,
  readingFingerprintOf,
  writeRanking,
} from "./ranking";
import { setPaneOpen } from "./board";
import { recencyOf } from "./classify";
import { judgeScenario } from "./verdict";

export const RANKING_TOOL = "ranking";

const MAX_SCENARIOS = 12;

export const RANKING_TOOL_SPEC = {
  name: RANKING_TOOL,
  description:
    "Read, preview or save how claudetower ranks this Desktop instance's sessions. show: the ranking file's path, its content, the effective ranking, the defaults and the built-in labels. preview: run the real session reader on made-up scenarios under a draft ranking and under the current one, and return each scenario's urgency, band, labels and order. save: check a ranking and write it as this instance's ranking file. Used by the claudetower ranking skill.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["show", "preview", "save"] },
      ranking: {
        type: "object",
        description:
          "preview and save: the ranking file's full content (rules, labels, bands, recency, lanes, finish, scheduledTasks; parts left out come from the default)",
      },
      scenarios: {
        type: "array",
        description: `preview: up to ${MAX_SCENARIOS} made-up sessions to read`,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: {
              type: "string",
              description:
                "What the session is about and where it stands, as its history and last words would show it",
            },
            ageHours: { type: "number" },
            lane: {
              type: "string",
              enum: [
                "answer",
                "act",
                "review",
                "follow-up",
                "in-flight",
                "wrap-up",
              ],
            },
          },
          required: ["name", "description"],
        },
      },
    },
    required: ["action"],
  },
};

type Scenario = NonNullable<RankingToolInput["scenarios"]>[number];
type RankingRequest = Partial<RankingToolInput>;

async function readScenario(
  $: EngineInterface,
  ranking: Ranking,
  scenario: Scenario,
) {
  const verdict = await judgeScenario($, ranking, scenario.description);
  if (!verdict) return { name: scenario.name, error: "could not read it" };
  return {
    name: scenario.name,
    urgency: verdict.urgency,
    band: bandOf(ranking, verdict.urgency).name,
    labels: verdict.labels,
    isLastMile: verdict.isLastMile,
    score: Math.round(
      verdict.urgency *
        recencyOf(ranking, (scenario.ageHours ?? 0) * HOUR_MS) *
        ranking.lanes[scenario.lane ?? "answer"],
    ),
  };
}

async function readAll(
  $: EngineInterface,
  ranking: Ranking,
  scenarios: Scenario[],
) {
  const results: Awaited<ReturnType<typeof readScenario>>[] = [];
  for (let index = 0; index < scenarios.length; index += READ_CONCURRENCY)
    results.push(
      ...(await Promise.all(
        scenarios
          .slice(index, index + READ_CONCURRENCY)
          .map((scenario) => readScenario($, ranking, scenario)),
      )),
    );
  const scoreOf = (result: (typeof results)[number]) =>
    "error" in result ? -1 : result.score;
  return results.sort((a, b) => scoreOf(b) - scoreOf(a));
}

async function show($: EngineInterface) {
  const hasFile = await hasRankingFile($);
  return {
    instance: host.instance,
    path: rankingPath(),
    hasFile,
    file: hasFile ? JSON.parse(await $.fs.read(rankingPath())) : null,
    effective: await loadRanking($),
    defaults: DEFAULT_RANKING,
    builtInLabels: BUILT_IN_LABELS,
  };
}

async function preview($: EngineInterface, input: RankingRequest) {
  const problems = checkRanking(input.ranking);
  if (problems.length > 0) return { problems };
  const scenarios = (input.scenarios ?? []).slice(0, MAX_SCENARIOS);
  if (scenarios.length === 0) return { problems: ["no scenarios to preview"] };
  const draft = rankingOf(input.ranking as Partial<Ranking>);
  const current = await loadRanking($);
  const [withDraft, withCurrent] = await Promise.all([
    readAll($, draft, scenarios),
    readAll($, current, scenarios),
  ]);
  return {
    draft: withDraft,
    current: withCurrent,
    reReadsSessions:
      readingFingerprintOf(draft) !== readingFingerprintOf(current),
  };
}

async function save($: EngineInterface, input: RankingRequest) {
  const problems = checkRanking(input.ranking);
  if (problems.length > 0) return { problems };
  const before = readingFingerprintOf(await loadRanking($));
  const isFirst = !(await hasRankingFile($));
  await writeRanking($, input.ranking as Partial<Ranking>);
  if (isFirst) await setPaneOpen($, true);
  return {
    saved: rankingPath(),
    reReadsSessions:
      readingFingerprintOf(rankingOf(input.ranking as Partial<Ranking>)) !==
      before,
  };
}

export async function runRankingTool($: EngineInterface, input: unknown) {
  const request = (input ?? {}) as RankingRequest;
  if (!host.instance)
    return { problems: ["claudetower has not found its Desktop instance yet"] };
  if (request.action === "show") return show($);
  if (request.action === "preview") return preview($, request);
  if (request.action === "save") return save($, request);
  return { problems: ['action must be "show", "preview" or "save"'] };
}
