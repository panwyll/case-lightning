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

// The email intents the classifier emits — an AUTO automation fires only for the
// intents it lists (empty = any).
const INTENTS: Array<[string, string]> = [
  ['STATUS_UPDATE', 'Status update'],
  ['ACTION_REQUIRED', 'Action required'],
  ['DOCUMENT_DELIVERY', 'Document delivery'],
  ['ENQUIRY', 'Enquiry'],
  ['CHASE', 'Chase'],
  ['ADMIN', 'Admin'],
  ['OTHER', 'Other'],
];

const STEP_LABEL: Record<string, string> = {
  CREATE_MATTER: 'Create matter (from the email)',
  GENERATE_DOCS: 'Generate documents',
  CREATE_TASK: 'Create a task',
  DRAFT_REPLY: 'Draft a reply',
  ARCHIVE_MATTER: 'Archive matter (close it)',
  DELEGATE: 'Delegate (assign + forward)',
  NOTIFY: 'Notify someone',
  TAG: 'Tag in Outlook',
  APPEND_TRACKER: 'Add a tracker row',
  ASSIGN: 'Assign the matter',
};
const STEP_TYPES = Object.keys(STEP_LABEL);

interface Step { type: string; config: Record<string, any> }
interface Automation {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: 'MANUAL' | 'AUTO';
  steps: Step[];
  intents: string[];
  min_confidence: number;
  require_no_attention: boolean;
  sender_domains: string[];
  match_stages: string[];
  risk_accepted: boolean;
  risk_acknowledgement: string | null;
}
interface Tpl { id: string; name: string }
interface DocTpl { id: string; name: string }
interface Member { id: string; display_name: string | null; email: string }
interface Stage { key: string; name: string }

const stepSends = (a: Automation) => a.trigger === 'AUTO' && a.steps.some((s) => s.type === 'DRAFT_REPLY' && s.config?.send === true);

export default function Automations() {
  const [items, setItems] = useState<Automation[]>([]);
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [docTemplates, setDocTemplates] = useState<DocTpl[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, t, d, u, s] = await Promise.all([
        api<{ automations: Automation[] }>('/admin/automations'),
        api<{ templates: Tpl[] }>('/admin/templates').catch(() => ({ templates: [] })),
        api<{ templates: DocTpl[] }>('/admin/doc-templates').catch(() => ({ templates: [] })),
        api<{ users: Member[] }>('/admin/users').catch(() => ({ users: [] })),
        api<{ stages: Stage[] }>('/stages').catch(() => ({ stages: [] })),
      ]);
      setItems(a.automations ?? []);
      setTemplates(t.templates ?? []);
      setDocTemplates(d.templates ?? []);
      setMembers(u.users ?? []);
      setStages((s.stages ?? []).filter((x: any) => x.active ?? true));
    } catch (e: any) { setErr(e?.message || 'Could not load automations.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = (id: string, patch: Partial<Automation>) => setItems((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const setSteps = (id: string, steps: Step[]) => set(id, { steps });
  const addStep = (a: Automation, type: string) => setSteps(a.id, [...a.steps, { type, config: {} }]);
  const setStepConfig = (a: Automation, i: number, config: any) => setSteps(a.id, a.steps.map((s, j) => (j === i ? { ...s, config } : s)));
  const removeStep = (a: Automation, i: number) => setSteps(a.id, a.steps.filter((_, j) => j !== i));
  const moveStep = (a: Automation, i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= a.steps.length) return;
    const next = [...a.steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(a.id, next);
  };

  const save = async (a: Automation) => {
    setErr(null);
    try {
      await api(`/admin/automations/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: a.name, description: a.description, enabled: a.enabled, trigger: a.trigger, steps: a.steps,
          intents: a.intents, minConfidence: a.min_confidence, requireNoAttention: a.require_no_attention,
          senderDomains: a.sender_domains, matchStages: a.match_stages,
          riskAccepted: a.risk_accepted, riskAcknowledgement: a.risk_acknowledgement || undefined,
        }),
      });
      setSavedId(a.id); setTimeout(() => setSavedId(null), 1400);
      void load();
    } catch (e: any) { setErr(e?.message || 'Could not save the automation.'); }
  };
  const toggle = async (a: Automation, next: boolean) => {
    setErr(null);
    if (next && stepSends(a) && !(a.risk_accepted && a.risk_acknowledgement)) {
      setOpen(a.id);
      setErr('This automation auto-sends — open it and accept the risk acknowledgement before enabling.');
      return;
    }
    set(a.id, { enabled: next });
    try {
      await api(`/admin/automations/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify(next && stepSends(a)
          ? { enabled: true, riskAccepted: a.risk_accepted, riskAcknowledgement: a.risk_acknowledgement }
          : { enabled: next }),
      });
    } catch (e: any) { set(a.id, { enabled: !next }); setErr(e?.message || 'Could not change the automation.'); }
  };
  const create = async (trigger: 'MANUAL' | 'AUTO') => {
    try {
      const r = await api<{ id: string }>('/admin/automations', { method: 'POST', body: JSON.stringify({ name: trigger === 'AUTO' ? 'New automatic rule' : 'New automation', enabled: false, trigger }) });
      await load();
      setOpen(r.id);
    } catch (e: any) { setErr(e?.message || 'Could not create an automation.'); }
  };
  const loadExamples = async () => {
    setErr(null);
    try { await api('/admin/automations/examples', { method: 'POST' }); await load(); }
    catch (e: any) { setErr(e?.message || 'Could not load examples.'); }
  };
  const remove = async (a: Automation) => {
    if (!window.confirm(`Delete "${a.name}"? This can't be undone.`)) return;
    setItems((rs) => rs.filter((x) => x.id !== a.id));
    await api(`/admin/automations/${a.id}`, { method: 'DELETE' }).catch(() => {});
  };

  const summary = (a: Automation) => {
    if (a.trigger === 'MANUAL') return `Run by hand · ${a.steps.length} step${a.steps.length === 1 ? '' : 's'}`;
    const bits = [
      'Automatic',
      a.intents.length ? a.intents.map((i) => INTENTS.find((x) => x[0] === i)?.[1] ?? i).join(', ') : 'any email',
      `≥${Math.round(a.min_confidence * 100)}% match`,
      a.match_stages.length ? `in ${a.match_stages.map((k) => stages.find((s) => s.key === k)?.name ?? k).join('/')}` : null,
      stepSends(a) ? 'auto-sends' : null,
    ].filter(Boolean);
    return bits.join(' · ');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15, color: '#0f172a', flex: 1 }}>Automations</strong>
        <button onClick={() => create('MANUAL')} style={{ ...btn }}>+ Manual</button>
        <button onClick={() => create('AUTO')} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>+ Automatic</button>
      </div>
      {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}
      {items.length === 0 && (
        <div style={{ ...card, color: '#94a3b8', fontSize: 13, display: 'flex', gap: 10, alignItems: 'center' }}>
          No automations yet. <button onClick={loadExamples} style={{ ...btn, padding: '4px 10px' }}>Load examples</button>
        </div>
      )}

      {items.map((a) => {
        const isOpen = open === a.id;
        const sends = stepSends(a);
        return (
          <div key={a.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => toggle(a, !a.enabled)}
                title={a.enabled ? 'Enabled — click to turn off' : 'Disabled — click to turn on'}
                style={{ flex: 'none', width: 40, height: 23, borderRadius: 999, border: 'none', cursor: 'pointer', background: a.enabled ? '#16a34a' : '#cbd5e1', position: 'relative' }}
              >
                <span style={{ position: 'absolute', top: 3, left: a.enabled ? 20 : 3, width: 17, height: 17, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
              </button>
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : a.id)}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {a.name}
                  <span style={{ fontSize: 10, fontWeight: 800, color: a.trigger === 'AUTO' ? '#5A27E0' : '#475569', background: a.trigger === 'AUTO' ? '#ede9fe' : '#f1f5f9', borderRadius: 999, padding: '1px 7px' }}>{a.trigger === 'AUTO' ? 'AUTOMATIC' : 'MANUAL'}</span>
                  {sends && <span style={{ fontSize: 10, fontWeight: 800, color: a.risk_accepted ? '#166534' : '#b91c1c', background: a.risk_accepted ? '#dcfce7' : '#fee2e2', borderRadius: 999, padding: '1px 7px' }}>{a.risk_accepted ? 'AUTO-SENDS' : 'SENDS · risk not accepted'}</span>}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>{summary(a)}</div>
              </div>
              <button onClick={() => setOpen(isOpen ? null : a.id)} style={{ ...btn, padding: '4px 10px' }}>{isOpen ? 'Close' : 'Edit'}</button>
            </div>

            {isOpen && (
              <div style={{ marginTop: 12, borderTop: '1px solid #eef2f7', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <input value={a.name} onChange={(e) => set(a.id, { name: e.target.value })} placeholder="Name" style={{ ...input, fontWeight: 700 }} />

                {/* Trigger */}
                <div>
                  <div style={sect}>Trigger</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['MANUAL', 'AUTO'] as const).map((tg) => (
                      <button key={tg} onClick={() => set(a.id, { trigger: tg })}
                        style={{ fontSize: 12.5, fontWeight: 700, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid ' + (a.trigger === tg ? '#5A27E0' : '#d0d5dd'), background: a.trigger === tg ? '#5A27E0' : '#fff', color: a.trigger === tg ? '#fff' : '#475569' }}>
                        {tg === 'AUTO' ? 'Automatic (on a matching email)' : 'Manual (I run it)'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Conditions — AUTO only */}
                {a.trigger === 'AUTO' && (
                  <div>
                    <div style={sect}>When an email matches</div>
                    <label style={lbl}>Intents <span style={{ color: '#94a3b8', fontWeight: 400 }}>(none = any)</span></label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {INTENTS.map(([v, l]) => {
                        const on = a.intents.includes(v);
                        return (
                          <button key={v} onClick={() => set(a.id, { intents: on ? a.intents.filter((x) => x !== v) : [...a.intents, v] })}
                            style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, cursor: 'pointer', border: '1px solid ' + (on ? '#5A27E0' : '#d0d5dd'), background: on ? '#5A27E0' : '#fff', color: on ? '#fff' : '#475569' }}>{l}</button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                      <label style={{ ...lbl, margin: 0 }}>Min confidence: <strong style={{ color: '#5A27E0' }}>{Math.round(a.min_confidence * 100)}%</strong></label>
                      <input type="range" min={0.5} max={1} step={0.01} value={a.min_confidence} onChange={(e) => set(a.id, { min_confidence: Number(e.target.value) })} style={{ flex: 1, minWidth: 140, accentColor: '#5A27E0' }} />
                    </div>
                    <label style={{ display: 'flex', gap: 7, fontSize: 13, color: '#334155', marginTop: 8 }}>
                      <input type="checkbox" checked={a.require_no_attention} onChange={(e) => set(a.id, { require_no_attention: e.target.checked })} />
                      Only when the email needs no conveyancer attention
                    </label>
                    <label style={lbl}>Sender domains <span style={{ color: '#94a3b8', fontWeight: 400 }}>(optional allowlist, comma-separated)</span></label>
                    <input value={a.sender_domains.join(', ')} onChange={(e) => set(a.id, { sender_domains: e.target.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) })} placeholder="e.g. hunters.com, santander.co.uk" style={input} />
                    {stages.length > 0 && (
                      <>
                        <label style={lbl}>Matter stage <span style={{ color: '#94a3b8', fontWeight: 400 }}>(none = any stage)</span></label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          {stages.map((s) => {
                            const on = a.match_stages.includes(s.key);
                            return (
                              <button key={s.key} onClick={() => set(a.id, { match_stages: on ? a.match_stages.filter((x) => x !== s.key) : [...a.match_stages, s.key] })}
                                style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, cursor: 'pointer', border: '1px solid ' + (on ? '#5A27E0' : '#d0d5dd'), background: on ? '#5A27E0' : '#fff', color: on ? '#fff' : '#475569' }}>{s.name}</button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Steps */}
                <div>
                  <div style={sect}>{a.trigger === 'AUTO' ? 'Then, automatically' : 'Steps (run in order)'}</div>
                  {a.steps.map((s, i) => (
                    <div key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 8, background: '#fff' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <strong style={{ fontSize: 13 }}>{i + 1}. {STEP_LABEL[s.type] ?? s.type}</strong>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button style={miniBtn} onClick={() => moveStep(a, i, -1)}>↑</button>
                          <button style={miniBtn} onClick={() => moveStep(a, i, 1)}>↓</button>
                          <button style={{ ...miniBtn, border: '1px solid #fecaca', color: '#b91c1c' }} onClick={() => removeStep(a, i)}>✕</button>
                        </div>
                      </div>
                      {s.type === 'DRAFT_REPLY' && (
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <select style={{ ...input, marginBottom: 0, width: 160, flex: 'none' }} value={s.config.tone ?? 'NEUTRAL'} onChange={(e) => setStepConfig(a, i, { ...s.config, tone: e.target.value })}>
                              <option value="NEUTRAL">Neutral tone</option>
                              <option value="FIRM">Firm tone</option>
                              <option value="CHASING">Chasing tone</option>
                            </select>
                            <select style={{ ...input, marginBottom: 0, flex: 1, minWidth: 150 }} value={s.config.templateId ?? ''} onChange={(e) => setStepConfig(a, i, { ...s.config, templateId: e.target.value || undefined })}>
                              <option value="">AI-drafted (no template)</option>
                              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          </div>
                          {a.trigger === 'AUTO' && (
                            <label style={{ display: 'flex', gap: 7, fontSize: 12.5, color: '#334155' }}>
                              <input type="checkbox" checked={!!s.config.send} onChange={(e) => setStepConfig(a, i, { ...s.config, send: e.target.checked })} />
                              Send it automatically (otherwise just draft it)
                            </label>
                          )}
                        </div>
                      )}
                      {s.type === 'CREATE_TASK' && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <input style={{ ...input, marginBottom: 0, flex: 2 }} placeholder="Task detail" value={s.config.detail ?? ''} onChange={(e) => setStepConfig(a, i, { ...s.config, detail: e.target.value })} />
                          <input style={{ ...input, marginBottom: 0, flex: 1 }} type="number" placeholder="Due in N days" value={s.config.dueOffsetDays ?? ''} onChange={(e) => setStepConfig(a, i, { ...s.config, dueOffsetDays: e.target.value })} />
                        </div>
                      )}
                      {s.type === 'GENERATE_DOCS' && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Templates to generate:</div>
                          {docTemplates.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>No templates yet — add some in Doc packs first.</div>}
                          {docTemplates.map((tpl) => {
                            const ids: string[] = s.config.templateIds ?? [];
                            const on = ids.includes(tpl.id);
                            return (
                              <label key={tpl.id} style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 2 }}>
                                <input type="checkbox" checked={on} onChange={(e) => setStepConfig(a, i, { ...s.config, templateIds: e.target.checked ? [...ids, tpl.id] : ids.filter((x) => x !== tpl.id) })} />
                                {tpl.name}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {s.type === 'TAG' && (
                        <input style={{ ...input, marginTop: 8, marginBottom: 0 }} placeholder="Category label (defaults to the matter ref)" value={s.config.label ?? ''} onChange={(e) => setStepConfig(a, i, { ...s.config, label: e.target.value })} />
                      )}
                      {s.type === 'ASSIGN' && (
                        <select style={{ ...input, marginTop: 8, marginBottom: 0 }} value={s.config.assigneeUserId ?? ''} onChange={(e) => setStepConfig(a, i, { ...s.config, assigneeUserId: e.target.value || undefined })}>
                          <option value="">Choose a person…</option>
                          {members.map((m) => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
                        </select>
                      )}
                      {s.type === 'CREATE_MATTER' && <div style={hint}>Provisions a matter from the email (no setup needed).</div>}
                      {s.type === 'ARCHIVE_MATTER' && <div style={hint}>Closes the matter so it drops off the live board.</div>}
                      {s.type === 'APPEND_TRACKER' && <div style={hint}>Adds a row to the matter’s Excel tracker.</div>}
                      {s.type === 'DELEGATE' && <div style={hint}>Assigns the matter and forwards the email. {a.trigger === 'AUTO' ? 'Set a recipient in the note if unattended.' : 'You pick the person when you run it.'}</div>}
                      {s.type === 'NOTIFY' && <div style={hint}>Drafts an update email. {a.trigger === 'AUTO' ? '' : 'You choose the recipient when you run it.'}</div>}
                    </div>
                  ))}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0' }}>
                    {STEP_TYPES.map((tp) => (
                      <button key={tp} style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 7, background: '#f8fafc', fontSize: 12, fontWeight: 600, cursor: 'pointer' }} onClick={() => addStep(a, tp)}>+ {STEP_LABEL[tp]}</button>
                    ))}
                  </div>
                </div>

                {/* Risk ack — an AUTO automation with a sending step */}
                {sends && (
                  <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca' }}>
                    <strong style={{ color: '#991b1b' }}>Risk acknowledgement required to enable.</strong>
                    <p style={{ fontSize: 12, color: '#7f1d1d', margin: '4px 0 8px' }}>This automation sends emails to clients/counterparties with no human review (on the cancellable send delay). You accept full professional responsibility (SRA, GDPR) for what it sends.</p>
                    <textarea value={a.risk_acknowledgement ?? ''} onChange={(e) => set(a.id, { risk_acknowledgement: e.target.value })} placeholder="Type your acknowledgement, e.g. 'I accept responsibility for auto-sent status acknowledgements on this automation'" style={{ ...input, minHeight: 56 }} />
                    <label style={{ display: 'flex', gap: 7, fontSize: 13, fontWeight: 600, color: '#7f1d1d', marginTop: 6 }}>
                      <input type="checkbox" checked={a.risk_accepted} onChange={(e) => set(a.id, { risk_accepted: e.target.checked })} />
                      I accept these risks and authorise auto-sending for this automation.
                    </label>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => save(a)} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>Save</button>
                  {savedId === a.id && <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700 }}>✓ Saved</span>}
                  <button onClick={() => remove(a)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca', marginLeft: 'auto' }}>Delete</button>
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
const miniBtn: React.CSSProperties = { padding: '2px 7px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' };
const input: React.CSSProperties = { boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a', width: '100%' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, color: '#64748b', margin: '10px 0 4px' };
const sect: React.CSSProperties = { fontSize: 10.5, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 };
const hint: React.CSSProperties = { fontSize: 12, color: '#64748b', marginTop: 6 };
