'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { FileText, Lock, Loader, Check } from '@/app/shared/icons';

/**
 * A secure link to files we sent a client (lib/server/file-shares.ts). No account, no password:
 * the client asks for a code, we email it to the address we have for them, they type it, the
 * files open. Written for anyone: one thing to do at a time, large text, plain words.
 */
const CSS = `
.fs{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;background:#f6f7fb;min-height:100vh;padding:32px 16px 60px;box-sizing:border-box}
.fs .wrap{max-width:560px;margin:0 auto}
.fs .firm{font-size:15px;font-weight:700;color:#475569;margin:0 0 4px}
.fs h1{font-size:24px;margin:0 0 18px;line-height:1.3}
.fs .card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:20px}
.fs .file{display:flex;align-items:center;gap:10px;padding:12px 0;border-top:1px solid #f1f5f9;font-size:16px}
.fs .file:first-child{border-top:0;padding-top:0}
.fs .file .n{flex:1;min-width:0;word-break:break-word}
.fs .file svg{flex:none;color:#64748b}
.fs .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:10px;padding:12px 18px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none}
.fs .btn.primary{background:#5A27E0;color:#fff;border-color:#5A27E0;width:100%}
.fs .btn.small{padding:8px 12px;font-size:14px}
.fs .btn:disabled{opacity:.55;cursor:not-allowed}
.fs .code{width:100%;box-sizing:border-box;font-size:30px;letter-spacing:.35em;text-align:center;padding:12px;border:1.5px solid #cbd5e1;border-radius:10px;font-family:ui-monospace,Menlo,monospace;margin:4px 0 12px}
.fs .code:focus{outline:none;border-color:#5A27E0;box-shadow:0 0 0 3px #ede9fe}
.fs .line{font-size:15px;color:#475569;margin:14px 0;line-height:1.5}
.fs .err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:10px;padding:12px;font-size:15px;margin:12px 0}
.fs .link{border:0;background:none;padding:0;color:#5A27E0;font:inherit;font-size:15px;font-weight:600;cursor:pointer;text-decoration:underline}
.fs .acts{display:flex;gap:8px;flex-wrap:wrap}
@keyframes fs-spin{to{transform:rotate(360deg)}}
.fs .spin{animation:fs-spin .8s linear infinite}
`;

type Ctx = { status: 'ok' | 'gone' | 'error'; firmName?: string; propertyAddress?: string; files?: string[]; open?: boolean; codeTo?: string[] };

export default function SecureFiles() {
  const { token } = useParams<{ token: string }>();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [phase, setPhase] = useState<'start' | 'code' | 'open'>('start');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/f/${token}`).then(async (x) => (x.ok ? x.json() : { status: 'error' })).catch(() => ({ status: 'error' }));
    setCtx(r?.status === 'ok' || r?.status === 'gone' ? r : { status: 'error' });
    if (r?.open) setPhase('open');
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (phase === 'code') input.current?.focus(); }, [phase]);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/v1/f/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? 'Something went wrong. Please try again.');
    return j;
  };
  const askCode = async () => {
    setBusy(true); setErr(null);
    try { const j = await post({ action: 'code' }); setDevCode(j.devCode ?? null); setCode(''); setPhase('code'); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setErr(null);
    try { await post({ action: 'verify', code }); setPhase('open'); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!ctx) return <div className="fs"><style>{CSS}</style><div className="wrap"><Loader size={20} className="spin" /></div></div>;
  if (ctx.status === 'error') return (
    <div className="fs"><style>{CSS}</style><div className="wrap">
      <h1>We could not open this link just now</h1>
      <div className="card"><div className="line" style={{ margin: 0 }}>Please try again in a few minutes, or reply to our email and we will send your documents another way.</div></div>
    </div></div>
  );
  if (ctx.status === 'gone') return (
    <div className="fs"><style>{CSS}</style><div className="wrap">
      <h1>This link has expired</h1>
      <div className="card"><div className="line" style={{ margin: 0 }}>Reply to our email or call us and we will send you a new one.</div></div>
    </div></div>
  );
  const files = ctx.files ?? [];
  return (
    <div className="fs"><style>{CSS}</style><div className="wrap">
      <p className="firm">{ctx.firmName}</p>
      <h1>{files.length === 1 ? 'Your document' : 'Your documents'}{ctx.propertyAddress ? ` for ${ctx.propertyAddress}` : ''}</h1>
      <div className="card">
        {files.map((f, i) => (
          <div key={i} className="file">
            {phase === 'open' ? <FileText size={20} /> : <Lock size={20} />}
            <span className="n">{f}</span>
            {phase === 'open' && (
              <span className="acts">
                {/\.pdf$/i.test(f) && <a className="btn small" href={`/api/v1/f/${token}/${i}?view=1`} target="_blank" rel="noreferrer">View</a>}
                <a className="btn small" href={`/api/v1/f/${token}/${i}`}>Download</a>
              </span>
            )}
          </div>
        ))}

        {phase === 'start' && (
          <>
            <div className="line">To open {files.length === 1 ? 'it' : 'them'}, we will email you a code{ctx.codeTo?.length ? ` at ${ctx.codeTo.join(' and ')}` : ''}.</div>
            <button className="btn primary" disabled={busy} onClick={() => void askCode()}>{busy ? <><Loader size={18} className="spin" />Sending…</> : 'Email Me A Code'}</button>
          </>
        )}

        {phase === 'code' && (
          <>
            <div className="line">We have emailed you a six-digit code. Type it here.</div>
            {devCode && <div className="line">Development code: <b>{devCode}</b></div>}
            <input ref={input} className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-label="Code" onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) void check(); }} />
            <button className="btn primary" disabled={busy || code.length !== 6} onClick={() => void check()}>{busy ? <><Loader size={18} className="spin" />Checking…</> : 'Open'}</button>
            <div className="line">No email? Check your junk folder, or <button className="link" disabled={busy} onClick={() => void askCode()}>Send A New Code</button>.</div>
          </>
        )}

        {phase === 'open' && <div className="line" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}><Check size={16} style={{ color: '#166534', flex: 'none' }} />Open on this device for the next day.</div>}
        {err && <div className="err">{err}</div>}
      </div>
      <div className="line">Having trouble? Reply to our email and we will send {files.length === 1 ? 'it' : 'them'} another way.</div>
    </div></div>
  );
}
