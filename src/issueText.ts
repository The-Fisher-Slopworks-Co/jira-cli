// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JiraAttachment, JiraComment, JiraIssueDetails, JiraSubtask } from './jira.js';

/**
 * Render a Jira issue's body as plain text for `jira issue <KEY>` — the
 * non-interactive path an AI agent (or a human at a pipe) reads. Pure: takes the
 * already-fetched {@link JiraIssueDetails} and the resolved base URL, returns the
 * full report as one string. The dashboard's issue view shares the same shaping
 * helpers ({@link formatBytes}, {@link formatComment}, {@link describeAttachment}).
 */
export function formatIssueText(details: JiraIssueDetails, baseUrl: string | null): string {
  const out: string[] = [];

  // Header: key + summary, then the facts as aligned label/value pairs.
  out.push(`${details.key}${details.summary != null ? `  ${details.summary}` : ''}`);
  const facts: [string, string][] = [];
  if (details.issueType != null) facts.push(['Type', details.issueType]);
  if (details.status != null) facts.push(['Status', details.status]);
  if (details.parentKey != null) {
    facts.push([
      'Parent',
      details.parentSummary != null ? `${details.parentKey}  ${details.parentSummary}` : details.parentKey,
    ]);
  }
  if (baseUrl != null) facts.push(['Link', `${baseUrl}/browse/${details.key}`]);
  for (const [label, value] of facts) {
    out.push(`${label.padEnd(7)} ${value}`);
  }

  out.push('', ...section('Description'));
  out.push(details.description != null && details.description.trim() !== '' ? details.description : '(empty)');

  out.push('', ...section(`Subtasks (${details.subtasks.length})`));
  if (details.subtasks.length === 0) {
    out.push('(none)');
  } else {
    for (const s of details.subtasks) out.push(describeSubtask(s));
  }

  out.push('', ...section(`Comments (${details.comments.length})`));
  if (details.comments.length === 0) {
    out.push('(none)');
  } else {
    details.comments.forEach((c, i) => {
      if (i > 0) out.push('');
      out.push(...formatComment(c));
    });
  }

  out.push('', ...section(`Attachments (${details.attachments.length})`));
  if (details.attachments.length === 0) {
    out.push('(none)');
  } else {
    for (const a of details.attachments) {
      out.push(describeAttachment(a));
      if (a.content != null) out.push(`  ${a.content}`);
    }
  }

  return out.join('\n');
}

/** A section heading followed by an underline of matching width. */
export function section(title: string): string[] {
  return [title, '-'.repeat(title.length)];
}

/** One comment as a `[author · date]` header line followed by its body lines. */
export function formatComment(c: JiraComment): string[] {
  const who = c.author ?? '?';
  const when = c.created ?? '';
  const edited = c.updated != null && c.updated !== c.created ? ' (edited)' : '';
  const header = `[${who}${when !== '' ? ` · ${when}` : ''}${edited}]`;
  const body = c.body != null && c.body.trim() !== '' ? c.body : '(empty)';
  return [header, body];
}

/** One subtask summarised as `KEY  [status]  summary`, dropping absent parts. */
export function describeSubtask(s: JiraSubtask): string {
  const tail = [s.status != null ? `[${s.status}]` : null, s.summary].filter(
    (x) => x != null && x !== '',
  );
  return tail.length > 0 ? `${s.key}  ${tail.join('  ')}` : s.key;
}

/** One attachment summarised as `filename  (mimeType, size)`. */
export function describeAttachment(a: JiraAttachment): string {
  const name = a.filename ?? '(unnamed)';
  const meta = [a.mimeType, a.size != null ? formatBytes(a.size) : null].filter((x) => x != null);
  return meta.length > 0 ? `${name}  (${meta.join(', ')})` : name;
}

/** Human-readable byte size: `512 B`, `2.0 KB`, `1.5 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
