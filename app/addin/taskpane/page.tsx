'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Minimal Office.js typings (we only touch the mailbox item) ───────────────
declare global {
  interface Window {
    Office?: {
      onReady: (cb: (info: { host: string }) => void) => void;
      context?: { mailbox?: { item?: OfficeItem } };
    };
  }
}
interface OfficeItem {
  itemId?: string;
  conversationId?: string;
  subject?: string;
}

interface Me {
  email: string;
  displayName: string | null;
  role: string;
}
interface DraftPackage {
  subject: string;
  bodyHtml: string;
  why: string[];
  actions: Array<{ owner: string; task: string; due: string }>;
  referencedDocuments: Array<{ id: string; file_name: string; web_url: string | null }>;
}

const TONES = ['NEUTRAL', 'FIRM', 'CHASING'] as const;
type Tone = (typeof TONES)[number];

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

export default function Taskpane() {
  const [me, setMe] = useState<Me | null>(null);
  const [aiConnected, setAiConnected] = useState<boolean | null>(null);
  const [autoTriage, setAutoTriage] = useState<{ enabled: boolean; expiresAt: string | null } | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState<string>('');

  // Outlook thread context
  const [messageId, setMessageId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [subject, setSubject] = useState('');

  // Matter
  const [matterId, setMatterId] = useState('');
  const [matterInfo, setMatterInfo] = useState<any>(null);
  const [showNewMatter, setShowNewMatter] = useState(false);
  const [form, setForm] = useState({
    matterRef: '',
    propertyAddress: '',
    buyerNames: '',
    sellerNames: '',
    counterpartySolicitor: '',
    exchangeTargetDate: '',
    completionTargetDate: '',
  });

  // Triage / suggested match
  const [triage, setTriage] = useState<any>(null);
  const [riskOk, setRiskOk] = useState(false);

  // AI outputs
  const [summary, setSummary] = useState<{ happened: string[]; outstanding: string[] } | null>(null);
  const [tone, setTone] = useState<Tone>('NEUTRAL');
  const [draft, setDraft] = useState<DraftPackage | null>(null);
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');

  const officeReady = useRef(false);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch {
      setMe(null);
    }
    try {
      const k = await api<{ connected: boolean }>('/me/ai-key');
      setAiConnected(k.connected);
    } catch {
      setAiConnected(null);
    }
    try {
      setAutoTriage(await api<{ enabled: boolean; expiresAt: string | null }>('/graph/subscriptions'));
    } catch {
      setAutoTriage(null);
    }
  }, []);

  async function toggleAutoTriage() {
    await run(autoTriage?.enabled ? 'Disabling auto-triage' : 'Enabling auto-triage', async () => {
      await api('/graph/subscriptions', { method: autoTriage?.enabled ? 'DELETE' : 'POST' });
      setAutoTriage(await api('/graph/subscriptions'));
      setStatus(autoTriage?.enabled ? 'Auto-triage off.' : 'Auto-triage on — new inbox mail will be tagged & matched.');
    });
  }

  useEffect(() => {
    refreshMe();
    // Wait for Office.js then pull the current message context.
    const tryOffice = () => {
      if (window.Office && !officeReady.current) {
        officeReady.current = true;
        window.Office.onReady(() => {
          const item = window.Office?.context?.mailbox?.item;
          if (item?.itemId) setMessageId(item.itemId);
          if (item?.conversationId) setConversationId(item.conversationId);
          if (item?.subject) {
            setSubject(item.subject);
            setForm((f) => ({ ...f, matterRef: f.matterRef }));
          }
        });
      }
    };
    tryOffice();
    const t = setInterval(tryOffice, 400);
    return () => clearInterval(t);
  }, [refreshMe]);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setStatus('');
    try {
      const r = await fn();
      return r;
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const requireThread = () => {
    if (!conversationId) throw new Error('Open an email so CaseLightning can read the thread.');
  };
  const requireMatter = () => {
    if (!matterId) throw new Error('Link or create a matter first.');
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  async function createMatter() {
    await run('Creating matter', async () => {
      const body = {
        matterRef: form.matterRef || `AUTO-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 9000 + 1000)}`,
        propertyAddress: form.propertyAddress,
        buyerNames: form.buyerNames.split(';').map((s) => s.trim()).filter(Boolean),
        sellerNames: form.sellerNames.split(';').map((s) => s.trim()).filter(Boolean),
        counterpartySolicitor: form.counterpartySolicitor || undefined,
        exchangeTargetDate: form.exchangeTargetDate || undefined,
        completionTargetDate: form.completionTargetDate || undefined,
      };
      const created = await api<{ id: string; folderWebUrl: string | null; trackerWebUrl: string | null }>('/matters', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMatterId(created.id);
      setShowNewMatter(false);
      // Link the current thread automatically when one is open.
      if (conversationId) {
        await api(`/matters/${created.id}/link-thread`, {
          method: 'POST',
          body: JSON.stringify({ graphThreadId: conversationId, graphConversationId: conversationId, subject }),
        });
      }
      setStatus('Matter created — OneDrive folder + Tracker.xlsx provisioned.');
      await loadMatter(created.id);
    });
  }

  async function linkThread() {
    await run('Linking thread', async () => {
      requireMatter();
      requireThread();
      await api(`/matters/${matterId}/link-thread`, {
        method: 'POST',
        body: JSON.stringify({ graphThreadId: conversationId, graphConversationId: conversationId, subject }),
      });
      setStatus('Thread linked to matter.');
    });
  }

  async function loadMatter(id = matterId) {
    await run('Loading matter', async () => {
      if (!id) throw new Error('No matter id');
      setMatterInfo(await api(`/matters/${id}`));
    });
  }

  async function findMatter() {
    const r = await run('Finding matter', async () => {
      if (!messageId) throw new Error('Open an email first.');
      return api('/triage', { method: 'POST', body: JSON.stringify({ messageId, conversationId }) });
    });
    if (r) {
      setTriage(r);
      setRiskOk(false);
    }
  }

  async function useCandidate(c: any) {
    await run('Linking match', async () => {
      await api('/triage/apply', {
        method: 'POST',
        body: JSON.stringify({
          triageId: triage?.triageId,
          matterId: c.matterId,
          messageId,
          conversationId,
          band: c.band,
          riskAccepted: c.band === 'AUTO' ? true : riskOk,
        }),
      });
      setMatterId(c.matterId);
      setTriage(null);
      await loadMatter(c.matterId);
      setStatus(`Linked to ${c.matterRef}.`);
    });
  }

  async function summarise() {
    const r = await run('Summarising', async () => {
      requireMatter();
      requireThread();
      return api<{ happened: string[]; outstanding: string[] }>(`/threads/${encodeURIComponent(conversationId)}/summarise`, {
        method: 'POST',
        body: JSON.stringify({ matterId, conversationId }),
      });
    });
    if (r) setSummary(r);
  }

  async function extractFacts() {
    await run('Extracting facts', async () => {
      requireMatter();
      requireThread();
      await api(`/threads/${encodeURIComponent(conversationId)}/extract-facts`, {
        method: 'POST',
        body: JSON.stringify({ matterId, conversationId }),
      });
      setStatus('Facts extracted; matter summary + Excel tracker updated.');
      await loadMatter();
    });
  }

  async function saveToMatter() {
    await run('Saving to OneDrive', async () => {
      requireMatter();
      requireThread();
      if (!messageId) throw new Error('No message selected.');
      const r = await api<{ savedDocs: any[] }>(`/threads/${encodeURIComponent(conversationId)}/save-to-matter`, {
        method: 'POST',
        body: JSON.stringify({ matterId, messageId, includeAttachments: true }),
      });
      setStatus(`Saved ${r.savedDocs.length} file(s) to the matter's OneDrive folder.`);
    });
  }

  async function generateDraft() {
    const r = await run('Drafting reply', async () => {
      requireMatter();
      requireThread();
      if (!messageId) throw new Error('No message selected.');
      return api<DraftPackage>(`/threads/${encodeURIComponent(conversationId)}/draft-reply`, {
        method: 'POST',
        body: JSON.stringify({ matterId, messageId, conversationId, tone }),
      });
    });
    if (r) {
      setDraft(r);
      setDraftSubject(r.subject);
      setDraftBody(r.bodyHtml);
    }
  }

  async function createOutlookDraft() {
    await run('Creating Outlook draft', async () => {
      requireMatter();
      requireThread();
      const r = await api<{ draftId: string }>(`/threads/${encodeURIComponent(conversationId)}/create-draft`, {
        method: 'POST',
        body: JSON.stringify({ matterId, messageId, subject: draftSubject || undefined, bodyHtml: draftBody }),
      });
      setStatus(`Draft created in Outlook (never sent). Draft id: ${r.draftId}`);
    });
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={S.bolt}>⚡</span>
          <strong style={{ fontSize: 15 }}>CaseLightning</strong>
        </div>
        <span style={S.user}>{me ? `${me.displayName || me.email}` : 'Not connected'}</span>
      </header>

      {!me && (
        <Card>
          <p style={S.muted}>Connect your Microsoft 365 account to read the current thread and manage cases.</p>
          <button style={S.primary} onClick={() => (window.location.href = '/api/v1/auth/login')}>
            Connect Outlook
          </button>
        </Card>
      )}

      {me && (
        <>
          {/* Thread context */}
          <Card>
            <Label>Current thread</Label>
            <div style={S.threadSubject}>{subject || '— open an email —'}</div>
            <div style={S.rowWrap}>
              <Field label="Matter UUID" value={matterId} onChange={setMatterId} placeholder="paste or create" />
            </div>
            <div style={S.rowWrap}>
              <button style={S.secondary} onClick={findMatter} disabled={!messageId}>
                Find matter
              </button>
              <button style={S.secondary} onClick={() => setShowNewMatter((s) => !s)}>
                {showNewMatter ? 'Cancel' : 'New matter'}
              </button>
              <button style={S.secondary} onClick={linkThread} disabled={!matterId || !conversationId}>
                Link thread
              </button>
              <button style={S.secondary} onClick={() => loadMatter()} disabled={!matterId}>
                Refresh
              </button>
            </div>
          </Card>

          {triage && (
            <Card>
              <Label>Suggested match</Label>
              <div style={S.rowWrap}>
                <span style={S.chip}>{triage.classification?.intent}</span>
                <span style={{ ...S.chip, background: triage.classification?.needsAttention ? '#fee2e2' : '#dcfce7' }}>
                  {triage.classification?.needsAttention ? 'Needs attention' : 'No action needed'}
                </span>
                <span style={S.chip}>{triage.classification?.urgency}</span>
              </div>
              <p style={S.muted}>{triage.classification?.reason}</p>

              {(triage.candidates ?? []).length === 0 && (
                <p style={S.muted}>No candidate matters found from the thread. Create or link one manually.</p>
              )}

              {(triage.candidates ?? []).map((c: any) => {
                const pct = Math.round((c.score ?? 0) * 100);
                const auto = c.band === 'AUTO';
                return (
                  <div key={c.matterId} style={S.candidate}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: 13 }}>{c.matterRef}</strong>
                      <span style={{ ...S.confidence, background: auto ? '#dcfce7' : pct >= 60 ? '#fef9c3' : '#fee2e2' }}>
                        {pct}% · {c.band}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: '#475569' }}>{c.propertyAddress}</div>
                    <ul style={{ ...S.ul, fontSize: 11, color: '#64748b' }}>
                      {(c.signals ?? []).map((s: any, i: number) => (
                        <li key={i}>{s.detail}</li>
                      ))}
                    </ul>
                    {!auto && (
                      <label style={{ display: 'flex', gap: 6, fontSize: 11, color: '#b91c1c', margin: '4px 0' }}>
                        <input type="checkbox" checked={riskOk} onChange={(e) => setRiskOk(e.target.checked)} />
                        Below the high-confidence bar — I accept this is a subpar match.
                      </label>
                    )}
                    <button style={S.secondary} onClick={() => useCandidate(c)} disabled={!auto && !riskOk}>
                      Use this matter
                    </button>
                  </div>
                );
              })}
            </Card>
          )}

          {showNewMatter && (
            <Card>
              <Label>New matter</Label>
              <Field label="Matter ref (blank = auto)" value={form.matterRef} onChange={(v) => setForm({ ...form, matterRef: v })} />
              <Field label="Property address" value={form.propertyAddress} onChange={(v) => setForm({ ...form, propertyAddress: v })} />
              <Field label="Buyers (; separated)" value={form.buyerNames} onChange={(v) => setForm({ ...form, buyerNames: v })} />
              <Field label="Sellers (; separated)" value={form.sellerNames} onChange={(v) => setForm({ ...form, sellerNames: v })} />
              <Field label="Counterparty solicitor" value={form.counterpartySolicitor} onChange={(v) => setForm({ ...form, counterpartySolicitor: v })} />
              <div style={S.rowWrap}>
                <Field label="Exchange target" value={form.exchangeTargetDate} onChange={(v) => setForm({ ...form, exchangeTargetDate: v })} placeholder="YYYY-MM-DD" />
                <Field label="Completion target" value={form.completionTargetDate} onChange={(v) => setForm({ ...form, completionTargetDate: v })} placeholder="YYYY-MM-DD" />
              </div>
              <button style={S.primary} onClick={createMatter} disabled={!form.propertyAddress}>
                Create + provision OneDrive
              </button>
            </Card>
          )}

          {/* Quick actions */}
          <Card>
            <Label>Quick actions</Label>
            <div style={S.grid}>
              <button style={S.action} onClick={summarise} disabled={!matterId}>Summarise</button>
              <button style={S.action} onClick={extractFacts} disabled={!matterId}>Extract facts</button>
              <button style={S.action} onClick={saveToMatter} disabled={!matterId}>Save to matter</button>
              <button style={S.action} onClick={generateDraft} disabled={!matterId}>Draft reply</button>
            </div>
          </Card>

          {summary && (
            <Card>
              <Label>Summary</Label>
              <SubLabel>Happened</SubLabel>
              <ul style={S.ul}>{summary.happened.map((h, i) => <li key={i}>{h}</li>)}</ul>
              <SubLabel>Outstanding</SubLabel>
              <ul style={S.ul}>{summary.outstanding.map((o, i) => <li key={i}>{o}</li>)}</ul>
            </Card>
          )}

          {/* Draft workspace */}
          {draft && (
            <Card>
              <Label>Draft reply — never auto-sent</Label>
              <div style={S.rowWrap}>
                {TONES.map((t) => (
                  <button key={t} style={t === tone ? S.toneActive : S.tone} onClick={() => setTone(t)}>
                    {t}
                  </button>
                ))}
                <button style={S.secondary} onClick={generateDraft}>Regenerate</button>
              </div>
              <SubLabel>Subject</SubLabel>
              <input style={S.input} value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} />
              <SubLabel>Body</SubLabel>
              <textarea style={S.textarea} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={8} />
              {draft.why.length > 0 && (
                <>
                  <SubLabel>Why this draft</SubLabel>
                  <ul style={S.ul}>{draft.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </>
              )}
              {draft.actions.length > 0 && (
                <>
                  <SubLabel>Next actions</SubLabel>
                  <ul style={S.ul}>{draft.actions.map((a, i) => <li key={i}>{a.owner}: {a.task} ({a.due})</li>)}</ul>
                </>
              )}
              <button style={S.primary} onClick={createOutlookDraft}>Create Outlook draft</button>
            </Card>
          )}

          {/* Matter panel */}
          {matterInfo?.matter && (
            <Card>
              <Label>Matter {matterInfo.matter.matter_ref}</Label>
              <div style={S.kv}><span>Property</span><span>{matterInfo.matter.property_address}</span></div>
              {matterInfo.matter.folder_web_url && (
                <a style={S.link} href={matterInfo.matter.folder_web_url} target="_blank" rel="noreferrer">Open OneDrive folder →</a>
              )}
              {matterInfo.matter.tracker_web_url && (
                <a style={S.link} href={matterInfo.matter.tracker_web_url} target="_blank" rel="noreferrer">Open Excel tracker →</a>
              )}
              {(matterInfo.summary?.outstanding_items?.length ?? 0) > 0 && (
                <>
                  <SubLabel>Outstanding</SubLabel>
                  <ul style={S.ul}>{matterInfo.summary.outstanding_items.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul>
                </>
              )}
            </Card>
          )}

          {/* AI engine + auto-triage */}
          <Card>
            <Label>AI engine</Label>
            <p style={S.muted}>
              {aiConnected === null ? 'Status unknown.' : aiConnected ? 'Per-user key connected.' : 'Using the firm’s central Claude key.'}
            </p>
            <SubLabel>Auto-triage</SubLabel>
            <p style={S.muted}>
              {autoTriage?.enabled
                ? 'On — new inbox mail is auto-matched, tagged, and run through your firm’s auto-rules.'
                : 'Off — turn on to triage & tag incoming mail automatically (requires the deployed app).'}
            </p>
            <button style={autoTriage?.enabled ? S.secondary : S.primary} onClick={toggleAutoTriage}>
              {autoTriage?.enabled ? 'Turn off auto-triage' : 'Turn on auto-triage'}
            </button>
          </Card>
        </>
      )}

      {(busy || status) && (
        <div style={{ ...S.toast, ...(busy ? S.toastBusy : {}) }}>{busy ? `${busy}…` : status}</div>
      )}
      <footer style={S.footer}>Draft-only · matter-isolated · every action audited</footer>
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  return <section style={S.card}>{children}</section>;
}
function Label({ children }: { children: React.ReactNode }) {
  return <div style={S.label}>{children}</div>;
}
function SubLabel({ children }: { children: React.ReactNode }) {
  return <div style={S.subLabel}>{children}</div>;
}
function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block', flex: 1, minWidth: 120 }}>
      <span style={S.fieldLabel}>{label}</span>
      <input style={S.input} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// ── Inline styles (self-contained so the taskpane renders the same regardless
//    of the dark marketing theme on <body>) ──────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 480, margin: '0 auto', padding: 12, paddingBottom: 60 },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 4px 12px',
    borderBottom: '1px solid #e2e8f0',
    marginBottom: 12,
  },
  bolt: { color: '#ff2d78', fontSize: 18 },
  user: { fontSize: 12, color: '#64748b' },
  card: {
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    background: '#f8fafc',
  },
  label: { fontWeight: 700, fontSize: 13, marginBottom: 8, color: '#0f172a' },
  subLabel: { fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b', margin: '10px 0 4px' },
  fieldLabel: { display: 'block', fontSize: 11, color: '#64748b', marginBottom: 2 },
  muted: { fontSize: 12, color: '#64748b', margin: '0 0 10px' },
  threadSubject: { fontSize: 13, fontWeight: 600, marginBottom: 10, color: '#0f172a' },
  rowWrap: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  input: {
    width: '100%',
    padding: '7px 9px',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 6,
  },
  textarea: {
    width: '100%',
    padding: '8px 9px',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  primary: {
    width: '100%',
    padding: '9px 12px',
    background: '#ff2d78',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    marginTop: 4,
  },
  secondary: {
    padding: '7px 10px',
    background: '#fff',
    color: '#0f172a',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
  },
  action: {
    padding: '10px',
    background: '#0f172a',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  tone: { padding: '5px 10px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  toneActive: { padding: '5px 10px', background: '#00d4ff', border: '1px solid #00d4ff', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 700 },
  ul: { margin: '0 0 4px', paddingLeft: 18, fontSize: 13, lineHeight: 1.5 },
  chip: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#e2e8f0', color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.3 },
  candidate: { border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, marginBottom: 6, background: '#fff' },
  confidence: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, color: '#0f172a' },
  kv: { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: '#334155', gap: 12 },
  link: { display: 'block', fontSize: 12, color: '#0099bb', margin: '6px 0', textDecoration: 'none', fontWeight: 600 },
  toast: {
    position: 'fixed',
    left: 12,
    right: 12,
    bottom: 28,
    maxWidth: 456,
    margin: '0 auto',
    background: '#0f172a',
    color: '#fff',
    padding: '10px 12px',
    borderRadius: 8,
    fontSize: 12,
    boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
  },
  toastBusy: { background: '#0099bb' },
  footer: { position: 'fixed', left: 0, right: 0, bottom: 0, textAlign: 'center', fontSize: 10, color: '#94a3b8', padding: 6, background: '#fff', borderTop: '1px solid #e2e8f0' },
};
