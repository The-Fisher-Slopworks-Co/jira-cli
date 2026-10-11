// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialStore, JiraCredentials } from "./credentials.js";
import {
  JiraAuthError,
  type JiraApi,
  type JiraAttachment,
  type JiraIssueDetails,
  type JiraSession,
} from "./jira.js";
import { runDownloadCommand } from "./downloadCmd.js";

const SESSION: JiraSession = {
  baseUrl: "https://jira.test",
  cookie: "JSESSIONID=x",
};

/** Build a JiraAttachment, defaulting the fields a download doesn't care about. */
function attachment(over: Partial<JiraAttachment>): JiraAttachment {
  return {
    id: "1",
    filename: "file.bin",
    author: null,
    created: null,
    size: null,
    mimeType: null,
    content: "https://jira.test/secure/attachment/1/file.bin",
    ...over,
  };
}

function detailsWith(attachments: JiraAttachment[]): JiraIssueDetails {
  return {
    key: "PROJ-9",
    summary: "Has files",
    status: null,
    issueType: null,
    parentKey: null,
    parentSummary: null,
    description: null,
    comments: [],
    attachments,
    subtasks: [],
  };
}

/** A Jira stub plus captured out/err buffers, written files, and made dirs. */
function harness(
  opts: {
    session?: JiraSession | null;
    details?: JiraIssueDetails | null;
    fetchError?: unknown;
    /** Per-URL download outcome: bytes to return, or an error to throw. */
    download?: (url: string) => Uint8Array;
    /** When set, requests 401 until a sign-in mints this fresh cookie. */
    freshCookie?: string;
    creds?: JiraCredentials | null;
    /** When set, mkdirp rejects with this. */
    mkdirError?: unknown;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const logins: JiraCredentials[] = [];
  const live = (s: JiraSession) =>
    opts.freshCookie == null || s.cookie === opts.freshCookie;
  const jira: JiraApi = {
    loadSession: async () =>
      opts.session === undefined ? SESSION : opts.session,
    login: async (baseUrl, username, password) => {
      logins.push({ baseUrl, username, password });
      return { baseUrl, cookie: opts.freshCookie ?? "x" };
    },
    fetchIssueDetails: async (session) => {
      if (opts.fetchError !== undefined) throw opts.fetchError;
      if (!live(session)) throw new JiraAuthError("Jira session expired");
      return opts.details === undefined
        ? detailsWith([attachment({})])
        : opts.details;
    },
    searchIssues: async () => ({
      startAt: 0,
      maxResults: 0,
      total: 0,
      issues: [],
    }),
    downloadAttachment: async (session, url) => {
      if (!live(session)) throw new JiraAuthError("Jira session expired");
      return (opts.download ?? (() => new Uint8Array([1, 2, 3])))(url);
    },
  };
  const store: CredentialStore = {
    load: async () => opts.creds ?? null,
    save: async () => true,
  };
  const deps = {
    jira,
    store,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    mkdirp: async (dir: string) => {
      if (opts.mkdirError !== undefined) throw opts.mkdirError;
      dirs.push(dir);
    },
    writeFile: async (path: string, data: Uint8Array) =>
      void files.set(path, data),
  };
  return { deps, out, err, files, dirs, logins };
}

const CREDS: JiraCredentials = {
  baseUrl: "https://jira.test",
  username: "alice",
  password: "secret",
};

test("downloads every attachment to the current directory and uppercases the key", async () => {
  const h = harness({
    details: detailsWith([
      attachment({
        id: "1",
        filename: "a.png",
        size: 2048,
        content: "https://jira.test/x/1",
      }),
      attachment({
        id: "2",
        filename: "b.txt",
        content: "https://jira.test/x/2",
      }),
    ]),
    download: (url) => new Uint8Array(url.endsWith("1") ? [1, 1] : [2]),
  });
  const code = await runDownloadCommand(["proj-9"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual([...h.files.keys()], ["a.png", "b.txt"]);
  assert.deepEqual(h.files.get("a.png"), new Uint8Array([1, 1]));
  const text = h.out.join("");
  assert.match(text, /Downloading 2 attachments from PROJ-9 to \./);
  assert.match(text, /a\.png {2}\(2\.0 KB\)/); // reported size comes from Jira's `size`
  assert.match(text, /b\.txt {2}\(1 B\)/); // falls back to the downloaded byte count
});

test("--out writes into the given directory, creating it first", async () => {
  const h = harness({
    details: detailsWith([attachment({ filename: "a.png" })]),
  });
  const code = await runDownloadCommand(["PROJ-9", "--out", "dl/here"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.dirs, ["dl/here"]);
  assert.deepEqual([...h.files.keys()], ["dl/here/a.png"]);
});

test("-o and --out=DIR are accepted too", async () => {
  for (const argv of [
    ["PROJ-9", "-o", "d"],
    ["PROJ-9", "--out=d"],
  ]) {
    const h = harness({
      details: detailsWith([attachment({ filename: "a.png" })]),
    });
    assert.equal(await runDownloadCommand(argv, h.deps), 0);
    assert.deepEqual([...h.files.keys()], ["d/a.png"]);
  }
});

test("duplicate filenames are disambiguated, keeping the extension", async () => {
  const h = harness({
    details: detailsWith([
      attachment({ id: "1", filename: "shot.png" }),
      attachment({ id: "2", filename: "shot.png" }),
      attachment({ id: "3", filename: "shot.png" }),
    ]),
  });
  assert.equal(await runDownloadCommand(["PROJ-9"], h.deps), 0);
  assert.deepEqual(
    [...h.files.keys()],
    ["shot.png", "shot (2).png", "shot (3).png"],
  );
});

test("a path-traversal filename is reduced to its basename", async () => {
  const h = harness({
    details: detailsWith([attachment({ filename: "../../etc/passwd" })]),
  });
  assert.equal(await runDownloadCommand(["PROJ-9", "--out", "dl"], h.deps), 0);
  assert.deepEqual([...h.files.keys()], ["dl/passwd"]);
});

test("a nameless attachment falls back to attachment-<id>", async () => {
  const h = harness({
    details: detailsWith([attachment({ id: "7", filename: null })]),
  });
  assert.equal(await runDownloadCommand(["PROJ-9"], h.deps), 0);
  assert.deepEqual([...h.files.keys()], ["attachment-7"]);
});

test("attachments without a content URL are skipped", async () => {
  const h = harness({
    details: detailsWith([
      attachment({ filename: "real.png", content: "https://jira.test/x/1" }),
      attachment({ filename: "ghost.png", content: null }),
    ]),
  });
  assert.equal(await runDownloadCommand(["PROJ-9"], h.deps), 0);
  assert.deepEqual([...h.files.keys()], ["real.png"]);
  assert.match(h.out.join(""), /Downloading 1 attachment from/);
});

test("an issue with no attachments is a success, not an error", async () => {
  const h = harness({ details: detailsWith([]) });
  assert.equal(await runDownloadCommand(["PROJ-9"], h.deps), 0);
  assert.equal(h.files.size, 0);
  assert.match(h.out.join(""), /PROJ-9 has no attachments/);
});

test("one failed download exits 1 but still writes the others", async () => {
  const h = harness({
    details: detailsWith([
      attachment({
        id: "1",
        filename: "ok.png",
        content: "https://jira.test/x/ok",
      }),
      attachment({
        id: "2",
        filename: "bad.png",
        content: "https://jira.test/x/bad",
      }),
    ]),
    download: (url) => {
      if (url.endsWith("bad")) throw new Error("HTTP 500");
      return new Uint8Array([1]);
    },
  });
  assert.equal(await runDownloadCommand(["PROJ-9"], h.deps), 1);
  assert.deepEqual([...h.files.keys()], ["ok.png"]);
  assert.match(h.err.join(""), /failed: bad\.png: HTTP 500/);
});

test("no key is a usage error (exit 2)", async () => {
  const h = harness();
  assert.equal(await runDownloadCommand([], h.deps), 2);
  assert.match(h.err.join(""), /Usage: jira download/);
});

test("--out without a value is a usage error (exit 2)", async () => {
  const h = harness();
  assert.equal(await runDownloadCommand(["PROJ-9", "--out"], h.deps), 2);
  assert.match(h.err.join(""), /Usage: jira download/);
});

test("no session exits 1 and points at jira login", async () => {
  const h = harness({ session: null });
  assert.equal(await runDownloadCommand(["PROJ-9"], h.deps), 1);
  assert.match(h.err.join(""), /no Jira session.*jira login/);
});

test("a missing issue (null) exits 1", async () => {
  const h = harness({ details: null });
  assert.equal(await runDownloadCommand(["PROJ-9"], h.deps), 1);
  assert.match(h.err.join(""), /not found/);
});

test("a failed mkdir exits 1", async () => {
  const h = harness({
    details: detailsWith([attachment({})]),
    mkdirError: new Error("EACCES"),
  });
  assert.equal(
    await runDownloadCommand(["PROJ-9", "--out", "/root/nope"], h.deps),
    1,
  );
  assert.match(h.err.join(""), /could not create \/root\/nope: EACCES/);
  assert.equal(h.files.size, 0);
});

test("with no session but saved credentials, it signs in transparently", async () => {
  const h = harness({
    session: null,
    creds: CREDS,
    details: detailsWith([attachment({ filename: "a" })]),
  });
  const code = await runDownloadCommand(["PROJ-9"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.logins, [CREDS]);
  assert.deepEqual([...h.files.keys()], ["a"]);
});

test("an expired session re-authenticates from saved credentials and downloads", async () => {
  // The on-disk session 401s on both the details fetch and the download; a
  // re-login mints `fresh`, after which everything works.
  const h = harness({
    freshCookie: "fresh",
    creds: CREDS,
    details: detailsWith([attachment({ filename: "a.png" })]),
  });
  const code = await runDownloadCommand(["PROJ-9"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual([...h.files.keys()], ["a.png"]);
});
