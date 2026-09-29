'use client';
import { Spin } from './BusyButton';
import { useEffect, useMemo, useState } from 'react';
import type { Api, CaseDocument } from './types';

/**
 * Recording what a client decided, when it did not arrive by an email the system read.
 * Rare, so it asks only what the record needs: which client, how and when they said it,
 * their email if there is one, and what they said. Nothing else on the page.
 */
const DECISION_LABEL: Record<string, string> = {
  'physical_condition:satisfied': 'Satisfied with the property',
  'physical_condition:renegotiate': 'Wants to renegotiate',
  'physical_condition:further_investigation': 'Wants further checks first (a specialist, or a fuller survey)',
  'physical_condition:withdraw': 'Withdraws',
  'further_investigation:pursue': 'Wants their specialist in',
  'further_investigation:evidence': "Ask the seller for evidence",
  'further_investigation:waive': 'Leave it',
  'exchange_authority:authorised': 'Authorises exchange',
  'exchange_authority:not_yet': 'Not ready to exchange',
  'exchange_authority:withdrawn': 'Withdraws authority to exchange',
  'accept_risk:accepted': 'Accepts the risk',
  'accept_risk:declined': 'Declines the risk',
  'accept_terms:accepted': 'Accepts the terms',
  'accept_terms:declined': 'Declines the terms',
  'completion_date:agreed': 'Agrees the completion date',
  'completion_date:declined': 'Declines the completion date',
};
/** Outcomes that need the client's words on record (the others are a plain yes). */
const NEEDS_WORDS = new Set(['renegotiate', 'further_investigation', 'withdraw', 'waive', 'not_yet', 'withdrawn', 'declined', 'pursue']);

export function ClientDecisionSheet({ matterId, api, subject, decision, about = null, docs, busy, onSubmit, onCancel }: {
  /** What it is about, when it is one of several (a specialist the surveyor named). */
  about?: string | null;
  matterId: string;
  api: Api;
  subject: string;
  decision: string;
  docs: CaseDocument[] | null;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [clients, setClients] = useState<Array<{ name: string; email: string }> | null>(null);
  const [who, setWho] = useState('');
  const [other, setOther] = useState('');
  const [channel, setChannel] = useState('email');
  const [at, setAt] = useState(new Date().toISOString().slice(0, 10));
  const [emailId, setEmailId] = useState('');
  const [words, setWords] = useState('');

  useEffect(() => {
    api<{ contacts: Array<{ email: string; name: string | null; role: string }> }>(`/matters/${matterId}/contacts`)
      .then((r) => {
        const list = r.contacts.filter((c) => c.role === 'CLIENT').map((c) => ({ name: c.name || c.email, email: c.email }));
        setClients(list);
        if (list.length) setWho(list.length > 1 ? 'all' : list[0].name);
      })
      .catch(() => setClients([]));
  }, [api, matterId]);

  // The client's emails on the case, newest first, as who sent it and what it was about.
  const emails = useMemo(() => {
    const addresses = new Set((clients ?? []).map((c) => c.email.toLowerCase()));
    return (docs ?? [])
      .filter((d) => d.docType === 'EMAIL')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({ d, fromClient: !!d.emailFromAddress && addresses.has(d.emailFromAddress.toLowerCase()) }))
      .sort((a, b) => Number(b.fromClient) - Number(a.fromClient));
  }, [docs, clients]);

  const outcome = decision;
  const title = DECISION_LABEL[`${subject}:${decision}`] ?? `${subject.replace(/_/g, ' ')}: ${decision.replace(/_/g, ' ')}`;
  const person = who === 'other' ? other.trim() : who === 'all' ? (clients ?? []).map((c) => c.name).join(' and ') : who;
  const wordsNeeded = NEEDS_WORDS.has(outcome);
  const ready = !!person && (!wordsNeeded || !!words.trim());

  const submit = async () => {
    const said = words.trim();
    await onSubmit({
      note: [`${person} confirmed by ${channel} on ${at}`, said ? `"${said}"` : null].filter(Boolean).join('. '),
      ...(emailId ? { evidenceDocumentId: emailId } : {}),
      completion: { documentId: emailId || null, checklist: null, party: { who: person, channel, at }, note: said || null, readDocument: emailId ? true : null },
    });
  };

  const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <div className="cds" role="dialog" aria-label={`Record: ${title}`}>
      <style>{CSS}</style>
      <div className="cds-h">{title}{about ? <span className="cds-about"> · {about}</span> : null}</div>
      <label className="cds-row">
        <span>Client</span>
        <select className="ep-input" value={who} onChange={(e) => setWho(e.target.value)}>
          {clients === null && <option value="">Loading…</option>}
          {clients?.length === 0 && <option value="">Choose…</option>}
          {(clients?.length ?? 0) > 1 && <option value="all">All clients</option>}
          {clients?.map((c) => <option key={c.email} value={c.name}>{c.name}</option>)}
          <option value="other">Someone else…</option>
        </select>
      </label>
      {who === 'other' && <label className="cds-row"><span /><input className="ep-input" placeholder="Name" value={other} onChange={(e) => setOther(e.target.value)} /></label>}
      <label className="cds-row">
        <span>How</span>
        <span className="cds-pair">
          <select className="ep-input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {['email', 'phone', 'in person', 'letter'].map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
          </select>
          <input className="ep-input" type="date" value={at} onChange={(e) => setAt(e.target.value)} />
        </span>
      </label>
      {channel === 'email' && (
        <label className="cds-row">
          <span>Their email</span>
          <select className="ep-input" value={emailId} onChange={(e) => setEmailId(e.target.value)}>
            <option value="">{docs === null ? 'Loading…' : emails.length ? 'None' : 'No emails on the case'}</option>
            {emails.map(({ d }) => <option key={d.id} value={d.id}>{day(d.createdAt)} · {d.emailFrom ?? 'Unknown'} · {d.emailSubject ?? '(no subject)'}</option>)}
          </select>
        </label>
      )}
      <label className="cds-row">
        <span>What they said</span>
        <textarea className="ep-input" rows={2} value={words} onChange={(e) => setWords(e.target.value)} placeholder={wordsNeeded ? 'Required' : 'Optional'} />
      </label>
      <div className="cds-a">
        <button className="ep-btn primary" disabled={busy || !ready} onClick={() => void submit()}>{busy ? <Spin>Recording…</Spin> : 'Record'}</button>
        <button className="ep-btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const CSS = `
.cds{margin-top:10px;border:1px solid #c4b5fd;background:#fff;border-radius:12px;padding:16px 18px;width:min(520px,92vw)}
.cds-h{font-size:15px;font-weight:800;color:#0f172a;margin-bottom:12px}
.cds-about{font-weight:600;color:#475569}
.cds-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px;align-items:center;padding:5px 0;font-size:13px;color:#334155;font-weight:600}
.cds-row .ep-input{margin:0;width:100%;font-weight:400}
.cds-row textarea.ep-input{resize:vertical;font-family:inherit}
.cds-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cds-a{display:flex;gap:8px;margin-top:14px}
.cds-a .ep-btn{margin:0}
@media (max-width:560px){.cds-row{grid-template-columns:1fr}}
`;
