import type { ClientModule } from "claude-code";

import type { CardHitMessage } from "../types";

type Props = { id: string; canToggle: boolean };

const CORNER_COLUMNS = 4;
const CORNER_ROWS = 2;

const CardHit: ClientModule<Props, Props> = (props, surface) => {
  const { Box } = surface.elements;
  const previous = surface.state;

  if (previous === undefined)
    surface.onPointer((event) => {
      if (event.type !== "up" || event.button !== "left") return;
      const current = surface.state ?? props;
      const isCorner =
        current.canToggle &&
        event.x >= surface.columns - CORNER_COLUMNS &&
        event.y < CORNER_ROWS;
      const message: CardHitMessage = {
        kind: isCorner ? "toggle" : "open",
        id: current.id,
      };
      surface.post(message);
    });
  if (previous?.id !== props.id || previous.canToggle !== props.canToggle)
    surface.setState(props);

  return <Box width="100%" height="100%" />;
};

export default CardHit;
