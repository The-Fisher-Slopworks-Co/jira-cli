// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialStore, JiraCredentials } from "./credentials.js";
import {
  DEFAULT_SEARCH_LIMIT,
  JiraAuthError,
  JiraUnreachableError,
  type JiraApi,
  type JiraSearchOptions,
  type JiraSearchResults,
  type JiraSession,
} from "./jira.js";
import { runSearchCommand } from "./searchCmd.js";

const SESSION: JiraSession = {
  baseUrl: "https://jira.test",
  cookie: "JSESSIONID=x",
};

const RESULTS: JiraSearchResults = {
  startAt: 0,
  maxResults: 50,
  total: 1,
  issues: [
    {
      key: "PROJ-9",
      summary: "Rate limiter for the public API",
      status: "Open",
      issueType: "Story",
      assignee: null,
      priority: "Major",
      updated: "2026-08-04T12:33:21.000+0300",
      components: ["Backend"],
      labels: ["api"],
      fixVersions: ["2.7.0"],
      links: [],
    },
  ],
};

const EMPTY: JiraSearchResults = {
  startAt: 0,
  maxResults: 50,
  total: 0,
  issues: [],
};

/** A Jira stub plus captured out/err buffers and the searches it was asked for. */
function harness(
  opts: {
    session?: JiraSession | null;
    results?: JiraSearchResults;
    searchError?: unknown;
    /** When set, searchIssues 401s until a sign-in mints this fresh cookie. */
    freshCookie?: string;
    /** Saved keychain credentials, for the transparent-login paths. Default: none. */
    creds?: JiraCredentials | null;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const searches: { jql: string; options?: JiraSearchOptions | undefined }[] =
    [];
  const logins: JiraCredentials[] = [];
  const jira: JiraApi = {
    loadSession: async () =>
      opts.session === undefined ? SESSION : opts.session,
    login: async (baseUrl, username, password) => {
      logins.push({ baseUrl, username, password });
      return { baseUrl, cookie: opts.freshCookie ?? "x" };
    },
    fetchIssueDetails: async () => null,
    searchIssues: async (session, jql, options) => {
      searches.push({ jql, options });
      if (opts.searchError !== undefined) throw opts.searchError;
      // Model an expired session: reject until a re-login swaps in freshCookie.
      if (opts.freshCookie != null && session.cookie !== opts.freshCookie) {
        throw new JiraAuthError("Jira session expired");
      }
      return opts.results ?? RESULTS;
    },
    downloadAttachment: async () => new Uint8Array(),
  };
  const store: CredentialStore = {
    load: async () => opts.creds ?? null,
    save: async () => true,
  };
  const deps = {
    jira,
    store,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  };
  return { deps, out, err, searches, logins };
}

const CREDS: JiraCredentials = {
  baseUrl: "https://jira.test",
  username: "alice",
  password: "secret",
};

test("sends the query verbatim and prints a row per issue", async () => {
  const h = harness();
  const jql = "project = PROJ AND component = Backend ORDER BY Rank ASC";
  assert.equal(await runSearchCommand([jql], h.deps), 0);
  // Nothing appended, nothing reordered: what the caller wrote is what ran.
  assert.deepEqual(h.searches, [
    { jql, options: { startAt: 0, maxResults: DEFAULT_SEARCH_LIMIT } },
  ]);
  const text = h.out.join("");
  assert.match(
    text,
    /PROJ-9 {2}Story {2}Open {2}unassigned {2}2026-08-04 {2}Rate limiter/,
  );
  assert.match(text, /1 issue\./);
});

test("joins an unquoted query back together", async () => {
  const h = harness();
  assert.equal(
    await runSearchCommand(["project", "=", "PROJ", "--json"], h.deps),
    0,
  );
  assert.equal(h.searches[0]?.jql, "project = PROJ");
});

test("--json prints the whole page, totals included", async () => {
  const truncated = { ...RESULTS, total: 120 };
  const h = harness({ results: truncated });
  assert.equal(await runSearchCommand(["project = PROJ", "--json"], h.deps), 0);
  assert.deepEqual(JSON.parse(h.out.join("")), truncated);
});

test("--limit and --start page the search, in both spellings", async () => {
  const h = harness();
  await runSearchCommand(
    ["project = PROJ", "--limit", "10", "--start", "20"],
    h.deps,
  );
  await runSearchCommand(
    ["project = PROJ", "--limit=10", "--start=20"],
    h.deps,
  );
  assert.deepEqual(
    h.searches.map((s) => s.options),
    [
      { startAt: 20, maxResults: 10 },
      { startAt: 20, maxResults: 10 },
    ],
  );
});

test("a nonsense --limit is a usage error (exit 2) and never reaches Jira", async () => {
  const h = harness();
  assert.equal(
    await runSearchCommand(["project = PROJ", "--limit", "lots"], h.deps),
    2,
  );
  assert.equal(
    await runSearchCommand(["project = PROJ", "--limit", "0"], h.deps),
    2,
  );
  assert.equal(
    await runSearchCommand(["project = PROJ", "--start", "-1"], h.deps),
    2,
  );
  assert.deepEqual(h.searches, []);
  assert.match(h.err.join(""), /--limit needs a whole number/);
});

test("no query is a usage error (exit 2)", async () => {
  const h = harness();
  assert.equal(await runSearchCommand([], h.deps), 2);
  assert.match(h.err.join(""), /Usage: jira search/);
});

test("a query that matches nothing still succeeds", async () => {
  const h = harness({ results: EMPTY });
  assert.equal(await runSearchCommand(["project = NOPE"], h.deps), 0);
  assert.match(h.out.join(""), /No issues match\./);
});

test("a rejected query exits 1 with Jira's own explanation", async () => {
  const h = harness({
    searchError: new Error(
      "Jira rejected the search: Field 'nope' does not exist",
    ),
  });
  assert.equal(await runSearchCommand(["nope = 1"], h.deps), 1);
  assert.match(h.err.join(""), /Field 'nope' does not exist/);
});

test("no session exits 1 and points at jira login", async () => {
  const h = harness({ session: null });
  assert.equal(await runSearchCommand(["project = PROJ"], h.deps), 1);
  assert.match(h.err.join(""), /no Jira session.*jira login/);
});

test("an expired session (401) with no saved credentials exits 1", async () => {
  const h = harness({ searchError: new JiraAuthError("Jira session expired") });
  assert.equal(await runSearchCommand(["project = PROJ"], h.deps), 1);
  assert.match(h.err.join(""), /session expired.*jira login/);
});

test("an expired session re-authenticates from saved credentials and succeeds", async () => {
  const h = harness({ freshCookie: "fresh", creds: CREDS });
  assert.equal(await runSearchCommand(["project = PROJ"], h.deps), 0);
  assert.deepEqual(h.logins, [CREDS]);
  assert.match(h.out.join(""), /Rate limiter/);
});

test("an unreachable Jira exits 3", async () => {
  const h = harness({
    searchError: new JiraUnreachableError(
      "https://jira.test",
      new Error("boom"),
    ),
  });
  assert.equal(await runSearchCommand(["project = PROJ"], h.deps), 3);
  assert.match(h.err.join(""), /could not reach jira\.test/);
});
