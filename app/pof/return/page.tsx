'use client';
import { useEffect, useState } from 'react';

/**
 * Back from the bank. The form's own link is never sent to the bank or stored by us in the clear: this
 * browser kept it when the client left, and takes them straight back to their form. In another browser
 * (the bank's app opened a new one), the client is told to reopen the form from their email: the
 * connected account is already on it.
 */
export default function BankReturn() {
  const [lost, setLost] = useState<null | 'ok' | 'fail'>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const c = q.get('c') ?? '';
    let token: string | null = null;
    try { token = localStorage.getItem(`pof-return:${c}`); } catch { /* storage blocked */ }
    if (!token) { setLost(q.get('s') === 'ok' ? 'ok' : 'fail'); return; }
    const back = q.get('s') === 'ok' ? `connected=${encodeURIComponent(c)}` : `connectFailed=${encodeURIComponent(q.get('m') ?? 'The bank connection did not complete.')}`;
    window.location.replace(`/pof/${token}?${back}`);
  }, []);
  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif', background: '#f6f7fb', minHeight: '100vh', padding: '40px 16px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', background: '#fff', border: '1px solid #e6e8ee', borderRadius: 14, padding: 20, fontSize: 16, color: '#0f172a', lineHeight: 1.5 }}>
        {lost === 'ok' ? <>Your bank is connected. Please go back to your proof-of-funds form using the link in our email: the account is already attached there.</> : lost === 'fail' ? <>The bank connection did not complete. Please go back to your proof-of-funds form using the link in our email, and try again or upload statements instead.</> : <>Taking you back to your form…</>}
      </div>
    </div>
  );
}
