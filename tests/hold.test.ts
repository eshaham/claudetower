import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { holdPlaces } from "../hooks/lib/hold";

const card = (id: string) => ({ id });
const byIdOf = (...ids: string[]) => new Map(ids.map((id) => [id, card(id)]));
const idsOf = (sections: Record<string, { id: string }[]>) =>
  Object.fromEntries(
    Object.entries(sections).map(([key, items]) => [
      key,
      items.map((item) => item.id),
    ]),
  );

describe("holding cards in place", () => {
  it("keeps a held card where it was when it would leave the list", () => {
    const held = holdPlaces(
      { finish: [card("a")], open: [card("c")] },
      { finish: ["a", "b"], open: ["c"] },
      new Set(["b"]),
      byIdOf("a", "b", "c"),
    );
    assert.deepEqual(idsOf(held), { finish: ["a", "b"], open: ["c"] });
  });

  it("keeps a held card in its old section when it would move", () => {
    const held = holdPlaces(
      { finish: [card("a")], open: [card("b"), card("c")] },
      { finish: ["b", "a"], open: ["c"] },
      new Set(["b"]),
      byIdOf("a", "b", "c"),
    );
    assert.deepEqual(idsOf(held), { finish: ["b", "a"], open: ["c"] });
  });

  it("lets cards that are not held move freely", () => {
    const held = holdPlaces(
      { finish: [], open: [card("a")] },
      { finish: ["a"], open: [] },
      new Set(),
      byIdOf("a"),
    );
    assert.deepEqual(idsOf(held), { finish: [], open: ["a"] });
  });

  it("drops a held card that no longer exists", () => {
    const held = holdPlaces(
      { finish: [], open: [] },
      { finish: ["gone"], open: [] },
      new Set(["gone"]),
      byIdOf(),
    );
    assert.deepEqual(idsOf(held), { finish: [], open: [] });
  });

  it("places a held card that was not shown before where it is now", () => {
    const held = holdPlaces(
      { finish: [card("a")], open: [] },
      { finish: [], open: [] },
      new Set(["a"]),
      byIdOf("a"),
    );
    assert.deepEqual(idsOf(held), { finish: ["a"], open: [] });
  });
});
