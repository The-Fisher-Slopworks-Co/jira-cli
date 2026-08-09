// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { render } from 'ink-testing-library';

import { TextPrompt } from './TextPrompt.js';

test('renders the label', () => {
  const { lastFrame } = render(<TextPrompt label="Task" required onSubmit={() => {}} />);
  assert.match(lastFrame() ?? '', /Task/);
});

test('typing then Enter submits the trimmed value', async () => {
  let got: string | undefined;
  const { stdin } = render(
    <TextPrompt label="Task" required onSubmit={(v) => (got = v)} />,
  );
  stdin.write('TASK-1');
  await delay(20);
  stdin.write('\r');
  await delay(20);
  assert.equal(got, 'TASK-1');
});

test('required empty input is rejected with a message and not submitted', async () => {
  let submitted = false;
  const { stdin, lastFrame } = render(
    <TextPrompt label="Task" required onSubmit={() => (submitted = true)} />,
  );
  stdin.write('\r');
  await delay(20);
  assert.equal(submitted, false);
  assert.match(lastFrame() ?? '', /This field is required\./);
});

test('optional empty input submits an empty string', async () => {
  let got: string | undefined;
  const { stdin } = render(
    <TextPrompt label="Story" required={false} onSubmit={(v) => (got = v)} />,
  );
  stdin.write('\r');
  await delay(20);
  assert.equal(got, '');
});

test('pre-filled initial value is submitted when accepted as-is', async () => {
  let got: string | undefined;
  const { stdin } = render(
    <TextPrompt label="Task title" required initialValue="Old title" onSubmit={(v) => (got = v)} />,
  );
  stdin.write('\r');
  await delay(20);
  assert.equal(got, 'Old title');
});
