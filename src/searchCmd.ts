// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { makeCredentialStore, type CredentialStore } from "./credentials.js";
import {
  DEFAULT_SEARCH_LIMIT,
  makeJira,
  makeJiraAuth,
  reportJiraFailure,
  resolveSession,
  withReauth,
  type JiraApi,
  type JiraAuth,
} from "./jira.js";
import { formatSearchText } from "./searchText.js";

/** Injectable side effects for {@link runSearchCommand}, so it can be unit-tested. */
export interface SearchCmdDeps {
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

const USAGE = `Usage: jira search <JQL> [--json] [--limit <n>] [--start <n>]

The query is sent to Jira verbatim — nothing is added to it, so what you write
is what runs. Unquoted arguments are joined back together with spaces.

  --json       every field, including components, labels and fix versions
  --limit <n>  results per page (default ${DEFAULT_SEARCH_LIMIT}; Jira caps it instance-side)
  --start <n>  index of the first result, for paging past the limit
`;

/**
 * Run `jira search <JQL>` — the non-interactive issue finder. Loads the saved
 * Jira session (signing in / refreshing from the keychain exactly like `jira
 * issue`), runs the query, and writes either one aligned row per issue or, with
 * `--json`, the whole result page as an object. Returns a process exit code: 0
 * on success (a query that matches nothing is an answer, not a failure), 2 on a
 * usage error, 3 when Jira can't be reached, 1 on any other failure (no session,
 * expired session, a query Jira rejected). Never throws.
 */
export async function runSearchCommand(
  argv: string[],
  deps: SearchCmdDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));

  // Accept `--limit=20` as well as `--limit 20` by splitting the `=` form into
  // two tokens up front, so the loop below has only one shape to handle.
  const args = argv.flatMap((arg) => {
    const split = /^(--limit|--start)=(.*)$/.exec(arg);
    return split != null ? [split[1], split[2]] : [arg];
  });

  let json = false;
  let startAt = 0;
  let maxResults = DEFAULT_SEARCH_LIMIT;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Never taken while i < args.length; narrows for noUncheckedIndexedAccess.
    if (arg === undefined) break;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      out(USAGE);
      return 0;
    } else if (arg === "--limit" || arg === "-n") {
      const value = count(args[++i], 1);
      if (value == null) {
        err(`jira: --limit needs a whole number of 1 or more\n${USAGE}`);
        return 2;
      }
      maxResults = value;
    } else if (arg === "--start") {
      const value = count(args[++i], 0);
      if (value == null) {
        err(`jira: --start needs a whole number of 0 or more\n${USAGE}`);
        return 2;
      }
      startAt = value;
    } else {
      positional.push(arg);
    }
  }

  // An unquoted query arrives as several arguments, so put it back together:
  // `jira search project = PROJ AND status = Open` should work as typed.
  const jql = positional.join(" ").trim();
  if (jql === "") {
    err(USAGE);
    return 2;
  }

  const jira = deps.jira ?? makeJira();
  // Signs in from the saved keychain credentials when there's no session, so an
  // expired session doesn't dead-end an agent on `jira login` (as in `jira issue`).
  const auth =
    deps.auth ?? makeJiraAuth(jira, deps.store ?? makeCredentialStore());
  const session = await resolveSession(auth, err);
  if (typeof session === "number") return session;
  if (session == null) {
    err("jira: no Jira session — run `jira login` first.\n");
    return 1;
  }

  let results;
  try {
    // Refresh the session from saved credentials on a 401 and retry once.
    results = await withReauth(auth, session, (s) =>
      jira.searchIssues(s, jql, { startAt, maxResults }),
    );
  } catch (e) {
    return reportJiraFailure(e, err);
  }

  if (json) {
    out(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }

  out(`${formatSearchText(results)}\n`);
  return 0;
}

/** A `--limit` / `--start` value as a whole number of at least `min`, else `null`. */
function count(raw: string | undefined, min: number): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : null;
}
