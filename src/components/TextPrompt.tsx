// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export interface TextPromptProps {
  label: string;
  /** Pre-filled, editable initial value (mirrors inquire's with_initial_value). */
  initialValue?: string;
  /** When true, an empty value is rejected with a message and not submitted. */
  required: boolean;
  /** When set, every character is rendered as this string (e.g. '*' for passwords). */
  mask?: string;
  /** Trim surrounding whitespace before submitting. Default true; disable for passwords. */
  trim?: boolean;
  /** Receives the (by default trimmed) value. */
  onSubmit: (value: string) => void;
}

export function TextPrompt({
  label,
  initialValue = '',
  required,
  mask,
  trim = true,
  onSubmit,
}: TextPromptProps) {
  const [value, setValue] = useState(initialValue);
  const [showError, setShowError] = useState(false);

  const handleSubmit = (raw: string) => {
    const submitted = trim ? raw.trim() : raw;
    if (required && submitted === '') {
      setShowError(true);
      return;
    }
    onSubmit(submitted);
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">? </Text>
        <Text bold>{label} </Text>
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} mask={mask} />
      </Box>
      {showError && <Text color="red">This field is required.</Text>}
    </Box>
  );
}
