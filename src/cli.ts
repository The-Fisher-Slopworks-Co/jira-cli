#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { runDownloadCommand } from './downloadCmd.js';
import { runIssueCommand } from './issueCmd.js';
import { runLoginCommand } from './login.js';

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

// Every command returns its own exit code and never throws: `issue` and
// `download` write plain text to stdout so a pipe or an agent can read them,
// `login` prompts. 0 success, 2 usage error, 130 interrupted, 1 anything else.
if (mode === 'issue') {
  process.exit(await runIssueCommand(process.argv.slice(3)));
}

if (mode === 'download') {
  process.exit(await runDownloadCommand(process.argv.slice(3)));
}

if (mode === 'login') {
  process.exit(await runLoginCommand());
}

process.stderr.write(`jira: unknown command '${mode}'\n\n${USAGE}`);
process.exit(2);
