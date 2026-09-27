/**
 * The "where things stand" tail of a client update: what is still waiting on the client and
 * what we are waiting on from others, with how long each usually takes. Written from the same
 * case brief the client Q&A answers from, so it never names an internal code.
 *
 * Timing: an item is left out when the client was told about it in the last few days (each
 * update records what it mentioned), or when it was only raised in the last hour — an update
 * sent ten minutes after the form went out does not say "we are still waiting on your form".
 */
import { caseBrief, type BriefWait } from './brief';
import type { MatterState } from './types';

const TOLD_QUIET_MS = 3 * 24 * 3_600_000;
const JUST_RAISED_MS = 24 * 60 * 60_000;

/** How long each kind of wait usually takes, in the client's terms. */
const USUALLY: Record<string, string> = {
  search: 'searches usually take two to three weeks',
  contract_pack: 'this usually takes a week or two',
  enquiry: 'replies usually take around ten working days',
  mortgage_offer: 'timing depends on your lender',
  management_pack: 'this often takes two to four weeks',
  redemption: 'lenders usually take a week or so',
  id_check: 'it takes a few minutes once you start',
  proof_of_funds: 'the sooner the better',
};

export interface ClientOverview { text: string; mentioned: string[] }

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const since = (w: BriefWait): string => (w.sinceCalendarDays <= 0 ? 'today' : w.sinceCalendarDays === 1 ? 'yesterday' : `${w.sinceCalendarDays} days ago`);

export function clientOverview(s: MatterState, now: Date): ClientOverview {
  const brief = caseBrief(s, now);
  const told = s.clientToldAt ?? {};
  const keep: BriefWait[] = [];
  const mentioned: string[] = [];
  for (const w of brief.waiting) {
    const key = `${w.key}:${w.subject}`;
    const open = s.waits.find((x) => x.key === w.key && x.subject === w.subject && x.closedAt === null);
    const toldAt = told[key] ? new Date(told[key]).getTime() : null;
    if (toldAt !== null && now.getTime() - toldAt < TOLD_QUIET_MS) continue;
    if (open && now.getTime() - new Date(open.openedAt).getTime() < JUST_RAISED_MS) continue;
    keep.push(w);
    mentioned.push(key);
  }
  if (!keep.length) return { text: '', mentioned: [] };
  const onYou = keep.filter((w) => w.role === 'client');
  const others = keep.filter((w) => w.role !== 'client');
  const parts: string[] = [];
  if (onYou.length) parts.push(`Still waiting on you: ${list(onYou.map((w) => `${w.what} (asked ${since(w)})`))}.`);
  if (others.length) {
    const byWho = new Map<string, BriefWait[]>();
    for (const w of others) byWho.set(w.who, [...(byWho.get(w.who) ?? []), w]);
    const bits = [...byWho.entries()].map(([who, ws]) => {
      const whats = [...new Set(ws.map((w) => w.what))];
      const usually = [...new Set(ws.map((w) => USUALLY[w.key]).filter(Boolean))][0];
      return `${who} for ${list(whats)}${usually ? ` (${usually})` : ''}`;
    });
    parts.push(`Elsewhere on your file we are waiting on ${list(bits)}.`);
  }
  return { text: `Where things stand: ${parts.join(' ')}`, mentioned };
}
