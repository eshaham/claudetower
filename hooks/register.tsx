import type { Register } from "claude-code";

import type { CardHitMessage } from "../types";
import {
  checkInbox,
  isPaneOpen,
  load,
  openPane,
  openSession,
  poll,
  setPaneOpen,
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
    await discoverHost($);
    await $.command.register({
      name: "tower",
      description: "Open the claudtower session board",
    });
    $.clock.every(POLL_MS, () => poll($));
    $.clock.every(INBOX_POLL_MS, () => checkInbox($));
    void poll($);

    return next(e);
  });

  on("command.run", { command: "tower" }, async ($) => {
    await openPane($);
    void load($);

    return { text: "Session board opened." };
  });

  on("ui.message", async ($, e) => {
    const message = e.data as CardHitMessage;
    if (message.kind === "open") await openSession($, message.id);
    if (message.kind === "toggle") await togglePreview($, message.id);

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
