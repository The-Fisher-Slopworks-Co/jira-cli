<!--
SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# jira-cli

A Jira command-line client for AI agents and for old on-prem Jira. It prints an
issue as plain text on stdout — nothing to drive — and signs in with a username
and password, which is all a Server / Data Center instance older than 8.14
offers. Jira Cloud is not supported: it disabled cookie auth.

## Install

Targets [Bun](https://bun.sh) ≥ 1.1.

```sh
bun add -g @slopworks/jira-cli
```

## Usage

```sh
jira login              # prompts for URL, username, password
jira issue PROJ-123     # description, subtasks, comments, attachments
jira issue PROJ-123 --json
jira download PROJ-123 --out ./attachments
```

`jira login` puts the credentials in the OS keychain, and from then on the
session signs itself back in whenever the cookie expires. `JIRA_URL` overrides
the saved base URL.

The session is kept in `$XDG_CONFIG_HOME/jira-cli/session.json`, mode `600`.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
