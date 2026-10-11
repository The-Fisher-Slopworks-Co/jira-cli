// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { CancelError } from "./cancel.js";
import { makePrompter, type PromptInput } from "./prompt.js";

/**
 * A stand-in for stdin/stdout that lets a test deliver input in whatever chunks
 * it likes — which is the interesting axis, since a pipe can hand over every
 * answer at once and a raw tty hands over one keystroke at a time.
 */
function fakeIo(opts: { isTTY?: boolean } = {}) {
  const data: ((chunk: string) => void)[] = [];
  const end: (() => void)[] = [];
  const written: string[] = [];
  const rawModes: boolean[] = [];

  const input: PromptInput = {
    on(event: "data" | "end", listener: never) {
      if (event === "data") data.push(listener);
      else end.push(listener);
    },
    off(event: "data" | "end", listener: never) {
      const list: unknown[] = event === "data" ? data : end;
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    },
    setEncoding() {},
    resume() {},
    pause() {},
    isTTY: opts.isTTY,
    isRaw: false,
    setRawMode(mode: boolean) {
      rawModes.push(mode);
    },
  };

  return {
    input,
    output: { write: (s: string) => void written.push(s) },
    /** Everything written to the fake stdout, concatenated. */
    text: () => written.join(""),
    rawModes,
    dataListeners: data,
    send: (chunk: string) => data.forEach((fn) => fn(chunk)),
    finish: () => end.forEach((fn) => fn()),
  };
}

test("ask returns the trimmed answer and shows the label", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira URL");
  io.send("  https://jira.test  \n");
  assert.equal(await answer, "https://jira.test");
  assert.match(io.text(), /\? Jira URL: /);
});

test("answers delivered in one chunk are consumed one line at a time", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  // A piped script hands everything over at once.
  io.send("https://jira.test\nalice\nsecret\n");
  assert.equal(await p.ask("Jira URL"), "https://jira.test");
  assert.equal(await p.ask("Jira username"), "alice");
  assert.equal(await p.ask("Jira password", { trim: false }), "secret");
});

test("ask splices CRLF as cleanly as LF", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  io.send("alice\r\nbob\r\n");
  assert.equal(await p.ask("one"), "alice");
  assert.equal(await p.ask("two"), "bob");
});

test("a default is offered in the prompt and used for an empty answer", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira URL", {
    required: true,
    defaultValue: "https://saved.jira",
  });
  io.send("\n");
  assert.equal(await answer, "https://saved.jira");
  assert.match(io.text(), /\[https:\/\/saved\.jira\]/);
});

test("a required answer is asked again until it is non-empty", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira username", { required: true });
  io.send("\n");
  io.send("   \n");
  io.send("alice\n");
  assert.equal(await answer, "alice");
  assert.equal(io.text().match(/This field is required\./g)?.length, 2);
});

test("trim: false keeps a password exactly as typed", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira password", { trim: false });
  io.send("  spaced  \n");
  assert.equal(await answer, "  spaced  ");
});

test("confirm takes the default on enter and understands y/n either way", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);

  const dflt = p.confirm("Save?", true);
  io.send("\n");
  assert.equal(await dflt, true);

  const no = p.confirm("Save?", true);
  io.send("n\n");
  assert.equal(await no, false);

  const yes = p.confirm("Save?", false);
  io.send("YES\n");
  assert.equal(await yes, true);
  assert.match(io.text(), /\[Y\/n\]/);
  assert.match(io.text(), /\[y\/N\]/);
});

test("confirm re-asks on an answer it does not understand", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  const answer = p.confirm("Save?", true);
  io.send("maybe\n");
  io.send("no\n");
  assert.equal(await answer, false);
  assert.match(io.text(), /Please answer y or n\./);
});

test("input that ends before an answer arrives cancels", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira URL");
  io.finish();
  await assert.rejects(() => answer, CancelError);
});

test("a final line with no newline still counts", async () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira URL");
  io.send("https://jira.test");
  io.finish();
  assert.equal(await answer, "https://jira.test");
});

test("off a tty, masking degrades to a plain line read", async () => {
  const io = fakeIo({ isTTY: false });
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira password", { mask: "*", trim: false });
  io.send("secret\n");
  assert.equal(await answer, "secret");
  // Nothing to echo over a pipe, so no mask characters are emitted either.
  assert.doesNotMatch(io.text(), /\*/);
  assert.deepEqual(io.rawModes, []);
});

test("close detaches from the input stream", () => {
  const io = fakeIo();
  const p = makePrompter(io.input, io.output);
  assert.equal(io.dataListeners.length, 1);
  p.close();
  assert.equal(io.dataListeners.length, 0);
});

// --- raw mode (a real terminal) ----------------------------------------------

test("on a tty a masked answer echoes the mask, never the characters", async () => {
  const io = fakeIo({ isTTY: true });
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira password", { mask: "*", trim: false });
  for (const ch of "abc") io.send(ch);
  io.send("\r");
  assert.equal(await answer, "abc");
  assert.doesNotMatch(io.text(), /abc/);
  assert.match(io.text(), /\*\*\*/);
  // Raw mode is entered and then restored to what it was.
  assert.deepEqual(io.rawModes, [true, false]);
});

test("backspace erases the last character of a masked answer", async () => {
  const io = fakeIo({ isTTY: true });
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira password", { mask: "*", trim: false });
  for (const ch of ["a", "b", "\u007f", "c"]) io.send(ch);
  io.send("\r");
  assert.equal(await answer, "ac");
});

test("backspace on an empty masked answer does nothing", async () => {
  const io = fakeIo({ isTTY: true });
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira password", { mask: "*", trim: false });
  io.send("\u007f");
  io.send("a");
  io.send("\r");
  assert.equal(await answer, "a");
});

test("Ctrl-C during a masked answer cancels and restores the terminal", async () => {
  const io = fakeIo({ isTTY: true });
  const p = makePrompter(io.input, io.output);
  const answer = p.ask("Jira password", { mask: "*" });
  io.send("a");
  io.send("\u0003");
  await assert.rejects(() => answer, CancelError);
  assert.deepEqual(io.rawModes, [true, false]);
});

test("a lone Esc cancels, but an arrow key is ignored", async () => {
  const arrows = fakeIo({ isTTY: true });
  const p1 = makePrompter(arrows.input, arrows.output);
  const typed = p1.ask("Jira password", { mask: "*", trim: false });
  arrows.send("\u001b[A"); // up arrow — a sequence, not a cancellation
  arrows.send("x");
  arrows.send("\r");
  assert.equal(await typed, "x");

  const esc = fakeIo({ isTTY: true });
  const p2 = makePrompter(esc.input, esc.output);
  const cancelled = p2.ask("Jira password", { mask: "*" });
  esc.send("\u001b");
  await assert.rejects(() => cancelled, CancelError);
});
