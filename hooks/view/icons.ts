import type { PrState } from "../../types";

export const CHEVRON_SIZE = 20;
export const PR_ICON_SIZE = 14;
export const BUBBLE_BORDER = "#3d3d3a";

const CHEVRON_COLOR = "#9a9893";

export const chevron = (isOpen: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${CHEVRON_SIZE}" height="${CHEVRON_SIZE}"><path d="${isOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"}" fill="none" stroke="${CHEVRON_COLOR}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const PULL_REQUEST_PATH =
  "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z";
const MERGE_PATH =
  "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z";

export const PR_STYLES: Record<
  PrState,
  { color: string; path: string; label: string }
> = {
  open: {
    color: "#3fb950",
    path: PULL_REQUEST_PATH,
    label: "Open pull request",
  },
  draft: {
    color: "#8b949e",
    path: PULL_REQUEST_PATH,
    label: "Draft pull request",
  },
  merged: { color: "#a371f7", path: MERGE_PATH, label: "Merged pull requests" },
  closed: {
    color: "#f85149",
    path: PULL_REQUEST_PATH,
    label: "Closed pull request",
  },
};

export const prIcon = (state: PrState) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${PR_ICON_SIZE}" height="${PR_ICON_SIZE}"><path fill="${PR_STYLES[state].color}" d="${PR_STYLES[state].path}"/></svg>`;
