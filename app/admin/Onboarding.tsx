'use client';
import { useCallback, useEffect, useState } from 'react';
import MailboxScan from './MailboxScan';
import { APPSOURCE_URL } from '../_components/shared';

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('cl_token') : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

interface Step { key: string; title: string; detail: string; done: boolean }
interface Invite { id: string; email: string; role: string; status: string }
interface Status {
  firmName: string; isDefaultName: boolean; onboarded: boolean; dismissed: boolean;
  steps: Step[]; completed: number; total: number; invites: Invite[];
}

const PURPLE = '#5A27E0';

export default function Onboarding({ onNavigate, onChange }: { onNavigate?: (tab: string) => void; onChange?: (s: { completed: number; total: number; onboarded: boolean }) => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [firm, setFirm] = useState('');
  const [provisioned, setProvisioned] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('CONVEYANCER');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api<Status>('/admin/onboarding');
      setSt(s);
      setFirm((f) => (f ? f : s.isDefaultName ? '' : s.firmName));
      onChange?.({ completed: s.completed, total: s.total, onboarded: s.onboarded });
    } catch (e: any) { setErr(e?.message || 'Could not load onboarding.'); }
  }, [onChange]);
  useEffect(() => { void load(); }, [load]);

  const post = async (body: any, tag: string) => {
    setBusy(tag); setErr(null);
    try {
      const r = await api<{ status: Status; result?: any }>('/admin/onboarding', { method: 'POST', body: JSON.stringify(body) });
      if (r.status) { setSt((prev) => ({ ...(prev as Status), ...r.status, invites: prev?.invites ?? [] })); onChange?.({ completed: r.status.completed, total: r.status.total, onboarded: r.status.onboarded }); }
      return r;
    } catch (e: any) { setErr(e?.message || 'Something went wrong.'); return null; }
    finally { setBusy(null); }
  };

  const saveFirm = async () => { if (!firm.trim()) return; await post({ action: 'firm', firmName: firm.trim() }, 'firm'); setMsg('Firm name saved.'); };
  const provision = async () => {
    const r = await post({ action: 'provision' }, 'provision');
    if (r?.result) setProvisioned(`Added the conveyancing workflow, ${r.result.docTemplates} document template(s) and ${r.result.automations} automation(s).`);
  };
  const ackStep = (key: string) => post({ action: 'state', patch: { [key]: true } }, key);
  const goTo = (tab: string, key: string) => { void ackStep(key); onNavigate?.(tab); };
  const finish = async () => { await post({ action: 'complete' }, 'complete'); };
  const dismiss = async () => { await post({ action: 'state', patch: { dismissed: true } }, 'dismiss'); onChange?.({ completed: st?.completed ?? 0, total: st?.total ?? 0, onboarded: true }); };

  const sendInvite = async () => {
    if (!inviteEmail.trim()) return;
    setBusy('invite'); setErr(null); setMsg(null);
    try {
      await api('/admin/invites', { method: 'POST', body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }) });
      setInviteEmail(''); setMsg('Invite sent.');
      const inv = await api<{ invites: Invite[] }>('/admin/invites');
      setSt((prev) => (prev ? { ...prev, invites: inv.invites } : prev));
      await load();
    } catch (e: any) { setErr(e?.message || 'Could not send the invite.'); }
    finally { setBusy(null); }
  };
  const revoke = async (id: string) => {
    await api(`/admin/invites?id=${id}`, { method: 'DELETE' }).catch(() => {});
    setSt((prev) => (prev ? { ...prev, invites: prev.invites.filter((i) => i.id !== id) } : prev));
  };

  if (!st) return <div style={{ ...card, color: '#94a3b8', fontSize: 13 }}>{err || 'Loading…'}</div>;

  const pct = Math.round((st.completed / st.total) * 100);
  const stepOf = (k: string) => st.steps.find((s) => s.key === k)!;
  const pending = st.invites.filter((i) => i.status === 'PENDING');

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#0f172a' }}>Get your firm set up</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{st.completed} of {st.total} done</div>
        </div>
        <div style={{ width: 140 }}>
          <div style={{ height: 8, background: '#eef2f7', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: PURPLE, transition: 'width .3s' }} />
          </div>
        </div>
      </div>

      {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', fontSize: 13 }}>{err}</div>}
      {msg && <div style={{ ...card, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', fontSize: 13 }}>{msg}</div>}

      {/* 1. The mailbox scan — first, because it's the only step that shows the firm its
             own data. Importing matters ticks the step server-side (matterCount > 0). */}
      <StepCard step={stepOf('matter')} n={1}>
        <div style={{ marginTop: 8 }}>
          <MailboxScan onImported={() => { void load(); }} />
        </div>
      </StepCard>

      {/* 2. Firm name */}
      <StepCard step={stepOf('firm')} n={2}>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input value={firm} onChange={(e) => setFirm(e.target.value)} placeholder="e.g. Oakwood Property Law" style={{ ...input, flex: 1 }} />
          <button onClick={saveFirm} disabled={busy === 'firm' || !firm.trim()} style={primary}>{busy === 'firm' ? 'Saving…' : 'Save'}</button>
        </div>
      </StepCard>

      {/* 3. Workspace provisioning */}
      <StepCard step={stepOf('workspace')} n={3}>
        {stepOf('workspace').done && !provisioned ? (
          <div style={hint}>Your workflow, document templates and automations are ready. <button onClick={provision} disabled={busy === 'provision'} style={link}>Re-run setup</button></div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <button onClick={provision} disabled={busy === 'provision'} style={primary}>{busy === 'provision' ? 'Setting up…' : 'Set up my workspace'}</button>
            {provisioned && <div style={{ ...hint, marginTop: 8, color: '#065f46' }}>{provisioned}</div>}
          </div>
        )}
      </StepCard>

      {/* 4. Connect Outlook — the add-in install, walked through properly. The store
             listing can't give this much detail, and "find the button in Outlook" is
             where people were dropping out. */}
      <StepCard step={stepOf('outlook')} n={4}>
        {!stepOf('outlook').done && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={hint}>
              Everything above works here in the browser. The add-in puts it in Outlook, so replies
              are drafted against the email you’re actually reading.
            </div>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: '#334155', lineHeight: 1.65 }}>
              <li>
                Open the CONVEYi listing and choose <strong>Get it now</strong> — sign in with the
                same Microsoft account you used here.
              </li>
              <li>
                Open Outlook and click any email. The <strong>CONVEYi</strong> button appears on the
                ribbon, or under the <strong>…</strong> (More actions) menu at the top-right of the
                message.
              </li>
              <li>
                Click it to open the task pane, then <strong>pin</strong> it using the pin icon in
                the pane’s top-right corner so it stays open as you move between emails.
              </li>
            </ol>
            <div style={{ ...hint, color: '#64748b' }}>
              New add-ins can take a few minutes to appear in Outlook, and if your firm restricts
              them your IT administrator may need to approve it first.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a href={APPSOURCE_URL} target="_blank" rel="noopener noreferrer" style={primaryLink}>
                Open the CONVEYi listing →
              </a>
              <button onClick={() => ackStep('outlook')} style={link}>I’ve installed it</button>
            </div>
          </div>
        )}
      </StepCard>

      {/* 5. Case Flow */}
      <StepCard step={stepOf('caseflow')} n={5}>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => goTo('workflow', 'caseflow')} style={secondary}>Open Case Flow →</button>
        </div>
      </StepCard>

      {/* 6. Team invites */}
      <StepCard step={stepOf('team')} n={6}>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@yourfirm.co.uk" type="email" style={{ ...input, flex: 1, minWidth: 200 }} />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} style={{ ...input, width: 150 }}>
              <option value="CONVEYANCER">Conveyancer</option>
              <option value="ASSISTANT">Assistant</option>
              <option value="ADMIN">Administrator</option>
            </select>
            <button onClick={sendInvite} disabled={busy === 'invite' || !inviteEmail.trim()} style={primary}>{busy === 'invite' ? 'Sending…' : 'Send invite'}</button>
          </div>
          {pending.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {pending.map((i) => (
                <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 8, padding: '5px 10px' }}>
                  <span style={{ flex: 1 }}>{i.email} · {i.role.charAt(0) + i.role.slice(1).toLowerCase()} · <span style={{ color: '#b45309' }}>pending</span></span>
                  <button onClick={() => revoke(i.id)} style={link}>Revoke</button>
                </div>
              ))}
            </div>
          )}
          <div style={hint}>Colleagues sign in with their work Microsoft account. Adding seats beyond your own may need the Firm plan. <button onClick={() => ackStep('team')} style={link}>Skip for now</button></div>
        </div>
      </StepCard>

      {/* 7. Plan */}
      <StepCard step={stepOf('plan')} n={7}>
        {!stepOf('plan').done && (
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => goTo('billing', 'plan')} style={secondary}>Choose a plan →</button>
            <button onClick={() => ackStep('plan')} style={link}>I’ll decide later</button>
          </div>
        )}
      </StepCard>

      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, fontSize: 13, color: '#64748b' }}>
          {st.completed === st.total ? 'Everything’s set up — nice work.' : 'You can finish the rest any time; your progress is saved.'}
        </div>
        <button onClick={dismiss} style={link}>Hide</button>
        <button onClick={finish} style={{ ...primary, opacity: st.completed === st.total ? 1 : 0.85 }}>{busy === 'complete' ? 'Finishing…' : 'Finish setup'}</button>
      </div>
    </div>
  );
}

function StepCard({ step, n, children }: { step: Step; n: number; children: React.ReactNode }) {
  return (
    <div style={{ ...card, display: 'flex', gap: 12 }}>
      <div style={{
        flex: 'none', width: 26, height: 26, borderRadius: 99, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 800, color: step.done ? '#fff' : '#94a3b8',
        background: step.done ? '#16a34a' : '#f1f5f9', border: step.done ? 'none' : '1px solid #e2e8f0',
      }}>{step.done ? '✓' : n}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0f172a' }}>{step.title}</div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 1 }}>{step.detail}</div>
        {children}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 14 };
const input: React.CSSProperties = { boxSizing: 'border-box', fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
const primary: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '8px 14px', borderRadius: 8, border: 'none', background: PURPLE, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' };
const secondary: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const primaryLink: React.CSSProperties = { ...primary, display: 'inline-block', textDecoration: 'none' };
const link: React.CSSProperties = { fontSize: 12, fontWeight: 600, border: 'none', background: 'none', color: PURPLE, cursor: 'pointer', padding: 0 };
const hint: React.CSSProperties = { fontSize: 11.5, color: '#94a3b8', lineHeight: 1.5 };
