// SPDX-FileCopyrightText: 2026 The Fisher Slopworks Co
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { section } from './issueText.js';
import type { JiraIssueLink, JiraSearchResults } from './jira.js';

/**
 * Render a page of search results as plain text for `jira search <JQL>`: one
 * aligned row per issue, the links that constrain them, and a footer saying how
 * much of the result set this is. Pure — takes the already-fetched
 * {@link JiraSearchResults} and returns the whole report as one string.
 *
 * A row carries what fits on a line and is worth scanning. `components`,
 * `labels` and `fixVersions` come out of `--json` instead: the query that found
 * these issues has usually already decided them.
 */
export function formatSearchText(results: JiraSearchResults): string {
  const out: string[] = [];

  // The fixed-width columns align to the widest value on this page; the summary
  // is last so it can run to the end of the line.
  const columns = results.issues.map((issue) => [
    issue.key,
    issue.issueType ?? '-',
    issue.status ?? '-',
    issue.assignee ?? 'unassigned',
    day(issue.updated),
  ]);
  const widths =
    columns.length > 0
      ? columns[0].map((_, col) => Math.max(...columns.map((row) => row[col].length)))
      : [];
  results.issues.forEach((issue, row) => {
    const head = columns[row].map((value, col) => value.padEnd(widths[col])).join('  ');
    out.push(`${head}  ${issue.summary ?? ''}`.trimEnd());
  });

  // Only the issues that have links, so a page without any costs no lines. Every
  // link is listed as Jira worded it rather than filtered down to "blockers":
  // which relations block work is the reader's call, not this formatter's.
  const linked = results.issues.filter((issue) => issue.links.length > 0);
  if (linked.length > 0) {
    out.push('', ...section('Links'));
    for (const issue of linked) {
      for (const link of issue.links) out.push(`${issue.key}  ${describeLink(link)}`);
    }
  }

  if (out.length > 0) out.push('');
  out.push(footer(results));
  return out.join('\n');
}

/** One link as `is blocked by PROJ-9 (Open)`, dropping the parts Jira omitted. */
export function describeLink(link: JiraIssueLink): string {
  const status = link.status != null ? ` (${link.status})` : '';
  return `${link.relation ?? 'links to'} ${link.key}${status}`;
}

/**
 * How much of the whole result set this page is. Always printed: a truncated
 * page reads exactly like a complete one, so without this line a reader can
 * report the first fifty issues of a release as the whole of it.
 */
function footer(results: JiraSearchResults): string {
  const { startAt, total, issues } = results;
  if (total === 0) return 'No issues match.';
  if (issues.length === 0) return `No issues at --start ${startAt} (${total} in total).`;
  if (startAt === 0 && issues.length === total) {
    return `${total} issue${total === 1 ? '' : 's'}.`;
  }
  const last = startAt + issues.length;
  const more = last < total ? `  (--start ${last} for the next page)` : '';
  return `Issues ${startAt + 1}-${last} of ${total}.${more}`;
}

/** The date half of a Jira timestamp — enough to spot a stale issue in a row. */
function day(timestamp: string | null): string {
  return timestamp != null ? timestamp.slice(0, 10) : '-';
}
