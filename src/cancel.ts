// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Thrown out of an interactive flow when the user interrupts it (Ctrl-C or
 * Esc), so the entry point can tell a deliberate cancellation from a real
 * failure and exit `130` instead of `1`.
 */
export class CancelError extends Error {}
