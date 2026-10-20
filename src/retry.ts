// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Attempts per call, the first one included. */
export const RETRY_ATTEMPTS = 3;

/** Pause before the second attempt; it doubles for each one after. */
const BASE_DELAY_MS = 500;

/**
 * Longest `Retry-After` honoured. A server asking for minutes is better answered
 * with a failure the caller can retry on their own schedule than with a hang.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Statuses that say "try again shortly" rather than "no": rate limiting, and a
 * proxy or gateway in front of Jira that lost its connection to it.
 */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

/** Whether an HTTP status is worth another attempt. */
export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

/**
 * A response with a {@link isTransientStatus transient status}. Carries the
 * server's `Retry-After`, if it sent a usable one.
 */
export class TransientStatusError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfter: string | null = null) {
    super(message);
    this.name = "TransientStatusError";
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Told before each retry: the failure, and the attempt about to start. */
  onRetry?: ((err: Error, attempt: number) => void) | undefined;
  /** Waits between attempts. Defaults to a timer; tests pass one that doesn't. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Run `fn` up to {@link RETRY_ATTEMPTS} times while it fails with an error
 * `retryable` accepts or a {@link TransientStatusError}, backing off
 * exponentially with jitter (so a burst of clients doesn't retry in lockstep) or
 * as long as `Retry-After` asks. Anything else, and the last failure, propagate.
 *
 * Only for calls that are safe to repeat — every call this CLI makes reads, or
 * signs in, which is idempotent.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryable: (err: unknown) => boolean,
  options: RetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = err instanceof TransientStatusError;
      if (
        !(err instanceof Error) ||
        !(transient || retryable(err)) ||
        attempt >= RETRY_ATTEMPTS
      )
        throw err;
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
      const delay =
        transient && err.retryAfterMs != null
          ? err.retryAfterMs
          : backoff / 2 + Math.random() * backoff;
      options.onRetry?.(err, attempt + 1);
      await sleep(delay);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `Retry-After` in milliseconds, capped at {@link MAX_RETRY_AFTER_MS}: either
 * delay-seconds or an HTTP date. `null` when absent or unparseable.
 */
function parseRetryAfter(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}
