'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { paths } from '@/lib/paths';

/**
 * The way in (docs/sign-in.md).
 *
 * Two doors, because a firm is not necessarily a Microsoft 365 firm any more: sign in
 * with the work Microsoft account, or have a one-time link emailed. Both land wherever
 * the person was headed — the middleware puts that in ?next.
 */
const CSS = `
.si{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:32px 16px;background:#faf9f7;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.si-card{width:100%;max-width:420px}
.si-brand{font-size:22px;font-weight:800;letter-spacing:-0.02em}
.si-brand span{color:#5A27E0}
.si-h1{font-size:26px;font-weight:800;margin:20px 0 6px;letter-spacing:-0.02em}
.si-sub{color:#64748b;font-size:14px;margin:0 0 22px;line-height:1.5}
.si-box{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:20px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.si-ms{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;padding:11px 16px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;font-size:14.5px;font-weight:600;color:#0f172a;text-decoration:none;font-family:inherit;cursor:pointer}
.si-ms:hover{background:#f8fafc}
.si-or{display:flex;align-items:center;gap:12px;margin:18px 0;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.si-or::before,.si-or::after{content:'';flex:1;height:1px;background:#e6e8ee}
.si-label{display:block;font-size:13px;font-weight:700;margin-bottom:6px}
.si-in{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:14.5px;font-family:inherit}
.si-in:focus{outline:2px solid #5A27E0;outline-offset:1px;border-color:#5A27E0}
.si-btn{width:100%;box-sizing:border-box;margin-top:10px;padding:11px 16px;border:0;border-radius:10px;background:#5A27E0;color:#fff;font-size:14.5px;font-weight:700;cursor:pointer;font-family:inherit}
.si-btn:disabled{opacity:.5;cursor:not-allowed}
.si-msg{margin-top:14px;padding:11px 13px;border-radius:10px;font-size:13.5px;line-height:1.5}
.si-msg.ok{background:#f0fdf4;border:1px solid #86efac;color:#14532d}
.si-msg.bad{background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d}
.si-foot{margin-top:18px;font-size:12.5px;color:#94a3b8;text-align:center;line-height:1.6}
.si-foot a{color:#64748b}
`;

function SignIn() {
  const params = useSearchParams();
  const next = params.get('next');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(params.get('error'));

  const msHref = `/api/v1/auth/login?flow=web${next ? `&next=${encodeURIComponent(next)}` : ''}`;

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/v1/auth/sign-in-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Could not send the link.');
      setSent(true);
      // Development only: the API hands back the link when no mail provider is set up.
      if (body?.devLink) console.info('Sign-in link (development only):', body.devLink);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not send the link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="si">
      <style>{CSS}</style>
      <div className="si-card">
        <div className="si-brand">CONVE<span>Yi</span></div>
        <h1 className="si-h1">Sign in</h1>
        <p className="si-sub">Your caseload, the decisions waiting on you, and what everything is waiting for.</p>

        <div className="si-box">
          <a className="si-ms" href={msHref}>
            <svg width="17" height="17" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg>
            Continue with Microsoft
          </a>

          <div className="si-or">or</div>

          {sent ? (
            <div className="si-msg ok">
              <strong>Check your email.</strong> If {email.trim()} belongs to an account, a sign-in link is on its way.
              It works once and lasts 15 minutes.
              <div style={{ marginTop: 8 }}>
                <button className="si-btn" style={{ background: '#fff', color: '#14532d', border: '1px solid #86efac' }} onClick={() => setSent(false)}>
                  Use a different address
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={sendLink}>
              <label className="si-label" htmlFor="si-email">Email me a sign-in link</label>
              <input
                id="si-email"
                className="si-in"
                type="email"
                autoComplete="email"
                required
                placeholder="you@yourfirm.co.uk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="si-btn" type="submit" disabled={busy || !email.trim()}>
                {busy ? 'Sending…' : 'Send me a link'}
              </button>
            </form>
          )}

          {err && <div className="si-msg bad">{err}</div>}
        </div>

        <p className="si-foot">
          New firm? <a href={paths.getStarted}>Start a trial</a> · Stuck? <a href={paths.support}>Support</a>
        </p>
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<main className="si"><style>{CSS}</style><div className="si-card"><div className="si-brand">CONVE<span>Yi</span></div></div></main>}>
      <SignIn />
    </Suspense>
  );
}
