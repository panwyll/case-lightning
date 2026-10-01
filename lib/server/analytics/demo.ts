/** A made-up firm's two years of cases (seeded, so the same every time), for the analytics preview (/dev/analytics) and its tests. Never used for a real firm. */
import type { AnalyticsInput, CaseFacts, CaseSide, FeedbackFact, Party } from './kpis';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export const DEMO_PEOPLE = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Asha Patel' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Ben Carter' },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Chloe Evans' },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Dan Hughes' },
  { id: '00000000-0000-4000-8000-000000000005', name: 'Ella Morgan' },
];

export function demoAnalyticsInput(now = new Date()): AnalyticsInput {
  const r = rng(42);
  const between = (a: number, b: number) => a + r() * (b - a);
  const DAY = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const cases: CaseFacts[] = [];
  const feedback: FeedbackFact[] = [];
  const start = now.getTime() - 760 * DAY;
  let n = 0;
  for (let day = start; day < now.getTime(); day += DAY) {
    const season = 1 + 0.25 * Math.sin(((new Date(day).getUTCMonth() + 1) / 12) * 2 * Math.PI);
    const growth = 0.85 + 0.3 * ((day - start) / (now.getTime() - start));
    const count = r() < 0.95 * season * growth ? (r() < 0.3 ? 2 : 1) : 0;
    for (let k = 0; k < count; k++) {
      n++;
      const person = DEMO_PEOPLE[Math.floor(r() * DEMO_PEOPLE.length)];
      const slow = person.name === 'Dan Hughes' ? 1.25 : person.name === 'Asha Patel' ? 0.85 : 1;
      const side: CaseSide = r() < 0.55 ? 'purchase' : r() < 0.85 ? 'sale' : 'remortgage';
      const leasehold = r() < 0.25;
      const t0 = day + between(9, 17) * 3_600_000;
      const waits: CaseFacts['waits'] = [];
      const decisions: CaseFacts['decisions'] = [];
      let cursor = t0;
      const step = (key: string, party: Party, lo: number, hi: number, parallel = false) => {
        const open = cursor + between(0, 2) * DAY;
        const len = between(lo, hi) * (leasehold && party === 'other_side' ? 1.5 : 1);
        const close = open + len * DAY;
        const chases: string[] = [];
        for (let c = open + 7 * DAY; c < close - DAY; c += 5 * DAY) chases.push(iso(c));
        waits.push({ key, party, openedAt: iso(open), closedAt: close <= now.getTime() ? iso(close) : null, chases: chases.filter((x) => Date.parse(x) <= now.getTime()) });
        const decided = close + between(0.1, 3) * slow * DAY;
        if (close <= now.getTime()) decisions.push({ kind: key === 'search' ? 'search' : key === 'enquiry' ? 'enquiry' : key === 'id_check' ? 'id_check' : 'proposal', createdAt: iso(close), resolvedAt: decided <= now.getTime() ? iso(decided) : null, resolvedBy: person.id });
        if (!parallel) cursor = decided;
        return close;
      };
      step('id_check', 'client', 1, 6, true);
      if (side === 'purchase') {
        step('search', 'searches', 10, 45, true);
        step('contract_pack', 'other_side', 8, 30);
        step('enquiry', 'other_side', 20, 60);
        step('mortgage_offer', 'lender', 5, 25, true);
      } else if (side === 'sale') {
        step('property_forms', 'client', 5, 25);
        step('enquiry', 'other_side', 25, 65);
      } else {
        step('redemption', 'lender', 4, 14);
      }
      const fallsThrough = r() < 0.2;
      const exAt = cursor + between(5, 25) * slow * DAY;
      const done = cursor < now.getTime() && exAt <= now.getTime();
      const fc: CaseFacts = { fee: (side === 'purchase' ? 1250 : side === 'sale' ? 1050 : 650) + (leasehold ? 300 : 0) + (r() < 0.3 ? 250 : 0), id: `demo-${n}`, ref: `DEMO-${String(n).padStart(4, '0')}`, handlerId: person.id, side, leasehold, instructedAt: iso(t0), exchangedAt: null, completedAt: null, abandoned: null, completionDate: null, waits, decisions };
      if (fallsThrough && cursor - t0 > 20 * DAY) {
        const at = t0 + between(20, Math.max(21, (cursor - t0) / DAY)) * DAY;
        if (at <= now.getTime()) {
          fc.abandoned = { at: iso(at), reason: ['chain_collapsed', 'survey', 'finance_failed', 'client_withdrew', 'gazumped'][Math.floor(r() * 5)] };
          for (const w of fc.waits) if (!w.closedAt || Date.parse(w.closedAt) > at) w.closedAt = iso(at);
          for (const d of fc.decisions) if (!d.resolvedAt || Date.parse(d.resolvedAt) > at) d.resolvedAt = iso(at);
        }
      } else if (done && side !== 'remortgage') {
        fc.exchangedAt = iso(exAt);
        const comp = exAt + between(7, 30) * DAY;
        fc.completionDate = iso(comp).slice(0, 10);
        if (comp <= now.getTime()) fc.completedAt = iso(comp);
      } else if (done) {
        const comp = exAt;
        fc.completionDate = iso(comp).slice(0, 10);
        fc.completedAt = iso(comp);
      }
      if (fc.exchangedAt && r() < 0.45) feedback.push({ matterId: fc.id, handlerId: person.id, kind: 'csat', score: Math.min(5, Math.max(1, Math.round(between(3.2, 5.4) / slow))), comment: r() < 0.25 ? ['Kept us in the loop the whole way.', 'Quick to answer every question.', 'A bit slow to hear back at times.', 'Really clear about what we needed to do.'][Math.floor(r() * 4)] : null, at: fc.exchangedAt });
      if (fc.completedAt && r() < 0.3) feedback.push({ matterId: fc.id, handlerId: person.id, kind: 'nps', score: Math.min(10, Math.max(3, Math.round(between(6.5, 11) / slow))), comment: r() < 0.3 ? ['Would recommend to anyone.', 'Smooth from start to finish.', 'Good, but the searches took ages.'][Math.floor(r() * 3)] : null, at: fc.completedAt });
      cases.push(fc);
    }
  }
  return { now, cases, feedback, targets: { monthlyCompletions: 24, perPerson: Object.fromEntries(DEMO_PEOPLE.map((p) => [p.id, 5])) }, people: DEMO_PEOPLE };
}
