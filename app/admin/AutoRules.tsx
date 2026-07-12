'use client';
import { useCallback, useEffect, useState } from 'react';

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

// The email intents the classifier emits — a rule fires only for the intents it lists (empty = any).
const INTENTS: Array<[string, string]> = [
  ['STATUS_UPDATE', 'Status update'],
  ['ACTION_REQUIRED', 'Action required'],
  ['DOCUMENT_DELIVERY', 'Document delivery'],
  ['ENQUIRY', 'Enquiry'],
  ['CHASE', 'Chase'],
  ['ADMIN', 'Admin'],
  ['OTHER', 'Other'],
];

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  intents: string[];
  min_confidence: number;
  require_no_attention: boolean;
  sender_domains: string[];
  do_categorize: boolean;
  category_label: string | null;
  do_assign: boolean;
  assign_to: string | null;
  do_append_tracker: boolean;
  reply_mode: 'NONE' | 'DRAFT' | 'SEND';
  reply_template_id: string | null;
  risk_accepted: boolean;
  risk_acknowledgement: string | null;
}
interface Tpl { id: string; name: string }
interface Member { id: string; display_name: string | null; email: string }

export default function AutoRules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, t, u] = await Promise.all([
        api<{ rules: Rule[] }>('/admin/rules'),
        api<{ templates: Tpl[] }>('/admin/templates').catch(() => ({ templates: [] })),
        api<{ users: Member[] }>('/admin/users').catch(() => ({ users: [] })),
      ]);
      setRules(r.rules ?? []);
      setTemplates(t.templates ?? []);
      setMembers(u.users ?? []);
    } catch (e: any) { setErr(e?.message || 'Could not load rules.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = (id: string, patch: Partial<Rule>) => setRules((rs) => rs.map((r) => r.id === id ? { ...r, ...patch } : r));

  const save = async (r: Rule) => {
    setErr(null);
    try {
      await api(`/admin/rules/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: r.name, enabled: r.enabled, intents: r.intents, minConfidence: r.min_confidence,
          requireNoAttention: r.require_no_attention, senderDomains: r.sender_domains,
          doCategorize: r.do_categorize, categoryLabel: r.category_label || null,
          doAssign: r.do_assign, assignTo: r.assign_to || null, doAppendTracker: r.do_append_tracker,
          replyMode: r.reply_mode, replyTemplateId: r.reply_template_id || null,
          riskAccepted: r.risk_accepted, riskAcknowledgement: r.risk_acknowledgement || undefined,
        }),
      });
      setSavedId(r.id); setTimeout(() => setSavedId(null), 1400);
      void load();
    } catch (e: any) { setErr(e?.message || 'Could not save the rule.'); }
  };
  const toggle = async (r: Rule, next: boolean) => {
    setErr(null);
    if (next && r.reply_mode === 'SEND' && !(r.risk_accepted && r.risk_acknowledgement)) {
      setOpen(r.id);
      setErr('This is an auto-SEND rule — open it and accept the risk acknowledgement before enabling.');
      return;
    }
    set(r.id, { enabled: next });
    try {
      await api(`/admin/rules/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify(next && r.reply_mode === 'SEND'
          ? { enabled: true, replyMode: 'SEND', riskAccepted: r.risk_accepted, riskAcknowledgement: r.risk_acknowledgement }
          : { enabled: next }),
      });
    } catch (e: any) { set(r.id, { enabled: !next }); setErr(e?.message || 'Could not change the rule.'); }
  };
  const create = async () => {
    try {
      await api('/admin/rules', { method: 'POST', body: JSON.stringify({ name: 'New rule', enabled: false, replyMode: 'NONE' }) });
      await load();
      // Expand the newest (top of the list, ordered by created_at desc).
      setRules((rs) => { if (rs[0]) setOpen(rs[0].id); return rs; });
    } catch (e: any) { setErr(e?.message || 'Could not create a rule.'); }
  };
  const remove = async (r: Rule) => {
    if (!window.confirm(`Delete the rule "${r.name}"? This can't be undone.`)) return;
    setRules((rs) => rs.filter((x) => x.id !== r.id));
    await api(`/admin/rules/${r.id}`, { method: 'DELETE' }).catch(() => {});
  };

  const memberName = (id: string | null) => { const m = members.find((x) => x.id === id); return m ? (m.display_name || m.email) : 'Unassigned'; };
  const summary = (r: Rule) => {
    const bits = [
      r.intents.length ? r.intents.map((i) => INTENTS.find((x) => x[0] === i)?.[1] ?? i).join(', ') : 'any email',
      `≥${Math.round(r.min_confidence * 100)}% match`,
      r.reply_mode === 'SEND' ? 'auto-send' : r.reply_mode === 'DRAFT' ? 'auto-draft' : 'no reply',
    ];
    return bits.join(' · ');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ ...card, background: '#fffbeb', borderColor: '#fde68a' }}>
        <strong>Premium automation.</strong> Rules act only on <em>AUTO-band</em> matches (very high confidence, a firm-created link) and only when automation is enabled in Policy. An auto-<strong>SEND</strong> rule requires you to accept responsibility each time you enable it.
      </div>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }}>
        <strong style={{ fontSize: 15, color: '#0f172a', flex: 1 }}>Auto-rules</strong>
        <button onClick={create} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>+ New rule</button>
      </div>
      {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}
      {rules.length === 0 && <div style={{ ...card, color: '#94a3b8', fontSize: 13 }}>No rules yet. Create one to automate very-high-confidence emails.</div>}

      {rules.map((r) => {
        const isOpen = open === r.id;
        return (
          <div key={r.id} style={card}>
            {/* Header row: toggle · name · summary · expand */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => toggle(r, !r.enabled)}
                title={r.enabled ? 'Enabled — click to turn off' : 'Disabled — click to turn on'}
                style={{ flex: 'none', width: 40, height: 23, borderRadius: 999, border: 'none', cursor: 'pointer', background: r.enabled ? '#16a34a' : '#cbd5e1', position: 'relative' }}
              >
                <span style={{ position: 'absolute', top: 3, left: r.enabled ? 20 : 3, width: 17, height: 17, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
              </button>
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : r.id)}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{r.name}
                  {r.reply_mode === 'SEND' && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: r.risk_accepted ? '#166534' : '#b91c1c', background: r.risk_accepted ? '#dcfce7' : '#fee2e2', borderRadius: 999, padding: '1px 7px' }}>{r.risk_accepted ? 'AUTO-SEND' : 'SEND · risk not accepted'}</span>}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>{summary(r)}</div>
              </div>
              <button onClick={() => setOpen(isOpen ? null : r.id)} style={{ ...btn, padding: '4px 10px' }}>{isOpen ? 'Close' : 'Edit'}</button>
            </div>

            {isOpen && (
              <div style={{ marginTop: 12, borderTop: '1px solid #eef2f7', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <input value={r.name} onChange={(e) => set(r.id, { name: e.target.value })} placeholder="Rule name" style={{ ...input, fontWeight: 700 }} />

                {/* Conditions */}
                <div>
                  <div style={sect}>When an email matches</div>
                  <label style={lbl}>Intents <span style={{ color: '#94a3b8', fontWeight: 400 }}>(none = any)</span></label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {INTENTS.map(([v, l]) => {
                      const on = r.intents.includes(v);
                      return (
                        <button key={v} onClick={() => set(r.id, { intents: on ? r.intents.filter((x) => x !== v) : [...r.intents, v] })}
                          style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, cursor: 'pointer', border: '1px solid ' + (on ? '#5A27E0' : '#d0d5dd'), background: on ? '#5A27E0' : '#fff', color: on ? '#fff' : '#475569' }}>{l}</button>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                    <label style={{ ...lbl, margin: 0 }}>Min confidence: <strong style={{ color: '#5A27E0' }}>{Math.round(r.min_confidence * 100)}%</strong></label>
                    <input type="range" min={0.5} max={1} step={0.01} value={r.min_confidence} onChange={(e) => set(r.id, { min_confidence: Number(e.target.value) })} style={{ flex: 1, minWidth: 140, accentColor: '#5A27E0' }} />
                  </div>
                  <label style={{ display: 'flex', gap: 7, fontSize: 13, color: '#334155', marginTop: 8 }}>
                    <input type="checkbox" checked={r.require_no_attention} onChange={(e) => set(r.id, { require_no_attention: e.target.checked })} />
                    Only when the email needs no conveyancer attention
                  </label>
                  <label style={lbl}>Sender domains <span style={{ color: '#94a3b8', fontWeight: 400 }}>(optional allowlist, comma-separated)</span></label>
                  <input value={r.sender_domains.join(', ')} onChange={(e) => set(r.id, { sender_domains: e.target.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) })} placeholder="e.g. hunters.com, santander.co.uk" style={input} />
                </div>

                {/* Actions */}
                <div>
                  <div style={sect}>Then</div>
                  <label style={{ display: 'flex', gap: 7, fontSize: 13, color: '#334155', alignItems: 'center' }}>
                    <input type="checkbox" checked={r.do_categorize} onChange={(e) => set(r.id, { do_categorize: e.target.checked })} />
                    Tag it in Outlook
                    {r.do_categorize && <input value={r.category_label ?? ''} onChange={(e) => set(r.id, { category_label: e.target.value })} placeholder="label (defaults to the matter ref)" style={{ ...input, marginLeft: 8, flex: 1 }} />}
                  </label>
                  <label style={{ display: 'flex', gap: 7, fontSize: 13, color: '#334155', alignItems: 'center', marginTop: 8 }}>
                    <input type="checkbox" checked={r.do_assign} onChange={(e) => set(r.id, { do_assign: e.target.checked })} />
                    Assign the matter to
                    {r.do_assign && (
                      <select value={r.assign_to ?? ''} onChange={(e) => set(r.id, { assign_to: e.target.value || null })} style={{ ...input, marginLeft: 8, flex: 1 }}>
                        <option value="">Choose a person…</option>
                        {members.map((m) => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
                      </select>
                    )}
                  </label>
                  <label style={{ display: 'flex', gap: 7, fontSize: 13, color: '#334155', marginTop: 8 }}>
                    <input type="checkbox" checked={r.do_append_tracker} onChange={(e) => set(r.id, { do_append_tracker: e.target.checked })} />
                    Add a row to the matter’s Excel tracker
                  </label>

                  <label style={lbl}>Reply</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select value={r.reply_mode} onChange={(e) => set(r.id, { reply_mode: e.target.value as Rule['reply_mode'] })} style={{ ...input, width: 220, flex: 'none' }}>
                      <option value="NONE">No reply</option>
                      <option value="DRAFT">Auto-draft (never sends)</option>
                      <option value="SEND">Auto-SEND (sends automatically)</option>
                    </select>
                    {r.reply_mode !== 'NONE' && (
                      <select value={r.reply_template_id ?? ''} onChange={(e) => set(r.id, { reply_template_id: e.target.value || null })} style={{ ...input, flex: 1, minWidth: 160 }}>
                        <option value="">AI-drafted (no template)</option>
                        {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    )}
                  </div>

                  {r.reply_mode === 'SEND' && (
                    <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', marginTop: 10 }}>
                      <strong style={{ color: '#991b1b' }}>Risk acknowledgement required to enable.</strong>
                      <p style={{ fontSize: 12, color: '#7f1d1d', margin: '4px 0 8px' }}>This rule sends emails to clients/counterparties with no human review. You accept full professional responsibility (SRA, GDPR) for what it sends.</p>
                      <textarea value={r.risk_acknowledgement ?? ''} onChange={(e) => set(r.id, { risk_acknowledgement: e.target.value })} placeholder="Type your acknowledgement, e.g. 'I accept responsibility for auto-sent status acknowledgements on this rule'" style={{ ...input, minHeight: 56 }} />
                      <label style={{ display: 'flex', gap: 7, fontSize: 13, fontWeight: 600, color: '#7f1d1d', marginTop: 6 }}>
                        <input type="checkbox" checked={r.risk_accepted} onChange={(e) => set(r.id, { risk_accepted: e.target.checked })} />
                        I accept these risks and authorise auto-sending for this rule.
                      </label>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => save(r)} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>Save rule</button>
                  {savedId === r.id && <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700 }}>✓ Saved</span>}
                  <button onClick={() => remove(r)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca', marginLeft: 'auto' }}>Delete</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 14 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const input: React.CSSProperties = { boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a', width: '100%' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, color: '#64748b', margin: '10px 0 4px' };
const sect: React.CSSProperties = { fontSize: 10.5, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 };
