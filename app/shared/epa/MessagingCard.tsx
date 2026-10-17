'use client';
/** Analytics → Cases: how the firm's correspondence is landing (lib/server/analytics/messaging.ts), four weeks against the four before. */
import { useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import type { MessagingWindow } from '@/lib/server/analytics/messaging';

type Res = { current: MessagingWindow; previous: MessagingWindow };
const CSS = `
.mg{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:16px 18px;margin-top:14px}
.mg h2{font-size:15px;font-weight:800;margin:0 0 14px;color:#0f172a}
.mg-row{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:14px}
.mg-fig b{display:block;font-size:22px;font-weight:800;color:#0f172a;line-height:1.1}
.mg-fig span{display:block;font-size:12px;font-weight:700;color:#64748b;margin-top:3px}
.mg-fig i{display:block;font-style:normal;font-size:11.5px;font-weight:700;margin-top:3px}
.mg-fig i.good{color:#15803d}.mg-fig i.bad{color:#b91c1c}.mg-fig i.flat{color:#94a3b8}
@media (max-width:1100px){.mg-row{grid-template-columns:repeat(4,minmax(0,1fr))}}
`;
const hours = (h: number | null) => (h == null ? '–' : h >= 24 ? `${(h / 24).toFixed(1)} Days` : `${h.toFixed(1)}h`);
const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);

/** The change since the four weeks before, coloured by whether it is better. */
function Delta({ now, was, lowerIsBetter, fmt }: { now: number | null; was: number | null; lowerIsBetter: boolean; fmt: (d: number) => string }) {
  if (now == null || was == null) return <i className="flat">No Earlier Figure</i>;
  const d = now - was;
  if (Math.abs(d) < 1e-9) return <i className="flat">No Change</i>;
  const better = lowerIsBetter ? d < 0 : d > 0;
  return <i className={better ? 'good' : 'bad'}>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d))}</i>;
}

export function MessagingCard() {
  const [r, setR] = useState<Res | null>(null);
  useEffect(() => { api<Res>('/analytics/messages').then(setR).catch(() => setR(null)); }, []);
  if (!r) return null;
  const c = r.current, p = r.previous;
  const pts = (d: number) => `${Math.round(d * 100)} Pts`;
  const figs: Array<{ value: string; label: string; now: number | null; was: number | null; lower: boolean; fmt: (d: number) => string }> = [
    { value: hours(c.replyHours), label: 'Average Reply Time', now: c.replyHours, was: p.replyHours, lower: true, fmt: hours },
    { value: hours(c.clientReplyHours), label: 'Client Wait For A Reply', now: c.clientReplyHours, was: p.clientReplyHours, lower: true, fmt: hours },
    { value: pct(c.waitingOnUs), label: 'Case Time Waiting On Us', now: c.waitingOnUs, was: p.waitingOnUs, lower: true, fmt: pts },
    { value: pct(c.followUpRate), label: 'Follow-Ups After Our Emails', now: c.followUpRate, was: p.followUpRate, lower: true, fmt: pts },
    { value: pct(c.bounceRate), label: 'Bounce Rate', now: c.bounceRate, was: p.bounceRate, lower: true, fmt: pts },
    { value: pct(c.linksOpened), label: 'Secure Links Opened', now: c.linksOpened, was: p.linksOpened, lower: false, fmt: pts },
    { value: pct(c.approvedAsDrafted), label: 'Drafts Approved As Written', now: c.approvedAsDrafted, was: p.approvedAsDrafted, lower: false, fmt: pts },
  ];
  return (
    <section className="mg">
      <style>{CSS}</style>
      <h2>Messages · Last 4 Weeks</h2>
      <div className="mg-row">
        {figs.map((f) => (
          <div key={f.label} className="mg-fig"><b>{f.value}</b><span>{f.label}</span><Delta now={f.now} was={f.was} lowerIsBetter={f.lower} fmt={f.fmt} /></div>
        ))}
      </div>
    </section>
  );
}
