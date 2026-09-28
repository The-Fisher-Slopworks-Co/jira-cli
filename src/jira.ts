// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DETAIL_ISSUE_FIELDS,
  JiraAuthError,
  JiraClient,
  type JiraAttachment,
  type JiraComment,
  type JiraSession,
  type JiraSubtask,
} from '@slopworks/jira';

import { type CredentialStore, makeCredentialStore } from './credentials.js';
import { makeSessionStore, type SessionStore } from './session.js';

// Re-export the library's session type, 401 error, and the comment/attachment/
// subtask shapes so the rest of the CLI imports everything Jira-related from
// this one module.
export type { JiraAttachment, JiraComment, JiraSession, JiraSubtask };
export { JiraAuthError };

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
   * Authenticate and persist the resulting session. Throws with a human-readable
   * message on bad credentials, a non-Server instance, or a network failure.
   */
  login(baseUrl: string, username: string, password: string): Promise<JiraSession>;
  /**
   * Fetch an issue's full body for display. Returns `null` on a recoverable
   * failure (not found, network, timeout, unparseable). Throws
   * {@link JiraAuthError} on a 401 so the caller can re-authenticate.
   */
  fetchIssueDetails(session: JiraSession, key: string): Promise<JiraIssueDetails | null>;
  /**
   * Run a JQL search and return one page of rows. `jql` is passed to Jira
   * verbatim — no clause is appended, so what the caller wrote is what runs.
   *
   * Unlike {@link JiraApi.fetchIssueDetails} this throws rather than returning
   * `null` on a recoverable failure: a rejected query is the normal way to get a
   * typo wrong, and Jira's own explanation ("Field 'foo' does not exist…") is
   * worth far more to the caller than an empty result would be. Throws
   * {@link JiraAuthError} on a 401, and a plain `Error` carrying Jira's message
   * on anything else.
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
   * {@link withReauth}, and a plain `Error` with a human-readable message on any
   * other failure (non-2xx, network, timeout).
   */
  downloadAttachment(session: JiraSession, url: string): Promise<Uint8Array>;
}

/**
 * Per-download timeout for attachments. Far longer than the library's small-JSON
 * default: an attachment can be many megabytes, so a six-second cap would
 * truncate large files.
 */
const ATTACHMENT_TIMEOUT_MS = 60_000;

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
  'summary',
  'status',
  'issuetype',
  'assignee',
  'priority',
  'updated',
  'components',
  'labels',
  'fixVersions',
  'issuelinks',
] as const;

/**
 * Build the real {@link JiraApi}: a {@link JiraClient} for transport plus a
 * {@link SessionStore} for persistence. The store is a parameter so tests can
 * swap in an in-memory one.
 */
export function makeJira(sessions: SessionStore = makeSessionStore()): JiraApi {
  const client = new JiraClient();
  return {
    loadSession: () => sessions.load(),
    async login(baseUrl, username, password) {
      // The library returns the session and stores nothing; persisting it is
      // this layer's job (see session.ts).
      const session = await client.login(baseUrl, username, password);
      await sessions.save(session);
      return session;
    },
    async fetchIssueDetails(session, key) {
      // getIssue throws JiraAuthError on 401 and returns null on every other
      // recoverable failure — exactly this contract. Re-word the 401 so the
      // "session expired" wording is consistent wherever it surfaces.
      const issue = await client
        .getIssue(session, key, { fields: DETAIL_ISSUE_FIELDS })
        .catch((err: unknown) => {
          if (err instanceof JiraAuthError) throw new JiraAuthError('Jira session expired');
          throw err;
        });
      if (issue == null) return null;
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
      let res: Response;
      try {
        res = await client.request(session, '/rest/api/2/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jql,
            startAt: options.startAt ?? 0,
            maxResults: options.maxResults ?? DEFAULT_SEARCH_LIMIT,
            fields: SEARCH_FIELDS,
          }),
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`could not reach Jira: ${errMessage(err)}`);
      }
      if (res.status === 401) throw new JiraAuthError('Jira session expired');
      if (!res.ok) throw new Error(await searchErrorMessage(res));
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        throw new Error(`could not parse Jira's search response: ${errMessage(err)}`);
      }
      return parseSearchResults(body);
    },
    async downloadAttachment(session, url) {
      // The attachment `content` URL is absolute, so `request` passes it through
      // untouched while still replaying the session cookie. Ask for any content
      // type (not the default JSON) and use the longer attachment timeout.
      let res: Response;
      try {
        res = await client.request(session, url, {
          headers: { Accept: '*/*' },
          signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`could not download attachment: ${errMessage(err)}`);
      }
      if (res.status === 401) throw new JiraAuthError('Jira session expired');
      if (!res.ok) throw new Error(`Jira returned HTTP ${res.status} for the attachment`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Message of an unknown thrown value, for the error strings above. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const messages = Array.isArray(body.errorMessages) ? body.errorMessages.map(str) : [];
  const errors = isRecord(body.errors) ? Object.values(body.errors).map(str) : [];
  const all = [...messages, ...errors].filter((m): m is string => m != null);
  return all.length > 0 ? `Jira rejected the search: ${all.join(' ')}` : fallback;
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
  const issues = rows.map(parseRow).filter((row): row is JiraSearchRow => row != null);
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
    assignee: isRecord(fields.assignee) ? str(fields.assignee.displayName) : null,
    priority: name(fields.priority),
    updated: str(fields.updated),
    components: names(fields.components),
    labels: Array.isArray(fields.labels) ? fields.labels.map(str).filter(isPresent) : [],
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
    const other = inward ?? (isRecord(raw.outwardIssue) ? raw.outwardIssue : null);
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or `null` — Jira spells "absent" both ways. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
   * user has never run `jira login`). Memoised, so concurrent and repeat callers
   * share one resolution (and at most one sign-in).
   */
  session(): Promise<JiraSession | null>;
  /**
   * Recover from a 401: the request made with `stale` was rejected as expired,
   * so sign in again from the saved credentials and return the fresh session.
   * Concurrent callers that 401 on the same `stale` session share a single
   * sign-in. Returns `null` when there are no saved credentials to recover with
   * (or they no longer work), in which case the caller surfaces the failure.
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
    } catch {
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

/** Convenience: a {@link JiraAuth} over the real Jira client and OS keychain. */
export function makeDefaultJiraAuth(jira: JiraApi = makeJira()): JiraAuth {
  return makeJiraAuth(jira, makeCredentialStore());
}
