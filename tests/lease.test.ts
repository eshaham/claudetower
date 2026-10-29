import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Lease, LeaseFile } from "../hooks/lib/lease";
import { holdLease, leaseActionOf } from "../hooks/lib/lease";

const EXPIRES = 30_000;

const sharedFile = (initial: Lease | null = null) => {
  let stored = initial;
  const fileFor = (): LeaseFile => ({
    read: async () => stored,
    write: async (lease) => {
      stored = lease;
    },
    settle: async () => undefined,
  });
  return { fileFor, current: () => stored };
};

describe("lease decisions", () => {
  it("renews its own lease", () => {
    assert.equal(
      leaseActionOf({ id: "a", at: 0 }, "a", 999_999, EXPIRES),
      "renew",
    );
  });

  it("follows a fresh lease held by another session", () => {
    assert.equal(
      leaseActionOf({ id: "b", at: 1000 }, "a", 20_000, EXPIRES),
      "follow",
    );
  });

  it("takes a lease nobody holds, or one whose holder went quiet", () => {
    assert.equal(leaseActionOf(null, "a", 0, EXPIRES), "take");
    assert.equal(
      leaseActionOf({ id: "b", at: 0 }, "a", EXPIRES + 1, EXPIRES),
      "take",
    );
  });
});

describe("holding the lease", () => {
  it("lets the first session lead and the next one follow", async () => {
    const shared = sharedFile();
    assert.equal(await holdLease(shared.fileFor(), "a", 1000, EXPIRES), true);
    assert.equal(await holdLease(shared.fileFor(), "b", 2000, EXPIRES), false);
    assert.equal(shared.current()?.id, "a");
  });

  it("keeps the leader's heartbeat fresh", async () => {
    const shared = sharedFile({ id: "a", at: 0 });
    assert.equal(await holdLease(shared.fileFor(), "a", 25_000, EXPIRES), true);
    assert.equal(shared.current()?.at, 25_000);
    assert.equal(
      await holdLease(shared.fileFor(), "b", 50_000, EXPIRES),
      false,
    );
  });

  it("hands the board to another session when the leader stops", async () => {
    const shared = sharedFile({ id: "a", at: 0 });
    assert.equal(
      await holdLease(shared.fileFor(), "b", EXPIRES + 1, EXPIRES),
      true,
    );
    assert.equal(shared.current()?.id, "b");
    assert.equal(
      await holdLease(shared.fileFor(), "a", EXPIRES + 2, EXPIRES),
      false,
    );
  });

  it("leaves one leader when two sessions take the lease at once", async () => {
    const shared = sharedFile();
    let release = () => {};
    const bothWritten = new Promise<void>((resolve) => {
      let waiting = 2;
      release = () => {
        waiting -= 1;
        if (waiting === 0) resolve();
      };
    });
    const racer = (): LeaseFile => {
      const file = shared.fileFor();
      return {
        ...file,
        settle: async () => {
          release();
          await bothWritten;
        },
      };
    };
    const [a, b] = await Promise.all([
      holdLease(racer(), "a", 1000, EXPIRES),
      holdLease(racer(), "b", 1000, EXPIRES),
    ]);
    assert.equal(Number(a) + Number(b), 1);
    assert.equal(shared.current()?.id, a ? "a" : "b");
  });
});
