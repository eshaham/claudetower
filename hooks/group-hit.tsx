import type { ClientModule } from "claude-code";

import type { CardHitMessage } from "../types";

type Props = { id: string };

const GroupHit: ClientModule<Props, Props> = (props, surface) => {
  const { Box } = surface.elements;
  const previous = surface.state;

  if (previous === undefined) {
    let isPressed = false;
    surface.onPointer((event) => {
      if (event.button !== "left") return;
      if (event.type === "down") isPressed = true;
      if (event.type !== "up" || !isPressed) return;
      isPressed = false;
      const message: CardHitMessage = {
        kind: "group",
        id: (surface.state ?? props).id,
      };
      surface.post(message);
    });
  }
  if (previous?.id !== props.id) surface.setState(props);

  return <Box width="100%" height="100%" />;
};

export default GroupHit;
