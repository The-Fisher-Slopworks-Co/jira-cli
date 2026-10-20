// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DETAIL_ISSUE_FIELDS,
  JiraAuthError,
  JiraClient,
  JiraError,
  issuePath,
  parseIssue,
  type JiraAttachment,
  type JiraComment,
  type JiraSession,
  type JiraSubtask,
} from "@slopworks/jira";

import type { CredentialStore } from "./credentials.js";
import {
  isTransientStatus,
  RETRY_ATTEMPTS,
  TransientStatusError,
  withRetry,
  type RetryOptions,
} from "./retry.js";
import { makeSessionStore, type SessionStore } from "./session.js";

// Re-export the library's session type, 401 error, and the comment/attachment/
// subtask shapes so the rest of the CLI imports everything Jira-related from
// this one module.
export type { JiraAttachment, JiraComment, JiraSession, JiraSubtask };
export { JiraAuthError };

/**
 * Exit code for a Jira that could not be reached at all. Distinct from `1` so a
 * script or an agent can tell "try again once the network is back" from "this
 * issue does not exist" without parsing stderr.
 */
export const EXIT_UNREACHABLE = 3;

/**
 * Jira could not be reached: the connection was refused, dropped mid-response
 * or timed out, or the host did not resolve. Kept apart from "not found" and
 * from a rejected sign-in because the remedy is different — the network, often
 * a corporate VPN, rather than the key or the password.
 */
export class JiraUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `could not reach ${hostOf(url)} (${networkReason(cause)}) — check your network or VPN`,
      { cause },
    );
    this.name = "JiraUnreachableError";
  }
}

/**
 * The issue body the CLI prints: header facts plus description, subtasks,
 * comments, and attachments. A missing summary is tolerated — viewing an issue
 * shouldn't fail just because it has none.
 */
export interface JiraIssueDetails {
  key: string;
  summary: string | null;
  /** Workflow status name as the instance spells it, or `null` if absent. */
  status: string | null;
  issueType: string | null;
  parentKey: string | null;
  parentSummary: string | null;
  description: string | null;
  comments: JiraComment[];
  attachments: JiraAttachment[];
  /** Child subtasks (each with key, summary, status, type), or `[]` if none. */
  subtasks: JiraSubtask[];
}

/**
 * One issue link, as seen from the issue that carries it: Jira nests the *other*
 * issue under `inwardIssue` or `outwardIssue`, and which one it is decides the
 * wording ({@link JiraIssueLink.relation}). The linked issue's status rides along
 * in the same response, so "is this blocked by something still open?" is
 * answerable from a search alone, without a request per link.
 */
export interface JiraIssueLink {
  /** The relationship in this direction, as Jira words it (e.g. `is blocked by`). */
  relation: string | null;
  key: string;
  summary: string | null;
  /** Workflow status name of the linked issue, or `null` if absent. */
  status: string | null;
}

/**
 * One row of a search result: an issue's triage facts without its body. What
 * `jira search` needs to rank a version's backlog — and deliberately not
 * `description` or `comment`, which are what `jira issue <KEY>` is for.
 */
export interface JiraSearchRow {
  key: string;
  summary: string | null;
  status: string | null;
  issueType: string | null;
  /** Display name of the assignee, or `null` when the issue is unassigned. */
  assignee: string | null;
  priority: string | null;
  /** ISO-8601 timestamp of the last change, as Jira returned it, or `null`. */
  updated: string | null;
  components: string[];
  labels: string[];
  fixVersions: string[];
  links: JiraIssueLink[];
}

/**
 * One page of search results. The totals are part of the payload on purpose:
 * Jira caps a page instance-side, so a caller that only sees `issues` cannot
 * tell a complete answer from the first slice of a long one.
 */
export interface JiraSearchResults {
  /** Index of the first row within the whole result set. */
  startAt: number;
  /** Page size Jira actually applied, which may be below the one asked for. */
  maxResults: number;
  /** Matches in total — larger than `issues.length` when this page is a slice. */
  total: number;
  issues: JiraSearchRow[];
}

/** Paging options for {@link JiraApi.searchIssues}. */
export interface JiraSearchOptions {
  /** Index of the first result to return. Defaults to 0. */
  startAt?: number;
  /** Page size to ask for. Defaults to {@link DEFAULT_SEARCH_LIMIT}. */
  maxResults?: number;
}

/**
 * The CLI's narrow Jira surface: load or establish a session, fetch the one
 * issue shape it renders, run a JQL search, and pull an attachment's bytes.
 * Backed by the library's {@link JiraClient}, but kept as an interface so tests
 * inject an in-memory stub instead of reaching the network.
 */
export interface JiraApi {
  /** The persisted session, or `null` if there isn't one. */
  loadSession(): Promise<JiraSession | null>;
  /**
   * Authenticate and persist the resulting session. Throws
   * {@link JiraUnreachableError} when Jira can't be reached, and an error with a
   * human-readable message on bad credentials or a non-Server instance.
   */
  login(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<JiraSession>;
  /**
   * Fetch an issue's full body for display. Returns `null` when Jira says the
   * issue does not exist or is not visible to you (404 / 403). Throws
   * {@link JiraAuthError} on a 401 so the caller can re-authenticate,
   * {@link JiraUnreachableError} when Jira can't be reached, and a plain `Error`
   * on any other failure — a network drop must never read as "not found".
   */
  fetchIssueDetails(
    session: JiraSession,
    key: string,
  ): Promise<JiraIssueDetails | null>;
  /**
   * Run a JQL search and return one page of rows. `jql` is passed to Jira
   * verbatim — no clause is appended, so what the caller wrote is what runs.
   *
   * Unlike {@link JiraApi.fetchIssueDetails} this throws rather than returning
   * `null` on a recoverable failure: a rejected query is the normal way to get a
   * typo wrong, and Jira's own explanation ("Field 'foo' does not exist…") is
   * worth far more to the caller than an empty result would be. Throws
   * {@link JiraAuthError} on a 401, {@link JiraUnreachableError} when Jira can't
   * be reached, and a plain `Error` carrying Jira's message on anything else.
   */
  searchIssues(
    session: JiraSession,
    jql: string,
    options?: JiraSearchOptions,
  ): Promise<JiraSearchResults>;
  /**
   * Download an attachment's bytes from its absolute `content` URL (the value on
   * {@link JiraAttachment.content}), replaying the session cookie. Throws
   * {@link JiraAuthError} on a 401 so the caller can recover via
   * {@link withReauth}, {@link JiraUnreachableError} when Jira can't be reached,
   * and a plain `Error` with a human-readable message on any other non-2xx.
   */
  downloadAttachment(session: JiraSession, url: string): Promise<Uint8Array>;
}

/**
 * How long an attachment download may go without a byte arriving. There is no
 * cap on the whole download — a large file over a slow VPN is fine as long as it
 * keeps moving; a connection that went silent is what fails it, and early.
 */
const ATTACHMENT_IDLE_MS = 20_000;

/**
 * Per-search timeout. Longer than the library's small-JSON default for the same
 * reason attachments get one: a search over a whole fix version returns dozens
 * of issues with their links attached, and an on-prem Jira answering that in
 * more than six seconds is ordinary, not broken.
 */
const SEARCH_TIMEOUT_MS = 30_000;

/** Page size {@link JiraApi.searchIssues} asks for — Jira's own search default. */
export const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Fields a search row is built from. The triage set: enough to rank a backlog
 * and spot what's blocked, without the description and comments that would make
 * every row a page of text (fetch those per issue with `jira issue <KEY>`).
 */
const SEARCH_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "assignee",
  "priority",
  "updated",
  "components",
  "labels",
  "fixVersions",
  "issuelinks",
] as const;

/** Options for {@link makeJira}. */
export interface JiraOptions {
  /** Told about each retry, as a line ready to print (no `jira: ` prefix). */
  onRetry?: ((message: string) => void) | undefined;
  /** Waits between retries. Defaults to a timer; tests pass one that doesn't. */
  sleep?: RetryOptions["sleep"] | undefined;
  /** Overrides {@link ATTACHMENT_IDLE_MS}, for tests. */
  attachmentIdleMs?: number;
}

/**
 * Build the real {@link JiraApi}: a {@link JiraClient} for transport plus a
 * {@link SessionStore} for persistence. The store is a parameter so tests can
 * swap in an in-memory one.
 *
 * Every call retries a dropped connection, a timeout and a transient status
 * (429, 502–504) a few times before giving up, since a VPN that blips for a
 * second should cost the user a second, not a re-run.
 */
export function makeJira(
  sessions: SessionStore = makeSessionStore(),
  jiraOptions: JiraOptions = {},
): JiraApi {
  const { onRetry, sleep } = jiraOptions;
  const idleMs = jiraOptions.attachmentIdleMs ?? ATTACHMENT_IDLE_MS;
  const retry = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(fn, (err) => err instanceof JiraUnreachableError, {
      sleep,
      onRetry:
        onRetry &&
        ((err, attempt) =>
          onRetry(`${err.message} — retrying (${attempt}/${RETRY_ATTEMPTS})…`)),
    });
  // Every transport failure surfaces as a JiraUnreachableError straight from
  // fetch, so `request` callers see it as is. The library's `login` folds it
  // into a status-less JiraError, so the last one is also kept for `login` to
  // recover.
  let lastUnreachable: JiraUnreachableError | null = null;
  const client = new JiraClient({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      try {
        return await fetch(input, init);
      } catch (err) {
        lastUnreachable = new JiraUnreachableError(urlOf(input), err);
        throw lastUnreachable;
      }
    }) as typeof fetch,
  });
  return {
    loadSession: () => sessions.load(),
    async login(baseUrl, username, password) {
      const session = await retry(async () => {
        lastUnreachable = null;
        try {
          return await client.login(baseUrl, username, password);
        } catch (err) {
          if (!(err instanceof JiraError)) throw err;
          // Every other login failure carries the HTTP status it came from.
          if (lastUnreachable != null && err.status === undefined)
            throw lastUnreachable;
          if (err.status != null && isTransientStatus(err.status))
            throw new TransientStatusError(err.message);
          throw err;
        }
      });
      // The library returns the session and stores nothing; persisting it is
      // this layer's job (see session.ts).
      await sessions.save(session);
      return session;
    },
    async fetchIssueDetails(session, key) {
      // `request`, not `getIssue`: the library's best-effort getIssue folds a
      // network failure into the same `null` as a missing issue.
      const json = await retry(async () => {
        const res = await client.request(
          session,
          issuePath(key, DETAIL_ISSUE_FIELDS),
        );
        if (res.status === 401) throw new JiraAuthError("Jira session expired");
        // Jira answers 404 both for an unknown key and for one you can't see.
        if (res.status === 404 || res.status === 403) return null;
        const status = `Jira returned HTTP ${res.status} for ${key}`;
        if (isTransientStatus(res.status)) throw transient(res, status);
        if (!res.ok) throw new Error(status);
        return readBody(session.baseUrl, `issue ${key}`, () => res.json());
      });
      if (json == null) return null;
      const issue = parseIssue(json);
      return {
        key: issue.key ?? key,
        summary: issue.summary,
        status: issue.status,
        issueType: issue.issueType,
        parentKey: issue.parent?.key ?? null,
        parentSummary: issue.parent?.summary ?? null,
        description: issue.description,
        comments: issue.comments,
        attachments: issue.attachments,
        subtasks: issue.subtasks,
      };
    },
    async searchIssues(session, jql, options = {}) {
      // POST, not GET: a real JQL query with quoted values and a sort clause is
      // long, and `request` passes the method and body straight through. Also
      // carries its own timeout, since `getJson` would impose the small-JSON one.
      const body = JSON.stringify({
        jql,
        startAt: options.startAt ?? 0,
        maxResults: options.maxResults ?? DEFAULT_SEARCH_LIMIT,
        fields: SEARCH_FIELDS,
      });
      // A search only reads, so repeating the POST is safe.
      const json = await retry(async () => {
        const res = await client.request(session, "/rest/api/2/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (res.status === 401) throw new JiraAuthError("Jira session expired");
        if (isTransientStatus(res.status))
          throw transient(
            res,
            `Jira returned HTTP ${res.status} for the search`,
          );
        if (!res.ok) throw new Error(await searchErrorMessage(res));
        return readBody(session.baseUrl, "the search", () => res.json());
      });
      return parseSearchResults(json);
    },
    async downloadAttachment(session, url) {
      // The attachment `content` URL is absolute, so `request` passes it through
      // untouched while still replaying the session cookie. Ask for any content
      // type (not the default JSON), and time out on silence, not on size.
      return retry(async () => {
        const idle = idleTimeout(idleMs);
        try {
          const res = await client.request(session, url, {
            headers: { Accept: "*/*" },
            signal: idle.signal,
          });
          if (res.status === 401)
            throw new JiraAuthError("Jira session expired");
          const status = `Jira returned HTTP ${res.status} for the attachment`;
          if (isTransientStatus(res.status)) throw transient(res, status);
          if (!res.ok) throw new Error(status);
          return await readBody(url, "the attachment", () =>
            readAll(res, idle.reset),
          );
        } finally {
          idle.clear();
        }
      });
    },
  };
}

/** Message of an unknown thrown value, for the error strings above. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a response body. Headers can arrive before a connection drops, so a
 * failure here is still the network's — unless the bytes arrived and just
 * aren't JSON, which says the response itself was wrong.
 */
async function readBody<T>(
  url: string,
  what: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof SyntaxError)
      throw new Error(`could not parse Jira's response for ${what}`, {
        cause: err,
      });
    throw new JiraUnreachableError(url, err);
  }
}

/** A {@link TransientStatusError} for `res`, keeping its `Retry-After`. */
function transient(res: Response, message: string): TransientStatusError {
  return new TransientStatusError(message, res.headers.get("Retry-After"));
}

/**
 * An abort signal that fires once `ms` pass without a {@link reset} — a timeout
 * on silence rather than on the whole exchange.
 */
function idleTimeout(ms: number): {
  signal: AbortSignal;
  reset: () => void;
  clear: () => void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => clearTimeout(timer);
  const reset = () => {
    clear();
    timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(`no data for ${ms / 1000}s`, "TimeoutError"),
        ),
      ms,
    );
  };
  reset();
  return { signal: controller.signal, reset, clear };
}

/** Read a whole body, calling `onChunk` as each piece arrives. */
async function readAll(
  res: Response,
  onChunk: () => void,
): Promise<Uint8Array> {
  if (res.body == null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The URL a `fetch` call was made with, whatever form it took. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** The host part of `url`, or `url` itself when it doesn't parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A short reason for a transport failure. Bun and Node spell the same failure
 * differently (`ConnectionRefused` vs `ECONNREFUSED`), and undici hides the code
 * one `cause` deeper, so look at the whole chain.
 */
function networkReason(err: unknown): string {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e.name === "TimeoutError") return "timed out";
    const code = (e as { code?: unknown }).code;
    switch (code) {
      case "ConnectionRefused":
      case "ECONNREFUSED":
        return "connection refused";
      case "ECONNRESET":
      case "EPIPE":
      case "UND_ERR_SOCKET":
        return "connection dropped";
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return "host not found";
      case "ETIMEDOUT":
      case "UND_ERR_CONNECT_TIMEOUT":
        return "timed out";
    }
  }
  return errMessage(err);
}

/**
 * A human-readable message for a rejected search. Jira answers a bad query with
 * a 400 whose body says exactly what is wrong — an unknown field, an unknown
 * component value, a syntax error — which is the whole diagnosis, so surface it
 * instead of the status code whenever it's there.
 */
async function searchErrorMessage(res: Response): Promise<string> {
  const fallback = `Jira returned HTTP ${res.status} for the search`;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fallback;
  }
  if (!isRecord(body)) return fallback;
  // Two shapes: `errorMessages` is a flat list, `errors` is keyed by field name.
  const messages = Array.isArray(body.errorMessages)
    ? body.errorMessages.map(str)
    : [];
  const errors = isRecord(body.errors)
    ? Object.values(body.errors).map(str)
    : [];
  const all = [...messages, ...errors].filter((m): m is string => m != null);
  return all.length > 0
    ? `Jira rejected the search: ${all.join(" ")}`
    : fallback;
}

/**
 * Map a raw `/rest/api/2/search` body onto {@link JiraSearchResults}. Tolerant in
 * the same way the library's issue parser is: every field falls back to `null` or
 * an empty list when it's absent or of the wrong type, and a row with no key is
 * dropped rather than surfaced — nothing can be done with an issue you can't name.
 */
export function parseSearchResults(json: unknown): JiraSearchResults {
  const body = isRecord(json) ? json : {};
  const rows = Array.isArray(body.issues) ? body.issues : [];
  const issues = rows
    .map(parseRow)
    .filter((row): row is JiraSearchRow => row != null);
  return {
    startAt: num(body.startAt) ?? 0,
    // Jira echoes the page size it actually applied; fall back to what arrived.
    maxResults: num(body.maxResults) ?? issues.length,
    total: num(body.total) ?? issues.length,
    issues,
  };
}

/** One `issues[]` entry as a {@link JiraSearchRow}, or `null` if it has no key. */
function parseRow(json: unknown): JiraSearchRow | null {
  if (!isRecord(json)) return null;
  const key = str(json.key);
  if (key == null) return null;
  const fields = isRecord(json.fields) ? json.fields : {};
  return {
    key,
    summary: str(fields.summary),
    status: name(fields.status),
    issueType: name(fields.issuetype),
    assignee: isRecord(fields.assignee)
      ? str(fields.assignee.displayName)
      : null,
    priority: name(fields.priority),
    updated: str(fields.updated),
    components: names(fields.components),
    labels: Array.isArray(fields.labels)
      ? fields.labels.map(str).filter(isPresent)
      : [],
    fixVersions: names(fields.fixVersions),
    links: parseLinks(fields.issuelinks),
  };
}

/** The `issuelinks` array as {@link JiraIssueLink}s, dropping unusable entries. */
function parseLinks(json: unknown): JiraIssueLink[] {
  if (!Array.isArray(json)) return [];
  const links: JiraIssueLink[] = [];
  for (const raw of json) {
    if (!isRecord(raw)) continue;
    // Exactly one side is populated, and which one decides the wording: the same
    // link type reads `is blocked by` inward and `blocks` outward.
    const inward = isRecord(raw.inwardIssue) ? raw.inwardIssue : null;
    const other =
      inward ?? (isRecord(raw.outwardIssue) ? raw.outwardIssue : null);
    if (other == null) continue;
    const key = str(other.key);
    if (key == null) continue;
    const type = isRecord(raw.type) ? raw.type : {};
    const fields = isRecord(other.fields) ? other.fields : {};
    links.push({
      relation: str(inward != null ? type.inward : type.outward),
      key,
      summary: str(fields.summary),
      status: name(fields.status),
    });
  }
  return links;
}

/** A JSON object (and not an array), the shape every nested Jira field takes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, or `null` — Jira spells "absent" both ways. */
function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The `name` of a `{ name }` object: how Jira gives status, type, priority, version. */
function name(value: unknown): string | null {
  return isRecord(value) ? str(value.name) : null;
}

/** The `name`s of an array of `{ name }` objects (components, fix versions). */
function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map(name).filter(isPresent) : [];
}

function isPresent(value: string | null): value is string {
  return value != null;
}

/**
 * A transparent Jira session source. It hands out a usable session — the saved
 * one when there is a valid session on disk, otherwise a fresh sign-in from the
 * credentials saved in the OS keychain — and re-authenticates after a 401. This
 * is what lets `jira issue` and `jira download` recover from an expired session
 * on their own, so the user never has to run `jira login` by hand once their
 * credentials have been saved.
 *
 * Built from a {@link JiraApi} and (optionally) a {@link CredentialStore}. With
 * no store — or an empty one — it degrades to "whatever session is on disk":
 * the first `jira login` is still what seeds the keychain.
 */
export interface JiraAuth {
  /**
   * A session usable for requests, or `null` when Jira isn't set up at all
   * (no saved session *and* no saved credentials to sign in with — i.e. the
   * user has never run `jira login`). Throws {@link JiraUnreachableError} when a
   * needed sign-in can't reach Jira. Memoised, so concurrent and repeat callers
   * share one resolution (and at most one sign-in).
   */
  session(): Promise<JiraSession | null>;
  /**
   * Recover from a 401: the request made with `stale` was rejected as expired,
   * so sign in again from the saved credentials and return the fresh session.
   * Concurrent callers that 401 on the same `stale` session share a single
   * sign-in. Returns `null` when there are no saved credentials to recover with
   * (or they no longer work), in which case the caller surfaces the failure.
   * Throws {@link JiraUnreachableError} when the sign-in can't reach Jira.
   */
  reauthenticate(stale: JiraSession): Promise<JiraSession | null>;
}

/** Build a {@link JiraAuth} over `jira`, signing in from `store` when present. */
export function makeJiraAuth(jira: JiraApi, store?: CredentialStore): JiraAuth {
  // The most recent session we handed out (`undefined` until first resolved),
  // used to coalesce a burst of 401s onto one re-authentication.
  let resolved: JiraSession | null | undefined;
  let sessionPromise: Promise<JiraSession | null> | null = null;
  let reauthFor: JiraSession | null = null;
  let reauthPromise: Promise<JiraSession | null> | null = null;

  // Sign in from saved credentials; `null` when none are saved or they fail.
  const signIn = async (): Promise<JiraSession | null> => {
    if (store == null) {
      return null;
    }
    const creds = await store.load();
    if (creds == null) {
      return null;
    }
    try {
      return await jira.login(creds.baseUrl, creds.username, creds.password);
    } catch (err) {
      // A sign-in that never reached Jira says nothing about the credentials.
      if (err instanceof JiraUnreachableError) throw err;
      // Saved credentials rejected (e.g. password changed). Surface as "no
      // session"; the caller tells the user to run `jira login` again.
      return null;
    }
  };

  return {
    session() {
      sessionPromise ??= (async () => {
        const s = (await jira.loadSession()) ?? (await signIn());
        resolved = s;
        return s;
      })();
      return sessionPromise;
    },
    reauthenticate(stale) {
      // Another caller already refreshed past `stale` — reuse that newer session
      // instead of signing in a second time.
      if (resolved != null && resolved !== stale) {
        return Promise.resolve(resolved);
      }
      // Coalesce the burst of 401s that all carry the same expired session.
      if (reauthPromise != null && reauthFor === stale) {
        return reauthPromise;
      }
      reauthFor = stale;
      reauthPromise = (async () => {
        const s = await signIn();
        resolved = s;
        return s;
      })();
      return reauthPromise;
    },
  };
}

/**
 * Run a Jira fetch with one transparent re-authentication. Calls `fn` with
 * `session`; if it throws a {@link JiraAuthError} (the session expired),
 * re-authenticates via `auth` and retries `fn` once with the fresh session. The
 * 401 only reaches the caller when re-authentication can't recover it (no usable
 * saved credentials), so a caller wraps this in its own try/catch to report that.
 */
export async function withReauth<T>(
  auth: JiraAuth,
  session: JiraSession,
  fn: (session: JiraSession) => Promise<T>,
): Promise<T> {
  try {
    return await fn(session);
  } catch (err) {
    if (!(err instanceof JiraAuthError)) {
      throw err;
    }
    const fresh = await auth.reauthenticate(session);
    if (fresh == null) {
      throw err;
    }
    return await fn(fresh);
  }
}

/**
 * Report a failed Jira call on stderr the way every command words it, and return
 * the exit code to finish with: {@link EXIT_UNREACHABLE} when Jira couldn't be
 * reached, `1` for anything else.
 */
export function reportJiraFailure(
  e: unknown,
  err: (s: string) => void,
): number {
  if (e instanceof JiraAuthError) {
    err(
      "jira: Jira session expired and saved credentials no longer work — run `jira login`.\n",
    );
    return 1;
  }
  err(`jira: ${errMessage(e)}\n`);
  return e instanceof JiraUnreachableError ? EXIT_UNREACHABLE : 1;
}

/**
 * Resolve the session a command runs with. `null` means there is none to be had
 * (the caller points at `jira login`); a sign-in that couldn't reach Jira is
 * reported here instead, and its exit code returned, since `jira login` would
 * not help.
 */
export async function resolveSession(
  auth: JiraAuth,
  err: (s: string) => void,
): Promise<JiraSession | null | number> {
  try {
    return await auth.session();
  } catch (e) {
    if (e instanceof JiraUnreachableError) return reportJiraFailure(e, err);
    return null;
  }
}

/**
 * Where a command sends retry notices: stderr when it is a terminal, nowhere
 * otherwise — a person waiting wants to know why it's slow, a script reads the
 * outcome.
 */
export function retryNotice(
  err: (s: string) => void,
): ((message: string) => void) | undefined {
  return process.stderr.isTTY ? (m) => err(`jira: ${m}\n`) : undefined;
}
