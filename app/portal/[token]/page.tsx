'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, CheckCircle, ChevronRight, Circle, CircleDot, Clock, FileText, Loader, Lock, Mail, Phone, Search, Upload } from '@/app/shared/icons';

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
.cp .task .d{font-size:15px;color:#475569;line-height:1.5;margin:0 0 10px}
.cp .none{font-size:15px;color:#166534;display:flex;align-items:center;gap:8px}
.cp .steps{display:flex;gap:0;margin:0 0 18px;overflow-x:auto}
.cp .step{flex:1;min-width:92px;text-align:center;position:relative;font-size:13px;color:#94a3b8;font-weight:600;padding-top:30px}
.cp .step:before{content:'';position:absolute;top:11px;left:-50%;right:50%;height:3px;background:#e2e8f0}
.cp .step:first-child:before{display:none}
.cp .step.done:before,.cp .step.current:before{background:#5A27E0}
.cp .step i{position:absolute;top:0;left:50%;transform:translateX(-50%);width:24px;height:24px;border-radius:999px;background:#fff;border:3px solid #e2e8f0;display:flex;align-items:center;justify-content:center}
.cp .step.done i{background:#5A27E0;border-color:#5A27E0;color:#fff}
.cp .step.current i{border-color:#5A27E0}
.cp .step.current{color:#4c1d95}
.cp .step.done{color:#475569}
.cp .ws{display:flex;flex-wrap:wrap;gap:8px}
.cp .chip{display:inline-flex;align-items:center;gap:6px;font-size:14px;border-radius:99px;padding:6px 12px;background:#f1f5f9;color:#475569}
.cp .chip b{font-size:12px;font-weight:800;margin-left:2px}
.cp .chip.done{background:#dcfce7;color:#14532d}
.cp .chip.with_you{background:#ede9fe;color:#4c1d95}
.cp .chip.in_progress{background:#fef3c7;color:#78350f}
.cp .steps-m{display:none}
.cp .steps-m .seg{display:flex;gap:4px;margin-bottom:8px}
.cp .steps-m .seg i{flex:1;height:8px;border-radius:99px;background:#e2e8f0}
.cp .steps-m .seg i.done,.cp .steps-m .seg i.current{background:#5A27E0}
.cp .steps-m b{font-size:16px;margin-right:8px}
.cp .steps-m span{font-size:13px;color:#64748b}
.cp .others{margin-top:14px;font-size:15px;color:#475569;line-height:1.6}
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
.cp textarea{width:100%;font:inherit;font-size:16px;padding:11px 14px;border:1.5px solid #cbd5e1;border-radius:10px;min-height:110px;resize:vertical;margin:4px 0 10px}
.cp textarea:focus{outline:none;border-color:#5A27E0;box-shadow:0 0 0 3px #ede9fe}
.cp .scores{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}
.cp .score{min-width:44px;height:44px;border:1.5px solid #cbd5e1;border-radius:10px;background:#fff;font:inherit;font-size:16px;font-weight:700;cursor:pointer;color:#0f172a}
.cp .score.on{background:#5A27E0;border-color:#5A27E0;color:#fff}
.cp .ends{display:flex;justify-content:space-between;font-size:13px;color:#64748b;max-width:540px}
@keyframes cp-spin{to{transform:rotate(360deg)}}
.cp .spin{animation:cp-spin .8s linear infinite}
@media (max-width:560px){
.cp .steps{display:none}
.cp .steps-m{display:block;margin-bottom:16px}
}
`;

type Action = { type: 'link'; url: string; label: string } | { type: 'upload'; label: string; role: string | null } | { type: 'call'; label: string } | { type: 'reply'; label: string };
interface View {
  closed: boolean;
  journey: Array<{ key: string; label: string; state: 'done' | 'current' | 'next' }>;
  stageLabel: string;
  progress: Array<{ id: string; label: string; state: 'done' | 'in_progress' | 'with_you' | 'not_started' }>;
  tasks: Array<{ id: string; title: string; detail: string; since: string; action: Action }>;
  waitingOnOthers: Array<{ who: string; what: string[] }>;
  dates: { targetExchange: string | null; exchanged: string | null; completion: string | null; targetCompletion: string | null; completed: string | null };
}
interface Doc { id: string; name: string; at: string; from: 'us' | 'you' }
interface Faq { id: string; topic: string; q: string; a: string }
type Ctx =
  | { status: 'locked'; firmName: string; propertyAddress: string; codeTo: string[] }
  | { status: 'open'; firmName: string; propertyAddress: string; clientNames: string | null; handler: { name: string | null; email: string | null; phone: string | null }; firmPhone: string | null; view: View | null; documents: Doc[]; faqs: Faq[]; feedback: { milestone: string; kind: 'csat' | 'nps' } | null }
  | { status: 'gone' }
  | { status: 'error' };

const day = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const STATE_LABEL: Record<string, string> = { done: 'Done', in_progress: 'In Progress', with_you: 'With You', not_started: 'Not Started' };

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
  const [contact, setContact] = useState(false);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [rated, setRated] = useState<{ reviewUrl: string | null } | null>(null);
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
    if (a.type === 'link') return <a className="btn primary" href={a.url} target="_blank" rel="noreferrer">{a.label}</a>;
    if (a.type === 'upload') return <button className="btn primary" disabled={!!busy} onClick={() => choose(a.role, t.id)}>{busy === `up:${t.id}` ? <><Loader size={18} className="spin" />Uploading…</> : <><Upload size={18} />{a.label}</>}</button>;
    if (a.type === 'call') return phone ? <a className="btn primary" href={`tel:${phone.replace(/[^\d+]/g, '')}`}><Phone size={18} />{a.label}</a> : null;
    return ctx.handler.email ? <a className="btn" href={`mailto:${ctx.handler.email}?subject=${encodeURIComponent(`${ctx.propertyAddress}: ${t.title}`)}`}><Mail size={18} />{a.label}</a> : null;
  };

  return shell(
    <>
      <p className="firm">{ctx.firmName}{v && <span className="stage"><CircleDot size={16} />{v.stageLabel}</span>}</p>
      <h1 style={{ marginBottom: 18 }}>{ctx.propertyAddress}</h1>
      <input ref={picker} type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.doc,.docx" onChange={(e) => { const { role, task } = pickRole.current; void upload(e.target.files, role, task); e.target.value = ''; }} />
      {err && <div className="err">{err}</div>}
      {done && <div className="ok"><Check size={18} />{done}</div>}

      {ctx.feedback && (
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

      {v && !v.closed && (
        <div className="card">
          <h2>For You{tasks.length > 0 && <span className="count">{tasks.length}</span>}</h2>
          {tasks.length === 0 ? (
            <div className="none"><CheckCircle size={18} />Nothing for you to do right now.</div>
          ) : tasks.map((t) => (
            <div key={t.id} className="task">
              <p className="t">{t.title}</p>
              <p className="d">{t.detail}</p>
              {actionFor(t)}
            </div>
          ))}
        </div>
      )}

      {v && (
        <div className="card">
          <h2>Progress</h2>
          <div className="steps">
            {v.journey.map((s) => (
              <div key={s.key} className={`step ${s.state}`}><i>{s.state === 'done' ? <Check size={16} /> : null}</i>{s.label}</div>
            ))}
          </div>
          {(() => {
            const at = Math.max(0, v.journey.findIndex((s) => s.state === 'current'));
            const all = v.journey.every((s) => s.state === 'done');
            return (
              <div className="steps-m">
                <div className="seg">{v.journey.map((s) => <i key={s.key} className={s.state} />)}</div>
                <b>{all ? v.journey[v.journey.length - 1].label : v.journey[at].label}</b><span>{all ? '' : `Step ${at + 1} Of ${v.journey.length}`}</span>
              </div>
            );
          })()}
          <div className="ws">
            {v.progress.map((p) => (
              <span key={p.id} className={`chip ${p.state}`} title={STATE_LABEL[p.state]}>
                {p.state === 'done' ? <CheckCircle size={16} /> : p.state === 'not_started' ? <Circle size={16} /> : p.state === 'with_you' ? <CircleDot size={16} /> : <Clock size={16} />}
                {p.label}{p.state === 'with_you' && <b>With You</b>}
              </span>
            ))}
          </div>
          {v.waitingOnOthers.length > 0 && (
            <div className="others">{v.waitingOnOthers.map((w) => <div key={w.who}>Waiting for {w.who}: {w.what.join(', ')}.</div>)}</div>
          )}
          {(v.dates.exchanged || v.dates.targetExchange || v.dates.completion || v.dates.targetCompletion || v.dates.completed) && (
            <div className="dates">
              {v.dates.exchanged ? <div><b>Exchanged</b>{day(v.dates.exchanged)}</div> : v.dates.targetExchange ? <div><b>Aiming To Exchange</b>{day(v.dates.targetExchange)}</div> : null}
              {v.dates.completed ? <div><b>Completed</b>{day(v.dates.completed)}</div> : v.dates.completion ? <div><b>Completion</b>{day(v.dates.completion)}</div> : v.dates.targetCompletion ? <div><b>Aiming To Complete</b>{day(v.dates.targetCompletion)}</div> : null}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Documents</h2>
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

      {ctx.faqs.length > 0 && (() => {
        const term = q.trim().toLowerCase();
        const hits = term ? ctx.faqs.filter((f) => `${f.q} ${f.a}`.toLowerCase().includes(term)) : ctx.faqs;
        const shown = term || allFaqs ? hits : hits.slice(0, 6);
        return (
          <div className="card">
            <h2>Help</h2>
            <div style={{ position: 'relative' }}>
              <input className="search" placeholder="Search questions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search questions" style={{ paddingLeft: 40 }} />
              <Search size={18} style={{ position: 'absolute', left: 14, top: 14, color: '#94a3b8' }} />
            </div>
            {shown.map((f) => (
              <details key={f.id}>
                <summary><ChevronRight size={16} />{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
            {term && hits.length === 0 && <div className="line">No answer for that here. Ask us below.</div>}
            {!term && !allFaqs && hits.length > shown.length && <button className="link more" onClick={() => setAllFaqs(true)}>Show All {hits.length} Questions</button>}
          </div>
        );
      })()}

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
    </>
  );
}
