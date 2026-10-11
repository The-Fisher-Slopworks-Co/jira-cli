// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Secure storage for Jira credentials, backed by the OS secret store via Bun's
 * built-in `Bun.secrets` (macOS Keychain / Linux libsecret / Windows Credential
 * Manager). Kept behind an interface so tests inject an in-memory stub instead
 * of touching the real keychain — mirroring how {@link makeJira} is stubbed.
 */

/** A Jira credential triple: enough to sign in from scratch on a fresh machine. */
export interface JiraCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

/** Read / persist the saved Jira credentials. Both degrade gracefully (see impl). */
export interface CredentialStore {
  /** The stored credentials, or `null` if none are saved or the store is unavailable. */
  load(): Promise<JiraCredentials | null>;
  /** Persist the credentials. Best-effort: returns `false` if the store rejected it. */
  save(creds: JiraCredentials): Promise<boolean>;
}

// The project's tsconfig scopes global types to node + react (no bun-types), so
// we declare just the slice of `Bun.secrets` we call rather than pull in the
// whole Bun global. This `declare` is module-scoped and never leaks past here.
declare const Bun: {
  secrets: {
    get(options: { service: string; name: string }): Promise<string | null>;
    set(options: {
      service: string;
      name: string;
      value: string;
    }): Promise<void>;
  };
};

/** Service + account under which the single Jira credential set is stored. */
const SERVICE = "jira-cli";
const ACCOUNT = "jira";

/** Validate a raw keychain value into credentials, or `null` if absent/malformed. */
export function parseCredentials(raw: string | null): JiraCredentials | null {
  if (raw == null) {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Partial<JiraCredentials>;
    if (
      typeof obj.baseUrl === "string" &&
      typeof obj.username === "string" &&
      typeof obj.password === "string"
    ) {
      return {
        baseUrl: obj.baseUrl,
        username: obj.username,
        password: obj.password,
      };
    }
  } catch {
    // Malformed JSON → treat as absent.
  }
  return null;
}

/** Build the real keychain-backed {@link CredentialStore}. */
export function makeCredentialStore(): CredentialStore {
  return {
    async load() {
      // `Bun.secrets.get` throws (rather than returning null) when no Secret
      // Service / keyring is available — headless box, locked wallet, missing
      // libsecret. Treat any failure as "no credentials" so callers fall back to
      // an interactive login instead of crashing.
      try {
        return parseCredentials(
          await Bun.secrets.get({ service: SERVICE, name: ACCOUNT }),
        );
      } catch {
        return null;
      }
    },
    async save(creds) {
      try {
        await Bun.secrets.set({
          service: SERVICE,
          name: ACCOUNT,
          value: JSON.stringify(creds),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
