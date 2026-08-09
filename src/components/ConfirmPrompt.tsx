// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ConfirmPromptProps {
  label: string;
  /** Value chosen when the user submits an empty answer (just presses Enter). */
  defaultValue: boolean;
  onSubmit: (value: boolean) => void;
}

/**
 * A yes/no prompt that mirrors inquire's line-editor model: the user types an
 * answer and presses Enter. Empty input takes the default; an unrecognized
 * answer is rejected and the buffer cleared.
 */
export function ConfirmPrompt({ label, defaultValue, onSubmit }: ConfirmPromptProps) {
  const [buffer, setBuffer] = useState('');

  useInput((input, key) => {
    if (key.return) {
      const answer = buffer.trim().toLowerCase();
      if (answer === '') {
        onSubmit(defaultValue);
      } else if (answer === 'y' || answer === 'yes') {
        onSubmit(true);
      } else if (answer === 'n' || answer === 'no') {
        onSubmit(false);
      } else {
        setBuffer('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      setBuffer((b) => b + input);
    }
  });

  return (
    <Box>
      <Text color="cyan">? </Text>
      <Text bold>{label} </Text>
      <Text dimColor>{defaultValue ? '(Y/n) ' : '(y/N) '}</Text>
      <Text>{buffer}</Text>
    </Box>
  );
}
