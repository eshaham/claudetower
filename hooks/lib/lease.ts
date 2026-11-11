export type Lease = { id: string; at: number; version?: number };

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
  version = 0,
): LeaseAction {
  if (current?.id === self) return "renew";
  if (!current || now - current.at > expiresAfterMs) return "take";
  return (current.version ?? 0) < version ? "take" : "follow";
}

export async function holdLease(
  file: LeaseFile,
  self: string,
  now: number,
  expiresAfterMs: number,
  version = 0,
) {
  const action = leaseActionOf(
    await file.read(),
    self,
    now,
    expiresAfterMs,
    version,
  );
  if (action === "follow") return false;
  await file.write({ id: self, at: now, version });
  if (action === "renew") return true;
  await file.settle();
  return (await file.read())?.id === self;
}
