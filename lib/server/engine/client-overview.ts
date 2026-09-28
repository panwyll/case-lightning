/**
 * The "where things stand" tail of a client update: what is still waiting on the client and
 * what we are waiting on from others, with how long each usually takes. Written from the same
 * case brief the client Q&A answers from, so it never names an internal code.
 *
 * Timing: something the client owes us is mentioned only when nobody has asked them for it (an
 * update, a chase, the request itself) within the firm's reminder window (24 hours unless set),
 * so an update sent ten minutes after the form went out does not say "we are still waiting on
 * your form". What others owe is left out when the client heard about it in the last few days.
 */
import { caseBrief, type BriefWait } from './brief';
import { activeAvailability, awayNow, type MatterState } from './types';
import { prettyDate } from './notes';
import { clientToHand, type ChaseContentOptions } from './chase-content';

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

/** How long after the client was last asked for something (an update, a chase, the request) an update may remind them of it. The firm sets it (Rules > Timers). */
export const DEFAULT_CLIENT_REMINDER_HOURS = 24;

export function clientOverview(s: MatterState, now: Date, opts: ChaseContentOptions & { reminderHours?: number } = {}): ClientOverview {
  const remindMs = (opts.reminderHours ?? DEFAULT_CLIENT_REMINDER_HOURS) * 3_600_000;
  const brief = caseBrief(s, now);
  const told = s.clientToldAt ?? {};
  const keep: BriefWait[] = [];
  const mentioned: string[] = [];
  for (const w of brief.waiting) {
    const key = `${w.key}:${w.subject}`;
    const open = s.waits.find((x) => x.key === w.key && x.subject === w.subject && x.closedAt === null);
    const toldAt = told[key] ? new Date(told[key]).getTime() : null;
    if (w.role === 'client') {
      // Asked recently (told in an update, chased, or only just requested): not again yet. Otherwise it rides along with this update.
      const asked = Math.max(toldAt ?? 0, ...(open?.chasesSentAt ?? []).map((t) => new Date(t).getTime()), open ? new Date(open.openedAt).getTime() : 0);
      if (now.getTime() - asked < remindMs) continue;
    } else {
      if (toldAt !== null && now.getTime() - toldAt < TOLD_QUIET_MS) continue;
      if (open && now.getTime() - new Date(open.openedAt).getTime() < JUST_RAISED_MS) continue;
    }
    keep.push(w);
    mentioned.push(key);
  }
  const onYou = keep.filter((w) => w.role === 'client');
  const others = keep.filter((w) => w.role !== 'client');
  const parts: string[] = [];
  // What the client told us about their time shapes what we say: nothing is asked of someone
  // who is away, and something needed before they go is said before they go.
  const away = awayNow(s, 'client', now);
  const saidRecently = !!away && !!told[`away:${away.id}`] && now.getTime() - new Date(told[`away:${away.id}`]).getTime() < TOLD_QUIET_MS;
  const soon = away ? null : activeAvailability(s, now).find((w) => w.party === 'client' && new Date(`${w.from}T00:00:00Z`).getTime() > now.getTime() && new Date(`${w.from}T00:00:00Z`).getTime() - now.getTime() < 21 * 86_400_000) ?? null;
  const allOnYou = brief.waiting.filter((w) => w.role === 'client');
  if (away) {
    // Nothing is asked of someone who is away; the absence itself is mentioned once every few days, not in every message.
    if (!saidRecently) {
      parts.push(allOnYou.length
        ? `You mentioned you are away until ${prettyDate(away.until)}; nothing here needs you before you are back, and we will not chase you while you are away. When you are back we will still need ${list(allOnYou.map((w) => w.what))}.`
        : `You mentioned you are away until ${prettyDate(away.until)}; nothing here needs you before you are back.`);
      mentioned.push(`away:${away.id}`);
    }
  } else if (onYou.length) {
    // What they need to do it, in this message: the link, the form, what to send.
    const toHand = onYou.map((w) => clientToHand(s, w.key, w.subject, opts)).filter((x): x is string => !!x);
    parts.push(`Still waiting on you: ${list(onYou.map((w) => `${w.what} (asked ${since(w)})`))}${soon ? `; if you can, before you go away on ${prettyDate(soon.from)}` : ''}.${toHand.length ? `\n${toHand.map((x) => `• ${x}`).join('\n')}\n` : ''}`);
  } else if (soon && allOnYou.length) {
    parts.push(`Before you go away on ${prettyDate(soon.from)} we still need ${list(allOnYou.map((w) => w.what))}.`);
  }
  if (!keep.length && !parts.length) return { text: '', mentioned: [] };
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
