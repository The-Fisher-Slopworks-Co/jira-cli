// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { TransientStatusError, withRetry } from "./retry.js";

const noPause = { sleep: async () => {} };

test("withRetry backs off exponentially, with jitter, between attempts", async () => {
  const pauses: number[] = [];
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls++;
        throw new Error("down");
      },
      () => true,
      { sleep: async (ms) => void pauses.push(ms) },
    ),
  );
  assert.equal(calls, 3);
  assert.equal(pauses.length, 2);
  const [first = 0, second = 0] = pauses;
  assert.ok(first >= 250 && first <= 750, `first pause ${first}`);
  assert.ok(second >= 500 && second <= 1500, `second pause ${second}`);
});

test("withRetry rethrows at once what it isn't told to retry", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error("no such field");
        },
        () => false,
        noPause,
      ),
    /no such field/,
  );
  assert.equal(calls, 1);
});

test("withRetry retries a transient status even when the predicate says no", async () => {
  let calls = 0;
  const value = await withRetry(
    async () => {
      if (++calls === 1) throw new TransientStatusError("HTTP 502");
      return "ok";
    },
    () => false,
    noPause,
  );
  assert.equal(value, "ok");
  assert.equal(calls, 2);
});

test("Retry-After is read as seconds or a date, and capped", () => {
  assert.equal(new TransientStatusError("x", "3").retryAfterMs, 3000);
  assert.equal(new TransientStatusError("x", "600").retryAfterMs, 10_000);
  assert.equal(new TransientStatusError("x", "soon").retryAfterMs, null);
  assert.equal(new TransientStatusError("x").retryAfterMs, null);
  const inFive = new Date(Date.now() + 5000).toUTCString();
  const fromDate = new TransientStatusError("x", inFive).retryAfterMs ?? 0;
  assert.ok(fromDate > 3000 && fromDate <= 5000, `from date ${fromDate}`);
});
