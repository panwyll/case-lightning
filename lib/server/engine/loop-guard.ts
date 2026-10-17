/**
 * No automatic reply loops (docs/spec/triggers.md, "Someone waiting on our reply"). Someone who has written to us and not
 * yet had a person's reply is not sent anything unasked: an acknowledgement, chase or update to them is put to a person
 * instead. So an automatic message, their "no, I meant this", and another automatic message can never follow one
 * another, and nobody is chased while they wait for us. Pure: read from the case.
 */
import type { EngineAction, MatterState, NoteState, SenderRelation } from './types';

const RELATION_OF: Record<string, SenderRelation> = {
  client: 'client', seller_solicitor: 'other_side', buyer_solicitor: 'other_side', other_side: 'other_side',
  estate_agent: 'agent', agent: 'agent', lender: 'lender', broker: 'lender',
};

/** Who an automatic message goes to, as a party role, where it says. */
export function recipientOf(action: EngineAction, detail: Record<string, unknown>): string | null {
  const role = (detail.recipientRole ?? detail.to) as string | undefined;
  if (typeof role === 'string' && role) return role;
  return action === 'client_update' ? 'client' : null;
}

/** Their email still waiting on a person (read, its task not yet done), if any: the latest. */
export function unansweredFrom(s: MatterState, role: string): NoteState | null {
  const rel = RELATION_OF[role];
  if (!rel) return null;
  const waiting = Object.values(s.notes ?? {}).filter((n) => n.kind === 'email' && n.from?.relation === rel && n.status === 'proposed');
  return waiting.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}
