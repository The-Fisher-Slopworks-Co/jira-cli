<!--
SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# jira-cli

## Commands

```sh
bun install
bun test            # the node:test API, run by bun test
bun run typecheck   # tsc --noEmit, covers the tests too
bun run build       # tsc -p tsconfig.build.json → dist/
bun run dev -- help # run from source
```

## Architecture

`src/cli.ts` routes `issue` / `search` / `download` / `login` and owns the exit
codes. Everything under it is single-purpose:

- `jira.ts` — the adapter over `@slopworks/jira`: `JiraApi` (session, issue
  details, JQL search, attachment bytes) plus `makeJiraAuth`/`withReauth`, the
  transparent session source that signs in from the keychain and refreshes on a
  401.
- `session.ts` — session persistence (`$XDG_CONFIG_HOME/jira-cli/session.json`).
- `credentials.ts` — the OS keychain, via `Bun.secrets`.
- `issueText.ts` / `searchText.ts` — the pure formatters; `issueCmd.ts` /
  `searchCmd.ts` / `downloadCmd.ts` — the three non-interactive command runners.
- `login.ts` — the one interactive flow; `prompt.ts` — the terminal input it
  asks through.

## Gotchas

- Import local modules with a `.js` extension even though the files are `.ts`:
  `import { x } from './session.js'`. NodeNext rejects the extensionless form and
  emits the specifier verbatim, so what you write is what runs.
- **The library is transport; this repo is policy.** `@slopworks/jira` is pure by
  design — no filesystem, no `process.env`, no stored session. Anything about
  *where* a session or credential lives belongs here, never upstream.
- **`jira search` never touches the JQL.** It goes to Jira exactly as typed — no
  default scope, status filter or sort. What counts as an interesting issue is
  the caller's policy, and a clause added here is one they can't remove. The
  printed totals are the same idea: a truncated page must not read like a
  complete one. Search also carries its own timeout via `client.request`, since
  `getJson` would impose the library's six-second small-JSON one.
- Bun is a runtime requirement, not just a toolchain one: `credentials.ts` calls
  `Bun.secrets`. It is declared via a module-scoped `declare const Bun` so the
  node-typed tsconfig still compiles, and every call is wrapped in try/catch —
  a headless box or a locked keyring must degrade to "no credentials", not crash.
- Two tsconfigs. `tsconfig.json` is `noEmit` and includes the tests, so it backs
  `typecheck`; `tsconfig.build.json` emits to `dist/` and excludes them. A new
  compiler option almost always belongs in the base one.
- The commands never throw: they return a process exit code (`0` / `1`, `2` for
  usage, `130` interrupted). Keep it that way — the tests assert on the code, not
  on exceptions.
- `prompt.ts` is the only place that touches raw mode, and only for a masked
  answer: plain questions stay in cooked mode so the terminal keeps doing echo,
  line editing and SIGINT. Raw mode means owning Enter, backspace, Ctrl-C, Esc
  and escape sequences by hand, so keep the masked path as small as it is. Input
  is buffered because a chunk need not be a line — a pipe can deliver every
  answer at once.
- The one runtime dependency is `@slopworks/jira`, and it has none of its own.
  Weigh a new one against that: four prompts once cost 40 packages of TUI
  framework.
- Fixtures stay generic. Issue keys are `PROJ-*`, statuses are English, summaries
  are invented. No real tracker data.
- Dependabot can't regenerate `bun.lock`. Its PRs bump `package.json` only, so
  CI installs without `--frozen-lockfile` and the lockfile is refreshed by hand.

## Compliance

The repo follows the [org compliance standard](https://github.com/The-Fisher-Slopworks-Co/.github/blob/main/COMPLIANCE.md);
`.github/workflows/reuse.yml` fails the build when `reuse lint` does.

- The license is `AGPL-3.0-or-later`, never bare `AGPL-3.0` or `AGPL-3.0-only`.
  It appears in `package.json`, the README, `REUSE.toml` and every source header.
- Every new file needs copyright and license. Source files carry a two-line SPDX
  header in their own comment syntax; anything that cannot hold a comment falls
  under the `**` wildcard in `REUSE.toml`.
  ```ts
  // SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
  //
  // SPDX-License-Identifier: AGPL-3.0-or-later
  ```
- Don't add `CODE_OF_CONDUCT.md`, `SECURITY.md` or `CONTRIBUTING.md`. They are
  inherited org-wide from the `.github` repo.
- Third-party files keep their own license and get their own `REUSE.toml`
  annotation instead of the blanket wildcard.
