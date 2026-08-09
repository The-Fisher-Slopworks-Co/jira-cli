// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { render } from 'ink-testing-library';

import { ConfirmPrompt } from './ConfirmPrompt.js';

async function answer(
  stdin: { write: (s: string) => void },
  text: string,
): Promise<void> {
  if (text) {
    stdin.write(text);
    await delay(20);
  }
  stdin.write('\r');
  await delay(20);
}

test('y then Enter submits true', async () => {
  let got: boolean | undefined;
  const { stdin } = render(
    <ConfirmPrompt label="Proceed?" defaultValue onSubmit={(v) => (got = v)} />,
  );
  await answer(stdin, 'y');
  assert.equal(got, true);
});

test('n then Enter submits false', async () => {
  let got: boolean | undefined;
  const { stdin } = render(
    <ConfirmPrompt label="Proceed?" defaultValue onSubmit={(v) => (got = v)} />,
  );
  await answer(stdin, 'n');
  assert.equal(got, false);
});

test('Enter alone submits the default (true)', async () => {
  let got: boolean | undefined;
  const { stdin } = render(
    <ConfirmPrompt label="Proceed?" defaultValue onSubmit={(v) => (got = v)} />,
  );
  await answer(stdin, '');
  assert.equal(got, true);
});

test('Enter alone submits the default (false)', async () => {
  let got: boolean | undefined;
  const { stdin } = render(
    <ConfirmPrompt label="Proceed?" defaultValue={false} onSubmit={(v) => (got = v)} />,
  );
  await answer(stdin, '');
  assert.equal(got, false);
});

test('a single keypress does not submit on its own', async () => {
  let submitted = false;
  const { stdin } = render(
    <ConfirmPrompt label="Proceed?" defaultValue onSubmit={() => (submitted = true)} />,
  );
  stdin.write('y');
  await delay(30);
  assert.equal(submitted, false);
});

test('shows the (Y/n) hint for a true default', () => {
  const { lastFrame } = render(
    <ConfirmPrompt label="Proceed?" defaultValue onSubmit={() => {}} />,
  );
  assert.match(lastFrame() ?? '', /\(Y\/n\)/);
});
