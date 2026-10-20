<!--
SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# jira-cli

## Commands

```sh
bun install          # also installs the lefthook pre-commit hook
bun run check        # the whole gate: typecheck, lint, format:check, knip, reuse, test
bun test             # the node:test API, run by bun test
bun run typecheck    # tsc --noEmit, covers the tests too
bun run lint         # oxlint
bun run format       # prettier --write; format:check only verifies
bun run knip         # unused files, exports and dependencies
bun run reuse        # uvx reuse lint; needs uv installed
bun run build        # tsc -p tsconfig.build.json → dist/
bun run dev -- help  # run from source
```

CI runs the same gate (minus REUSE, which has its own workflow) plus
`bun run build`, and a version tag publishes only after it passes.

## Definition of done

- **Issues and pull requests are written in English** — title and body, whatever language the task was discussed in.
- **Never commit to main.** Every task starts on a fresh branch off `origin/main`, named `<type>/<short-task>` — `fix/`, `feat/`, `refactor/`, `chore/`.
- **One task = one branch = one PR.** Past ~300 changed lines, split it into several PRs. `.github/workflows/pr-size.yml` labels every PR `size:XS`…`size:XXL`; **`size:XL` or `size:XXL` means split the PR**, not "explain why it is large".
- **PR title is the squash commit subject:** conventional commit with a scope, enforced by `.github/workflows/pr-title.yml`.
  - Type: `feat` `fix` `refactor` `chore` `docs` `test` `ci` `perf` `revert`.
  - Scope (required): an area of `src/` — `cli` `credentials` `download` `issue` `jira` `login` `prompt` `search` `session` — or `deps` `github` `release`. A new area means adding it to the `scopes:` list in that workflow.
  - Subject: lowercase start, imperative, no trailing period.
  - The body describes this PR alone, following the PR template.
- **No AI attribution.** No `Assisted-by:` / `Co-Authored-By: <LLM>` trailers, no agent as commit author or committer, and no "Generated with/by …" lines or agent-platform links in PR bodies. The PR body becomes the squash commit body, so the PR title workflow checks the title, the body and every commit of the PR.
- **Before opening:** `bun run check` green, then open the PR and report its URL.
- **Never merge locally.** Merging happens on GitHub, squash only.

## Architecture

`src/cli.ts` routes `issue` / `search` / `download` / `login` and owns the exit
codes. Everything under it is single-purpose:

- `jira.ts` — the adapter over `@slopworks/jira`: `JiraApi` (session, issue
  details, JQL search, attachment bytes) plus `makeJiraAuth`/`withReauth`, the
  transparent session source that signs in from the keychain and refreshes on a
  401.
- `retry.ts` — `withRetry`: a few attempts with jittered backoff (or
  `Retry-After`) for a dropped connection, a timeout or a 429/502–504. Every
  `JiraApi` call goes through it; only safe because every call reads or signs in.
- `session.ts` — session persistence (`$XDG_CONFIG_HOME/jira-cli/session.json`).
- `credentials.ts` — the OS keychain, via `Bun.secrets`.
- `issueText.ts` / `searchText.ts` — the pure formatters; `issueCmd.ts` /
  `searchCmd.ts` / `downloadCmd.ts` — the three non-interactive command runners.
- `login.ts` — the one interactive flow; `prompt.ts` — the terminal input it
  asks through.

## Gotchas

- Import local modules with a `.js` extension even though the files are `.ts`:
  `import { x } from "./session.js"`. NodeNext rejects the extensionless form and
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
  usage, `3` Jira unreachable, `130` interrupted). A network failure must never
  read as "not found" or "run `jira login`" — `JiraUnreachableError` keeps it
  apart all the way up. Keep it that way — the tests assert on the code, not
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
- Dependabot runs the `bun` ecosystem, which regenerates `bun.lock` itself, so
  CI installs with `--frozen-lockfile`. It only opens security updates.

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
