import type { EngineInterface, RenderInput } from "claude-code";

import { startSetup, useDefaultRanking } from "../lib/board";

export const SETUP_TITLE = "✨ Rank sessions your way";

export function setupButtons(
  $: EngineInterface,
  { Button }: ReturnType<EngineInterface["ui"]["resolve"]>,
  place: string,
) {
  return [
    <Button
      key={`setup-start-${place}`}
      variant="primary"
      label="Set up"
      onPress={() => startSetup($)}
    />,
    <Button
      key={`setup-default-${place}`}
      variant="secondary"
      label="Use the default"
      onPress={() => useDefaultRanking($)}
    />,
  ];
}

export function renderSetupBand(
  $: EngineInterface,
  e: RenderInput<"AbovePrompt">,
) {
  const elements = $.ui.resolve(e);
  const { Box, Text } = elements;
  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      <Text weight="semibold" color="claude">
        {SETUP_TITLE}
      </Text>
      <Text dimColor wrap="truncate-end">
        · choose how claudetower ranks your sessions, then its panel opens
      </Text>
      {setupButtons($, elements, "band")}
    </Box>
  );
}
