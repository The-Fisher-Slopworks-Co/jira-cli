// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { makeCredentialStore, type CredentialStore } from './credentials.js';
import { JiraAuthError, makeJira, makeJiraAuth, withReauth, type JiraApi, type JiraAuth } from './jira.js';
import { formatIssueText } from './issueText.js';

/** Injectable side effects for {@link runIssueCommand}, so it can be unit-tested. */
export interface IssueCmdDeps {
  jira?: JiraApi;
  /** Saved Jira credentials, for transparent re-login. Defaults to the OS keychain. */
  store?: CredentialStore;
  /** Pre-built session source, for tests; production builds one from `jira` + `store`. */
  auth?: JiraAuth;
  /** Write to standard output (no trailing newline added). Defaults to `process.stdout`. */
  out?: (s: string) => void;
  /** Write to standard error (no trailing newline added). Defaults to `process.stderr`. */
  err?: (s: string) => void;
}

const USAGE = 'Usage: jira issue <KEY> [--json]\n';

/**
 * Run `jira issue <KEY>` — the non-interactive issue viewer. Loads the saved Jira
 * session, fetches the issue's description, comments, and attachments, and writes
 * either a human-readable report or, with `--json`, the raw issue object. Returns
 * a process exit code: 0 on success, 2 on a usage error, 1 on any other failure
 * (no session, expired session, not found, network). Never throws.
 */
export async function runIssueCommand(argv: string[], deps: IssueCmdDeps = {}): Promise<number> {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));

  let json = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      out(USAGE);
      return 0;
    } else positional.push(arg);
  }

  const rawKey = positional[0];
  if (rawKey == null || rawKey === '') {
    err(USAGE);
    return 2;
  }
  const key = rawKey.toUpperCase();

  const jira = deps.jira ?? makeJira();
  // Signs in from the saved keychain credentials when there's no session, so an
  // expired session doesn't dead-end an agent on `jira login`.
  const auth = deps.auth ?? makeJiraAuth(jira, deps.store ?? makeCredentialStore());
  const session = await auth.session().catch(() => null);
  if (session == null) {
    err('jira: no Jira session — run `jira login` first.\n');
    return 1;
  }

  let details;
  try {
    // Refresh the session from saved credentials on a 401 and retry once.
    details = await withReauth(auth, session, (s) => jira.fetchIssueDetails(s, key));
  } catch (e) {
    if (e instanceof JiraAuthError) {
      err('jira: Jira session expired and saved credentials no longer work — run `jira login`.\n');
      return 1;
    }
    err(`jira: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (details == null) {
    err(`jira: issue ${key} not found, or you don't have access.\n`);
    return 1;
  }

  if (json) {
    out(`${JSON.stringify(details, null, 2)}\n`);
    return 0;
  }

  const baseUrl = (process.env.JIRA_URL || session.baseUrl || '').replace(/\/+$/, '') || null;
  out(`${formatIssueText(details, baseUrl)}\n`);
  return 0;
}
