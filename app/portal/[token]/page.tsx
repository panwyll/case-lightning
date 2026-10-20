'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, CheckCircle, ChevronRight, Circle, CircleDot, Clock, FileText, Loader, Lock, Mail, Menu, Phone, Search, Upload, X } from '@/app/shared/icons';

/**
 * The client's portal (lib/server/client-portal.ts): where the case is, what we need from them, and
 * their documents. No account: a code emailed to the address we have for them opens it on this device.
 * Written for anyone, on a phone first: large text, one column, plain words.
 */
const CSS = `
.cp{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;background:#f6f7fb;min-height:100vh;padding:28px 16px 60px;box-sizing:border-box}
.cp *{box-sizing:border-box}
.cp .wrap{max-width:760px;margin:0 auto}
.cp .firm{font-size:15px;font-weight:700;color:#475569;margin:0 0 4px}
.cp h1{font-size:24px;margin:0 0 6px;line-height:1.3}
.cp h2{font-size:18px;font-weight:800;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.cp .count{background:#5A27E0;color:#fff;border-radius:999px;font-size:13px;padding:2px 9px;font-weight:700}
.cp .stage{display:inline-flex;align-items:center;gap:5px;background:#ede9fe;color:#4c1d95;border-radius:999px;padding:3px 10px;font-size:13px;font-weight:700;margin-left:10px;vertical-align:middle}
.cp .card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:20px;margin-bottom:14px}
.cp .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:10px;padding:11px 16px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;white-space:nowrap}
.cp .btn.primary{background:#5A27E0;color:#fff;border-color:#5A27E0}
.cp .btn.wide{width:100%}
.cp .btn.small{padding:7px 12px;font-size:14px}
.cp .btn:disabled{opacity:.55;cursor:not-allowed}
.cp .line{font-size:15px;color:#475569;margin:12px 0;line-height:1.5}
.cp .err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:10px;padding:12px;font-size:15px;margin:12px 0}
.cp .ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:10px;padding:12px;font-size:15px;margin:12px 0;display:flex;gap:8px;align-items:center}
.cp .link{border:0;background:none;padding:0;color:#5A27E0;font:inherit;font-size:15px;font-weight:600;cursor:pointer;text-decoration:underline}
.cp .code{width:100%;font-size:30px;letter-spacing:.35em;text-align:center;padding:12px;border:1.5px solid #cbd5e1;border-radius:10px;font-family:ui-monospace,Menlo,monospace;margin:4px 0 12px}
.cp .code:focus{outline:none;border-color:#5A27E0;box-shadow:0 0 0 3px #ede9fe}
.cp .task{border-top:1px solid #f1f5f9;padding:16px 0}
.cp .task:first-of-type{border-top:0;padding-top:0}
.cp .task:last-child{padding-bottom:0}
.cp .task .t{font-size:16px;font-weight:700;margin:0 0 4px}
.cp .qs{display:grid;gap:14px}
.cp .q p{font-size:15px;color:#0f172a;line-height:1.45;margin:0 0 8px}
.cp .yn{display:flex;gap:8px}
.cp .yn .btn{min-width:84px}
.cp .task .d{font-size:15px;color:#475569;line-height:1.5;margin:0 0 10px}
.cp .none{font-size:15px;color:#166534;display:flex;align-items:center;gap:8px}
.cp .sum{font-size:14px;font-weight:600;color:#64748b;margin:0 0 8px}
.cp .bar{display:flex;gap:3px;height:14px;margin:2px 0 10px}
.cp .bar button{flex:1;border:0;padding:0;border-radius:4px;cursor:pointer;background:#e2e8f0}
.cp .bar button:focus-visible{outline:2px solid #5A27E0;outline-offset:2px}
.cp .bar .done,.cp .key .done{background:#16a34a}
.cp .bar .with_you,.cp .key .with_you{background:#5A27E0}
.cp .bar .in_progress,.cp .key .in_progress{background:#f59e0b}
.cp .bar .not_started,.cp .key .not_started{background:#e2e8f0}
.cp .key{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:#475569;margin-bottom:10px}
.cp .key span{display:inline-flex;align-items:center;gap:6px}
.cp .key i{width:10px;height:10px;border-radius:3px;display:inline-block}
.cp .strand summary{font-size:15px;font-weight:600;padding:12px 0}
.cp .strand summary .st{display:inline-flex;color:#94a3b8}
.cp .strand summary .st svg{color:inherit}
.cp .strand.done summary .st{color:#16a34a}
.cp .strand.with_you summary .st{color:#5A27E0}
.cp .strand.in_progress summary .st{color:#d97706}
.cp .strand summary .holder{margin-left:auto;line-height:1.2;font-size:13px;font-weight:600;color:#64748b;text-align:right}
.cp .strand.with_you summary .holder{color:#4c1d95}
.cp .strand.done summary .holder{color:#166534}
.cp .strand dl{margin:0 0 14px 26px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px;color:#334155;line-height:1.5}
.cp .strand dt{color:#64748b;font-weight:600}
.cp .strand dd{margin:0}
.cp .strand .about{margin:0 0 10px 26px;font-size:15px;color:#334155;line-height:1.5}
.cp .msg summary{display:block;padding:12px 0}
.cp .msg summary b{display:block;font-size:15px}
.cp .msg summary small{font-size:13px;color:#64748b;font-weight:500}
.cp .msg .body{white-space:pre-wrap;font-size:15px;color:#334155;line-height:1.55;margin:0 0 14px;padding:12px 14px;background:#f8fafc;border-radius:10px}
.cp .asked{font-size:13px;color:#64748b;margin:-2px 0 6px}
.cp .tabs{display:flex;gap:4px;border-bottom:1px solid #e2e8f0;margin:0 0 16px}
.cp .tabs button{border:0;background:none;font:inherit;font-size:15px;font-weight:600;color:#64748b;padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;display:inline-flex;align-items:center;gap:8px}
.cp .tabs button.on{color:#4c1d95;border-bottom-color:#5A27E0}
.cp .tabs button:focus-visible,.cp .mnav button:focus-visible,.cp .menu button:focus-visible{outline:2px solid #5A27E0;outline-offset:2px}
.cp .mnav{display:none;position:sticky;top:0;z-index:5;background:#f6f7fb;align-items:center;gap:12px;padding:8px 0;margin:0 0 12px}
.cp .mnav button{border:1px solid #cbd5e1;background:#fff;border-radius:10px;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#0f172a}
.cp .mnav b{font-size:18px;display:inline-flex;align-items:center;gap:8px}
.cp .menu{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:6px;margin:-4px 0 14px;display:grid}
.cp .menu button{border:0;background:none;font:inherit;font-size:17px;font-weight:600;text-align:left;padding:13px 14px;border-radius:10px;cursor:pointer;color:#0f172a;display:flex;align-items:center;gap:8px}
.cp .menu button.on{background:#f5f3ff;color:#4c1d95}
@media (max-width:640px){.cp .tabs{display:none}.cp .mnav{display:flex}}
.cp .dates{display:flex;flex-wrap:wrap;gap:10px 24px;margin-top:14px;font-size:15px}
.cp .dates b{display:block;font-size:13px;color:#64748b;font-weight:600}
.cp .doc{display:flex;align-items:center;gap:10px;padding:11px 0;border-top:1px solid #f1f5f9;font-size:15px}
.cp .doc:first-child{border-top:0}
.cp .doc .n{flex:1;min-width:0;word-break:break-word}
.cp .doc .n small{display:block;color:#64748b;font-size:13px}
.cp .doc svg{flex:none;color:#64748b}
.cp .drop{border:2px dashed #cbd5e1;border-radius:12px;padding:12px;text-align:center;font-size:15px;color:#475569;margin-bottom:12px;cursor:pointer}
.cp .drop.over{border-color:#5A27E0;background:#f5f3ff}
.cp .who{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}

.cp .search{width:100%;font:inherit;font-size:16px;padding:11px 14px;border:1.5px solid #cbd5e1;border-radius:10px;margin-bottom:10px}
.cp .search:focus{outline:none;border-color:#5A27E0;box-shadow:0 0 0 3px #ede9fe}
.cp details{border-top:1px solid #f1f5f9}
.cp details:first-of-type{border-top:0}
.cp summary{cursor:pointer;list-style:none;padding:13px 0;font-size:16px;font-weight:600;display:flex;align-items:center;gap:10px}
.cp summary::-webkit-details-marker{display:none}
.cp summary svg{flex:none;color:#94a3b8;transition:transform .15s}
.cp details[open] summary svg{transform:rotate(90deg)}
.cp details p{margin:0 0 14px 26px;font-size:15px;color:#334155;line-height:1.6}
.cp .more{margin-top:8px}
.cp .topic{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin:16px 0 2px;display:flex;align-items:center;gap:8px}
.cp .topic .now{background:#ede9fe;color:#4c1d95;border-radius:99px;padding:1px 8px;font-size:11px;letter-spacing:0;text-transform:none}
.cp textarea{width:100%;font:inherit;font-size:16px;padding:11px 14px;border:1.5px solid #cbd5e1;border-radius:10px;min-height:110px;resize:vertical;margin:4px 0 10px}
.cp textarea:focus{outline:none;border-color:#5A27E0;box-shadow:0 0 0 3px #ede9fe}
.cp .scores{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}
.cp .score{min-width:44px;height:44px;border:1.5px solid #cbd5e1;border-radius:10px;background:#fff;font:inherit;font-size:16px;font-weight:700;cursor:pointer;color:#0f172a}
.cp .score.on{background:#5A27E0;border-color:#5A27E0;color:#fff}
.cp .ends{display:flex;justify-content:space-between;font-size:13px;color:#64748b;max-width:540px}
@keyframes cp-spin{to{transform:rotate(360deg)}}
.cp .spin{animation:cp-spin .8s linear infinite}
@media (max-width:560px){.cp .bar{height:12px}}
`;

type Action = { type: 'link'; url: string; label: string } | { type: 'upload'; label: string; role: string | null } | { type: 'call'; label: string } | { type: 'reply'; label: string } | { type: 'questions'; label: string; kind: 'sdlt' | 'cgt'; questions: Array<{ key: string; q: string }> };
interface View {
  closed: boolean;
  journey: Array<{ key: string; label: string; state: 'done' | 'current' | 'next' }>;
  stageLabel: string;
  progress: Array<{ id: string; label: string; state: 'done' | 'in_progress' | 'with_you' | 'not_started'; about: string; withWho: string | null; usually: string | null; since: string | null; expected: string | null; longerThanUsual: boolean; chased: number }>;
  tasks: Array<{ id: string; title: string; detail: string; since: string; action: Action }>;
  waitingOnOthers: Array<{ who: string; what: string[] }>;
  dates: { targetExchange: string | null; exchanged: string | null; completion: string | null; targetCompletion: string | null; completed: string | null };
}
interface Doc { id: string; name: string; at: string; from: 'us' | 'you' }
interface Msg { id: string; subject: string; body: string; at: string }
interface Faq { id: string; q: string; a: string }
interface HelpSection { stage: string; label: string; current: boolean; faqs: Faq[] }
type Ctx =
  | { status: 'locked'; firmName: string; propertyAddress: string; codeTo: string[] }
  | { status: 'open'; firmName: string; propertyAddress: string; clientNames: string | null; handler: { name: string | null; email: string | null; phone: string | null }; firmPhone: string | null; view: View | null; documents: Doc[]; history: Msg[]; help: HelpSection[]; feedback: { milestone: string; kind: 'csat' | 'nps' } | null }
  | { status: 'gone' }
  | { status: 'error' };

const day = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const STATE_LABEL: Record<string, string> = { done: 'Done', in_progress: 'In Progress', with_you: 'With You', not_started: 'Not Started' };
const STATES = ['done', 'with_you', 'in_progress', 'not_started'] as const;
/** "With your lender", "With you", "Done": who has a strand, as its row and its bar segment say. */
const holder = (p: View['progress'][number]) => (p.state === 'done' ? 'Done' : p.state === 'not_started' ? 'Not Started' : p.withWho ? `With ${p.withWho === 'You' || p.withWho === 'Us' ? p.withWho : p.withWho.charAt(0).toLowerCase() + p.withWho.slice(1)}` : STATE_LABEL[p.state]);

/** Photos from a phone are often over the upload limit: shrink them to a sharp JPEG first. */
async function fitForUpload(file: File): Promise<File> {
  const LIMIT = 3.8 * 1024 * 1024;
  if (file.size <= LIMIT || !/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  return blob ? new File([blob], file.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

export default function ClientPortal() {
  const { token } = useParams<{ token: string }>();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [phase, setPhase] = useState<'start' | 'code'>('start');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState('');
  const [allFaqs, setAllFaqs] = useState(false);
  const [strand, setStrand] = useState<string | null>(null);
  const [allHistory, setAllHistory] = useState(false);
  const [tab, setTab] = useState<string>('');
  const [menu, setMenu] = useState(false);
  // The section in the address (#progress), so a refresh or a link from an email opens it.
  useEffect(() => { const h = window.location.hash.slice(1); if (h) setTab(h); }, []);
  const [contact, setContact] = useState(false);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [rated, setRated] = useState<{ reviewUrl: string | null } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const codeInput = useRef<HTMLInputElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const pickRole = useRef<{ role: string | null; task: string | null }>({ role: null, task: null });

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/portal/${token}`).then(async (x) => (x.ok ? x.json() : { status: 'error' })).catch(() => ({ status: 'error' }));
    setCtx(['locked', 'open', 'gone'].includes(r?.status) ? r : { status: 'error' });
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (phase === 'code') codeInput.current?.focus(); }, [phase]);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/v1/portal/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? 'Something went wrong. Please try again.');
    return j;
  };
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr(null);
    try { await fn(); } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const askCode = () => run('code', async () => { const j = await post({ action: 'code' }); setDevCode(j.devCode ?? null); setCode(''); setPhase('code'); });
  const check = () => run('verify', async () => { await post({ action: 'verify', code }); await load(); });

  const upload = (files: FileList | File[] | null, role: string | null, task: string | null) => run(task ? `up:${task}` : 'up', async () => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setDone(null);
    for (const f of list) {
      const fit = await fitForUpload(f);
      const fd = new FormData();
      fd.append('file', fit);
      if (role) fd.append('role', role);
      const r = await fetch(`/api/v1/portal/${token}/upload`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${f.name}: ${j?.error?.message ?? j?.error ?? (r.status === 413 ? 'That file is too large to upload here. Email it to us instead.' : 'It did not upload. Please try again.')}`);
    }
    setDone(list.length === 1 ? `Uploaded ${list[0].name}. We have it.` : `Uploaded ${list.length} files. We have them.`);
    await load();
  });
  const sendMessage = () => run('msg', async () => {
    const r = await fetch(`/api/v1/portal/${token}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: msg }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? 'It did not send. Please try again.');
    setSent(true); setMsg('');
  });
  const rate = () => run('rate', async () => {
    const r = await fetch(`/api/v1/portal/${token}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ score, comment: comment.trim() || undefined }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? 'It did not send. Please try again.');
    setRated({ reviewUrl: j.reviewUrl ?? null });
  });
  const sendAnswers = (kind: 'sdlt' | 'cgt') => run('tax', async () => {
    const r = await fetch(`/api/v1/portal/${token}/tax`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, answers }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? 'It did not send. Please try again.');
    setAsking(null); setDone('Thank you. We have your answers.');
    await load();
  });
  const choose = (role: string | null, task: string | null) => { pickRole.current = { role, task }; picker.current?.click(); };

  const shell = (body: React.ReactNode) => <div className="cp"><style>{CSS}</style><div className="wrap">{body}</div></div>;
  if (!ctx) return shell(<Loader size={20} className="spin" />);
  if (ctx.status === 'error') return shell(<><h1>We could not open your case just now</h1><div className="card"><div className="line" style={{ margin: 0 }}>Please try again in a few minutes, or reply to our latest email.</div></div></>);
  if (ctx.status === 'gone') return shell(<><h1>This link no longer works</h1><div className="card"><div className="line" style={{ margin: 0 }}>Reply to our latest email or call us and we will send you a new one.</div></div></>);

  if (ctx.status === 'locked') return shell(
    <>
      <p className="firm">{ctx.firmName}</p>
      <h1>{ctx.propertyAddress}</h1>
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 700 }}><Lock size={18} />Your Case</div>
        {phase === 'start' && (
          <>
            <div className="line">To open it, we will email you a code{ctx.codeTo.length ? ` at ${ctx.codeTo.join(' and ')}` : ''}.</div>
            <button className="btn primary wide" disabled={!!busy} onClick={() => void askCode()}>{busy ? <><Loader size={18} className="spin" />Sending…</> : 'Email Me A Code'}</button>
          </>
        )}
        {phase === 'code' && (
          <>
            <div className="line">We have emailed you a six-digit code. Type it here.</div>
            {devCode && <div className="line">Development code: <b>{devCode}</b></div>}
            <input ref={codeInput} className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-label="Code" onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) void check(); }} />
            <button className="btn primary wide" disabled={!!busy || code.length !== 6} onClick={() => void check()}>{busy ? <><Loader size={18} className="spin" />Checking…</> : 'Open'}</button>
            <div className="line">No email? Check your junk folder, or <button className="link" disabled={!!busy} onClick={() => void askCode()}>Send A New Code</button>.</div>
          </>
        )}
        {err && <div className="err">{err}</div>}
      </div>
    </>
  );

  const v = ctx.view;
  const phone = ctx.handler.phone ?? ctx.firmPhone;
  const tasks = v?.tasks ?? [];
  const actionFor = (t: View['tasks'][number]) => {
    const a = t.action;
    if (a.type === 'questions') {
      if (asking !== t.id) return <button className="btn primary" onClick={() => { setAsking(t.id); setAnswers({}); }}>{a.label}</button>;
      const missing = a.questions.some((q) => answers[q.key] === undefined);
      return (
        <div className="qs">
          {a.questions.map((q) => (
            <div key={q.key} className="q">
              <p>{q.q}</p>
              <div className="yn">
                <button className={`btn${answers[q.key] === true ? ' primary' : ''}`} onClick={() => setAnswers({ ...answers, [q.key]: true })}>Yes</button>
                <button className={`btn${answers[q.key] === false ? ' primary' : ''}`} onClick={() => setAnswers({ ...answers, [q.key]: false })}>No</button>
              </div>
            </div>
          ))}
          <button className="btn primary" disabled={missing || !!busy} onClick={() => void sendAnswers(a.kind)}>{busy === 'tax' ? <><Loader size={18} className="spin" />Sending…</> : 'Send Answers'}</button>
        </div>
      );
    }
    if (a.type === 'link') return <a className="btn primary" href={a.url} target="_blank" rel="noreferrer">{a.label}</a>;
    if (a.type === 'upload') return <button className="btn primary" disabled={!!busy} onClick={() => choose(a.role, t.id)}>{busy === `up:${t.id}` ? <><Loader size={18} className="spin" />Uploading…</> : <><Upload size={18} />{a.label}</>}</button>;
    if (a.type === 'call') return phone ? <a className="btn primary" href={`tel:${phone.replace(/[^\d+]/g, '')}`}><Phone size={18} />{a.label}</a> : null;
    return ctx.handler.email ? <a className="btn" href={`mailto:${ctx.handler.email}?subject=${encodeURIComponent(`${ctx.propertyAddress}: ${t.title}`)}`}><Mail size={18} />{a.label}</a> : null;
  };

  // One section at a time: tabs on a wide screen, a menu on a phone. A section with nothing in it is not offered.
  const sections: Array<{ key: string; label: string; count?: number }> = [
    ...(v && !v.closed ? [{ key: 'you', label: 'For You', count: tasks.length }] : []),
    ...(v && v.progress.length > 0 ? [{ key: 'progress', label: 'Progress' }] : []),
    { key: 'documents', label: 'Documents' },
    ...(ctx.history.length > 0 ? [{ key: 'history', label: 'History' }] : []),
    { key: 'help', label: 'Help' },
  ];
  const cur = sections.some((x) => x.key === tab) ? tab : sections[0].key;
  const go = (k: string) => { setTab(k); setMenu(false); window.history.replaceState(null, '', `#${k}`); window.scrollTo({ top: 0 }); };
  const here = sections.find((x) => x.key === cur)!;

  return shell(
    <>
      <p className="firm">{ctx.firmName}</p>
      <h1 style={{ marginBottom: 18 }}>{ctx.propertyAddress}</h1>
      <input ref={picker} type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.doc,.docx" onChange={(e) => { const { role, task } = pickRole.current; void upload(e.target.files, role, task); e.target.value = ''; }} />
      <nav className="tabs" aria-label="Your case">
        {sections.map((x) => <button key={x.key} className={x.key === cur ? 'on' : ''} aria-current={x.key === cur ? 'page' : undefined} onClick={() => go(x.key)}>{x.label}{!!x.count && <span className="count">{x.count}</span>}</button>)}
      </nav>
      <div className="mnav">
        <button aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} aria-controls="cp-menu" onClick={() => setMenu(!menu)}>{menu ? <X size={22} /> : <Menu size={22} />}</button>
        <b>{here.label}{!!here.count && <span className="count">{here.count}</span>}</b>
      </div>
      {menu && (
        <div id="cp-menu" className="menu">
          {sections.map((x) => <button key={x.key} className={x.key === cur ? 'on' : ''} aria-current={x.key === cur ? 'page' : undefined} onClick={() => go(x.key)}>{x.label}{!!x.count && <span className="count">{x.count}</span>}</button>)}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {done && <div className="ok"><Check size={18} />{done}</div>}

      {cur === 'you' && ctx.feedback && (
        <div className="card">
          {rated ? (
            <>
              <div className="none"><CheckCircle size={18} />Thank you. It helps us do better.</div>
              {rated.reviewUrl && <div style={{ marginTop: 12 }}><a className="btn primary" href={rated.reviewUrl} target="_blank" rel="noreferrer">Leave Us A Review</a></div>}
            </>
          ) : (
            <>
              <h2>{ctx.feedback.kind === 'nps' ? 'Would You Recommend Us?' : 'How Are We Doing?'}</h2>
              <div className="scores">
                {Array.from({ length: ctx.feedback.kind === 'nps' ? 11 : 5 }, (_, i) => (ctx.feedback!.kind === 'nps' ? i : i + 1)).map((n) => (
                  <button key={n} className={`score${score === n ? ' on' : ''}`} onClick={() => setScore(n)} aria-label={`Score ${n}`}>{n}</button>
                ))}
              </div>
              <div className="ends"><span>{ctx.feedback.kind === 'nps' ? 'Not Likely' : 'Poor'}</span><span>{ctx.feedback.kind === 'nps' ? 'Very Likely' : 'Excellent'}</span></div>
              {score !== null && (
                <>
                  <textarea placeholder="Anything you would like to tell us? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 80, marginTop: 12 }} />
                  <button className="btn primary" disabled={!!busy} onClick={() => void rate()}>{busy === 'rate' ? <><Loader size={18} className="spin" />Sending…</> : 'Send'}</button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {cur === 'you' && v && !v.closed && (
        <div className="card">
          {tasks.length === 0 ? (
            <div className="none"><CheckCircle size={18} />Nothing for you to do right now.</div>
          ) : tasks.map((t) => (
            <div key={t.id} className="task">
              <p className="t">{t.title}</p>
              {t.since && <p className="asked">Asked {day(t.since)}</p>}
              <p className="d">{t.detail}</p>
              {actionFor(t)}
            </div>
          ))}
        </div>
      )}

      {cur === 'progress' && v && v.progress.length > 0 && (
        <div className="card">
          <div className="sum">{v.progress.filter((p) => p.state === 'done').length} Of {v.progress.length} Done</div>
          {/* One segment per part of the work, side by side: they run at the same time, not one after another. */}
          <div className="bar">
            {v.progress.map((p) => (
              <button key={p.id} className={p.state} title={`${p.label}: ${holder(p)}${p.usually ? `. Usually ${p.usually.charAt(0).toLowerCase()}${p.usually.slice(1)}` : ''}`} aria-label={`${p.label}: ${holder(p)}`}
                onClick={() => { setStrand(p.id); document.getElementById(`strand-${p.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} />
            ))}
          </div>
          <div className="key">
            {STATES.filter((st) => v.progress.some((p) => p.state === st)).map((st) => <span key={st}><i className={st} />{v.progress.filter((p) => p.state === st).length} {STATE_LABEL[st]}</span>)}
          </div>
          {v.progress.map((p) => (
            <details key={p.id} id={`strand-${p.id}`} className={`strand ${p.state}`} open={strand === p.id} onToggle={(e) => { const open = (e.currentTarget as HTMLDetailsElement).open; if (open) setStrand(p.id); else if (strand === p.id) setStrand(null); }}>
              <summary>
                <span className="st">{p.state === 'done' ? <CheckCircle size={18} /> : p.state === 'not_started' ? <Circle size={18} /> : p.state === 'with_you' ? <CircleDot size={18} /> : <Clock size={18} />}</span>
                {p.label}
                <span className="holder">{holder(p)}</span>
              </summary>
              {p.about && <p className="about">{p.about}</p>}
              <dl>
                {p.usually && <><dt>Usually</dt><dd>{p.usually}</dd></>}
                {p.since && <><dt>{p.state === 'with_you' ? 'Asked' : 'Since'}</dt><dd>{day(p.since)}</dd></>}
                {p.expected && <><dt>Expected</dt><dd>By around {day(p.expected)}</dd></>}
                {p.state === 'with_you' && sections.some((x) => x.key === 'you') && <><dt /><dd><button className="link" onClick={() => go('you')}>See What To Do</button></dd></>}
                {p.longerThanUsual && <><dt>Timing</dt><dd>Taking longer than usual.{p.chased > 0 ? ` We have chased ${p.chased === 1 ? 'once' : `${p.chased} times`} and will keep at it.` : ' We are following it up.'}</dd></>}
              </dl>
            </details>
          ))}
          {(v.dates.exchanged || v.dates.targetExchange || v.dates.completion || v.dates.targetCompletion || v.dates.completed) && (
            <div className="dates">
              {v.dates.exchanged ? <div><b>Exchanged</b>{day(v.dates.exchanged)}</div> : v.dates.targetExchange ? <div><b>Aiming To Exchange</b>{day(v.dates.targetExchange)}</div> : null}
              {v.dates.completed ? <div><b>Completed</b>{day(v.dates.completed)}</div> : v.dates.completion ? <div><b>Completion</b>{day(v.dates.completion)}</div> : v.dates.targetCompletion ? <div><b>Aiming To Complete</b>{day(v.dates.targetCompletion)}</div> : null}
            </div>
          )}
        </div>
      )}

      {cur === 'documents' && (
      <div className="card">
        <div
          className={`drop${over ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => choose(null, null)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') choose(null, null); }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files, null, null); }}
        >
          {busy === 'up' ? <><Loader size={18} className="spin" /> Uploading…</> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Upload size={18} />Send Us A Document</span>}
        </div>
        {ctx.documents.length === 0 ? <div className="line" style={{ margin: 0 }}>No documents yet.</div> : ctx.documents.map((d) => (
          <div key={d.id} className="doc">
            <FileText size={20} />
            <span className="n">{d.name}<small>{d.from === 'us' ? 'From us' : 'From you'} · {day(d.at)}</small></span>
            {d.from === 'us' && /\.pdf$/i.test(d.name) && <a className="btn small" href={`/api/v1/portal/${token}/documents/${d.id}?view=1`} target="_blank" rel="noreferrer">View</a>}
            <a className="btn small" href={`/api/v1/portal/${token}/documents/${d.id}`}>Download</a>
          </div>
        ))}
      </div>

      )}

      {cur === 'history' && ctx.history.length > 0 && (
        <div className="card">
          {(allHistory ? ctx.history : ctx.history.slice(0, 5)).map((m) => (
            <details key={m.id} className="msg">
              <summary><b>{m.subject}</b><small>{day(m.at)}</small></summary>
              <div className="body">{m.body}</div>
            </details>
          ))}
          {!allHistory && ctx.history.length > 5 && <button className="link more" onClick={() => setAllHistory(true)}>Show All {ctx.history.length}</button>}
        </div>
      )}

      {cur === 'help' && ctx.help.length > 0 && (() => {
        const term = q.trim().toLowerCase();
        const hits = term ? ctx.help.flatMap((sec) => sec.faqs).filter((f) => `${f.q} ${f.a}`.toLowerCase().includes(term)) : [];
        const qa = (f: Faq) => (
          <details key={f.id}>
            <summary><ChevronRight size={16} />{f.q}</summary>
            <p>{f.a}</p>
          </details>
        );
        const [first, ...rest] = ctx.help;
        const section = (sec: HelpSection) => (
          <div key={sec.stage}>
            <div className="topic">{sec.label}{sec.current && <span className="now">Now</span>}</div>
            {sec.faqs.map(qa)}
          </div>
        );
        return (
          <div className="card">
            <div style={{ position: 'relative' }}>
              <input className="search" placeholder="Search questions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search questions" style={{ paddingLeft: 40 }} />
              <Search size={18} style={{ position: 'absolute', left: 14, top: 14, color: '#94a3b8' }} />
            </div>
            {term ? (
              hits.length ? hits.map(qa) : <div className="line">No answer for that here. Ask us below.</div>
            ) : (
              <>
                {section(first)}
                {allFaqs ? rest.map(section) : rest.length > 0 && <button className="link more" onClick={() => setAllFaqs(true)}>Other Stages</button>}
              </>
            )}
          </div>
        );
      })()}

      {cur === 'help' && (
      <div className="card">
        <h2>Still Need Help?</h2>
        {!contact ? (
          <button className="btn" onClick={() => setContact(true)}><Mail size={18} />Contact Us</button>
        ) : (
          <>
            {sent ? (
              <div className="ok"><Check size={18} />Sent. {ctx.handler.name ?? 'We'} will reply by email.</div>
            ) : (
              <>
                <textarea placeholder={`Your message to ${ctx.handler.name ?? ctx.firmName}`} value={msg} onChange={(e) => setMsg(e.target.value)} />
                <button className="btn primary" disabled={!!busy || msg.trim().length < 10} onClick={() => void sendMessage()}>{busy === 'msg' ? <><Loader size={18} className="spin" />Sending…</> : 'Send Message'}</button>
              </>
            )}
            <div className="who" style={{ marginTop: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 700, alignSelf: 'center', marginRight: 4 }}>{ctx.handler.name ?? ctx.firmName}</span>
              {phone && <a className="btn small" href={`tel:${phone.replace(/[^\d+]/g, '')}`}><Phone size={16} />{phone}</a>}
              {ctx.handler.email && <a className="btn small" href={`mailto:${ctx.handler.email}`}><Mail size={16} />{ctx.handler.email}</a>}
            </div>
          </>
        )}
      </div>
      )}
    </>
  );
}
