<!--
SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# jira-cli

Read a Jira Server / Data Center issue from the terminal, and download its
attachments. It signs in with a username and password rather than an API token,
so it works on the older on-prem instances where personal access tokens aren't
available. Output is plain text on stdout, which makes it usable from a pipe or
by an AI agent.

Built on [`@slopworks/jira`](https://github.com/The-Fisher-Slopworks-Co/jira),
which is its only dependency and has none of its own. Jira Cloud is not
supported — it disabled cookie auth.

## Install

Needs [Bun](https://bun.sh) ≥ 1.1: the keychain is `Bun.secrets`.

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

`jira login` offers to save your credentials to the OS keychain. Once it has,
the other commands sign in — and refresh an expired session — on their own, so
you only run `login` again if the saved credentials stop working.

Exit codes: `0` success, `2` usage error, `1` anything else (no session, unknown
key, failed download). Set `JIRA_URL` to override the base URL used for the
`Link` line.

## Where things are kept

| What | Where |
|---|---|
| Session (base URL + `JSESSIONID`) | `$XDG_CONFIG_HOME/jira-cli/session.json`, mode `600` |
| Username and password | OS keychain, service `jira-cli` |

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
