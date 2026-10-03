'use client';
import { useState } from 'react';
import { BusyButton } from './BusyButton';
import type { Api } from './types';

/** Who a failed send was for, read from its task title (the server sets the same on the Tasks list). */
export function addressFor(title: string): { role: string; who: string } | null {
  const t = title.toLowerCase();
  if (/(seller'?s?|buyer'?s?|other side'?s?) solicitor/.test(t)) return { role: 'OTHER_SIDE', who: /buyer/.test(t) ? "the buyer's solicitor" : "the seller's solicitor" };
  if (/family|personal representative/.test(t)) return { role: 'FAMILY', who: "the client's family" };
  if (/lender/.test(t)) return { role: 'LENDER', who: 'the lender' };
  if (/agent/.test(t)) return { role: 'AGENT', who: 'the estate agent' };
  if (/client/.test(t)) return { role: 'CLIENT', who: 'the client' };
  return null;
}

/**
 * A send that failed because there is no address for them: the address is typed here, saved to the
 * case's contacts under their role, and the same message goes — without a trip to the case.
 */
export function AddressAndSend({ api, matterId, issueId, need, onDone, onError, buttonClass = 'ep-btn primary', inputClass = 'ep-input' }: {
  api: Api; matterId: string; issueId: string; need: { role: string; who: string }; onDone: () => void; onError: (text: string) => void; buttonClass?: string; inputClass?: string;
}) {
  const [email, setEmail] = useState('');
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input className={inputClass} type="email" placeholder={`Email for ${need.who}`} value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 230, margin: 0 }} />
      <BusyButton className={buttonClass} disabled={!valid} busyLabel="Sending…" doneLabel="Sent" onClick={async () => {
        try {
          await api(`/matters/${matterId}/contacts`, { method: 'POST', body: JSON.stringify({ email: email.trim(), role: need.role }) });
          await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify({ type: 'retry_issue', issueId }) });
          setTimeout(onDone, 1500);
          return true;
        } catch (e: unknown) { onError(e instanceof Error ? e.message : 'It was unsuccessful.'); return false; }
      }}>Save And Send</BusyButton>
    </span>
  );
}
