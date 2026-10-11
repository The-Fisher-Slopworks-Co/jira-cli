// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // `src/cli.ts` is the `bin` entry, which knip reads from package.json.
  entry: [
    // Co-located tests are roots of their own: an export that only a test
    // reaches is still reached.
    "src/**/*.test.ts",
  ],
  project: ["src/**/*.ts", "*.ts"],
  // `uv` is a machine prerequisite (README → Development), not an npm package.
  ignoreBinaries: ["uvx"],
};

export default config;
