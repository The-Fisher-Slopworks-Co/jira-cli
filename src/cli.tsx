#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render } from 'ink';

import { CancelError } from './cancel.js';
import { runDownloadCommand } from './downloadCmd.js';
import { runIssueCommand } from './issueCmd.js';
import { LoginApp } from './login.js';

const USAGE = `jira — command-line client for Jira Server / Data Center

Usage:
  jira issue <KEY>     print an issue: description, subtasks, comments, attachments
                       (add --json for the raw issue object)
  jira download <KEY>  download an issue's attachments (--out <dir> to choose where)
  jira login           sign in to Jira (refreshes the saved session)
  jira help            show this help
`;

const mode = process.argv[2];

if (mode == null || mode === 'help' || mode === '--help' || mode === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

// `jira issue` and `jira download` are non-interactive (plain stdout, no Ink) so
// a pipe or an AI agent can read an issue. Each manages its own exit code.
if (mode === 'issue') {
  process.exit(await runIssueCommand(process.argv.slice(3)));
}

if (mode === 'download') {
  process.exit(await runDownloadCommand(process.argv.slice(3)));
}

if (mode !== 'login') {
  process.stderr.write(`jira: unknown command '${mode}'\n\n${USAGE}`);
  process.exit(2);
}

// `jira login` is the one interactive command: it prompts through Ink and exits
// the process, mapping Ctrl-C / Esc to 130.
const { waitUntilExit } = render(<LoginApp />, { exitOnCtrlC: false });

try {
  await waitUntilExit();
} catch (err) {
  if (err instanceof CancelError) {
    process.exitCode = 130;
  } else {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
