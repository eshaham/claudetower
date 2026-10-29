export type Lease = { id: string; at: number };

export type LeaseFile = {
  read: () => Promise<Lease | null>;
  write: (lease: Lease) => Promise<void>;
  settle: () => Promise<void>;
};

export type LeaseAction = "renew" | "take" | "follow";

export const isLease = (value: unknown): value is Lease =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Lease).id === "string" &&
  typeof (value as Lease).at === "number";

export function leaseActionOf(
  current: Lease | null,
  self: string,
  now: number,
  expiresAfterMs: number,
): LeaseAction {
  if (current?.id === self) return "renew";
  if (!current || now - current.at > expiresAfterMs) return "take";
  return "follow";
}

export async function holdLease(
  file: LeaseFile,
  self: string,
  now: number,
  expiresAfterMs: number,
) {
  const action = leaseActionOf(await file.read(), self, now, expiresAfterMs);
  if (action === "follow") return false;
  await file.write({ id: self, at: now });
  if (action === "renew") return true;
  await file.settle();
  return (await file.read())?.id === self;
}
