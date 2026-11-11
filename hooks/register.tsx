import type { EngineInterface, Register } from "claude-code";

import type { CardHitMessage } from "../types";
import {
  checkInbox,
  clearQuestionOpen,
  followOtherSessions,
  isPaneOpen,
  followBoard,
  leaseTick,
  load,
  markPanelAsked,
  markQuestionOpen,
  noteClickLayerFailure,
  openPane,
  openSession,
  poll,
  readAutoFinishMarks,
  readCards,
  readNeedsSetup,
  setAutoFinish,
  setPaneOpen,
  takeRelayedMessage,
  toggleAutoFinish,
  toggleCompose,
  toggleGroup,
} from "./lib/board";
import {
  FOLLOW_TICK_MS,
  LEASE_TICK_MS,
  PANE,
  PLUGIN,
  POLL_MS,
  discoverHost,
  host,
  log,
  setTicketPrefixes,
} from "./lib/config";
import {
  RANKING_TOOL,
  RANKING_TOOL_SPEC,
  runRankingTool,
} from "./lib/ranking-tool";
import { answersOf, raceOpenQuestion } from "./lib/open-question";
import { renderAbovePrompt } from "./view/above-prompt";
import { renderPane } from "./view/pane";
import { renderSetupBand } from "./view/setup";

async function switchAutoFinish($: EngineInterface, args: string) {
  const self = (await readCards($)).find(
    (card) => card.cliId === host.selfCliId,
  );
  if (!self)
    return {
      text: "claudetower has not read this session yet. Try again in a few seconds.",
    };
  const asked = args.trim().toLowerCase();
  const isOn =
    asked === "on"
      ? true
      : asked === "off"
        ? false
        : !(self.id in (await readAutoFinishMarks($)));
  await setAutoFinish($, self.id, isOn);
  return {
    text: isOn
      ? "Auto-finish is on. claudetower will tell this session to finish, merge its PR and archive, and it will ask you for anything it needs."
      : "Auto-finish is off.",
  };
}

export const register: Register = (on, options) => {
  setTicketPrefixes(String(options.ticketPrefixes ?? ""));

  on("session.start", async ($, e, next) => {
    await followOtherSessions($).catch((error: unknown) =>
      log($, `could not open the panel: ${String(error)}`),
    );
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

    await Promise.all(
      [
        () =>
          $.command.register({
            name: "tower",
            description: "Open the claudetower session board",
          }),
        () =>
          $.command.register({
            name: "auto-finish",
            description:
              "Let this session finish on its own: merge its PR and archive when nothing needs you",
            argumentHint: "[on|off]",
          }),
        () => $.tool.register(RANKING_TOOL_SPEC),
      ].map((registration) =>
        registration().catch((error: unknown) =>
          log($, `could not register a command or tool: ${String(error)}`),
        ),
      ),
    );

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

  on("command.run", { command: "auto-finish" }, ($, e) =>
    switchAutoFinish($, e.args).catch((error: unknown) => {
      log($, `could not switch auto-finish: ${String(error)}`);
      return { text: "Could not switch auto-finish." };
    }),
  );

  on("ui.message", async ($, e) => {
    const message = e.data as CardHitMessage;
    const handled =
      message.kind === "open"
        ? openSession($, message.id)
        : message.kind === "group"
          ? toggleGroup($, message.id)
          : message.kind === "auto-finish"
            ? toggleAutoFinish($, message.id)
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

  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    await markQuestionOpen($).catch((error: unknown) =>
      log($, `could not mark an open question: ${String(error)}`),
    );
    const outcome = await raceOpenQuestion(next(e)).finally(() =>
      clearQuestionOpen($).catch((error: unknown) =>
        log($, `could not clear an open question: ${String(error)}`),
      ),
    );
    if ("result" in outcome) return outcome.result;
    log($, "answered an open question with a choice made on the board");
    return {
      result: {
        questions: e.questions,
        answers: answersOf(e.questions, outcome.answer),
      },
    };
  });

  on("session.receive", async ($, e, next) => {
    const isTaken = await takeRelayedMessage($, e.text).catch(
      (error: unknown) => {
        log($, `could not check a received message: ${String(error)}`);
        return false;
      },
    );
    return isTaken
      ? {
          consumed:
            "a message claudetower relayed, submitted as the user's own",
        }
      : next(e);
  });

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
