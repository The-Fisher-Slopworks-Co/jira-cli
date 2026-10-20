// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { CredentialStore, JiraCredentials } from "./credentials.js";
import {
  JiraAuthError,
  JiraUnreachableError,
  type JiraApi,
  type JiraIssueDetails,
  type JiraSession,
} from "./jira.js";
import { runIssueCommand } from "./issueCmd.js";

const SESSION: JiraSession = {
  baseUrl: "https://jira.test",
  cookie: "JSESSIONID=x",
};

const DETAILS: JiraIssueDetails = {
  key: "PROJ-9",
  summary: "Has a body",
  status: "In Progress",
  issueType: "Task",
  parentKey: null,
  parentSummary: null,
  description: "the description",
  comments: [
    { id: "1", author: "Alice", body: "hi", created: "T1", updated: null },
  ],
  attachments: [],
  subtasks: [
    {
      key: "PROJ-10",
      summary: "A child task",
      status: "Done",
      issueType: "Sub-task",
    },
  ],
};

/** A Jira stub plus captured out/err buffers and the keys fetchIssueDetails saw. */
function harness(
  opts: {
    session?: JiraSession | null;
    details?: JiraIssueDetails | null;
    fetchError?: unknown;
    /** When set, fetchIssueDetails 401s until a sign-in mints this fresh cookie. */
    freshCookie?: string;
    /** Saved keychain credentials, for the transparent-login paths. Default: none. */
    creds?: JiraCredentials | null;
    /** When set, a sign-in rejects with this. */
    loginError?: unknown;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const fetched: string[] = [];
  const logins: JiraCredentials[] = [];
  const jira: JiraApi = {
    loadSession: async () =>
      opts.session === undefined ? SESSION : opts.session,
    login: async (baseUrl, username, password) => {
      logins.push({ baseUrl, username, password });
      if (opts.loginError !== undefined) throw opts.loginError;
      return { baseUrl, cookie: opts.freshCookie ?? "x" };
    },
    fetchIssueDetails: async (session, key) => {
      fetched.push(key);
      if (opts.fetchError !== undefined) throw opts.fetchError;
      // Model an expired session: reject until a re-login swaps in freshCookie.
      if (opts.freshCookie != null && session.cookie !== opts.freshCookie) {
        throw new JiraAuthError("Jira session expired");
      }
      return opts.details === undefined ? DETAILS : opts.details;
    },
    searchIssues: async () => ({
      startAt: 0,
      maxResults: 0,
      total: 0,
      issues: [],
    }),
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
  return { deps, out, err, fetched, logins };
}

const CREDS: JiraCredentials = {
  baseUrl: "https://jira.test",
  username: "alice",
  password: "secret",
};

/** Neutralise JIRA_URL so the base URL comes from the session deterministically. */
function clearJiraUrl(t: TestContext): void {
  const prev = process.env.JIRA_URL;
  delete process.env.JIRA_URL;
  t.after(() => {
    if (prev === undefined) delete process.env.JIRA_URL;
    else process.env.JIRA_URL = prev;
  });
}

test("prints a human-readable report and uppercases the key", async (t) => {
  clearJiraUrl(t);
  const h = harness();
  const code = await runIssueCommand(["proj-9"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.fetched, ["PROJ-9"]);
  const text = h.out.join("");
  assert.match(text, /PROJ-9 {2}Has a body/);
  assert.match(text, /the description/);
  assert.match(text, /Subtasks \(1\)\n-+\nPROJ-10 {2}\[Done\] {2}A child task/);
  assert.match(text, /Link {4}https:\/\/jira\.test\/browse\/PROJ-9/);
});

test("--json prints the raw details object", async (t) => {
  clearJiraUrl(t);
  const h = harness();
  const code = await runIssueCommand(["PROJ-9", "--json"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(h.out.join("")), DETAILS);
});

test("no key is a usage error (exit 2)", async () => {
  const h = harness();
  assert.equal(await runIssueCommand([], h.deps), 2);
  assert.match(h.err.join(""), /Usage: jira issue/);
});

test("no session exits 1 and points at jira login", async () => {
  const h = harness({ session: null });
  assert.equal(await runIssueCommand(["PROJ-9"], h.deps), 1);
  assert.match(h.err.join(""), /no Jira session.*jira login/);
});

test("an expired session (401) exits 1 and points at jira login", async () => {
  const h = harness({ fetchError: new JiraAuthError("Jira session expired") });
  assert.equal(await runIssueCommand(["PROJ-9"], h.deps), 1);
  assert.match(h.err.join(""), /session expired.*jira login/);
});

test("with no session but saved credentials, it signs in transparently", async (t) => {
  clearJiraUrl(t);
  const h = harness({ session: null, creds: CREDS });
  const code = await runIssueCommand(["PROJ-9"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.logins, [CREDS]); // signed in from the keychain, no prompt
  assert.match(h.out.join(""), /Has a body/);
});

test("an expired session re-authenticates from saved credentials and succeeds", async (t) => {
  clearJiraUrl(t);
  // The on-disk session 401s; a re-login mints `fresh`, after which the fetch works.
  const h = harness({ freshCookie: "fresh", creds: CREDS });
  const code = await runIssueCommand(["PROJ-9"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.logins, [CREDS]);
  assert.match(h.out.join(""), /Has a body/);
});

test("a missing issue (null) exits 1", async () => {
  const h = harness({ details: null });
  assert.equal(await runIssueCommand(["PROJ-9"], h.deps), 1);
  assert.match(h.err.join(""), /not found/);
});

test("an unreachable Jira exits 3 and says so, not 'not found'", async () => {
  const h = harness({
    fetchError: new JiraUnreachableError(
      "https://jira.test",
      new Error("boom"),
    ),
  });
  assert.equal(await runIssueCommand(["PROJ-9"], h.deps), 3);
  assert.match(h.err.join(""), /could not reach jira\.test.*VPN/);
  assert.doesNotMatch(h.err.join(""), /not found/);
});

test("a sign-in that can't reach Jira exits 3 instead of pointing at jira login", async () => {
  const h = harness({
    session: null,
    creds: CREDS,
    loginError: new JiraUnreachableError(
      "https://jira.test",
      new Error("boom"),
    ),
  });
  assert.equal(await runIssueCommand(["PROJ-9"], h.deps), 3);
  assert.match(h.err.join(""), /could not reach jira\.test/);
  assert.doesNotMatch(h.err.join(""), /jira login/);
});
