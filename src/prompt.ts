// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The terminal prompts `jira login` asks. Deliberately small: four questions in
 * sequence, so they read as `await`s rather than as a state machine.
 *
 * Plain questions leave the tty in cooked mode — the terminal echoes and
 * line-buffers for us, and Ctrl-C raises SIGINT the usual way. Only a masked
 * question switches to raw mode, because hiding the characters means taking over
 * the echo, and with it Enter, backspace, Ctrl-C and Esc. Off a tty (a pipe, the
 * tests) there is nothing to echo, so masking degrades to a plain line read.
 */
import { CancelError } from './cancel.js';

/** ASCII controls raw mode hands us, named rather than spelled out at each use. */
const ESC = '\u001b';
const ETX = '\u0003'; // Ctrl-C
const EOT = '\u0004'; // Ctrl-D
const DEL = '\u007f'; // backspace on most terminals

/** The slice of `process.stdin` this module needs, so tests can pass a stream. */
export interface PromptInput {
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'end', listener: () => void): unknown;
  setEncoding(encoding: 'utf8'): unknown;
  resume(): unknown;
  pause(): unknown;
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** The slice of `process.stdout` this module needs. */
export interface PromptOutput {
  write(chunk: string): unknown;
}

export interface AskOptions {
  /** Offered as `[value]` and returned when the answer is empty. */
  defaultValue?: string;
  /** Re-ask while the answer is empty. */
  required?: boolean;
  /** Echo this instead of each character (e.g. `*`). */
  mask?: string;
  /** Trim surrounding whitespace. Default true; disable for passwords. */
  trim?: boolean;
}

export interface Prompter {
  /** Ask for a line of text. Throws {@link CancelError} if the user interrupts. */
  ask(label: string, options?: AskOptions): Promise<string>;
  /** Ask a yes/no question. Throws {@link CancelError} if the user interrupts. */
  confirm(label: string, defaultValue: boolean): Promise<boolean>;
  /** Print one status line. */
  log(line: string): void;
  /** Detach from the input stream so the process can exit. */
  close(): void;
}

/** Build a {@link Prompter} over `process.stdin` / `process.stdout` by default. */
export function makePrompter(
  input: PromptInput = process.stdin,
  output: PromptOutput = process.stdout,
): Prompter {
  // Input arrives in chunks that need not line up with lines: a piped script can
  // deliver every answer at once. Everything read is buffered here and consumed
  // a line at a time.
  let buffer = '';
  let ended = false;
  let wake: (() => void) | null = null;

  const onData = (chunk: string): void => {
    buffer += chunk;
    wake?.();
  };
  const onEnd = (): void => {
    ended = true;
    wake?.();
  };

  input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', onEnd);
  input.resume();

  /** Wait until more input arrives (or the stream ends). */
  const more = (): Promise<void> =>
    ended
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });

  /** Read one line, letting the terminal handle echo and editing. */
  async function readCookedLine(): Promise<string> {
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      if (ended) {
        // A last line with no trailing newline still counts; nothing at all
        // means the input is exhausted, which is a cancellation.
        if (buffer === '') throw new CancelError('input ended');
        const rest = buffer;
        buffer = '';
        return rest;
      }
      await more();
    }
  }

  /** Read one line in raw mode, echoing `mask` for each character. */
  async function readMaskedLine(mask: string): Promise<string> {
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    try {
      let value = '';
      for (;;) {
        if (buffer === '') {
          if (ended) throw new CancelError('input ended');
          await more();
          continue;
        }
        const chunk = buffer;
        buffer = '';

        for (let i = 0; i < chunk.length; ) {
          const ch = chunk[i]!;

          if (ch === ESC) {
            // Raw mode delivers arrow keys and friends as escape sequences. A
            // lone Esc — nothing following it — is the user cancelling; anything
            // longer is a key we skip over, so the characters *after* it are
            // still read rather than lost along with the sequence.
            if (i === chunk.length - 1) {
              output.write('\n');
              throw new CancelError('cancelled');
            }
            i = skipEscapeSequence(chunk, i);
            continue;
          }
          if (ch === '\r' || ch === '\n') {
            output.write('\n');
            // Anything past the newline belongs to the next question.
            buffer = chunk.slice(i + 1) + buffer;
            return value;
          }
          if (ch === ETX || ch === EOT) {
            // Raw mode suppresses SIGINT, so cancel by hand rather than leave
            // the caller waiting forever.
            output.write('\n');
            throw new CancelError('cancelled');
          }
          if (ch === DEL || ch === '\b') {
            if (value !== '') {
              value = value.slice(0, -1);
              output.write('\b \b');
            }
            i++;
            continue;
          }
          // Skip the remaining C0 controls; they are not password material.
          if (ch >= ' ') {
            value += ch;
            output.write(mask);
          }
          i++;
        }
      }
    } finally {
      input.setRawMode?.(wasRaw);
    }
  }

  const readValue = (mask?: string): Promise<string> =>
    mask != null && input.isTTY === true ? readMaskedLine(mask) : readCookedLine();

  return {
    async ask(label, options = {}) {
      const { defaultValue, required = false, mask, trim = true } = options;
      const suffix = defaultValue != null && defaultValue !== '' ? ` [${defaultValue}]` : '';
      for (;;) {
        output.write(`? ${label}${suffix}: `);
        const raw = await readValue(mask);
        const value = trim ? raw.trim() : raw;
        if (value !== '') return value;
        if (defaultValue != null && defaultValue !== '') return defaultValue;
        if (!required) return '';
        output.write('This field is required.\n');
      }
    },

    async confirm(label, defaultValue) {
      const hint = defaultValue ? 'Y/n' : 'y/N';
      for (;;) {
        output.write(`? ${label} [${hint}]: `);
        const answer = (await readCookedLine()).trim().toLowerCase();
        if (answer === '') return defaultValue;
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        output.write('Please answer y or n.\n');
      }
    },

    log(line) {
      output.write(`${line}\n`);
    },

    close() {
      input.off('data', onData);
      input.off('end', onEnd);
      input.pause();
    },
  };
}

/**
 * Index just past the escape sequence starting at `i` (which is an ESC). CSI
 * (`ESC [`) and SS3 (`ESC O`) run until a final byte in `@`..`~`; anything else
 * is ESC plus one character (Alt-<key>).
 */
function skipEscapeSequence(s: string, i: number): number {
  const next = s[i + 1];
  if (next !== '[' && next !== 'O') {
    return i + 2;
  }
  let j = i + 2;
  while (j < s.length && !(s[j]! >= '@' && s[j]! <= '~')) {
    j++;
  }
  return j + 1;
}
