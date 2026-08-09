// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCredentials } from './credentials.js';

test('parseCredentials rejects absent or malformed input', () => {
  assert.equal(parseCredentials(null), null);
  assert.equal(parseCredentials('not json'), null);
  assert.equal(parseCredentials('{}'), null);
  // Missing a field.
  assert.equal(parseCredentials(JSON.stringify({ baseUrl: 'x', username: 'y' })), null);
  // Wrong type for a field.
  assert.equal(parseCredentials(JSON.stringify({ baseUrl: 1, username: 'y', password: 'z' })), null);
});

test('parseCredentials returns the triple for a valid entry, ignoring extras', () => {
  const creds = parseCredentials(
    JSON.stringify({
      baseUrl: 'https://jira.test',
      username: 'alice',
      password: 'secret',
      extra: 'ignored',
    }),
  );
  assert.deepEqual(creds, { baseUrl: 'https://jira.test', username: 'alice', password: 'secret' });
});
