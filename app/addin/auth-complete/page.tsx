'use client';

import { useEffect, useState } from 'react';

/**
 * OAuth completion bridge. The Microsoft sign-in runs in an Office dialog window
 * (so it isn't blocked from being iframed). When it lands here — signed in, on
 * our own domain — we message the parent taskpane and the dialog closes. Opened
 * in a plain browser instead, we just forward to the taskpane.
 */
export default function AuthComplete() {
  const [msg, setMsg] = useState('Finishing sign-in…');

  useEffect(() => {
    let done = false;
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('s') ?? '';
    const finish = () => {
      if (done) return;
      try {
        if ((window as any).Office?.context?.ui?.messageParent) {
          (window as any).Office.context.ui.messageParent(JSON.stringify({ status: 'ok', token }));
          done = true;
          setMsg('Connected. You can close this window.');
          return;
        }
      } catch {
        /* not in a dialog — fall through to redirect */
      }
    };

    const tryOffice = () => {
      if ((window as any).Office?.onReady) {
        (window as any).Office.onReady(() => finish());
        return true;
      }
      return false;
    };

    if (!tryOffice()) {
      const t = setInterval(() => tryOffice() && clearInterval(t), 300);
      setTimeout(() => clearInterval(t), 4000);
    }

    // If we're not inside an Office dialog after a moment, this is a normal
    // browser sign-in (no add-in) — the session cookie is already set, so land
    // on the web app.
    const fallback = setTimeout(() => {
      if (!done) window.location.replace('/admin');
    }, 2500);
    return () => clearTimeout(fallback);
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '60vh', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            width: 48,
            height: 48,
            margin: '0 auto 16px',
            borderRadius: 12,
            background: '#5A27E0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
            <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </svg>
        </div>
        <p style={{ color: '#15101F', fontWeight: 600 }}>{msg}</p>
      </div>
    </div>
  );
}
