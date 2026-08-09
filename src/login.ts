// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CancelError } from './cancel.js';
import { makeCredentialStore, type CredentialStore } from './credentials.js';
import { makeJira, type JiraApi } from './jira.js';
import { makePrompter, type Prompter } from './prompt.js';

/** Injectable side effects for {@link runLoginCommand}, so it can be unit-tested. */
export interface LoginCmdDeps {
  jira?: JiraApi;
  store?: CredentialStore;
  prompt?: Prompter;
  /** Write to standard error (no trailing newline added). Defaults to `process.stderr`. */
  err?: (s: string) => void;
  /** Base URL to offer as the prefill. Defaults to `JIRA_URL`. */
  jiraUrl?: string;
}

/**
 * Run `jira login`. Two paths:
 *
 *   1. Credentials in the OS keychain sign in silently, with no prompts.
 *   2. Otherwise prompt for URL / username / password, sign in, then offer to
 *      save the credentials to the keychain for next time.
 *
 * Saved credentials that no longer work (a changed password, say) fall through
 * to the interactive path rather than dead-ending, and the sign-in that follows
 * offers to re-save. Either way the session lands in
 * `$XDG_CONFIG_HOME/jira-cli/session.json`, which is what the other commands read.
 *
 * Returns a process exit code: 0 on success, 1 on a failed sign-in, 130 when the
 * user interrupts. Never throws.
 */
export async function runLoginCommand(deps: LoginCmdDeps = {}): Promise<number> {
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const jira = deps.jira ?? makeJira();
  const store = deps.store ?? makeCredentialStore();
  const prompt = deps.prompt ?? makePrompter();

  try {
    const saved = await store.load();
    if (saved != null) {
      prompt.log(`found saved credentials for ${saved.username} — signing in…`);
      try {
        await jira.login(saved.baseUrl, saved.username, saved.password);
        prompt.log(`signed in to ${saved.baseUrl} as ${saved.username}. session saved.`);
        return 0;
      } catch (e) {
        // Fall through to an interactive sign-in so the user can recover and
        // re-save, rather than dead-ending on every run.
        prompt.log(`saved credentials failed: ${message(e)}. Sign in again.`);
      }
    }

    const fallbackUrl = deps.jiraUrl ?? process.env.JIRA_URL;
    const previous = await jira.loadSession().catch(() => null);
    const baseUrl = await prompt.ask('Jira URL', {
      required: true,
      defaultValue: fallbackUrl || previous?.baseUrl || undefined,
    });
    const username = await prompt.ask('Jira username', { required: true });
    // Passwords are masked and sent verbatim — no trimming.
    const password = await prompt.ask('Jira password', {
      required: true,
      mask: '*',
      trim: false,
    });

    try {
      await jira.login(baseUrl, username, password);
    } catch (e) {
      err(`jira: ${message(e)}\n`);
      return 1;
    }
    prompt.log(`signed in to ${baseUrl} as ${username}. session saved.`);

    if (await prompt.confirm('Save credentials to keychain?', true)) {
      const ok = await store.save({ baseUrl, username, password });
      prompt.log(ok ? 'credentials saved to keychain.' : 'could not save credentials to keychain.');
    }
    return 0;
  } catch (e) {
    if (e instanceof CancelError) {
      return 130;
    }
    err(`jira: ${message(e)}\n`);
    return 1;
  } finally {
    prompt.close();
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
