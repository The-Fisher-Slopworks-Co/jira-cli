// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelError } from './cancel.js';
import type { CredentialStore, JiraCredentials } from './credentials.js';
import type { JiraApi, JiraSession } from './jira.js';
import { runLoginCommand } from './login.js';
import type { AskOptions, Prompter } from './prompt.js';

interface LoginCall {
  baseUrl: string;
  username: string;
  password: string;
}

function fakeJira(opts: { session?: JiraSession | null; loginError?: Error } = {}): {
  api: JiraApi;
  logins: LoginCall[];
} {
  const logins: LoginCall[] = [];
  const api: JiraApi = {
    loadSession: async () => opts.session ?? null,
    login: async (baseUrl, username, password) => {
      logins.push({ baseUrl, username, password });
      if (opts.loginError) throw opts.loginError;
      return { baseUrl, cookie: 'JSESSIONID=new' };
    },
    fetchIssueDetails: async () => null,
    searchIssues: async () => ({ startAt: 0, maxResults: 0, total: 0, issues: [] }),
    downloadAttachment: async () => new Uint8Array(),
  };
  return { api, logins };
}

/** An in-memory credential store: starts with `creds` (default empty) and records saves. */
function fakeStore(creds: JiraCredentials | null = null): {
  api: CredentialStore;
  saves: JiraCredentials[];
} {
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

/**
 * A prompter that answers from a script. Every question and its options are
 * recorded, so a test can assert on the prefill without driving a terminal.
 */
function scriptedPrompter(opts: { answers?: string[]; confirm?: boolean; cancelAt?: number } = {}) {
  const asked: { label: string; options: AskOptions }[] = [];
  const confirmed: string[] = [];
  const logs: string[] = [];
  let closed = false;
  let next = 0;

  const api: Prompter = {
    async ask(label, options = {}) {
      asked.push({ label, options });
      if (opts.cancelAt === asked.length) throw new CancelError('cancelled');
      const answer = opts.answers?.[next++];
      assert.ok(answer !== undefined, `unscripted prompt: ${label}`);
      return answer;
    },
    async confirm(label) {
      confirmed.push(label);
      return opts.confirm ?? true;
    },
    log: (line) => void logs.push(line),
    close: () => void (closed = true),
  };

  return {
    api,
    asked,
    confirmed,
    logs,
    text: () => logs.join('\n'),
    isClosed: () => closed,
  };
}

const ENTERED = ['https://jira.test', 'alice', 'secret'];

test('signs in with the entered credentials and offers to save them', async () => {
  const jira = fakeJira();
  const store = fakeStore();
  const prompt = scriptedPrompter({ answers: ENTERED, confirm: false });

  const code = await runLoginCommand({ jira: jira.api, store: store.api, prompt: prompt.api, jiraUrl: '' });

  assert.equal(code, 0);
  assert.deepEqual(jira.logins, [
    { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' },
  ]);
  assert.match(prompt.text(), /signed in to https:\/\/jira\.test as alice\. session saved\./);
  // Declining the save prompt writes nothing to the keychain.
  assert.deepEqual(prompt.confirmed, ['Save credentials to keychain?']);
  assert.deepEqual(store.saves, []);
  assert.ok(prompt.isClosed());
});

test('saves credentials to the keychain when the prompt is accepted', async () => {
  const jira = fakeJira();
  const store = fakeStore();
  const prompt = scriptedPrompter({ answers: ENTERED, confirm: true });

  assert.equal(
    await runLoginCommand({ jira: jira.api, store: store.api, prompt: prompt.api, jiraUrl: '' }),
    0,
  );
  assert.deepEqual(store.saves, [
    { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' },
  ]);
  assert.match(prompt.text(), /credentials saved to keychain\./);
});

test('the password is asked masked and untrimmed', async () => {
  const jira = fakeJira();
  const prompt = scriptedPrompter({ answers: ENTERED });

  await runLoginCommand({ jira: jira.api, store: fakeStore().api, prompt: prompt.api, jiraUrl: '' });

  assert.deepEqual(
    prompt.asked.map((a) => a.label),
    ['Jira URL', 'Jira username', 'Jira password'],
  );
  const password = prompt.asked[2]!.options;
  assert.equal(password.mask, '*');
  assert.equal(password.trim, false);
  assert.equal(password.required, true);
});

test('signs in from saved keychain credentials without any prompts', async () => {
  const jira = fakeJira();
  const store = fakeStore({ baseUrl: 'https://jira.test', username: 'alice', password: 'secret' });
  const prompt = scriptedPrompter();

  assert.equal(
    await runLoginCommand({ jira: jira.api, store: store.api, prompt: prompt.api, jiraUrl: '' }),
    0,
  );
  assert.deepEqual(jira.logins, [
    { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' },
  ]);
  assert.match(prompt.text(), /session saved\./);
  // No questions, and no re-offer to save what is already stored.
  assert.deepEqual(prompt.asked, []);
  assert.deepEqual(prompt.confirmed, []);
  assert.deepEqual(store.saves, []);
});

test('prefills the URL from the saved session', async () => {
  const jira = fakeJira({ session: { baseUrl: 'https://saved.jira', cookie: 'JSESSIONID=x' } });
  const prompt = scriptedPrompter({ answers: ENTERED });

  await runLoginCommand({ jira: jira.api, store: fakeStore().api, prompt: prompt.api, jiraUrl: '' });

  assert.equal(prompt.asked[0]?.options.defaultValue, 'https://saved.jira');
});

test('JIRA_URL wins over the saved session for the prefill', async () => {
  const jira = fakeJira({ session: { baseUrl: 'https://saved.jira', cookie: 'JSESSIONID=x' } });
  const prompt = scriptedPrompter({ answers: ENTERED });

  await runLoginCommand({
    jira: jira.api,
    store: fakeStore().api,
    prompt: prompt.api,
    jiraUrl: 'https://from.env',
  });

  assert.equal(prompt.asked[0]?.options.defaultValue, 'https://from.env');
});

test('a failed sign-in exits 1 and never reports success', async () => {
  const jira = fakeJira({ loginError: new Error('wrong username/password') });
  const prompt = scriptedPrompter({ answers: ENTERED });
  const errors: string[] = [];

  const code = await runLoginCommand({
    jira: jira.api,
    store: fakeStore().api,
    prompt: prompt.api,
    err: (s) => void errors.push(s),
    jiraUrl: '',
  });

  assert.equal(code, 1);
  assert.match(errors.join(''), /wrong username\/password/);
  assert.doesNotMatch(prompt.text(), /session saved/);
  assert.deepEqual(prompt.confirmed, []); // nothing to offer saving
  assert.ok(prompt.isClosed());
});

test('saved credentials that stopped working fall through to an interactive sign-in', async () => {
  // The stored password fails once; the run recovers by asking, and then offers
  // to save the corrected credentials.
  let attempt = 0;
  const logins: LoginCall[] = [];
  const jira: JiraApi = {
    loadSession: async () => null,
    login: async (baseUrl, username, password) => {
      logins.push({ baseUrl, username, password });
      if (++attempt === 1) throw new Error('wrong username/password');
      return { baseUrl, cookie: 'JSESSIONID=new' };
    },
    fetchIssueDetails: async () => null,
    searchIssues: async () => ({ startAt: 0, maxResults: 0, total: 0, issues: [] }),
    downloadAttachment: async () => new Uint8Array(),
  };
  const store = fakeStore({ baseUrl: 'https://jira.test', username: 'alice', password: 'stale' });
  const prompt = scriptedPrompter({ answers: ENTERED, confirm: true });

  const code = await runLoginCommand({ jira, store: store.api, prompt: prompt.api, jiraUrl: '' });

  assert.equal(code, 0);
  assert.match(prompt.text(), /saved credentials failed: wrong username\/password\. Sign in again\./);
  assert.deepEqual(logins.map((l) => l.password), ['stale', 'secret']);
  assert.deepEqual(store.saves, [
    { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' },
  ]);
});

test('interrupting a prompt exits 130 and closes the prompter', async () => {
  const jira = fakeJira();
  const prompt = scriptedPrompter({ answers: ENTERED, cancelAt: 2 });

  const code = await runLoginCommand({
    jira: jira.api,
    store: fakeStore().api,
    prompt: prompt.api,
    jiraUrl: '',
  });

  assert.equal(code, 130);
  assert.deepEqual(jira.logins, []);
  assert.ok(prompt.isClosed());
});
