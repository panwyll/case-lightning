'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

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

interface Tpl { id: string; name: string; category: string; subjectTemplate: string | null; bodyTemplate: string; styleTag: string; attachDocTemplateIds?: string[]; isActive?: boolean }
interface DocTpl { id: string; name: string }

const STYLES = ['NEUTRAL', 'FIRM', 'CHASING'];
// The {{placeholders}} that fill from matter data (mirrors buildMatterVars).
const PLACEHOLDERS = ['matter_ref', 'property_address', 'buyer_names', 'seller_names', 'exchange_date', 'completion_date', 'counterparty_solicitor', 'counterparty_agent', 'lender', 'stage', 'firm_name', 'assigned_to', 'today'];
const SAMPLE: Record<string, string> = {
  matter_ref: 'SMI-OAK', property_address: '14 Oak Street, Leeds LS1 2AB', buyer_names: 'Mr & Mrs Smith', seller_names: 'Ms Jones',
  exchange_date: '19 Jul 2026', completion_date: '2 Aug 2026', counterparty_solicitor: 'Croft & Hargreaves', counterparty_agent: 'Hunters',
  lender: 'Santander', stage: 'searches & enquiries', firm_name: 'Your Firm LLP', assigned_to: 'Alex Fee-earner', today: '12 Jul 2026',
};
const fill = (s: string) => (s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => SAMPLE[k] ?? `{{${k}}}`);

export default function EmailTemplates() {
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [docTemplates, setDocTemplates] = useState<DocTpl[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ templates: Tpl[]; docTemplates: DocTpl[] }>('/admin/templates');
      setTemplates(r.templates ?? []);
      setDocTemplates(r.docTemplates ?? []);
    }
    catch (e: any) { setErr(e?.message || 'Could not load templates.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cur = templates.find((t) => t.id === sel) || null;
  const set = (patch: Partial<Tpl>) => setTemplates((ts) => ts.map((t) => t.id === sel ? { ...t, ...patch } : t));

  const save = async (t: Tpl) => {
    try {
      await api(`/admin/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ name: t.name, category: t.category, subjectTemplate: t.subjectTemplate ?? '', bodyTemplate: t.bodyTemplate, styleTag: t.styleTag, attachDocTemplateIds: t.attachDocTemplateIds ?? [] }) });
      setSaved(true); setTimeout(() => setSaved(false), 1200);
    } catch (e: any) { setErr(e?.message || 'Could not save.'); }
  };
  const create = async () => {
    try {
      const r = await api<{ template: Tpl }>('/admin/templates', { method: 'POST', body: JSON.stringify({ name: 'New template', category: 'General', subjectTemplate: '', bodyTemplate: 'Dear {{buyer_names}},\n\n\n\nKind regards\n{{firm_name}}', styleTag: 'NEUTRAL' }) });
      await load(); setSel(r.template.id);
    } catch (e: any) { setErr(e?.message || 'Could not create.'); }
  };
  const archive = async (t: Tpl) => {
    if (!window.confirm(`Archive "${t.name}"? It stops appearing in the drafter and workflow.`)) return;
    await api(`/admin/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) }).catch(() => {});
    setTemplates((ts) => ts.filter((x) => x.id !== t.id)); setSel(null);
  };
  const insertPlaceholder = (key: string) => {
    if (!cur) return;
    const ta = bodyRef.current;
    const token = `{{${key}}}`;
    if (ta) {
      const s = ta.selectionStart ?? cur.bodyTemplate.length;
      const next = cur.bodyTemplate.slice(0, s) + token + cur.bodyTemplate.slice(ta.selectionEnd ?? s);
      set({ bodyTemplate: next });
      requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + token.length; });
    } else { set({ bodyTemplate: cur.bodyTemplate + token }); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }}>
        <strong style={{ fontSize: 15, color: '#0f172a' }}>Email templates</strong>
        <span style={{ fontSize: 12.5, color: '#64748b', flex: 1 }}>Reusable emails the reply drafter and workflow send from. Insert <code>{'{{placeholders}}'}</code> that fill with each matter's data.</span>
        <button onClick={create} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>+ New template</button>
      </div>
      {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* List */}
        <div style={{ ...card, width: 220, flex: 'none', padding: 8 }}>
          {templates.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8', padding: 8 }}>No templates yet.</div>}
          {templates.map((t) => (
            <button key={t.id} onClick={() => setSel(t.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 9px', border: 'none', borderRadius: 8, background: sel === t.id ? '#F2EEFC' : 'transparent', cursor: 'pointer', marginBottom: 2 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{t.name}</div>
              <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{t.category} · {t.styleTag}</div>
            </button>
          ))}
        </div>

        {/* Editor */}
        {cur ? (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={card}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={cur.name} onChange={(e) => set({ name: e.target.value })} onBlur={() => save(cur)} placeholder="Name" style={{ ...input, fontWeight: 700, flex: 2 }} />
                <input value={cur.category} onChange={(e) => set({ category: e.target.value })} onBlur={() => save(cur)} placeholder="Category" style={{ ...input, flex: 1 }} />
                <select value={cur.styleTag} onChange={(e) => { set({ styleTag: e.target.value }); save({ ...cur, styleTag: e.target.value }); }} style={{ ...input, width: 120, flex: 'none' }}>
                  {STYLES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
                </select>
              </div>
              <label style={lbl}>Subject</label>
              <input value={cur.subjectTemplate ?? ''} onChange={(e) => set({ subjectTemplate: e.target.value })} onBlur={() => save(cur)} placeholder="e.g. {{matter_ref}} — update on your purchase" style={input} />
              <label style={lbl}>Body</label>
              <textarea ref={bodyRef} value={cur.bodyTemplate} onChange={(e) => set({ bodyTemplate: e.target.value })} onBlur={() => save(cur)} rows={12} style={{ ...input, fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical' }} />
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                <span style={{ fontSize: 11, color: '#94a3b8', marginRight: 4 }}>Insert:</span>
                {PLACEHOLDERS.map((k) => (
                  <button key={k} onClick={() => insertPlaceholder(k)} title={`Sample: ${SAMPLE[k]}`} style={{ fontSize: 10.5, fontFamily: 'ui-monospace, monospace', color: '#5A27E0', background: '#F2EEFC', border: '1px solid #ddd2f7', borderRadius: 6, padding: '2px 6px', cursor: 'pointer' }}>{`{{${k}}}`}</button>
                ))}
              </div>
              <label style={lbl}>Attach documents</label>
              {(() => {
                const ids = cur.attachDocTemplateIds ?? [];
                const setIds = (next: string[]) => { set({ attachDocTemplateIds: next }); save({ ...cur, attachDocTemplateIds: next }); };
                const available = docTemplates.filter((d) => !ids.includes(d.id));
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {ids.map((id) => {
                      const d = docTemplates.find((x) => x.id === id);
                      return (
                        <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, color: '#7c4a03', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 999, padding: '3px 6px 3px 9px' }}>
                          📎 {d?.name ?? 'document'}
                          <button onClick={() => setIds(ids.filter((x) => x !== id))} title="Remove" style={{ border: 'none', background: 'none', color: '#b45309', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                        </span>
                      );
                    })}
                    {available.length > 0 && (
                      <select value="" onChange={(e) => { if (e.target.value) setIds([...ids, e.target.value]); }} style={{ ...input, width: 'auto' }}>
                        <option value="">{ids.length ? '+ add another…' : '+ attach a document…'}</option>
                        {available.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    )}
                  </div>
                );
              })()}
              {(cur.attachDocTemplateIds?.length ?? 0) > 0
                ? <p style={{ fontSize: 10.5, color: '#b45309', margin: '6px 0 0' }}>📎 Generated from the matter and attached whenever this email sends. If the total is too large, the email is held as a draft and flagged rather than sent without them.</p>
                : docTemplates.length === 0 && <p style={{ fontSize: 10.5, color: '#94a3b8', margin: '6px 0 0' }}>No document templates yet — add one in Doc packs to attach it here.</p>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <button onClick={() => save(cur)} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>Save</button>
                {saved && <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✓ Saved</span>}
                <button onClick={() => archive(cur)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca', marginLeft: 'auto' }}>Archive</button>
              </div>
            </div>
            {/* Live preview with sample data */}
            <div style={{ ...card, background: '#fbfbfe' }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6 }}>Preview (sample matter)</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>{fill(cur.subjectTemplate || '(no subject)')}</div>
              <div style={{ fontSize: 13, color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{fill(cur.bodyTemplate)}</div>
            </div>
          </div>
        ) : (
          <div style={{ ...card, flex: 1, color: '#94a3b8', fontSize: 13 }}>Pick a template to edit, or create a new one.</div>
        )}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, margin: '10px 0 3px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
