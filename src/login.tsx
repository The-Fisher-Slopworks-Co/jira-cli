// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';

import { CancelError } from './cancel.js';
import { type CredentialStore, type JiraCredentials, makeCredentialStore } from './credentials.js';
import { makeJira, type JiraApi } from './jira.js';
import { ConfirmPrompt } from './components/ConfirmPrompt.js';
import { TextPrompt } from './components/TextPrompt.js';

/**
 * `jira login` — a standalone Jira sign-in. Two paths:
 *
 *   1. If credentials are saved in the OS keychain, sign in with them silently.
 *   2. Otherwise prompt for URL / username / password, sign in, then offer to
 *      save the credentials to the keychain for next time.
 *
 * Either way the session (base URL + JSESSIONID) is persisted to
 * `$XDG_CONFIG_HOME/jira-cli/session.json`, so `jira issue` and `jira download`
 * pick it up without prompting. Ctrl-C / Esc cancels with exit code 130.
 */
type Stage =
  | { step: 'loading' }
  | { step: 'url'; initialUrl: string }
  | { step: 'user'; baseUrl: string }
  | { step: 'pass'; baseUrl: string; username: string }
  | { step: 'submitting'; baseUrl: string; username: string; password: string; fromStore: boolean }
  | { step: 'savePrompt'; creds: JiraCredentials }
  | { step: 'saving'; creds: JiraCredentials }
  | { step: 'done' }
  | { step: 'error'; message: string };

export interface LoginAppProps {
  jira?: JiraApi;
  store?: CredentialStore;
}

export function LoginApp({ jira: jiraProp, store: storeProp }: LoginAppProps) {
  const { exit } = useApp();
  const jiraRef = useRef<JiraApi>(jiraProp ?? makeJira());
  const storeRef = useRef<CredentialStore>(storeProp ?? makeCredentialStore());
  const jira = jiraRef.current;
  const store = storeRef.current;

  const [log, setLog] = useState<string[]>([]);
  const addLog = useCallback((line: string) => setLog((prev) => [...prev, line]), []);
  const [stage, setStage] = useState<Stage>({ step: 'loading' });

  // Ctrl-C / Esc cancel with exit code 130 (see cli.tsx).
  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape) {
      exit(new CancelError());
    }
  });

  const processed = useRef(new WeakSet<object>());
  useEffect(() => {
    if (processed.current.has(stage)) {
      return;
    }
    processed.current.add(stage);

    const run = async () => {
      switch (stage.step) {
        case 'loading': {
          // Keychain first: saved credentials sign in with no prompts.
          const creds = await store.load();
          if (creds != null) {
            addLog(`found saved credentials for ${creds.username} — signing in…`);
            setStage({
              step: 'submitting',
              baseUrl: creds.baseUrl,
              username: creds.username,
              password: creds.password,
              fromStore: true,
            });
            break;
          }
          // No saved credentials: prefill the URL from JIRA_URL or the last session.
          const session = await jira.loadSession().catch(() => null);
          setStage({ step: 'url', initialUrl: process.env.JIRA_URL || session?.baseUrl || '' });
          break;
        }
        case 'submitting': {
          const { baseUrl, username, password, fromStore } = stage;
          try {
            await jira.login(baseUrl, username, password);
            addLog(`signed in to ${baseUrl} as ${username}. session saved.`);
            // Credentials that came from the keychain are already saved; only a
            // fresh interactive sign-in offers to store them.
            setStage(
              fromStore ? { step: 'done' } : { step: 'savePrompt', creds: { baseUrl, username, password } },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (fromStore) {
              // Saved credentials no longer work (e.g. the password changed).
              // Fall back to an interactive sign-in so the user can recover and
              // re-save, rather than dead-ending on every run.
              addLog(`saved credentials failed: ${message}. Sign in again.`);
              setStage({ step: 'url', initialUrl: baseUrl });
            } else {
              setStage({ step: 'error', message });
            }
          }
          break;
        }
        case 'saving': {
          const ok = await store.save(stage.creds);
          addLog(ok ? 'credentials saved to keychain.' : 'could not save credentials to keychain.');
          setStage({ step: 'done' });
          break;
        }
        case 'done': {
          exit();
          break;
        }
        case 'error': {
          exit(new Error(stage.message));
          break;
        }
        // Prompt-only steps wait for input.
        case 'url':
        case 'user':
        case 'pass':
        case 'savePrompt':
          break;
      }
    };

    run().catch((err) =>
      setStage({ step: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, [stage, jira, store, addLog, exit]);

  return (
    <Box flexDirection="column">
      <Static items={log}>{(line, i) => <Text key={i}>{line}</Text>}</Static>
      {/* Key by step so each prompt mounts fresh. */}
      <Box key={stage.step}>{renderStage(stage, setStage)}</Box>
    </Box>
  );
}

function renderStage(stage: Stage, setStage: (next: Stage) => void) {
  switch (stage.step) {
    case 'url':
      return (
        <TextPrompt
          label="Jira URL"
          required
          initialValue={stage.initialUrl}
          onSubmit={(v) => setStage({ step: 'user', baseUrl: v })}
        />
      );
    case 'user':
      return (
        <TextPrompt
          label="Jira username"
          required
          onSubmit={(v) => setStage({ step: 'pass', baseUrl: stage.baseUrl, username: v })}
        />
      );
    case 'pass':
      return (
        <TextPrompt
          label="Jira password"
          required
          mask="*"
          trim={false}
          onSubmit={(v) =>
            setStage({
              step: 'submitting',
              baseUrl: stage.baseUrl,
              username: stage.username,
              password: v,
              fromStore: false,
            })
          }
        />
      );
    case 'savePrompt':
      return (
        <ConfirmPrompt
          label="Save credentials to keychain?"
          defaultValue
          onSubmit={(ok) => setStage(ok ? { step: 'saving', creds: stage.creds } : { step: 'done' })}
        />
      );
    case 'loading':
      return <Text dimColor>Loading…</Text>;
    case 'submitting':
      return <Text dimColor>Signing in to Jira…</Text>;
    case 'saving':
      return <Text dimColor>Saving credentials…</Text>;
    case 'done':
    case 'error':
      return null;
  }
}
