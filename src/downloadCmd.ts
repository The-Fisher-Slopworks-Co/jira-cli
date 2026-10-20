// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeCredentialStore, type CredentialStore } from "./credentials.js";
import {
  JiraAuthError,
  JiraUnreachableError,
  makeJira,
  makeJiraAuth,
  reportJiraFailure,
  resolveSession,
  retryNotice,
  withReauth,
  type JiraApi,
  type JiraAttachment,
  type JiraAuth,
} from "./jira.js";
import { formatBytes } from "./issueText.js";

/** Injectable side effects for {@link runDownloadCommand}, so it can be unit-tested. */
export interface DownloadCmdDeps {
  jira?: JiraApi;
  /** Saved Jira credentials, for transparent re-login. Defaults to the OS keychain. */
  store?: CredentialStore;
  /** Pre-built session source, for tests; production builds one from `jira` + `store`. */
  auth?: JiraAuth;
  /** Write to standard output (no trailing newline added). Defaults to `process.stdout`. */
  out?: (s: string) => void;
  /** Write to standard error (no trailing newline added). Defaults to `process.stderr`. */
  err?: (s: string) => void;
  /** Create the output directory (and parents). Defaults to `fs.mkdir({ recursive })`. */
  mkdirp?: (dir: string) => Promise<void>;
  /** Write one file's bytes. Defaults to {@link writeFileAtomic}. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
  /** Size of an existing file, or `null` if there is none. Defaults to `fs.stat`. */
  fileSize?: (path: string) => Promise<number | null>;
}

const USAGE = `Usage: jira download <KEY> [--out <dir>] [--force]

A file already in <dir> with the attachment's name and size is kept, so after
an interrupted run the same command fetches only what is missing.

  --out <dir>  where to write (default: the current directory)
  --force      download every attachment again, even the ones already there
`;

/**
 * Run `jira download <KEY>` — the non-interactive attachment downloader. Loads the
 * saved Jira session (signing in / refreshing from the keychain exactly like
 * `jira issue`), fetches the issue's attachment list, and writes every attachment
 * to `--out` (the current directory by default), replaying the session cookie.
 * An attachment already there with the same name and size is kept unless
 * `--force`, so re-running after an interruption fetches only what's missing.
 * Returns a process exit code: 0 on success (including an issue with no
 * attachments), 2 on a usage error, 3 when Jira can't be reached, 1 on any other
 * failure (no session, expired session, issue not found, or a download/write
 * error). Never throws.
 */
export async function runDownloadCommand(
  argv: string[],
  deps: DownloadCmdDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const mkdirp =
    deps.mkdirp ??
    (async (dir) => void (await mkdir(dir, { recursive: true })));
  const write = deps.writeFile ?? writeFileAtomic;
  const fileSize =
    deps.fileSize ??
    ((path) =>
      stat(path).then(
        (s) => s.size,
        () => null,
      ));

  // Parse: one positional KEY, plus --out/-o <dir> (or --out=<dir>).
  let outDir = ".";
  let force = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Never taken while i < argv.length; narrows for noUncheckedIndexedAccess.
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") {
      out(USAGE);
      return 0;
    } else if (arg === "--out" || arg === "-o") {
      const value = argv[++i];
      if (value == null) {
        err(USAGE);
        return 2;
      }
      outDir = value;
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else {
      positional.push(arg);
    }
  }

  const rawKey = positional[0];
  if (rawKey == null || rawKey === "") {
    err(USAGE);
    return 2;
  }
  const key = rawKey.toUpperCase();

  const jira = deps.jira ?? makeJira(undefined, { onRetry: retryNotice(err) });
  // Signs in from the saved keychain credentials when there's no session, so an
  // expired session doesn't dead-end an agent on `jira login` (as in `jira issue`).
  const auth =
    deps.auth ?? makeJiraAuth(jira, deps.store ?? makeCredentialStore());
  const session = await resolveSession(auth, err);
  if (typeof session === "number") return session;
  if (session == null) {
    err("jira: no Jira session — run `jira login` first.\n");
    return 1;
  }

  let details;
  try {
    // Refresh the session from saved credentials on a 401 and retry once.
    details = await withReauth(auth, session, (s) =>
      jira.fetchIssueDetails(s, key),
    );
  } catch (e) {
    return reportJiraFailure(e, err);
  }
  if (details == null) {
    err(`jira: issue ${key} not found, or you don't have access.\n`);
    return 1;
  }

  // Only attachments with a content URL can actually be downloaded.
  const attachments = details.attachments.filter(
    (a): a is JiraAttachment & { content: string } => a.content != null,
  );
  if (attachments.length === 0) {
    out(`${key} has no attachments.\n`);
    return 0;
  }

  try {
    await mkdirp(outDir);
  } catch (e) {
    err(
      `jira: could not create ${outDir}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }

  out(
    `Downloading ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} from ${key} to ${outDir}\n`,
  );

  // Track names used this run so two attachments with the same filename don't
  // clobber each other (Jira allows duplicate names on one issue).
  const used = new Set<string>();
  const tally: Tally = { downloaded: 0, kept: 0, failed: 0 };
  for (const [i, a] of attachments.entries()) {
    const name = uniqueName(
      safeFilename(a.filename, `attachment-${a.id ?? i + 1}`),
      used,
    );
    const dest = join(outDir, name);
    // Same name and size as Jira reports: a previous run already got it.
    if (!force && a.size != null && (await fileSize(dest)) === a.size) {
      tally.kept++;
      out(`  ${dest}  (${formatBytes(a.size)}, already there)\n`);
      continue;
    }
    try {
      const bytes = await withReauth(auth, session, (s) =>
        jira.downloadAttachment(s, a.content),
      );
      await write(dest, bytes);
      tally.downloaded++;
      const size = formatBytes(a.size ?? bytes.byteLength);
      out(`  ${dest}  (${size})\n`);
    } catch (e) {
      // An unrecoverable expired session or an unreachable Jira affects every
      // remaining file, so stop.
      if (e instanceof JiraAuthError || e instanceof JiraUnreachableError) {
        const code = reportJiraFailure(e, err);
        const rest = attachments.length - tally.downloaded - tally.kept;
        err(
          `jira: ${rest} of ${attachments.length} not downloaded — run the same command again to fetch the rest.\n`,
        );
        return code;
      }
      tally.failed++;
      err(
        `  failed: ${a.filename ?? name}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  out(`${summary(tally)}\n`);
  return tally.failed > 0 ? 1 : 0;
}

/** What one run did with each attachment. */
interface Tally {
  downloaded: number;
  /** Already in the output directory from an earlier run. */
  kept: number;
  failed: number;
}

/** The closing line: `Done: 2 downloaded, 1 already there, 1 failed.` */
function summary(tally: Tally): string {
  const parts = [
    `${tally.downloaded} downloaded`,
    tally.kept > 0 ? `${tally.kept} already there` : null,
    tally.failed > 0 ? `${tally.failed} failed` : null,
  ].filter((p) => p != null);
  return `Done: ${parts.join(", ")}.`;
}

/**
 * Write `data` to `path` through a `.part` file renamed into place, so a run cut
 * short never leaves a truncated file under the real name — one that the next
 * run would take for a finished download.
 */
async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  const part = `${path}.part`;
  await writeFile(part, data);
  await rename(part, path);
}

/**
 * Reduce a Jira-supplied filename to a safe basename: drop any directory part
 * (so a crafted `../../etc/passwd` can't escape the output directory) and fall
 * back to `fallback` for empty / `.` / `..` names.
 */
function safeFilename(raw: string | null, fallback: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const trimmed = base.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") return fallback;
  return trimmed;
}

/**
 * Return `name` if unused, else the first ` (n)` variant (inserted before the
 * extension) that is free, recording the result in `used`.
 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  // Split off a real extension only (a leading-dot name like `.env` has none).
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (used.has(`${stem} (${n})${ext}`)) n++;
  const unique = `${stem} (${n})${ext}`;
  used.add(unique);
  return unique;
}
