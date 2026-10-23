import type { Register } from "claude-code";

import type { CardHitMessage } from "../types";
import {
  checkInbox,
  followOtherSessions,
  isPaneOpen,
  load,
  openPane,
  openSession,
  poll,
  setPaneOpen,
  toggleCompose,
  togglePreview,
} from "./lib/board";
import {
  INBOX_POLL_MS,
  PANE,
  POLL_MS,
  discoverHost,
  log,
  setTicketPrefixes,
} from "./lib/config";
import { renderAbovePrompt } from "./view/above-prompt";
import { renderPane } from "./view/pane";

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
    void discoverHost($)
      .then(() => {
        $.clock.every(POLL_MS, () =>
          poll($).catch((error: unknown) =>
            log($, `could not refresh: ${String(error)}`),
          ),
        );
        $.clock.every(INBOX_POLL_MS, () =>
          checkInbox($).catch((error: unknown) =>
            log($, `could not check for answers: ${String(error)}`),
          ),
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
          : toggleCompose($, message.id);
    await handled.catch((error: unknown) =>
      log($, `could not handle a ${message.kind} click: ${String(error)}`),
    );

    return {};
  });

  on("ui.close", async ($, e, next) => {
    const closed = await next(e);
    if (e.id === PANE && e.origin.kind === "person")
      await setPaneOpen($, false).catch((error: unknown) =>
        log($, `could not record the close: ${String(error)}`),
      );

    return closed;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) =>
    e.props.hasSurvey || (await isPaneOpen($))
      ? next(e)
      : renderAbovePrompt($, e),
  );

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) =>
    renderPane($, e),
  );
};
