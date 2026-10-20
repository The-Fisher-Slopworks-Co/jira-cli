// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { CredentialStore, JiraCredentials } from "./credentials.js";
import {
  JiraAuthError,
  JiraUnreachableError,
  makeJira,
  makeJiraAuth,
  parseSearchResults,
  withReauth,
  type JiraApi,
  type JiraSession,
} from "./jira.js";

// The Jira REST client itself (cookie auth, parsing, error model) is unit-tested
// in the `@slopworks/jira` library. These tests cover this CLI's thin adapter:
// that makeJira persists the session it signs in with, maps a fetched issue onto
// JiraIssueDetails, and preserves the 401-throws / recoverable-returns-null
// contract the commands rely on.

const WITH_BODY = {
  key: "PROJ-9",
  fields: {
    summary: "Has a body",
    status: { name: "In Progress" },
    issuetype: { name: "Task" },
    description: "Line one\nLine two",
    comment: {
      comments: [
        {
          id: "1",
          author: { displayName: "Alice" },
          body: "hi",
          created: "2026-01-02T10:00:00.000+0000",
        },
      ],
    },
    attachment: [
      {
        id: "5",
        filename: "diagram.png",
        author: { displayName: "Alice" },
        created: "2026-01-02T10:00:00.000+0000",
        size: 2048,
        mimeType: "image/png",
        content: "https://jira.example.com/secure/attachment/5/diagram.png",
      },
    ],
    subtasks: [
      {
        key: "PROJ-10",
        fields: {
          summary: "A child",
          status: { name: "Done" },
          issuetype: { name: "Sub-task" },
        },
      },
    ],
  },
};

/**
 * Point the session file at a throwaway XDG dir and clear JIRA_URL for the
 * duration of `t`, so the real `login()` write never touches the user's session.
 * Restores on teardown.
 */
function isolateConfig(t: TestContext): void {
  const xdg = mkdtempSync(join(tmpdir(), "jira-cli-xdg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevUrl = process.env.JIRA_URL;
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.JIRA_URL;
  t.after(() => {
    rmSync(xdg, { recursive: true, force: true });
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevUrl === undefined) delete process.env.JIRA_URL;
    else process.env.JIRA_URL = prevUrl;
  });
}

/** A base URL on a port nothing listens on, so every connection is refused. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Start a throwaway HTTP server on a random port; returns its base URL. */
async function listen(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

test("makeJira persists the session it signs in with, and reads it back", async (t: TestContext) => {
  isolateConfig(t);
  let sentCookie: string | undefined;
  const base = await listen(t, (req, res) => {
    const { pathname } = new URL(req.url ?? "", "http://localhost");
    if (req.method === "POST" && pathname === "/rest/auth/1/session") {
      res.setHeader("Set-Cookie", "JSESSIONID=ABC123; Path=/; HttpOnly");
      res.end("{}");
      return;
    }
    if (req.method === "GET" && pathname === "/rest/api/2/issue/PROJ-9") {
      sentCookie = req.headers.cookie;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(WITH_BODY));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const jira = makeJira();

  // The library returns the session and stores nothing; this layer writes it,
  // which loadSession then reads back.
  const session = await jira.login(base, "alice", "secret");
  assert.equal(session.baseUrl, base);
  assert.equal(session.cookie, "JSESSIONID=ABC123");
  assert.deepEqual(await jira.loadSession(), session);

  // The cookie is replayed on later requests.
  await jira.fetchIssueDetails(session, "PROJ-9");
  assert.equal(sentCookie, "JSESSIONID=ABC123");
});

test("loadSession is null before anyone has signed in", async (t: TestContext) => {
  isolateConfig(t);
  assert.equal(await makeJira().loadSession(), null);
});

test("fetchIssueDetails requests the body fields and maps description/comments/attachments", async (t: TestContext) => {
  isolateConfig(t);
  const seen: string[] = [];
  const base = await listen(t, (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    seen.push(url.searchParams.get("fields") ?? "");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(WITH_BODY));
  });
  const jira = makeJira();
  const details = await jira.fetchIssueDetails(
    { baseUrl: base, cookie: "JSESSIONID=x" },
    "PROJ-9",
  );
  const requestedFields = seen[0] ?? "";
  assert.ok(requestedFields.includes("description"));
  assert.ok(
    requestedFields.includes("comment") &&
      requestedFields.includes("attachment"),
  );
  assert.ok(requestedFields.includes("subtasks"));
  assert.deepEqual(details, {
    key: "PROJ-9",
    summary: "Has a body",
    status: "In Progress",
    issueType: "Task",
    parentKey: null,
    parentSummary: null,
    description: "Line one\nLine two",
    comments: [
      {
        id: "1",
        author: "Alice",
        body: "hi",
        created: "2026-01-02T10:00:00.000+0000",
        updated: null,
      },
    ],
    attachments: [
      {
        id: "5",
        filename: "diagram.png",
        author: "Alice",
        created: "2026-01-02T10:00:00.000+0000",
        size: 2048,
        mimeType: "image/png",
        content: "https://jira.example.com/secure/attachment/5/diagram.png",
      },
    ],
    subtasks: [
      {
        key: "PROJ-10",
        summary: "A child",
        status: "Done",
        issueType: "Sub-task",
      },
    ],
  });
});

test("fetchIssueDetails keeps an issue that has no summary", async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        key: "PROJ-1",
        fields: { status: { name: "Done" }, description: "body" },
      }),
    );
  });
  const jira = makeJira();
  const details = await jira.fetchIssueDetails(
    { baseUrl: base, cookie: "JSESSIONID=x" },
    "PROJ-1",
  );
  assert.equal(details?.summary, null);
  assert.equal(details?.description, "body");
});

test("fetchIssueDetails surfaces a 401 as JiraAuthError and other errors as null", async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (req, res) => {
    res.statusCode = (req.url ?? "").includes("/EXPIRED-1") ? 401 : 404;
    res.end("{}");
  });
  const session = { baseUrl: base, cookie: "JSESSIONID=x" };
  const jira = makeJira();
  await assert.rejects(
    () => jira.fetchIssueDetails(session, "EXPIRED-1"),
    JiraAuthError,
  );
  assert.equal(await jira.fetchIssueDetails(session, "MISSING-1"), null);
});

test("downloadAttachment replays the cookie and surfaces a 401 as JiraAuthError", async (t: TestContext) => {
  isolateConfig(t);
  let sentCookie: string | undefined;
  const base = await listen(t, (req, res) => {
    if ((req.url ?? "").includes("expired")) {
      res.statusCode = 401;
      res.end("{}");
      return;
    }
    sentCookie = req.headers.cookie;
    res.end("file-bytes");
  });
  const jira = makeJira();
  const session = { baseUrl: base, cookie: "JSESSIONID=x" };
  const bytes = await jira.downloadAttachment(
    session,
    `${base}/secure/attachment/5/diagram.png`,
  );
  assert.equal(new TextDecoder().decode(bytes), "file-bytes");
  assert.equal(sentCookie, "JSESSIONID=x");
  await assert.rejects(
    () =>
      jira.downloadAttachment(
        session,
        `${base}/secure/attachment/6/expired.png`,
      ),
    JiraAuthError,
  );
});

// --- JQL search --------------------------------------------------------------

const SEARCH_BODY = {
  startAt: 10,
  maxResults: 5,
  total: 42,
  issues: [
    {
      key: "PROJ-9",
      fields: {
        summary: "Rate limiter for the public API",
        status: { name: "In Progress" },
        issuetype: { name: "Story" },
        assignee: { displayName: "Alice" },
        priority: { name: "Major" },
        updated: "2026-08-04T12:33:21.000+0300",
        components: [{ name: "Backend" }],
        labels: ["api"],
        fixVersions: [{ name: "2.7.0" }],
        issuelinks: [
          {
            type: {
              name: "Blocks",
              inward: "is blocked by",
              outward: "blocks",
            },
            inwardIssue: {
              key: "PROJ-4",
              fields: { summary: "Token bucket", status: { name: "Open" } },
            },
          },
        ],
      },
    },
    {
      key: "PROJ-10",
      fields: { summary: "Unassigned one", assignee: null, issuelinks: [] },
    },
  ],
};

/** Capture one request's method, path and JSON body, then answer with `reply`. */
function record(
  seen: {
    method?: string | undefined;
    path?: string;
    body?: unknown;
  },
  reply: unknown,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      seen.method = req.method;
      seen.path = new URL(req.url ?? "", "http://localhost").pathname;
      seen.body = raw === "" ? undefined : JSON.parse(raw);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
    });
  };
}

test("searchIssues posts the query verbatim and maps rows, links and totals", async (t: TestContext) => {
  isolateConfig(t);
  const seen: { method?: string; path?: string; body?: unknown } = {};
  const base = await listen(t, record(seen, SEARCH_BODY));
  const jql = "project = PROJ AND component = Backend ORDER BY Rank ASC";
  const results = await makeJira().searchIssues(
    { baseUrl: base, cookie: "JSESSIONID=x" },
    jql,
    {
      startAt: 10,
      maxResults: 5,
    },
  );

  assert.equal(seen.method, "POST");
  assert.equal(seen.path, "/rest/api/2/search");
  const sent = seen.body as {
    jql: string;
    startAt: number;
    maxResults: number;
    fields: string[];
  };
  assert.equal(sent.jql, jql); // nothing appended to it
  assert.equal(sent.startAt, 10);
  assert.equal(sent.maxResults, 5);
  // The triage set: what ranks a backlog, and not the bodies that would make
  // every row a page of text.
  assert.ok(
    sent.fields.includes("assignee") && sent.fields.includes("issuelinks"),
  );
  assert.ok(
    !sent.fields.includes("description") && !sent.fields.includes("comment"),
  );

  assert.equal(results.total, 42);
  assert.equal(results.startAt, 10);
  assert.deepEqual(results.issues[0], {
    key: "PROJ-9",
    summary: "Rate limiter for the public API",
    status: "In Progress",
    issueType: "Story",
    assignee: "Alice",
    priority: "Major",
    updated: "2026-08-04T12:33:21.000+0300",
    components: ["Backend"],
    labels: ["api"],
    fixVersions: ["2.7.0"],
    // The blocker's own status rides along, so nothing extra has to be fetched.
    links: [
      {
        relation: "is blocked by",
        key: "PROJ-4",
        summary: "Token bucket",
        status: "Open",
      },
    ],
  });
  assert.equal(results.issues[1]?.assignee, null);
});

test("searchIssues surfaces a 401 as JiraAuthError", async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (_req, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  await assert.rejects(
    () =>
      makeJira().searchIssues(
        { baseUrl: base, cookie: "JSESSIONID=x" },
        "project = PROJ",
      ),
    JiraAuthError,
  );
});

test("searchIssues reports why Jira rejected a query, not just the status", async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (_req, res) => {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        errorMessages: [
          "Field 'nope' does not exist or you do not have permission to view it.",
        ],
        errors: {},
      }),
    );
  });
  await assert.rejects(
    () =>
      makeJira().searchIssues(
        { baseUrl: base, cookie: "JSESSIONID=x" },
        "nope = 1",
      ),
    /Field 'nope' does not exist/,
  );
});

test("searchIssues falls back to the status when the failure has no message", async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (_req, res) => {
    res.statusCode = 503;
    res.end("<html>down for maintenance</html>");
  });
  await assert.rejects(
    () =>
      makeJira().searchIssues(
        { baseUrl: base, cookie: "JSESSIONID=x" },
        "project = PROJ",
      ),
    /HTTP 503/,
  );
});

test("parseSearchResults words an outward link with the other side of the type", () => {
  const parsed = parseSearchResults({
    total: 1,
    issues: [
      {
        key: "PROJ-1",
        fields: {
          issuelinks: [
            {
              type: { inward: "is blocked by", outward: "blocks" },
              outwardIssue: {
                key: "PROJ-2",
                fields: { status: { name: "Done" } },
              },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(parsed.issues[0]?.links, [
    { relation: "blocks", key: "PROJ-2", summary: null, status: "Done" },
  ]);
});

test("parseSearchResults drops the rows and links it cannot name", () => {
  const parsed = parseSearchResults({
    issues: [
      { fields: { summary: "no key at all" } },
      { key: "PROJ-1", fields: { issuelinks: [{ type: {} }, "nonsense"] } },
    ],
  });
  assert.deepEqual(
    parsed.issues.map((i) => i.key),
    ["PROJ-1"],
  );
  assert.deepEqual(parsed.issues[0]?.links, []);
});

test("parseSearchResults survives a body with nothing in it", () => {
  assert.deepEqual(parseSearchResults(null), {
    startAt: 0,
    maxResults: 0,
    total: 0,
    issues: [],
  });
});

// --- Transparent session management (makeJiraAuth / withReauth) --------------

const CREDS: JiraCredentials = {
  baseUrl: "https://jira.test",
  username: "alice",
  password: "secret",
};

/** A scriptable JiraApi stub recording its logins. */
function stubJira(
  opts: { session?: JiraSession | null; loginError?: Error } = {},
): {
  jira: JiraApi;
  logins: number;
} {
  let logins = 0;
  const jira: JiraApi = {
    loadSession: async () => opts.session ?? null,
    login: async (baseUrl, username, password) => {
      logins++;
      if (opts.loginError) throw opts.loginError;
      // A fresh cookie per sign-in, so a retry can be distinguished from the stale session.
      return {
        baseUrl,
        cookie: `JSESSIONID=fresh-${logins}-${username}-${password.length}`,
      };
    },
    fetchIssueDetails: async () => null,
    searchIssues: async () => ({
      startAt: 0,
      maxResults: 0,
      total: 0,
      issues: [],
    }),
    downloadAttachment: async () => new Uint8Array(),
  };
  return {
    jira,
    get logins() {
      return logins;
    },
  };
}

function stubStore(creds: JiraCredentials | null): CredentialStore {
  return { load: async () => creds, save: async () => true };
}

test("JiraAuth.session returns the saved session without signing in", async () => {
  const saved: JiraSession = {
    baseUrl: "https://j",
    cookie: "JSESSIONID=saved",
  };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  assert.deepEqual(await auth.session(), saved);
  assert.equal(s.logins, 0); // a valid session needs no sign-in
});

test("JiraAuth.session signs in from saved credentials when there is no session", async () => {
  const s = stubJira({ session: null });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  assert.ok(session != null && session.cookie.startsWith("JSESSIONID=fresh"));
  assert.equal(s.logins, 1);
});

test("JiraAuth.session is null (no sign-in) with neither a session nor credentials", async () => {
  const s = stubJira({ session: null });
  // No credentials saved, and a missing store behaves the same.
  assert.equal(await makeJiraAuth(s.jira, stubStore(null)).session(), null);
  assert.equal(await makeJiraAuth(s.jira).session(), null);
  assert.equal(s.logins, 0);
});

test("JiraAuth.session memoises: concurrent callers share a single sign-in", async () => {
  const s = stubJira({ session: null });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const [a, b, c] = await Promise.all([
    auth.session(),
    auth.session(),
    auth.session(),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(s.logins, 1);
});

test("withReauth refreshes from saved credentials on a 401 and retries once", async () => {
  const saved: JiraSession = {
    baseUrl: "https://j",
    cookie: "JSESSIONID=stale",
  };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session(); // the stale on-disk session
  const seenCookies: string[] = [];
  const result = await withReauth(auth, session!, async (sess) => {
    seenCookies.push(sess.cookie);
    if (sess.cookie === "JSESSIONID=stale") throw new JiraAuthError("expired");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(s.logins, 1); // exactly one re-sign-in
  assert.deepEqual(seenCookies, ["JSESSIONID=stale", seenCookies[1]]); // stale, then fresh
  assert.ok(seenCookies[1]?.startsWith("JSESSIONID=fresh"));
});

test("withReauth coalesces a burst of concurrent 401s into one sign-in", async () => {
  const saved: JiraSession = {
    baseUrl: "https://j",
    cookie: "JSESSIONID=stale",
  };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  const run = () =>
    withReauth(auth, session!, async (sess) => {
      if (sess.cookie === "JSESSIONID=stale")
        throw new JiraAuthError("expired");
      return sess.cookie;
    });
  const results = await Promise.all([run(), run(), run(), run(), run()]);
  // All five recovered onto the same freshly-minted session, via one sign-in.
  assert.equal(s.logins, 1);
  assert.equal(new Set(results).size, 1);
});

test("withReauth surfaces the 401 when there are no credentials to recover with", async () => {
  const saved: JiraSession = {
    baseUrl: "https://j",
    cookie: "JSESSIONID=stale",
  };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(null)); // nothing to sign in with
  const session = await auth.session();
  await assert.rejects(
    () =>
      withReauth(auth, session!, async () => {
        throw new JiraAuthError("expired");
      }),
    JiraAuthError,
  );
});

test("withReauth surfaces a 401 when the saved credentials no longer work", async () => {
  const saved: JiraSession = {
    baseUrl: "https://j",
    cookie: "JSESSIONID=stale",
  };
  const s = stubJira({
    session: saved,
    loginError: new Error("wrong password"),
  });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  await assert.rejects(
    () =>
      withReauth(auth, session!, async () => {
        throw new JiraAuthError("expired");
      }),
    JiraAuthError,
  );
});

test("withReauth passes through a non-auth error without re-authenticating", async () => {
  const saved: JiraSession = { baseUrl: "https://j", cookie: "JSESSIONID=ok" };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  await assert.rejects(
    () =>
      withReauth(auth, session!, async () => {
        throw new Error("network boom");
      }),
    /network boom/,
  );
  assert.equal(s.logins, 0);
});

test("an unreachable Jira is reported as such by every call, never as not found", async (t: TestContext) => {
  isolateConfig(t);
  const base = await closedPort();
  const session = { baseUrl: base, cookie: "JSESSIONID=x" };
  const jira = makeJira();
  const unreachable = (e: unknown) =>
    e instanceof JiraUnreachableError &&
    e.message.includes(new URL(base).host) &&
    /connection refused/.test(e.message) &&
    /VPN/.test(e.message);
  await assert.rejects(() => jira.login(base, "alice", "secret"), unreachable);
  await assert.rejects(
    () => jira.fetchIssueDetails(session, "PROJ-9"),
    unreachable,
  );
  await assert.rejects(() => jira.searchIssues(session, "x"), unreachable);
  await assert.rejects(
    () => jira.downloadAttachment(session, `${base}/secure/attachment/5/a`),
    unreachable,
  );
});

test("a connection dropped mid-body is unreachable, not a parse failure", async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    res.write("partial");
    setTimeout(() => req.socket.destroy(), 20);
  });
  const session = { baseUrl: base, cookie: "JSESSIONID=x" };
  await assert.rejects(
    () =>
      makeJira().downloadAttachment(session, `${base}/secure/attachment/5/a`),
    /could not reach .*connection dropped/,
  );
});

test("fetchIssueDetails throws on a server error instead of reporting not found", async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (req, res) => {
    res.statusCode = (req.url ?? "").includes("/HIDDEN-1") ? 403 : 503;
    res.end("{}");
  });
  const session = { baseUrl: base, cookie: "JSESSIONID=x" };
  const jira = makeJira();
  await assert.rejects(
    () => jira.fetchIssueDetails(session, "PROJ-9"),
    /HTTP 503 for PROJ-9/,
  );
  assert.equal(await jira.fetchIssueDetails(session, "HIDDEN-1"), null);
});
