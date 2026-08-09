// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import type { JiraIssueDetails } from './jira.js';
import {
  describeAttachment,
  describeSubtask,
  formatBytes,
  formatComment,
  formatIssueText,
} from './issueText.js';

function details(over: Partial<JiraIssueDetails> = {}): JiraIssueDetails {
  return {
    key: 'PROJ-9',
    summary: 'Has a body',
    status: 'In Progress',
    issueType: 'Task',
    parentKey: null,
    parentSummary: null,
    description: 'Line one\nLine two',
    comments: [],
    attachments: [],
    subtasks: [],
    ...over,
  };
}

test('formatBytes scales units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB');
});

test('describeAttachment shows name with type and size, tolerating missing meta', () => {
  assert.equal(
    describeAttachment({ id: '1', filename: 'a.png', author: null, created: null, size: 2048, mimeType: 'image/png', content: null }),
    'a.png  (image/png, 2.0 KB)',
  );
  assert.equal(
    describeAttachment({ id: null, filename: null, author: null, created: null, size: null, mimeType: null, content: null }),
    '(unnamed)',
  );
});

test('describeSubtask shows key with status and summary, dropping absent parts', () => {
  assert.equal(
    describeSubtask({ key: 'PROJ-10', summary: 'Backend', status: 'Done', issueType: 'Sub-task' }),
    'PROJ-10  [Done]  Backend',
  );
  assert.equal(describeSubtask({ key: 'PROJ-11', summary: 'Frontend', status: null, issueType: null }), 'PROJ-11  Frontend');
  assert.equal(describeSubtask({ key: 'PROJ-13', summary: null, status: 'Done', issueType: null }), 'PROJ-13  [Done]');
  assert.equal(describeSubtask({ key: 'PROJ-12', summary: null, status: null, issueType: null }), 'PROJ-12');
});

test('formatComment marks an edited comment and empty bodies', () => {
  assert.deepEqual(
    formatComment({ id: '1', author: 'Alice', body: 'hi', created: 'T1', updated: 'T2' }),
    ['[Alice · T1 (edited)]', 'hi'],
  );
  assert.deepEqual(formatComment({ id: '2', author: null, body: '', created: null, updated: null }), [
    '[?]',
    '(empty)',
  ]);
});

test('formatIssueText renders header, description, subtasks, comments, and attachments', () => {
  const text = formatIssueText(
    details({
      parentKey: 'PROJ-1',
      parentSummary: 'Story',
      subtasks: [
        { key: 'PROJ-10', summary: 'Backend', status: 'Done', issueType: 'Sub-task' },
        { key: 'PROJ-11', summary: 'Frontend', status: 'In Review', issueType: 'Sub-task' },
      ],
      comments: [{ id: '1', author: 'Alice', body: 'hello', created: 'T1', updated: null }],
      attachments: [
        { id: '5', filename: 'd.png', author: 'Alice', created: 'T1', size: 2048, mimeType: 'image/png', content: 'https://j/secure/attachment/5/d.png' },
      ],
    }),
    'https://jira.test',
  );
  assert.match(text, /^PROJ-9 {2}Has a body$/m);
  assert.match(text, /^Type {4}Task$/m);
  assert.match(text, /^Status {2}In Progress$/m);
  assert.match(text, /^Parent {2}PROJ-1 {2}Story$/m);
  assert.match(text, /^Link {4}https:\/\/jira\.test\/browse\/PROJ-9$/m);
  assert.match(text, /Description\n-----------\nLine one\nLine two/);
  assert.match(text, /Subtasks \(2\)\n-+\nPROJ-10 {2}\[Done\] {2}Backend\nPROJ-11 {2}\[In Review\] {2}Frontend/);
  assert.match(text, /Comments \(1\)/);
  assert.match(text, /\[Alice · T1\]\nhello/);
  assert.match(text, /Attachments \(1\)\n-+\nd\.png {2}\(image\/png, 2\.0 KB\)\n {2}https:\/\/j\/secure\/attachment\/5\/d\.png/);
});

test('formatIssueText shows empty/none placeholders and omits Parent/Link when absent', () => {
  const text = formatIssueText(details({ description: '   ', parentKey: null }), null);
  assert.match(text, /Description\n-----------\n\(empty\)/);
  assert.match(text, /Subtasks \(0\)\n-+\n\(none\)/);
  assert.match(text, /Comments \(0\)\n-+\n\(none\)/);
  assert.match(text, /Attachments \(0\)\n-+\n\(none\)/);
  assert.doesNotMatch(text, /Parent/);
  assert.doesNotMatch(text, /Link/);
});
