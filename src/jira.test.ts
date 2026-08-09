// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { CredentialStore, JiraCredentials } from './credentials.js';
import {
  JiraAuthError,
  makeJira,
  makeJiraAuth,
  withReauth,
  type JiraApi,
  type JiraSession,
} from './jira.js';

// The Jira REST client itself (cookie auth, parsing, error model) is unit-tested
// in the `@slopworks/jira` library. These tests cover this CLI's thin adapter:
// that makeJira persists the session it signs in with, maps a fetched issue onto
// JiraIssueDetails, and preserves the 401-throws / recoverable-returns-null
// contract the commands rely on.

const WITH_BODY = {
  key: 'PROJ-9',
  fields: {
    summary: 'Has a body',
    status: { name: 'In Progress' },
    issuetype: { name: 'Task' },
    description: 'Line one\nLine two',
    comment: {
      comments: [
        { id: '1', author: { displayName: 'Alice' }, body: 'hi', created: '2026-01-02T10:00:00.000+0000' },
      ],
    },
    attachment: [
      {
        id: '5',
        filename: 'diagram.png',
        author: { displayName: 'Alice' },
        created: '2026-01-02T10:00:00.000+0000',
        size: 2048,
        mimeType: 'image/png',
        content: 'https://jira.example.com/secure/attachment/5/diagram.png',
      },
    ],
    subtasks: [
      { key: 'PROJ-10', fields: { summary: 'A child', status: { name: 'Done' }, issuetype: { name: 'Sub-task' } } },
    ],
  },
};

/**
 * Point the session file at a throwaway XDG dir and clear JIRA_URL for the
 * duration of `t`, so the real `login()` write never touches the user's session.
 * Restores on teardown.
 */
function isolateConfig(t: TestContext): void {
  const xdg = mkdtempSync(join(tmpdir(), 'jira-cli-xdg-'));
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

test('makeJira persists the session it signs in with, and reads it back', async (t: TestContext) => {
  isolateConfig(t);
  let sentCookie: string | undefined;
  const base = await listen(t, (req, res) => {
    const { pathname } = new URL(req.url ?? '', 'http://localhost');
    if (req.method === 'POST' && pathname === '/rest/auth/1/session') {
      res.setHeader('Set-Cookie', 'JSESSIONID=ABC123; Path=/; HttpOnly');
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && pathname === '/rest/api/2/issue/PROJ-9') {
      sentCookie = req.headers.cookie;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(WITH_BODY));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const jira = makeJira();

  // The library returns the session and stores nothing; this layer writes it,
  // which loadSession then reads back.
  const session = await jira.login(base, 'alice', 'secret');
  assert.equal(session.baseUrl, base);
  assert.equal(session.cookie, 'JSESSIONID=ABC123');
  assert.deepEqual(await jira.loadSession(), session);

  // The cookie is replayed on later requests.
  await jira.fetchIssueDetails(session, 'PROJ-9');
  assert.equal(sentCookie, 'JSESSIONID=ABC123');
});

test('loadSession is null before anyone has signed in', async (t: TestContext) => {
  isolateConfig(t);
  assert.equal(await makeJira().loadSession(), null);
});

test('fetchIssueDetails requests the body fields and maps description/comments/attachments', async (t: TestContext) => {
  isolateConfig(t);
  const seen: string[] = [];
  const base = await listen(t, (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    seen.push(url.searchParams.get('fields') ?? '');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(WITH_BODY));
  });
  const jira = makeJira();
  const details = await jira.fetchIssueDetails({ baseUrl: base, cookie: 'JSESSIONID=x' }, 'PROJ-9');
  const requestedFields = seen[0] ?? '';
  assert.ok(requestedFields.includes('description'));
  assert.ok(requestedFields.includes('comment') && requestedFields.includes('attachment'));
  assert.ok(requestedFields.includes('subtasks'));
  assert.deepEqual(details, {
    key: 'PROJ-9',
    summary: 'Has a body',
    status: 'In Progress',
    issueType: 'Task',
    parentKey: null,
    parentSummary: null,
    description: 'Line one\nLine two',
    comments: [
      { id: '1', author: 'Alice', body: 'hi', created: '2026-01-02T10:00:00.000+0000', updated: null },
    ],
    attachments: [
      {
        id: '5',
        filename: 'diagram.png',
        author: 'Alice',
        created: '2026-01-02T10:00:00.000+0000',
        size: 2048,
        mimeType: 'image/png',
        content: 'https://jira.example.com/secure/attachment/5/diagram.png',
      },
    ],
    subtasks: [{ key: 'PROJ-10', summary: 'A child', status: 'Done', issueType: 'Sub-task' }],
  });
});

test('fetchIssueDetails keeps an issue that has no summary', async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ key: 'PROJ-1', fields: { status: { name: 'Done' }, description: 'body' } }));
  });
  const jira = makeJira();
  const details = await jira.fetchIssueDetails({ baseUrl: base, cookie: 'JSESSIONID=x' }, 'PROJ-1');
  assert.equal(details?.summary, null);
  assert.equal(details?.description, 'body');
});

test('fetchIssueDetails surfaces a 401 as JiraAuthError and other errors as null', async (t: TestContext) => {
  isolateConfig(t);
  const base = await listen(t, (req, res) => {
    res.statusCode = (req.url ?? '').includes('/EXPIRED-1') ? 401 : 404;
    res.end('{}');
  });
  const session = { baseUrl: base, cookie: 'JSESSIONID=x' };
  const jira = makeJira();
  await assert.rejects(() => jira.fetchIssueDetails(session, 'EXPIRED-1'), JiraAuthError);
  assert.equal(await jira.fetchIssueDetails(session, 'MISSING-1'), null);
});

test('downloadAttachment replays the cookie and surfaces a 401 as JiraAuthError', async (t: TestContext) => {
  isolateConfig(t);
  let sentCookie: string | undefined;
  const base = await listen(t, (req, res) => {
    if ((req.url ?? '').includes('expired')) {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    sentCookie = req.headers.cookie;
    res.end('file-bytes');
  });
  const jira = makeJira();
  const session = { baseUrl: base, cookie: 'JSESSIONID=x' };
  const bytes = await jira.downloadAttachment(session, `${base}/secure/attachment/5/diagram.png`);
  assert.equal(new TextDecoder().decode(bytes), 'file-bytes');
  assert.equal(sentCookie, 'JSESSIONID=x');
  await assert.rejects(
    () => jira.downloadAttachment(session, `${base}/secure/attachment/6/expired.png`),
    JiraAuthError,
  );
});

// --- Transparent session management (makeJiraAuth / withReauth) --------------

const CREDS: JiraCredentials = { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' };

/** A scriptable JiraApi stub recording its logins. */
function stubJira(opts: { session?: JiraSession | null; loginError?: Error } = {}): {
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
      return { baseUrl, cookie: `JSESSIONID=fresh-${logins}-${username}-${password.length}` };
    },
    fetchIssueDetails: async () => null,
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

test('JiraAuth.session returns the saved session without signing in', async () => {
  const saved: JiraSession = { baseUrl: 'https://j', cookie: 'JSESSIONID=saved' };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  assert.deepEqual(await auth.session(), saved);
  assert.equal(s.logins, 0); // a valid session needs no sign-in
});

test('JiraAuth.session signs in from saved credentials when there is no session', async () => {
  const s = stubJira({ session: null });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  assert.ok(session != null && session.cookie.startsWith('JSESSIONID=fresh'));
  assert.equal(s.logins, 1);
});

test('JiraAuth.session is null (no sign-in) with neither a session nor credentials', async () => {
  const s = stubJira({ session: null });
  // No credentials saved, and a missing store behaves the same.
  assert.equal(await makeJiraAuth(s.jira, stubStore(null)).session(), null);
  assert.equal(await makeJiraAuth(s.jira).session(), null);
  assert.equal(s.logins, 0);
});

test('JiraAuth.session memoises: concurrent callers share a single sign-in', async () => {
  const s = stubJira({ session: null });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const [a, b, c] = await Promise.all([auth.session(), auth.session(), auth.session()]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(s.logins, 1);
});

test('withReauth refreshes from saved credentials on a 401 and retries once', async () => {
  const saved: JiraSession = { baseUrl: 'https://j', cookie: 'JSESSIONID=stale' };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session(); // the stale on-disk session
  const seenCookies: string[] = [];
  const result = await withReauth(auth, session!, async (sess) => {
    seenCookies.push(sess.cookie);
    if (sess.cookie === 'JSESSIONID=stale') throw new JiraAuthError('expired');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(s.logins, 1); // exactly one re-sign-in
  assert.deepEqual(seenCookies, ['JSESSIONID=stale', seenCookies[1]]); // stale, then fresh
  assert.ok(seenCookies[1]?.startsWith('JSESSIONID=fresh'));
});

test('withReauth coalesces a burst of concurrent 401s into one sign-in', async () => {
  const saved: JiraSession = { baseUrl: 'https://j', cookie: 'JSESSIONID=stale' };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  const run = () =>
    withReauth(auth, session!, async (sess) => {
      if (sess.cookie === 'JSESSIONID=stale') throw new JiraAuthError('expired');
      return sess.cookie;
    });
  const results = await Promise.all([run(), run(), run(), run(), run()]);
  // All five recovered onto the same freshly-minted session, via one sign-in.
  assert.equal(s.logins, 1);
  assert.equal(new Set(results).size, 1);
});

test('withReauth surfaces the 401 when there are no credentials to recover with', async () => {
  const saved: JiraSession = { baseUrl: 'https://j', cookie: 'JSESSIONID=stale' };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(null)); // nothing to sign in with
  const session = await auth.session();
  await assert.rejects(
    () => withReauth(auth, session!, async () => { throw new JiraAuthError('expired'); }),
    JiraAuthError,
  );
});

test('withReauth surfaces a 401 when the saved credentials no longer work', async () => {
  const saved: JiraSession = { baseUrl: 'https://j', cookie: 'JSESSIONID=stale' };
  const s = stubJira({ session: saved, loginError: new Error('wrong password') });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  await assert.rejects(
    () => withReauth(auth, session!, async () => { throw new JiraAuthError('expired'); }),
    JiraAuthError,
  );
});

test('withReauth passes through a non-auth error without re-authenticating', async () => {
  const saved: JiraSession = { baseUrl: 'https://j', cookie: 'JSESSIONID=ok' };
  const s = stubJira({ session: saved });
  const auth = makeJiraAuth(s.jira, stubStore(CREDS));
  const session = await auth.session();
  await assert.rejects(
    () => withReauth(auth, session!, async () => { throw new Error('network boom'); }),
    /network boom/,
  );
  assert.equal(s.logins, 0);
});
