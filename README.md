<!--
SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# jira-cli

A Jira command-line client for AI agents and for old on-prem Jira. Issues come
out as plain text on stdout, with no UI in the way. It logs in with a username
and password, which is all Server / Data Center gives you before 8.14. Jira Cloud
won't work at all: it dropped cookie auth.

## Install

Needs [Bun](https://bun.sh) 1.1 or newer.

```sh
bun add -g @slopworks/jira-cli
```

## Usage

```sh
jira login              # prompts for URL, username, password
jira issue PROJ-123     # description, subtasks, comments, attachments
jira issue PROJ-123 --json
jira search 'project = PROJ AND statusCategory != Done'
jira download PROJ-123 --out ./attachments
```

`jira login` puts your credentials in the OS keychain and writes the session to
`$XDG_CONFIG_HOME/jira-cli/session.json`, mode 600. After that it signs itself
back in whenever the cookie expires. `JIRA_URL` overrides the saved base URL.

`jira search` sends the JQL untouched — no clause is added to it — and prints a
row per issue, the linked issues underneath, and how much of the result set that
was. `--json` adds components, labels and fix versions; `--limit` and `--start`
page through the rest.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
