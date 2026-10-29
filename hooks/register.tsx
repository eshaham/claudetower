import type { Register } from "claude-code";

import type { CardHitMessage } from "../types";
import {
  checkInbox,
  followOtherSessions,
  isPaneOpen,
  followBoard,
  leaseTick,
  load,
  markPanelAsked,
  noteClickLayerFailure,
  openPane,
  openSession,
  poll,
  readNeedsSetup,
  setPaneOpen,
  toggleCompose,
  toggleGroup,
  togglePreview,
} from "./lib/board";
import {
  FOLLOW_TICK_MS,
  LEASE_TICK_MS,
  PANE,
  PLUGIN,
  POLL_MS,
  discoverHost,
  log,
  setTicketPrefixes,
} from "./lib/config";
import {
  RANKING_TOOL,
  RANKING_TOOL_SPEC,
  runRankingTool,
} from "./lib/ranking-tool";
import { renderAbovePrompt } from "./view/above-prompt";
import { renderPane } from "./view/pane";
import { renderSetupBand } from "./view/setup";

export const register: Register = (on, options) => {
  setTicketPrefixes(String(options.ticketPrefixes ?? ""));

  on("session.start", async ($, e, next) => {
    await followOtherSessions($).catch((error: unknown) =>
      log($, `could not open the panel: ${String(error)}`),
    );
    await $.command.register({
      name: "tower",
      description: "Open the claudetower session board",
    });
    await $.tool.register(RANKING_TOOL_SPEC);
    void discoverHost($)
      .then(() => {
        $.clock.every(POLL_MS, () =>
          poll($).catch((error: unknown) =>
            log($, `could not refresh: ${String(error)}`),
          ),
        );
        $.clock.every(LEASE_TICK_MS, () =>
          leaseTick($).catch((error: unknown) =>
            log($, `could not check who leads the board: ${String(error)}`),
          ),
        );
        $.clock.every(FOLLOW_TICK_MS, () =>
          Promise.all([followBoard($), checkInbox($)]).catch((error: unknown) =>
            log($, `could not follow the board: ${String(error)}`),
          ),
        );
        void leaseTick($).catch((error: unknown) =>
          log($, `could not check who leads the board: ${String(error)}`),
        );
        return poll($);
      })
      .catch((error: unknown) => log($, `could not start: ${String(error)}`));

    return next(e);
  });

  on("session.attach", async ($, e, next) => {
    const attached = await next(e);
    await followOtherSessions($).catch((error: unknown) =>
      log($, `could not open the panel: ${String(error)}`),
    );

    return attached;
  });

  on("command.run", { command: "tower" }, async ($) => {
    markPanelAsked();
    await openPane($);
    void load($).catch((error: unknown) =>
      log($, `could not refresh: ${String(error)}`),
    );

    return { text: "Session board opened." };
  });

  on("ui.message", async ($, e) => {
    const message = e.data as CardHitMessage;
    const handled =
      message.kind === "open"
        ? openSession($, message.id)
        : message.kind === "toggle"
          ? togglePreview($, message.id)
          : message.kind === "group"
            ? toggleGroup($, message.id)
            : toggleCompose($, message.id);
    await handled.catch((error: unknown) =>
      log($, `could not handle a ${message.kind} click: ${String(error)}`),
    );

    return {};
  });

  on(
    "tool.call",
    { tool: `mcp__${PLUGIN}__${RANKING_TOOL}` },
    async ($, e) => ({
      result: JSON.stringify(await runRankingTool($, e), null, 2),
    }),
  );

  on("ui.fault", async ($, e, next) => {
    await noteClickLayerFailure($, e.reason);
    return next(e);
  });

  on("ui.close", async ($, e, next) => {
    const closed = await next(e);
    if (e.id === PANE && e.origin.kind === "person")
      await setPaneOpen($, false).catch((error: unknown) =>
        log($, `could not record the close: ${String(error)}`),
      );

    return closed;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    if (await readNeedsSetup($)) return renderSetupBand($, e);
    return (await isPaneOpen($)) ? next(e) : renderAbovePrompt($, e);
  });

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) =>
    renderPane($, e),
  );
};
