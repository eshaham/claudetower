import type { ClientModule } from "claude-code";

import type { CardHitMessage } from "../types";

type Props = { id: string; canToggle: boolean; canCompose: boolean };

const TOGGLE_COLUMNS = 3;
const COMPOSE_COLUMNS = 4;
const CORNER_ROWS = 2;

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
      const fromRight = surface.columns - event.x;
      const inCorner = event.y < CORNER_ROWS;
      const kind: CardHitMessage["kind"] =
        inCorner && current.canToggle && fromRight <= TOGGLE_COLUMNS
          ? "toggle"
          : inCorner &&
              current.canCompose &&
              fromRight <= TOGGLE_COLUMNS + COMPOSE_COLUMNS
            ? "compose"
            : "open";
      const message: CardHitMessage = { kind, id: current.id };
      surface.post(message);
    });
  }
  if (
    previous?.id !== props.id ||
    previous.canToggle !== props.canToggle ||
    previous.canCompose !== props.canCompose
  )
    surface.setState(props);

  return <Box width="100%" height="100%" />;
};

export default CardHit;
