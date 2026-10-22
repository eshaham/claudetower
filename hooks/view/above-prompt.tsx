import type { EngineInterface, RenderInput } from "claude-code";

import { openPane, readCards } from "../lib/board";
import { isAskingYou } from "../lib/classify";
import { FRESH_MS, host } from "../lib/config";

export async function renderAbovePrompt(
  $: EngineInterface,
  e: RenderInput<"AbovePrompt">,
) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const waiting = (await readCards($)).filter(
    (card) =>
      isAskingYou(card) &&
      !card.isRunning &&
      card.ageMs < FRESH_MS &&
      card.cliId !== host.selfCliId,
  );
  const top = waiting[0];

  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={waiting.length > 0 ? "error" : "success"}>
        {waiting.length > 0
          ? `${waiting.length} need you`
          : "Nothing needs you"}
      </Text>
      {top && (
        <Text dimColor wrap="truncate-end">
          · {top.title}
        </Text>
      )}
      <Button key="tower-open" label="Sessions" onPress={() => openPane($)} />
    </Box>
  );
}
