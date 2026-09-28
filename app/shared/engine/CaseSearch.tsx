'use client';
/** Choose a case by searching its reference, address or client (the most recent first before anything is typed). */
import { useEffect, useRef, useState } from 'react';
import { Search, X } from '@/app/shared/icons';

export interface CaseHit { id: string; matterRef: string | null; propertyAddress: string | null }

export function CaseSearch({ api, value, onChange, placeholder = 'Choose a case' }: { api: <T>(path: string, init?: RequestInit) => Promise<T>; value: CaseHit | null; onChange: (c: CaseHit | null) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<CaseHit[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api<{ matters?: CaseHit[] }>(`/matters?status=open&limit=12&q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.matters ?? [])).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, api]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const label = (c: CaseHit) => [c.propertyAddress, c.matterRef].filter(Boolean).join(' · ');
  return (
    <div ref={box} style={{ position: 'relative', minWidth: 0 }}>
      {value && !open ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #d0d5dd', borderRadius: 8, padding: '6px 8px', background: '#fff', fontSize: 12.5 }}>
          <button type="button" onClick={() => setOpen(true)} style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'none', font: 'inherit', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#0f172a' }}>{label(value)}</button>
          <button type="button" aria-label="Clear" onClick={() => onChange(null)} style={{ border: 0, background: 'none', cursor: 'pointer', color: '#64748b', display: 'flex' }}><X size={16} /></button>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', display: 'flex' }}><Search size={16} /></span>
          <input autoFocus={open} value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} placeholder={placeholder} style={{ width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px 7px 30px', borderRadius: 8, border: '1px solid #d0d5dd' }} />
        </div>
      )}
      {open && (
        <div style={{ position: 'absolute', zIndex: 30, top: 'calc(100% + 4px)', left: 0, right: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.14)', maxHeight: 260, overflowY: 'auto', padding: 4 }}>
          {hits.length ? hits.map((c) => (
            <button key={c.id} type="button" onClick={() => { onChange(c); setOpen(false); setQ(''); }} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: value?.id === c.id ? '#f5f3ff' : 'none', borderRadius: 7, padding: '7px 9px', font: 'inherit', fontSize: 12.5, cursor: 'pointer', color: '#0f172a' }}>{label(c)}</button>
          )) : <div style={{ fontSize: 12.5, color: '#94a3b8', padding: 8 }}>No open case matches.</div>}
        </div>
      )}
    </div>
  );
}
