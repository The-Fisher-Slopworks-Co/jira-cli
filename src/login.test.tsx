// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { render } from 'ink-testing-library';

import type { CredentialStore, JiraCredentials } from './credentials.js';
import { LoginApp } from './login.js';
import type { JiraApi, JiraSession } from './jira.js';

interface LoginCall {
  baseUrl: string;
  username: string;
  password: string;
}

function fakeJira(
  opts: { session?: JiraSession | null; loginError?: Error } = {},
): { api: JiraApi; logins: LoginCall[] } {
  const logins: LoginCall[] = [];
  const session = opts.session === undefined ? null : opts.session;
  const api: JiraApi = {
    loadSession: async () => session,
    login: async (baseUrl, username, password) => {
      logins.push({ baseUrl, username, password });
      if (opts.loginError) {
        throw opts.loginError;
      }
      return { baseUrl, cookie: 'JSESSIONID=new' };
    },
    fetchIssueDetails: async () => null,
    downloadAttachment: async () => new Uint8Array(),
  };
  return { api, logins };
}

/** An in-memory credential store: starts with `creds` (default empty) and records saves. */
function fakeStore(
  creds: JiraCredentials | null = null,
): { api: CredentialStore; saves: JiraCredentials[] } {
  const saves: JiraCredentials[] = [];
  const api: CredentialStore = {
    load: async () => creds,
    save: async (c) => {
      saves.push(c);
      return true;
    },
  };
  return { api, saves };
}

/** Neutralise JIRA_URL so the URL prefill is deterministic, restoring after. */
function clearJiraUrl(t: TestContext): void {
  const prev = process.env.JIRA_URL;
  delete process.env.JIRA_URL;
  t.after(() => {
    if (prev === undefined) {
      delete process.env.JIRA_URL;
    } else {
      process.env.JIRA_URL = prev;
    }
  });
}

async function waitForFrame(
  lastFrame: () => string | undefined,
  re: RegExp,
  timeout = 4000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (re.test(lastFrame() ?? '')) {
      return;
    }
    await delay(15);
  }
  throw new Error(`timed out waiting for ${re}\nlast frame:\n${lastFrame() ?? '(none)'}`);
}

async function waitFor(cond: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (cond()) {
      return;
    }
    await delay(15);
  }
  throw new Error('timed out waiting for condition');
}

async function submitText(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  stdin.write(text);
  await delay(25);
  stdin.write('\r');
}

test('signs in with the entered credentials and saves the session', async (t) => {
  clearJiraUrl(t);
  const jira = fakeJira();
  const store = fakeStore();
  const { stdin, lastFrame, frames } = render(<LoginApp jira={jira.api} store={store.api} />);

  await waitForFrame(lastFrame, /Jira URL/);
  await submitText(stdin, 'https://jira.test');
  await waitForFrame(lastFrame, /Jira username/);
  await submitText(stdin, 'alice');

  await waitForFrame(lastFrame, /Jira password/);
  // Masked and sent verbatim (trim disabled).
  stdin.write('secret');
  await waitForFrame(lastFrame, /\*{6}/);
  assert.doesNotMatch(lastFrame() ?? '', /secret/);
  stdin.write('\r');

  await waitFor(() => jira.logins.length > 0);
  assert.deepEqual(jira.logins, [
    { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' },
  ]);
  await waitFor(() => frames.some((f) => /session saved/.test(f)));

  // Declining the save prompt writes nothing to the keychain.
  await waitForFrame(lastFrame, /Save credentials to keychain\?/);
  await submitText(stdin, 'n');
  assert.deepEqual(store.saves, []);
});

test('saves credentials to the keychain when the prompt is accepted', async (t) => {
  clearJiraUrl(t);
  const jira = fakeJira();
  const store = fakeStore();
  const { stdin, lastFrame } = render(<LoginApp jira={jira.api} store={store.api} />);

  await waitForFrame(lastFrame, /Jira URL/);
  await submitText(stdin, 'https://jira.test');
  await waitForFrame(lastFrame, /Jira username/);
  await submitText(stdin, 'alice');
  await waitForFrame(lastFrame, /Jira password/);
  await submitText(stdin, 'secret');

  await waitForFrame(lastFrame, /Save credentials to keychain\?/);
  await submitText(stdin, 'y');

  await waitFor(() => store.saves.length > 0);
  assert.deepEqual(store.saves, [
    { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' },
  ]);
});

test('signs in from saved keychain credentials without any prompts', async (t) => {
  clearJiraUrl(t);
  const jira = fakeJira();
  const store = fakeStore({ baseUrl: 'https://jira.test', username: 'alice', password: 'secret' });
  const { frames } = render(<LoginApp jira={jira.api} store={store.api} />);

  await waitFor(() => jira.logins.length > 0);
  assert.deepEqual(jira.logins, [
    { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' },
  ]);
  await waitFor(() => frames.some((f) => /session saved/.test(f)));
  // No interactive prompts, and no re-offer to save (already stored).
  assert.ok(!frames.some((f) => /Jira URL/.test(f)));
  assert.ok(!frames.some((f) => /Save credentials/.test(f)));
  assert.deepEqual(store.saves, []);
});

test('prefills the URL from the saved session', async (t) => {
  clearJiraUrl(t);
  const jira = fakeJira({ session: { baseUrl: 'https://saved.jira', cookie: 'JSESSIONID=x' } });
  const { lastFrame } = render(<LoginApp jira={jira.api} store={fakeStore().api} />);

  await waitForFrame(lastFrame, /Jira URL/);
  assert.match(lastFrame() ?? '', /https:\/\/saved\.jira/);
});

test('attempts login and surfaces a failure', async (t) => {
  clearJiraUrl(t);
  const jira = fakeJira({ loginError: new Error('wrong username/password') });
  const { stdin, lastFrame, frames } = render(<LoginApp jira={jira.api} store={fakeStore().api} />);

  await waitForFrame(lastFrame, /Jira URL/);
  await submitText(stdin, 'https://jira.test');
  await waitForFrame(lastFrame, /Jira username/);
  await submitText(stdin, 'alice');
  await waitForFrame(lastFrame, /Jira password/);
  await submitText(stdin, 'bad');

  await waitFor(() => jira.logins.length > 0);
  // The failure path never reports success.
  assert.ok(!frames.some((f) => /session saved/.test(f)));
});
