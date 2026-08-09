// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { configDir, makeSessionStore, parseSession, sessionPath } from './session.js';

/** A throwaway directory, removed when the test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jira-cli-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('configDir honours XDG_CONFIG_HOME and falls back to ~/.config', () => {
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'), join('/xdg', 'jira-cli'));
  assert.equal(configDir({}, '/home/u'), join('/home/u', '.config', 'jira-cli'));
  // An empty value is not a directory; treat it as unset rather than resolving
  // the session file to a relative path.
  assert.equal(configDir({ XDG_CONFIG_HOME: '' }, '/home/u'), join('/home/u', '.config', 'jira-cli'));
});

test('sessionPath is the session file inside the config directory', () => {
  assert.equal(sessionPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'), '/xdg/jira-cli/session.json');
});

test('parseSession accepts a complete session and rejects everything else', () => {
  assert.deepEqual(parseSession('{"baseUrl":"https://j","cookie":"JSESSIONID=x"}'), {
    baseUrl: 'https://j',
    cookie: 'JSESSIONID=x',
  });
  // Extra keys are dropped, not preserved.
  assert.deepEqual(parseSession('{"baseUrl":"https://j","cookie":"c","extra":1}'), {
    baseUrl: 'https://j',
    cookie: 'c',
  });
  assert.equal(parseSession(null), null);
  assert.equal(parseSession('not json'), null);
  assert.equal(parseSession('{"baseUrl":"https://j"}'), null);
  assert.equal(parseSession('{"cookie":"JSESSIONID=x"}'), null);
  assert.equal(parseSession('{"baseUrl":1,"cookie":"c"}'), null);
});

test('the store reads back what it saved', async (t: TestContext) => {
  const path = join(tempDir(t), 'nested', 'session.json');
  const store = makeSessionStore(path);
  assert.equal(await store.load(), null); // nothing saved yet

  const session = { baseUrl: 'https://jira.example.com', cookie: 'JSESSIONID=ABC' };
  await store.save(session); // creates the directory on the way
  assert.deepEqual(await store.load(), session);
});

test('the session file is not readable by anyone else', async (t: TestContext) => {
  const path = join(tempDir(t), 'session.json');
  await makeSessionStore(path).save({ baseUrl: 'https://j', cookie: 'JSESSIONID=secret' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('an existing world-readable session file is narrowed on the next save', async (t: TestContext) => {
  const path = join(tempDir(t), 'session.json');
  // `mode` on writeFile only applies when the file is created, so a file left
  // over from a laxer umask would otherwise keep its permissions.
  writeFileSync(path, '{}', { mode: 0o644 });
  await makeSessionStore(path).save({ baseUrl: 'https://j', cookie: 'JSESSIONID=secret' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a malformed session file reads as "not signed in"', async (t: TestContext) => {
  const path = join(tempDir(t), 'session.json');
  writeFileSync(path, 'garbage{');
  assert.equal(await makeSessionStore(path).load(), null);
});
