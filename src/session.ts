// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the CLI keeps its Jira session between runs.
 *
 * `@slopworks/jira` is deliberately pure: it hands back a {@link JiraSession}
 * and never stores it, because where a session lives is policy, not transport.
 * This module is that policy — the session file is
 * `$XDG_CONFIG_HOME/jira-cli/session.json` (falling back to `~/.config`),
 * written `600` since it holds a live `JSESSIONID`.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { JiraSession } from "@slopworks/jira";

/** Directory the CLI owns under `$XDG_CONFIG_HOME` (or `~/.config`). */
export const CONFIG_DIR = "jira-cli";
/** Session file name inside {@link CONFIG_DIR}. */
export const SESSION_FILE = "session.json";

/** The config directory, honouring `$XDG_CONFIG_HOME` when it is set and non-empty. */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg != null && xdg !== "" ? xdg : join(home, ".config");
  return join(base, CONFIG_DIR);
}

/** Absolute path of the session file. */
export function sessionPath(env?: NodeJS.ProcessEnv, home?: string): string {
  return join(configDir(env, home), SESSION_FILE);
}

/**
 * Validate a raw session file body into a {@link JiraSession}, or `null` when it
 * is absent, unparseable, or missing either field. A malformed file reads as
 * "no session" so the CLI falls back to signing in rather than crashing.
 */
export function parseSession(raw: string | null): JiraSession | null {
  if (raw == null) {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Partial<JiraSession>;
    if (typeof obj.baseUrl === "string" && typeof obj.cookie === "string") {
      return { baseUrl: obj.baseUrl, cookie: obj.cookie };
    }
  } catch {
    // Malformed JSON → treat as absent.
  }
  return null;
}

/** Read / persist the session. `load` degrades to `null`; `save` throws. */
export interface SessionStore {
  /** The stored session, or `null` if there is none (or it is unreadable). */
  load(): Promise<JiraSession | null>;
  /** Persist the session, creating the config directory if needed. */
  save(session: JiraSession): Promise<void>;
}

/** Build the file-backed {@link SessionStore}. */
export function makeSessionStore(path: string = sessionPath()): SessionStore {
  return {
    async load() {
      try {
        return parseSession(await readFile(path, "utf8"));
      } catch {
        // Missing file, unreadable, no permission — all mean "not signed in".
        return null;
      }
    },
    async save(session) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, {
        mode: 0o600,
      });
      // `mode` on writeFile only applies when the file is created, so an older
      // file keeps its permissions. Narrow them explicitly.
      await chmod(path, 0o600);
    },
  };
}
