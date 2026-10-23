import type { EngineInterface } from "claude-code";

import type { LaneId } from "../../types";
import { host, log } from "./config";

export type UrgencyRule = { said: string; rule: string };
export type LabelDefinition = { name: string; means: string };
export type Band = { name: string; from: number; color?: BandColor };
export type ScheduledTasks = "problems-only" | "all";

export type Ranking = {
  rules: UrgencyRule[];
  labels: LabelDefinition[];
  bands: Band[];
  recency: { halfLifeHours: number; floor: number };
  lanes: Record<LaneId, number>;
  finish: { show: number };
  scheduledTasks: ScheduledTasks;
};

const BAND_COLORS = [
  "error",
  "warning",
  "success",
  "suggestion",
  "claude",
  "subtle",
] as const;
type BandColor = (typeof BAND_COLORS)[number];

const LANE_IDS: LaneId[] = [
  "answer",
  "act",
  "review",
  "follow-up",
  "in-flight",
  "wrap-up",
];

export const BUILT_IN_LABELS: LabelDefinition[] = [
  {
    name: "production",
    means: "Concerns a live production service, app or its users",
  },
  {
    name: "security",
    means: "Concerns a security issue, a leaked secret or access control",
  },
  {
    name: "ci",
    means: "Concerns CI: failing checks, broken builds or test pipelines",
  },
  { name: "deploy", means: "Concerns deploying or releasing" },
  {
    name: "blocks-others",
    means: "Other people are waiting on this work to continue theirs",
  },
];

export const DEFAULT_RANKING: Ranking = {
  rules: [],
  labels: [],
  bands: [
    { name: "Urgent", from: 80, color: "error" },
    { name: "High", from: 60, color: "warning" },
    { name: "Normal", from: 30 },
    { name: "Low", from: 0 },
  ],
  recency: { halfLifeHours: 48, floor: 0.8 },
  lanes: {
    answer: 1,
    act: 1,
    review: 1,
    "follow-up": 0.95,
    "in-flight": 0.85,
    "wrap-up": 0.8,
  },
  finish: { show: 3 },
  scheduledTasks: "problems-only",
};

const LABEL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const checkRules = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (rule) => isRecord(rule) && isText(rule.said) && isText(rule.rule),
  )
    ? []
    : ["rules must be a list of { said, rule }, both non-empty text"];

const checkLabels = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    !value.every(
      (label) =>
        isRecord(label) &&
        typeof label.name === "string" &&
        LABEL_NAME.test(label.name) &&
        isText(label.means),
    )
  )
    return [
      "labels must be a list of { name, means }, name in lowercase-with-dashes",
    ];
  const names = value.map((label) => (label as LabelDefinition).name);
  const taken = names.filter(
    (name, index) =>
      names.indexOf(name) !== index ||
      BUILT_IN_LABELS.some((builtIn) => builtIn.name === name),
  );
  return taken.length > 0
    ? [`label names must be unique and not built in: ${taken.join(", ")}`]
    : [];
};

const checkBands = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    !value.every(
      (band) =>
        isRecord(band) &&
        isText(band.name) &&
        typeof band.from === "number" &&
        band.from >= 0 &&
        band.from <= 100 &&
        (band.color === undefined ||
          BAND_COLORS.includes(band.color as BandColor)),
    )
  )
    return [
      `bands must be a list of { name, from (0-100), color? (${BAND_COLORS.join(", ")}) }`,
    ];
  return value.some((band) => (band as Band).from === 0)
    ? []
    : ["one band must start from 0"];
};

const checkRecency = (value: unknown) =>
  isRecord(value) &&
  typeof value.halfLifeHours === "number" &&
  value.halfLifeHours > 0 &&
  typeof value.floor === "number" &&
  value.floor >= 0 &&
  value.floor <= 1
    ? []
    : ["recency must be { halfLifeHours > 0, floor 0-1 }"];

const checkLanes = (value: unknown) =>
  isRecord(value) &&
  Object.entries(value).every(
    ([lane, factor]) =>
      LANE_IDS.includes(lane as LaneId) &&
      typeof factor === "number" &&
      factor > 0,
  )
    ? []
    : [`lanes must map ${LANE_IDS.join(", ")} to numbers above 0`];

const checkFinish = (value: unknown) =>
  isRecord(value) &&
  typeof value.show === "number" &&
  Number.isInteger(value.show) &&
  value.show >= 0
    ? []
    : ["finish must be { show: a whole number of 0 or more }"];

const checkScheduled = (value: unknown) =>
  value === "problems-only" || value === "all"
    ? []
    : ['scheduledTasks must be "problems-only" or "all"'];

const CHECKS: Record<keyof Ranking, (value: unknown) => string[]> = {
  rules: checkRules,
  labels: checkLabels,
  bands: checkBands,
  recency: checkRecency,
  lanes: checkLanes,
  finish: checkFinish,
  scheduledTasks: checkScheduled,
};

export function checkRanking(raw: unknown) {
  if (!isRecord(raw)) return ["the ranking must be a JSON object"];
  const unknownKeys = Object.keys(raw).filter((key) => !(key in CHECKS));
  return [
    ...unknownKeys.map((key) => `unknown part: ${key}`),
    ...Object.entries(CHECKS).flatMap(([key, check]) =>
      key in raw ? check(raw[key]) : [],
    ),
  ];
}

export function rankingOf(raw: Partial<Ranking>): Ranking {
  return {
    ...DEFAULT_RANKING,
    ...raw,
    recency: { ...DEFAULT_RANKING.recency, ...raw.recency },
    lanes: { ...DEFAULT_RANKING.lanes, ...raw.lanes },
    finish: { ...DEFAULT_RANKING.finish, ...raw.finish },
    bands: [...(raw.bands ?? DEFAULT_RANKING.bands)].sort(
      (a, b) => b.from - a.from,
    ),
  };
}

export const allLabelsOf = (ranking: Ranking) => [
  ...BUILT_IN_LABELS,
  ...ranking.labels,
];

const hashOf = (text: string) =>
  [...text]
    .reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)
    .toString(36);

export const readingFingerprintOf = (ranking: Ranking) =>
  hashOf(
    JSON.stringify({
      rules: ranking.rules.map((rule) => rule.rule),
      labels: allLabelsOf(ranking),
    }),
  );

export const bandOf = (ranking: Ranking, urgency: number) =>
  ranking.bands.find((band) => urgency >= band.from) ??
  ranking.bands[ranking.bands.length - 1]!;

export const rankingPath = () =>
  `${host.home}/.claude/claudetower/rankings/${host.instance}.json`;

let cached: { path: string; mtimeMs: number; ranking: Ranking } | null = null;

export async function hasRankingFile($: EngineInterface) {
  return Boolean(host.instance) && (await $.fs.exists(rankingPath()));
}

export async function loadRanking($: EngineInterface): Promise<Ranking> {
  const path = rankingPath();
  if (!host.instance || !(await $.fs.exists(path))) return DEFAULT_RANKING;
  const { mtimeMs } = await $.fs.stat(path);
  if (cached?.path === path && cached.mtimeMs === mtimeMs)
    return cached.ranking;
  const raw = JSON.parse(await $.fs.read(path)) as unknown;
  const problems = checkRanking(raw);
  if (problems.length > 0) {
    log($, `ignoring ${path}: ${problems.join("; ")}`);
    $.ui.toast(
      `claudetower: your ranking file has a problem, so the default ranking is in use: ${problems[0]}`,
    );
    cached = { path, mtimeMs, ranking: DEFAULT_RANKING };
    return DEFAULT_RANKING;
  }
  const ranking = rankingOf(raw as Partial<Ranking>);
  cached = { path, mtimeMs, ranking };
  return ranking;
}

export async function writeRanking($: EngineInterface, raw: Partial<Ranking>) {
  const path = rankingPath();
  await $.process.run(["/bin/mkdir", "-p", path.replace(/\/[^/]+$/, "")]);
  await $.fs.write(path, `${JSON.stringify(raw, null, 2)}\n`);
}
