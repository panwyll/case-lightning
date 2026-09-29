'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Search } from '@/app/shared/icons';
import { BusyButton } from '@/app/shared/engine/BusyButton';
import { CaseSearch, type CaseHit } from '@/app/shared/engine/CaseSearch';

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
  // A write can raise or clear a task: the sidebar number re-reads.
  if ((options.method ?? 'GET').toUpperCase() !== 'GET' && typeof window !== 'undefined') window.dispatchEvent(new Event('conveyi:counts'));
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
/** "exchanged__sale" reads "Exchanged · Sale". */
const engineName = (k: string) => { const [base, kind] = k.split('__'); const n = base.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()); return kind ? `${n} · ${kind === 'transfer' ? 'Transfer Of Equity' : kind.replace(/^./, (c) => c.toUpperCase())}` : n; };
type Info = { when: string; to: string; kind?: string; requires: string[]; vars: string[] };
/** The top tabs: who a template goes to; the firm's own templates last. */
const TABS = ['All', 'Client', 'Solicitors', 'Lender', 'Others', "Firm's Own"] as const;
type Tab = (typeof TABS)[number];
const tabOf = (t: Tpl, info: Info | undefined): Exclude<Tab, 'All'> => {
  if (t.category !== 'Engine') return "Firm's Own";
  const to = info?.to ?? '';
  if (/^client/i.test(to)) return 'Client';
  if (/solicitor/i.test(to)) return 'Solicitors';
  if (/^lender/i.test(to)) return 'Lender';
  return 'Others';
};
const SECTION_ORDER = ['Updates', 'Chasers', 'Acknowledgements', 'Notices'];
const fill = (s: string) => (s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => SAMPLE[k] ?? `{{${k}}}`);

export default function EmailTemplates() {
  const [templates, setTemplates] = useState<Tpl[] | null>(null);
  const [tab, setTab] = useState<Tab>('All');
  const [q, setQ] = useState('');
  const [docTemplates, setDocTemplates] = useState<DocTpl[]>([]);
  const [engine, setEngine] = useState<Record<string, Info>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Preview against a real case: the words as they stand in the editor, filled from that case.
  const [previewCase, setPreviewCase] = useState<CaseHit | null>(null);
  const [live, setLive] = useState<{ subject: string; body: string } | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ templates: Tpl[]; docTemplates: DocTpl[]; engine?: Record<string, Info> }>('/admin/templates');
      setTemplates(r.templates ?? []);
      setDocTemplates(r.docTemplates ?? []);
      setEngine(r.engine ?? {});
      // Opened from an envelope on the flowchart (?t=<template key>): that template, selected.
      const want = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('t') : null;
      const hit = want ? (r.templates ?? []).find((t) => t.name === want) : null;
      if (hit) setSel(hit.id);
    }
    catch (e: any) { setErr(e?.message || 'Could not load templates.'); setTemplates((cur) => cur ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cur = (templates ?? []).find((t) => t.id === sel) || null;
  const label = (t: Tpl) => (t.category === 'Engine' ? engineName(t.name) : t.name);
  const counts = useMemo(() => { const c: Record<string, number> = { All: templates?.length ?? 0 }; for (const t of templates ?? []) { const k = tabOf(t, engine[t.name]); c[k] = (c[k] ?? 0) + 1; } return c; }, [templates, engine]);
  // The list: this tab, the words typed (name, when it sends, subject, body), in subsections.
  const sections = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const m = new Map<string, Tpl[]>();
    for (const t of templates ?? []) {
      const info = engine[t.name];
      if (tab !== 'All' && tabOf(t, info) !== tab) continue;
      const hay = `${label(t)} ${info?.when ?? ''} ${info?.to ?? ''} ${t.subjectTemplate ?? ''} ${t.bodyTemplate}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const sec = t.category === 'Engine' ? (info?.kind ?? 'Updates') : (t.category || 'General');
      m.set(sec, [...(m.get(sec) ?? []), t]);
    }
    const rank = (k: string) => { const i = SECTION_ORDER.indexOf(k); return i < 0 ? 99 : i; };
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([k, list]) => [k, list.sort((a, b) => label(a).localeCompare(label(b)))] as const);
  }, [templates, engine, tab, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLive(null); setLiveErr(null);
    if (!cur || !previewCase) return;
    const t = setTimeout(() => {
      api<{ subject: string; body: string }>('/admin/templates/preview', { method: 'POST', body: JSON.stringify({ matterId: previewCase.id, name: cur.name, engine: cur.category === 'Engine', subject: cur.subjectTemplate ?? '', body: cur.bodyTemplate }) })
        .then((r) => setLive(r)).catch((e: Error) => setLiveErr(e.message));
    }, 350);
    return () => clearTimeout(t);
  }, [cur?.id, cur?.subjectTemplate, cur?.bodyTemplate, previewCase?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<Tpl>) => setTemplates((ts) => (ts ?? []).map((t) => t.id === sel ? { ...t, ...patch } : t));

  const save = async (t: Tpl) => {
    try {
      const r = await api<{ template: Tpl }>(`/admin/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ name: t.name, category: t.category, subjectTemplate: t.subjectTemplate ?? '', bodyTemplate: t.bodyTemplate, styleTag: t.styleTag, attachDocTemplateIds: t.attachDocTemplateIds ?? [] }) });
      // The server may have de-duplicated the name (macOS-style _1); reflect what it stored.
      if (r?.template?.name && r.template.name !== t.name) setTemplates((ts) => (ts ?? []).map((x) => x.id === t.id ? { ...x, name: r.template.name } : x));
      return true;
    } catch (e: any) { setErr(e?.message || 'Could not save.'); return false; }
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
    setTemplates((ts) => (ts ?? []).filter((x) => x.id !== t.id)); setSel(null);
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 36, marginBottom: 2 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, lineHeight: 1.2, color: '#0f172a' }}>Email Templates</h1>
        <span style={{ flex: 1 }} />
        <button onClick={create} style={{ ...btn, height: 34, padding: '0 14px', fontSize: 13, fontWeight: 700, background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 9, display: 'inline-flex', alignItems: 'center' }}>New Template</button>
      </div>
      {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid #e8eaf0' }}>
        <div role="tablist" style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {TABS.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ border: 'none', background: 'none', padding: '8px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', color: tab === k ? '#5A27E0' : '#64748b', borderBottom: `2px solid ${tab === k ? '#5A27E0' : 'transparent'}`, marginBottom: -1, fontFamily: 'inherit' }}>
              {k}{templates ? <span style={{ marginLeft: 6, fontWeight: 600, color: '#94a3b8' }}>{counts[k] ?? 0}</span> : null}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative', marginLeft: 'auto', width: 260, maxWidth: '100%', marginBottom: 6 }}>
          <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', display: 'flex' }}><Search size={16} /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" aria-label="Search templates" style={{ ...input, paddingLeft: 32 }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* List */}
        <div style={{ ...card, width: 260, flex: 'none', padding: 8, maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' }}>
          {templates === null && <div style={{ fontSize: 12.5, color: '#94a3b8', padding: 8 }}>Loading…</div>}
          {templates !== null && sections.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8', padding: 8 }}>{templates.length === 0 ? 'No templates yet.' : 'No templates match.'}</div>}
          {sections.map(([sec, list]) => (<div key={sec} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 9px 4px' }}>{sec} <span style={{ fontWeight: 600 }}>{list.length}</span></div>
          {list.map((t) => (
            <button key={t.id} onClick={() => setSel(t.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 9px', border: 'none', borderRadius: 8, background: sel === t.id ? '#F2EEFC' : 'transparent', cursor: 'pointer', marginBottom: 2 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{label(t)}</div>
              <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{t.category === 'Engine' ? (engine[t.name]?.to ?? 'Engine') : t.category}</div>
            </button>
          ))}
          </div>))}
        </div>

        {/* Editor: the tools sit at the top right, above the fold; the preview is behind its button. */}
        {cur ? (() => {
          const ids = cur.attachDocTemplateIds ?? [];
          const setIds = (next: string[]) => { set({ attachDocTemplateIds: next }); void save({ ...cur, attachDocTemplateIds: next }); };
          const available = docTemplates.filter((d) => !ids.includes(d.id));
          const vars = cur.category === 'Engine' && engine[cur.name] ? engine[cur.name].vars : PLACEHOLDERS;
          const info = cur.category === 'Engine' ? engine[cur.name] : null;
          const has = (k: string) => cur.bodyTemplate.includes(`{{${k}}}`) || (cur.subjectTemplate ?? '').includes(`{{${k}}}`);
          return (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'calc(100vh - 240px)', overflowY: 'auto', paddingRight: 4 }}>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {cur.category === 'Engine'
                  ? <strong style={{ fontSize: 14, flex: 1, minWidth: 180 }}>{engineName(cur.name)}</strong>
                  : <span style={{ display: 'flex', gap: 8, flex: 1, minWidth: 260 }}>
                      <input value={cur.name} onChange={(e) => set({ name: e.target.value })} onBlur={() => void save(cur)} placeholder="Name" style={{ ...input, fontWeight: 700, flex: 2 }} />
                      <input value={cur.category} onChange={(e) => set({ category: e.target.value })} onBlur={() => void save(cur)} placeholder="Category" style={{ ...input, flex: 1 }} />
                    </span>}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
                  <select value="" aria-label="Insert a field" onChange={(e) => { if (e.target.value) insertPlaceholder(e.target.value); }} style={{ ...input, width: 'auto' }}>
                    <option value="">Insert…</option>
                    {vars.map((k) => <option key={k} value={k}>{`{{${k}}}`}{SAMPLE[k] ? ` · ${SAMPLE[k]}` : ''}</option>)}
                  </select>
                  <span style={{ position: 'relative' }}>
                    <button type="button" title="Attach a document" aria-label="Attach a document" disabled={!available.length && !ids.length} onClick={() => setAttachOpen((o) => !o)} style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 9px' }}><Paperclip size={16} />{ids.length ? ids.length : null}</button>
                    {attachOpen && (
                      <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.14)', padding: 4, minWidth: 240, display: 'grid' }}>
                        {available.length ? available.map((d) => <button key={d.id} type="button" onClick={() => { setIds([...ids, d.id]); setAttachOpen(false); }} style={{ textAlign: 'left', border: 0, background: 'none', padding: '7px 10px', borderRadius: 7, fontSize: 13, cursor: 'pointer' }}>{d.name}</button>) : <span style={{ padding: '7px 10px', fontSize: 12.5, color: '#94a3b8' }}>Every document is attached</span>}
                      </div>
                    )}
                  </span>
                  <button type="button" onClick={() => setPreviewOpen(true)} style={btn}>Preview</button>
                  <BusyButton className="" style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }} busyLabel="Saving…" doneLabel="Saved" onClick={() => save(cur)}>Save</BusyButton>
                  {cur.category !== 'Engine' && <button type="button" onClick={() => archive(cur)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca' }}>Archive</button>}
                </div>
              </div>
              {info && (
                <div style={{ fontSize: 12.5, color: '#475569', marginTop: 8, display: 'flex', gap: '4px 14px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span><b style={{ color: '#94a3b8', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', marginRight: 6 }}>Sent When</b>{info.when}</span>
                  <span><b style={{ color: '#94a3b8', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', marginRight: 6 }}>To</b>{info.to}</span>
                  {info.requires.length > 0 && <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}><b style={{ color: '#94a3b8', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', marginRight: 1 }}>Must Keep</b>{info.requires.map((k) => <code key={k} style={{ fontSize: 11, background: has(k) ? '#F2EEFC' : '#fee2e2', color: has(k) ? '#5A27E0' : '#b91c1c', borderRadius: 5, padding: '2px 6px' }}>{`{{${k}}}`}</code>)}</span>}
                </div>
              )}
              {ids.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {ids.map((id) => (
                    <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#334155', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 999, padding: '3px 4px 3px 10px' }}>
                      <Paperclip size={16} /> {docTemplates.find((x) => x.id === id)?.name ?? 'Document'}
                      <button type="button" onClick={() => setIds(ids.filter((x) => x !== id))} style={{ border: 0, background: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, padding: '0 6px' }}>Remove</button>
                    </span>
                  ))}
                </div>
              )}
              <label style={lbl}>Subject</label>
              <input value={cur.subjectTemplate ?? ''} onChange={(e) => set({ subjectTemplate: e.target.value })} onBlur={() => void save(cur)} placeholder="e.g. {{matter_ref}} — update on your purchase" style={input} />
              <label style={lbl}>Body</label>
              <textarea ref={bodyRef} value={cur.bodyTemplate} onChange={(e) => set({ bodyTemplate: e.target.value })} onBlur={() => void save(cur)} rows={18} style={{ ...input, fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical' }} />
            </div>
            {previewOpen && (
              <div role="dialog" aria-label="Preview" onMouseDown={(e) => { if (e.target === e.currentTarget) setPreviewOpen(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.38)', zIndex: 60, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '70px 16px 16px' }}>
                <div style={{ ...card, width: '100%', maxWidth: 720, maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', boxShadow: '0 24px 64px rgba(15,23,42,.24)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <strong style={{ fontSize: 14 }}>Preview</strong>
                    <div style={{ flex: 1, maxWidth: 360, marginLeft: 'auto' }}><CaseSearch api={api} value={previewCase} onChange={setPreviewCase} placeholder="Preview for a case" /></div>
                    <button type="button" onClick={() => setPreviewOpen(false)} style={btn}>Close</button>
                  </div>
                  {liveErr && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 6 }}>{liveErr}</div>}
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>{live ? live.subject || '(no subject)' : fill(cur.subjectTemplate || '(no subject)')}</div>
                  <div style={{ fontSize: 13, color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{live ? live.body : fill(cur.bodyTemplate)}</div>
                </div>
              </div>
            )}
          </div>
          );
        })() : (
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
