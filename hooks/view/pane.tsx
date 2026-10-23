import type { EngineInterface, RenderChildren, RenderInput } from "claude-code";

import type { PrState, SessionCard } from "../../types";
import {
  archiveSession,
  readCards,
  openSession,
  readPreviewed,
  readComposing,
  readDraft,
  setDraft,
  readPending,
  readNeedsSetup,
  readCollapsedGroups,
  toggleGroup,
  sendText,
  startAction,
  togglePreview,
} from "../lib/board";
import {
  LANES,
  badgeOf,
  belongsInList,
  isAskingYou,
  isUnread,
  reasonOf,
} from "../lib/classify";
import {
  BOARD_MIN_COLUMNS,
  CARDS_PER_LANE,
  CARD_LIMIT,
  DAY_MS,
  FRESH_MS,
  HOUR_MS,
  LINE_LIMIT,
  MINUTE_MS,
  PANE_COLUMNS,
  host,
} from "../lib/config";
import { isOpenPr } from "../lib/enrich";
import { loadRanking } from "../lib/ranking";
import { SETUP_TITLE, setupButtons } from "./setup";
import {
  BUBBLE_BORDER,
  CHEVRON_SIZE,
  PENCIL_SIZE,
  PR_ICON_SIZE,
  PR_STYLES,
  chevron,
  pencil,
  prIcon,
} from "./icons";

export const ago = (ms: number) => {
  if (ms < HOUR_MS) return `${Math.max(0, Math.round(ms / MINUTE_MS))}m`;
  if (ms < 2 * DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
};

const TICKET_PRIORITY_NAMES: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

const factsLine = (card: SessionCard) =>
  [
    card.project,
    card.ticket &&
      [
        card.ticket,
        TICKET_PRIORITY_NAMES[card.ticketPriority],
        card.ticketStatus,
      ]
        .filter(Boolean)
        .join(" "),
    card.uncommittedFiles > 0 ? `${card.uncommittedFiles} uncommitted` : "",
    ago(card.ageMs),
  ]
    .filter(Boolean)
    .join(" · ");

const COMPOSER_MAX_ROWS = 8;
const COMPOSER_CHROME_COLUMNS = 10;

const composerRows = (text: string, width: number) => {
  const perRow = Math.max(20, width - COMPOSER_CHROME_COLUMNS);
  const rows = text
    .split("\n")
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / perRow)),
      0,
    );
  return Math.min(COMPOSER_MAX_ROWS, Math.max(2, rows));
};

const hasPreview = (card: SessionCard) =>
  card.lastAsk !== "" || card.lastReply !== "";

export async function renderPane($: EngineInterface, e: RenderInput<"Pane">) {
  const resolved = $.ui.resolve(e);
  const { Box, Text, Button, Markdown } = resolved;
  const Svg = "Svg" in resolved ? resolved.Svg : null;
  const Client = "Client" in resolved ? resolved.Client : null;
  const [
    list,
    previewedId,
    pendingAt,
    composingId,
    draftText,
    ranking,
    isSettingUp,
    collapsedGroups,
  ] = await Promise.all([
    readCards($),
    readPreviewed($),
    readPending($),
    readComposing($),
    readDraft($),
    loadRanking($),
    readNeedsSetup($),
    readCollapsedGroups($),
  ]);
  const Input = "Input" in resolved ? resolved.Input : null;
  const isProcessing = (card: SessionCard) =>
    card.isRunning || (pendingAt[card.id] ?? 0) > card.lastAt;
  const canCompose = (card: SessionCard) =>
    card.cliId !== host.selfCliId && !isProcessing(card);
  const width = e.props.bodyColumns || e.viewport?.columns || PANE_COLUMNS;
  const isSelf = (card: SessionCard) => card.cliId === host.selfCliId;
  const self = list.find(isSelf);
  const others = list.filter((card) => !isSelf(card));
  const listed = others.filter((card) => belongsInList(card, ranking));
  const ranked = listed.filter((card) => !card.isFinishing);
  const finishing = listed
    .filter((card) => card.isFinishing)
    .sort((a, b) => b.ageMs - a.ageMs);
  const running = others.filter(
    (card) => card.isRunning && card.ageMs < FRESH_MS,
  );
  const asking = ranked.filter(isAskingYou).length;
  const unread = others.filter(isUnread).length;

  const summary = (
    <Box flexDirection="row" columnGap={1}>
      <Text weight="semibold">{asking} need you</Text>
      {finishing.length > 0 && (
        <Text dimColor>· {finishing.length} to finish</Text>
      )}
      {unread > 0 && <Text dimColor>· reading {unread}…</Text>}
    </Box>
  );

  const group = (id: string, title: string, items: RenderChildren[]) => (
    <Box key={`group-${id}`} flexDirection="column" rowGap={1}>
      <Button
        key={`group-toggle-${id}`}
        plain
        dimColor
        hover={{ dimColor: false }}
        label={`${collapsedGroups[id] ? "▸" : "▾"} ${title}`}
        onPress={() => toggleGroup($, id)}
      />
      {!collapsedGroups[id] && items}
    </Box>
  );

  const prIconOf = (state: PrState) =>
    Svg ? (
      <Svg
        source={prIcon(state)}
        alt={PR_STYLES[state].label}
        width={PR_ICON_SIZE}
        height={PR_ICON_SIZE}
      />
    ) : (
      <Text dimColor>{state}</Text>
    );

  const mergedCount = (count: number) =>
    count > 0 && (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {prIconOf("merged")}
        <Text dimColor>{count}</Text>
      </Box>
    );

  const prLines = (card: SessionCard) => {
    const open = card.prs.filter((pr) => isOpenPr(pr.state));
    const merged = card.prs.filter((pr) => pr.state === "merged").length;
    if (open.length === 0)
      return merged > 0 ? (
        <Box key={`prs-${card.id}`}>{mergedCount(merged)}</Box>
      ) : null;
    return open.map((pr, index) => (
      <Box
        key={`pr-${card.id}-${pr.number}`}
        flexDirection="row"
        columnGap={1}
        alignItems="center"
      >
        {prIconOf(pr.state)}
        <Text dimColor>#{pr.number}</Text>
        {pr.additions + pr.deletions > 0 && (
          <Text>
            <Text color="success">+{pr.additions}</Text>{" "}
            <Text color="error">−{pr.deletions}</Text>
          </Text>
        )}
        {pr.failing > 0 && <Text color="error">{pr.failing} failing</Text>}
        {pr.failing === 0 && pr.pending > 0 && (
          <Text color="warning">{pr.pending} running</Text>
        )}
        {index === 0 && mergedCount(merged)}
      </Box>
    ));
  };

  const reason = (card: SessionCard) => {
    const badge = badgeOf(card);
    const band = card.isRunning ? null : card.band;
    return (
      <Text wrap="wrap">
        {band && (
          <Text color={band.color} weight="semibold">
            {band.name}{" "}
          </Text>
        )}
        {badge && (
          <Text color={badge.color} weight="semibold">
            {badge.title}{" "}
          </Text>
        )}
        <Text>{reasonOf(card)}</Text>
        {card.isRereading && <Text dimColor> · updating…</Text>}
      </Text>
    );
  };

  const actions = (card: SessionCard) => {
    if (isProcessing(card))
      return (
        <Box marginTop={1}>
          <Text dimColor>Working…</Text>
        </Box>
      );
    const { options } = card;
    if (options.length === 0 && !card.canArchive) return null;
    return (
      <Box flexDirection="column" marginTop={1} rowGap={1}>
        {options.length > 0 && card.question !== "" && (
          <Text dimColor wrap="wrap">
            {card.question}
          </Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {options.map((option, index) => (
            <Button
              key={`option-${card.id}-${index}`}
              variant={index === 0 ? "primary" : "secondary"}
              label={option.label}
              onPress={() => startAction($, card, option)}
            />
          ))}
          {card.canArchive && (
            <Button
              key={`archive-${card.id}`}
              variant={options.length === 0 ? "primary" : "secondary"}
              label="Archive"
              onPress={() => archiveSession($, card)}
            />
          )}
        </Box>
      </Box>
    );
  };

  const preview = (card: SessionCard) =>
    previewedId === card.id && (
      <Box flexDirection="column" marginTop={1} rowGap={1}>
        {card.lastAsk !== "" && (
          <Box flexDirection="column" alignItems="flex-end">
            <Text dimColor size="caption">
              You wrote
              {card.lastAskAgoMs > 0 ? ` · ${ago(card.lastAskAgoMs)} ago` : ""}
            </Text>
            <Box
              width="85%"
              borderStyle="bold"
              borderColor={BUBBLE_BORDER}
              paddingX={2}
            >
              <Text wrap="wrap">{card.lastAsk}</Text>
            </Box>
          </Box>
        )}
        {card.lastReply !== "" && <Markdown text={card.lastReply} />}
      </Box>
    );

  const cardView = (card: SessionCard) => (
    <Box
      key={`card-${card.id}`}
      position="relative"
      flexDirection="column"
      borderStyle="round"
      paddingX={1}
    >
      <Box key={`body-${card.id}`} position="relative" flexDirection="column">
        <Box paddingRight={7}>
          <Text weight="semibold" wrap="wrap">
            {card.title}
          </Text>
        </Box>
        <Text dimColor size="caption" wrap="wrap">
          {factsLine(card)}
        </Text>
        {card.verdict && card.verdict.labels.length > 0 && (
          <Text color="subtle" size="caption" wrap="wrap">
            {card.verdict.labels.join(" · ")}
          </Text>
        )}
        {prLines(card)}
        {reason(card)}
        {Svg && canCompose(card) && (
          <Box position="absolute" top={0} right={3}>
            <Svg
              source={pencil(composingId === card.id)}
              alt="Write to this session"
              width={PENCIL_SIZE}
              height={PENCIL_SIZE}
            />
          </Box>
        )}
        {Svg && hasPreview(card) && (
          <Box position="absolute" top={0} right={0}>
            <Svg
              source={chevron(previewedId === card.id)}
              alt={previewedId === card.id ? "Collapse" : "Expand"}
              width={CHEVRON_SIZE}
              height={CHEVRON_SIZE}
            />
          </Box>
        )}
        {Client && (
          <Box position="absolute" top={0} left={0} right={0} bottom={0}>
            <Client
              key={`hit-${card.id}`}
              module="../card-hit.tsx"
              props={{
                id: card.id,
                canToggle: hasPreview(card),
                canCompose: canCompose(card),
              }}
              width="100%"
              height="100%"
            />
          </Box>
        )}
      </Box>
      {preview(card)}
      {actions(card)}
      {composingId === card.id && canCompose(card) && Input && (
        <Box marginTop={1} width="100%" flexDirection="column">
          <Input
            key={`compose-${card.id}`}
            placeholder="Write to this session…"
            submitLabel="↵"
            rows={composerRows(draftText, width)}
            value={draftText}
            autoFocus
            onInput={(text) => setDraft($, text)}
            onSubmit={(text) => sendText($, card, text)}
          />
        </Box>
      )}
      {previewedId === card.id && (
        <Box marginTop={1} flexDirection="row" justifyContent="center">
          <Button
            key={`collapse-${card.id}`}
            plain
            dimColor
            hover={{ dimColor: false, underline: true }}
            label="Collapse ▴"
            onPress={() => togglePreview($, card.id)}
          />
        </Box>
      )}
    </Box>
  );

  const runningLine = (card: SessionCard) => (
    <Box key={`line-${card.id}`} flexDirection="row" columnGap={1}>
      <Button
        key={`open-${card.id}`}
        plain
        onPress={() => openSession($, card.id)}
      >
        {card.title}
      </Button>
      <Text dimColor wrap="truncate-end">
        {card.project}
      </Text>
    </Box>
  );

  const setupCard = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="claude"
      paddingX={1}
      rowGap={1}
    >
      <Text weight="semibold" color="claude">
        {SETUP_TITLE}
      </Text>
      <Text wrap="wrap">
        claudetower ranks your sessions with a default that works for anyone.
        Tell it what matters to you in a short setup, run in a new session.
      </Text>
      <Box flexDirection="row" columnGap={1}>
        {setupButtons($, resolved, "pane")}
      </Box>
    </Box>
  );

  if (isSettingUp)
    return (
      <Box flexDirection="column" rowGap={1}>
        {setupCard}
        <Text dimColor wrap="wrap">
          Your sessions show here once you choose how to rank them.
        </Text>
      </Box>
    );

  if (list.length === 0) return <Text dimColor>Loading your sessions…</Text>;

  if (width >= BOARD_MIN_COLUMNS) {
    const laneWidth = `${Math.floor(100 / LANES.length)}%`;
    return (
      <Box flexDirection="column" rowGap={1}>
        {summary}
        <Box flexDirection="row" columnGap={1}>
          {LANES.map((lane) => {
            const items = [...finishing, ...ranked, ...running].filter(
              (card) => card.lane === lane.id,
            );
            return (
              <Box
                key={lane.id}
                flexDirection="column"
                width={laneWidth}
                flexGrow={0}
                flexShrink={0}
                minWidth={0}
                rowGap={1}
              >
                <Text color={lane.color} weight="semibold">
                  {lane.title} ({items.length})
                </Text>
                <Text dimColor size="caption" wrap="wrap">
                  {lane.hint}
                </Text>
                {items.slice(0, CARDS_PER_LANE).map(cardView)}
                {items.length > CARDS_PER_LANE && (
                  <Text dimColor>+{items.length - CARDS_PER_LANE} more</Text>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      {self && group("self", "This session", [cardView(self)])}
      {summary}
      {finishing.length > 0 &&
        group("finish", `Finish (${finishing.length})`, [
          ...finishing.slice(0, ranking.finish.show).map(cardView),
          finishing.length > ranking.finish.show && (
            <Text key="finish-more" dimColor>
              +{finishing.length - ranking.finish.show} more to finish
            </Text>
          ),
        ])}
      {ranked.length > 0 &&
        group("open", `Open sessions (${ranked.length})`, [
          ...ranked.slice(0, CARD_LIMIT).map(cardView),
          ranked.length > CARD_LIMIT && (
            <Text key="open-more" dimColor>
              +{ranked.length - CARD_LIMIT} more
            </Text>
          ),
        ])}
      {running.length > 0 &&
        group(
          "running",
          `Running (${running.length})`,
          running.slice(0, LINE_LIMIT).map(runningLine),
        )}
    </Box>
  );
}
