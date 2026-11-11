import type { ClientModule } from "claude-code";

import type { CardHitMessage } from "../types";

type Props = {
  id: string;
  canCompose: boolean;
  canAutoPilot?: boolean;
  isGroup?: boolean;
};

const COMPOSE_COLUMNS = 4;
const AUTO_PILOT_COLUMNS = 9;
const CORNER_ROWS = 2;

const zoneOf = (
  current: Props,
  columns: number,
  x: number,
  y: number,
): CardHitMessage["kind"] => {
  if (current.isGroup) return "group";
  const fromRight = columns - x;
  if (y >= CORNER_ROWS) return "open";
  if (current.canCompose && fromRight <= COMPOSE_COLUMNS) return "compose";
  if (
    current.canAutoPilot &&
    fromRight > COMPOSE_COLUMNS &&
    fromRight <= COMPOSE_COLUMNS + AUTO_PILOT_COLUMNS
  )
    return "auto-pilot";
  return "open";
};

const CardHit: ClientModule<Props, Props> = (props, surface) => {
  const { Box } = surface.elements;
  const previous = surface.state;

  if (previous === undefined) {
    let isPressed = false;
    surface.onPointer((event) => {
      if (event.button !== "left") return;
      if (event.type === "down") isPressed = true;
      if (event.type !== "up" || !isPressed) return;
      isPressed = false;
      const current = surface.state ?? props;
      const zone = zoneOf(current, surface.columns, event.x, event.y);
      const message: CardHitMessage = { kind: zone, id: current.id };
      surface.post(message);
    });
  }
  if (
    previous?.id !== props.id ||
    previous.canCompose !== props.canCompose ||
    previous.canAutoPilot !== props.canAutoPilot ||
    previous.isGroup !== props.isGroup
  )
    surface.setState(props);

  return <Box width="100%" height="100%" />;
};

export default CardHit;
