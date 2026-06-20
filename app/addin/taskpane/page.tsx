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
  from?: { emailAddress?: string; displayName?: string };
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

const TOKEN_KEY = 'cl_token';

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  // Bearer token (set after the sign-in dialog) covers desktop Outlook, where the
  // session cookie isn't shared with the taskpane. Cookie still works on the web.
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
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
  const [sender, setSender] = useState<{ name: string; email: string } | null>(null);
  const [form, setForm] = useState<{
    matterRef: string;
    propertyAddress: string;
    buyerNames: string[];
    sellerNames: string[];
    counterpartySolicitor: string;
    exchangeTargetDate: string;
    completionTargetDate: string;
  }>({
    matterRef: '',
    propertyAddress: '',
    buyerNames: [],
    sellerNames: [],
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

  // Documents & sharing
  const [docs, setDocs] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [attachmentIntent, setAttachmentIntent] = useState('');
  const [teamId, setTeamId] = useState('');
  const [channelId, setChannelId] = useState('');

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
          if (item?.subject) setSubject(item.subject);
          if (item?.from?.emailAddress) {
            setSender({ name: item.from.displayName || item.from.emailAddress, email: item.from.emailAddress });
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
    if (!conversationId) throw new Error('Open an email so CONVEYi can read the thread.');
  };
  const requireMatter = () => {
    if (!matterId) throw new Error('Link or create a matter first.');
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  // Sign-in must run in an Office dialog window — Microsoft's login refuses to be
  // iframed, so a redirect inside the taskpane fails with "refused to connect".
  function connect() {
    const Office = (window as any).Office;
    const origin = window.location.origin;
    if (Office?.context?.ui?.displayDialogAsync) {
      Office.context.ui.displayDialogAsync(
        `${origin}/api/v1/auth/login`,
        { height: 60, width: 30, displayInIframe: false },
        (result: any) => {
          if (result.status !== 'succeeded') {
            setStatus('Could not open the sign-in window. Allow pop-ups and try again.');
            return;
          }
          const dialog = result.value;
          dialog.addEventHandler(Office.EventType.DialogMessageReceived, async (arg: any) => {
            try {
              const data = JSON.parse(arg.message);
              if (data.token) window.localStorage.setItem(TOKEN_KEY, data.token);
            } catch {
              /* ignore malformed message */
            }
            dialog.close();
            await refreshMe();
            setStatus('Connected to Outlook.');
          });
          dialog.addEventHandler(Office.EventType.DialogEventReceived, () => refreshMe());
        }
      );
    } else {
      // Not in Office (e.g. testing in a plain browser tab) — top-level redirect.
      window.location.href = '/api/v1/auth/login';
    }
  }

  function cleanSubject(s: string) {
    return s.replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim();
  }

  // Open the New-matter form, pre-filling what we can read from the open email:
  // the property address from the subject, and the counterparty from the sender.
  function openNewMatter() {
    if (showNewMatter) {
      setShowNewMatter(false);
      return;
    }
    setForm((f) => ({
      ...f,
      propertyAddress: f.propertyAddress || cleanSubject(subject),
      counterpartySolicitor: f.counterpartySolicitor || (sender ? `${sender.name} <${sender.email}>` : ''),
    }));
    setShowNewMatter(true);
  }

  async function createMatter() {
    await run('Creating matter', async () => {
      const body = {
        matterRef: form.matterRef || `AUTO-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 9000 + 1000)}`,
        propertyAddress: form.propertyAddress,
        buyerNames: form.buyerNames,
        sellerNames: form.sellerNames,
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

  async function loadDocs() {
    await run('Loading documents', async () => {
      requireMatter();
      const r = await api<{ documents: any[] }>(`/matters/${matterId}/documents`);
      setDocs(r.documents);
    });
  }

  async function suggestAttachments() {
    const r = await run('Suggesting attachments', async () => {
      requireMatter();
      return api<{ suggestions: any[] }>(`/matters/${matterId}/documents/suggest-attachments`, {
        method: 'POST',
        body: JSON.stringify({ intent: attachmentIntent || 'respond to the current thread' }),
      });
    });
    if (r) setSuggestions(r.suggestions);
  }

  async function postToTeams() {
    await run('Posting to Teams', async () => {
      requireMatter();
      if (!teamId || !channelId) throw new Error('Team ID and Channel ID are required.');
      await api(`/matters/${matterId}/teams/post-summary`, {
        method: 'POST',
        body: JSON.stringify({ teamId, channelId }),
      });
      setStatus('Posted matter summary to Teams.');
    });
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#5A27E0" />
            <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </svg>
          <strong style={{ fontSize: 15 }}>
            CONVE<span style={{ color: '#5A27E0' }}>Yi</span>
          </strong>
        </div>
        <span style={S.user}>{me ? `${me.displayName || me.email}` : 'Not connected'}</span>
      </header>

      {!me && (
        <Card>
          <p style={S.muted}>Connect your Microsoft 365 account to read the current thread and manage cases.</p>
          <button style={S.primary} onClick={connect}>
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
            {matterInfo?.matter ? (
              <div style={S.linkedMatter}>
                <span>📁 {matterInfo.matter.matter_ref}</span>
                <button style={S.tagX} onClick={() => { setMatterId(''); setMatterInfo(null); }} title="Unlink">×</button>
              </div>
            ) : (
              <p style={S.muted}>No matter linked yet. Find a match, or create one.</p>
            )}
            <div style={S.rowWrap}>
              <button style={S.secondary} onClick={findMatter} disabled={!messageId}>
                Find matter
              </button>
              <button style={S.secondary} onClick={openNewMatter}>
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
              <Field label="Your reference (optional)" value={form.matterRef} onChange={(v) => setForm({ ...form, matterRef: v })} placeholder="auto-generated if left blank" />
              <Field label="Property address" value={form.propertyAddress} onChange={(v) => setForm({ ...form, propertyAddress: v })} placeholder="14 Oak Street, London SW1A 1AA" />
              <TagInput label="Buyers" values={form.buyerNames} onChange={(v) => setForm({ ...form, buyerNames: v })} placeholder="type a name, press Enter" />
              <TagInput label="Sellers" values={form.sellerNames} onChange={(v) => setForm({ ...form, sellerNames: v })} placeholder="type a name, press Enter" />
              <Field label="Counterparty (firm / email)" value={form.counterpartySolicitor} onChange={(v) => setForm({ ...form, counterpartySolicitor: v })} placeholder="prefilled from the email sender" />
              <div style={S.rowWrap}>
                <Field label="Exchange target" type="date" value={form.exchangeTargetDate} onChange={(v) => setForm({ ...form, exchangeTargetDate: v })} />
                <Field label="Completion target" type="date" value={form.completionTargetDate} onChange={(v) => setForm({ ...form, completionTargetDate: v })} />
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

          {/* Documents & sharing */}
          {matterId && (
            <Card>
              <Label>Documents &amp; sharing</Label>
              <div style={S.rowWrap}>
                <button style={S.secondary} onClick={loadDocs}>List documents</button>
                <button style={S.secondary} onClick={suggestAttachments}>Suggest attachments</button>
              </div>
              <input
                style={S.input}
                placeholder="What's the reply about? (improves suggestions)"
                value={attachmentIntent}
                onChange={(e) => setAttachmentIntent(e.target.value)}
              />
              {suggestions.length > 0 && (
                <>
                  <SubLabel>Suggested attachments</SubLabel>
                  <ul style={S.ul}>
                    {suggestions.map((s) => (
                      <li key={s.id}>
                        {s.web_url ? <a style={S.link} href={s.web_url} target="_blank" rel="noreferrer">{s.file_name}</a> : s.file_name}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {docs.length > 0 && (
                <>
                  <SubLabel>All documents</SubLabel>
                  <ul style={S.ul}>
                    {docs.map((d) => (
                      <li key={d.id}>
                        {d.web_url ? <a style={S.link} href={d.web_url} target="_blank" rel="noreferrer">{d.file_name}</a> : d.file_name}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <SubLabel>Post matter summary to Teams</SubLabel>
              <div style={S.rowWrap}>
                <Field label="Team ID" value={teamId} onChange={setTeamId} />
                <Field label="Channel ID" value={channelId} onChange={setChannelId} />
              </div>
              <button style={S.secondary} onClick={postToTeams} disabled={!teamId || !channelId}>
                Post to Teams
              </button>
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
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label style={{ display: 'block', flex: 1, minWidth: 120 }}>
      <span style={S.fieldLabel}>{label}</span>
      <input style={S.input} type={type ?? 'text'} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// Chip input: type a value and press Enter (or comma) to add it; multiple allowed.
function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = [...values];
    for (const p of raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      if (!next.includes(p)) next.push(p);
    }
    if (next.length !== values.length) onChange(next);
    setDraft('');
  };
  return (
    <label style={{ display: 'block', marginBottom: 6 }}>
      <span style={S.fieldLabel}>{label}</span>
      <div style={S.tagBox}>
        {values.map((v, i) => (
          <span key={i} style={S.tag}>
            {v}
            <button type="button" style={S.tagX} onClick={() => onChange(values.filter((_, j) => j !== i))} aria-label={`Remove ${v}`}>
              ×
            </button>
          </span>
        ))}
        <input
          style={S.tagInput}
          value={draft}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
        />
      </div>
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
  bolt: { color: '#5A27E0', fontSize: 18 },
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
  linkedMatter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    background: '#f1edfd',
    border: '1px solid #ddd6fe',
    borderRadius: 8,
    padding: '7px 10px',
    fontSize: 13,
    fontWeight: 600,
    color: '#4A1FBE',
    marginBottom: 8,
  },
  tagBox: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    alignItems: 'center',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    padding: 4,
    minHeight: 38,
    background: '#fff',
    marginBottom: 6,
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    background: '#ede9fb',
    color: '#4A1FBE',
    borderRadius: 999,
    padding: '2px 4px 2px 9px',
    fontSize: 12,
    fontWeight: 600,
  },
  tagX: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: '#7c6bb0', padding: '0 3px' },
  tagInput: { flex: 1, minWidth: 90, border: 'none', outline: 'none', padding: '4px 6px', fontSize: 13, background: 'transparent' },
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
    background: '#5A27E0',
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
  toneActive: { padding: '5px 10px', background: '#5A27E0', border: '1px solid #5A27E0', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 700 },
  ul: { margin: '0 0 4px', paddingLeft: 18, fontSize: 13, lineHeight: 1.5 },
  chip: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#e2e8f0', color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.3 },
  candidate: { border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, marginBottom: 6, background: '#fff' },
  confidence: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, color: '#0f172a' },
  kv: { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: '#334155', gap: 12 },
  link: { display: 'block', fontSize: 12, color: '#5A27E0', margin: '6px 0', textDecoration: 'none', fontWeight: 600 },
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
  toastBusy: { background: '#5A27E0' },
  footer: { position: 'fixed', left: 0, right: 0, bottom: 0, textAlign: 'center', fontSize: 10, color: '#94a3b8', padding: 6, background: '#fff', borderTop: '1px solid #e2e8f0' },
};
