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
 * The CLI's narrow Jira surface: load or establish a session, fetch the one
 * issue shape it renders, and pull an attachment's bytes. Backed by the
 * library's {@link JiraClient}, but kept as an interface so tests inject an
 * in-memory stub instead of reaching the network.
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
