type Ref = { plugin: string; key: string };
type Atom<T> = Ref & { initial: T };

const values = new Map<string, unknown>();
const keyOf = (ref: Ref) => `${ref.plugin}/${ref.key}`;

export const atom = <T>(ref: Ref, initial: T): Atom<T> => ({ ...ref, initial });

export async function read<T>(_: unknown, target: Atom<T>): Promise<T> {
  const key = keyOf(target);
  return values.has(key) ? (values.get(key) as T) : target.initial;
}

export async function update<T>(
  _: unknown,
  target: Atom<T>,
  change: (value: T) => T,
): Promise<T> {
  const next = change(await read(_, target));
  values.set(keyOf(target), next);
  return next;
}
