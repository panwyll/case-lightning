/**
 * What an email or note is about, by the issue it proposes: several emails saying the same thing (the seller is threatening
 * to pull out) are one subject, on the Tasks list once, beside the issue when it is open.
 */
import type { MatterState } from './types';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** The subjects a note's proposed issues raise: `kind|title`. */
export function noteTopics(n: { actions?: Array<{ command?: { type?: string; kind?: string; title?: string } | null }> } | null | undefined): string[] {
  return (n?.actions ?? []).filter((a) => a.command?.type === 'raise_issue' && a.command.kind && a.command.title).map((a) => `${a.command!.kind}|${norm(a.command!.title!)}`);
}
export const issueTopic = (i: { kind: string; title: string }) => `${i.kind}|${norm(i.title)}`;

/** Pending email decisions that only repeat a subject: the newest per subject stands, and an open issue on it takes them all. */
export function noteDecisionGroups(s: MatterState): { byIssue: Map<string, string[]>; covered: Set<string> } {
  const open = Object.values(s.issues).filter((i) => i.status === 'open' || i.status === 'negotiating');
  const issueByTopic = new Map(open.map((i) => [issueTopic(i), i.id]));
  const byIssue = new Map<string, string[]>();
  const covered = new Set<string>();
  const newestByTopic = new Map<string, { id: string; at: string }>();
  const pending = Object.values(s.decisions).filter((d) => d.kind === 'note_actions' && d.status === 'pending');
  for (const d of pending) {
    const topics = noteTopics(s.notes[d.subject ?? '']);
    if (!topics.length) continue;
    const issueId = topics.map((t) => issueByTopic.get(t)).find(Boolean);
    if (issueId) { byIssue.set(issueId, [...(byIssue.get(issueId) ?? []), d.eventId]); covered.add(d.eventId); continue; }
    const t = topics[0];
    const prev = newestByTopic.get(t);
    if (!prev) newestByTopic.set(t, { id: d.eventId, at: d.createdAt });
    else if (d.createdAt > prev.at) { covered.add(prev.id); newestByTopic.set(t, { id: d.eventId, at: d.createdAt }); }
    else covered.add(d.eventId);
  }
  // Newest first within an issue: the latest email holds the reply worth sending.
  for (const [k, ids] of byIssue) byIssue.set(k, ids.sort((a, b) => (s.decisions[b].createdAt > s.decisions[a].createdAt ? 1 : -1)));
  return { byIssue, covered };
}
