export type Places = Record<string, string[]>;

export function holdPlaces<T extends { id: string }>(
  sections: Record<string, T[]>,
  previous: Places,
  held: Set<string>,
  byId: Map<string, T>,
): Record<string, T[]> {
  const result = Object.fromEntries(
    Object.entries(sections).map(([key, items]) => [
      key,
      items.filter((item) => !held.has(item.id)),
    ]),
  );
  const placed = new Set<string>();
  for (const [key, ids] of Object.entries(previous))
    ids.forEach((id, index) => {
      const item = byId.get(id);
      if (!held.has(id) || !item || placed.has(id)) return;
      placed.add(id);
      const list = (result[key] ??= []);
      list.splice(Math.min(index, list.length), 0, item);
    });
  for (const [key, items] of Object.entries(sections))
    for (const item of items)
      if (held.has(item.id) && !placed.has(item.id)) {
        placed.add(item.id);
        const list = (result[key] ??= []);
        list.splice(Math.min(items.indexOf(item), list.length), 0, item);
      }
  return result;
}

export const placesOf = <T extends { id: string }>(
  sections: Record<string, T[]>,
): Places =>
  Object.fromEntries(
    Object.entries(sections).map(([key, items]) => [
      key,
      items.map((item) => item.id),
    ]),
  );
