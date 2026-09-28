// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import type { JiraSearchResults, JiraSearchRow } from './jira.js';
import { formatSearchText } from './searchText.js';

function row(over: Partial<JiraSearchRow> = {}): JiraSearchRow {
  return {
    key: 'PROJ-1',
    summary: 'A summary',
    status: 'Open',
    issueType: 'Task',
    assignee: 'Alice',
    priority: 'Major',
    updated: '2026-08-04T12:33:21.000+0300',
    components: ['Backend'],
    labels: [],
    fixVersions: ['2.7.0'],
    links: [],
    ...over,
  };
}

function page(issues: JiraSearchRow[], over: Partial<JiraSearchResults> = {}): JiraSearchResults {
  return { startAt: 0, maxResults: 50, total: issues.length, issues, ...over };
}

test('aligns the columns and shows only the day of the last change', () => {
  const [first, second] = formatSearchText(
    page([
      row({ key: 'PROJ-1', issueType: 'Task', status: 'Open', assignee: 'Alice', summary: 'Short' }),
      row({ key: 'PROJ-100', issueType: 'Bug', status: 'In Progress', assignee: null, summary: 'Longer one' }),
    ]),
  ).split('\n');
  // Whatever the widths work out to, the summaries line up.
  assert.equal(first.indexOf('Short'), second.indexOf('Longer one'));
  assert.ok(first.includes('2026-08-04'));
  assert.ok(!first.includes('12:33'), 'the time of day is noise in a table');
  assert.ok(second.includes('unassigned'));
});

test('a row with nothing but a key still prints', () => {
  const bare: JiraSearchRow = {
    key: 'PROJ-7',
    summary: null,
    status: null,
    issueType: null,
    assignee: null,
    priority: null,
    updated: null,
    components: [],
    labels: [],
    fixVersions: [],
    links: [],
  };
  assert.match(formatSearchText(page([bare])), /^PROJ-7 {2}- {2}- {2}unassigned {2}-$/m);
});

test('lists links under the issues that have them', () => {
  const text = formatSearchText(
    page([
      row({ key: 'PROJ-1' }),
      row({
        key: 'PROJ-2',
        links: [{ relation: 'is blocked by', key: 'PROJ-9', summary: 'Auth rewrite', status: 'Open' }],
      }),
    ]),
  );
  assert.match(text, /Links\n-+\nPROJ-2 {2}is blocked by PROJ-9 \(Open\)/);
});

test('says nothing about links when no issue has one', () => {
  assert.ok(!formatSearchText(page([row(), row()])).includes('Links'));
});

test('the footer counts a complete result set', () => {
  assert.match(formatSearchText(page([row(), row()])), /\n2 issues\.$/);
  assert.match(formatSearchText(page([row()])), /\n1 issue\.$/);
});

test('the footer makes a truncated page — and its next page — visible', () => {
  const text = formatSearchText(page([row(), row()], { total: 120 }));
  assert.match(text, /Issues 1-2 of 120\. {2}\(--start 2 for the next page\)$/);
});

test('the footer drops the next-page hint on the last page', () => {
  assert.match(formatSearchText(page([row()], { startAt: 119, total: 120 })), /Issues 120-120 of 120\.$/);
});

test('an empty result set is a sentence, not a blank page', () => {
  assert.equal(formatSearchText(page([], { total: 0 })), 'No issues match.');
});

test('a page past the end says so, with the real total', () => {
  assert.equal(
    formatSearchText(page([], { startAt: 90, total: 12 })),
    'No issues at --start 90 (12 in total).',
  );
});
