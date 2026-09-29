'use client';
/**
 * Choose the lender: type to search the firm's Lender Directory and the main UK lenders; one
 * that is not there is added (and joins the directory, so its requirements can be filled in).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from '@/app/shared/icons';

/** The lenders most UK purchases and remortgages go through. */
const UK_LENDERS = ['Nationwide Building Society', 'Halifax', 'Santander', 'Barclays', 'NatWest', 'Lloyds Bank', 'HSBC', 'TSB', 'Virgin Money', 'Coventry Building Society', 'Skipton Building Society', 'Yorkshire Building Society', 'Leeds Building Society', 'Accord Mortgages', 'Platform', 'Kensington Mortgages', 'Precise Mortgages', 'The Mortgage Works', 'Metro Bank', 'Bank of Ireland', 'Clydesdale Bank', 'Royal Bank of Scotland', 'First Direct', 'Nottingham Building Society', 'Principality Building Society', 'Newcastle Building Society', 'Paragon Bank', 'Aldermore', 'Together', 'Pepper Money'];

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export function LenderPicker({ api, value, onChange, inputStyle, className }: { api: Api; value: string; onChange: (v: string) => void; inputStyle?: React.CSSProperties; className?: string }) {
  const [known, setKnown] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { api<{ lenders: Array<{ lenderName: string }> }>('/engine/lenders/names').then((r) => setKnown(r.lenders.map((l) => l.lenderName))).catch(() => {}); }, [api]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const options = useMemo(() => {
    const q = norm(value);
    const dir = new Set(known.map(norm));
    const all = [...known.map((n) => ({ name: n, directory: true })), ...UK_LENDERS.filter((n) => !dir.has(norm(n))).map((n) => ({ name: n, directory: false }))];
    return (q ? all.filter((o) => norm(o.name).includes(q)) : all).slice(0, 12);
  }, [known, value]);
  const exact = options.some((o) => norm(o.name) === norm(value));
  const canAdd = value.trim().length >= 2 && !exact;
  const rows = options.length + (canAdd ? 1 : 0);
  const pick = (name: string, add = false) => {
    onChange(name); setOpen(false);
    if (add) void api('/engine/lenders/names', { method: 'POST', body: JSON.stringify({ lenderName: name }) }).then(() => setKnown((k) => [...k, name])).catch(() => {});
  };
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <input value={value} placeholder="Search lenders" autoComplete="off" style={inputStyle} className={className}
        onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(rows - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter' && rows) { e.preventDefault(); if (hi < options.length) pick(options[hi].name); else pick(value.trim(), true); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {open && rows > 0 && (
        <div role="listbox" style={{ position: 'absolute', zIndex: 40, top: 'calc(100% + 4px)', left: 0, right: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.14)', maxHeight: 260, overflowY: 'auto', padding: 4 }}>
          {options.map((o, i) => (
            <button key={o.name} type="button" role="option" aria-selected={hi === i} onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.name)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 0, borderRadius: 7, padding: '7px 9px', font: 'inherit', fontSize: 13, cursor: 'pointer', color: '#0f172a', background: hi === i ? '#f5f3ff' : 'none' }}>
              <span style={{ flex: 1 }}>{o.name}</span>
              {o.directory && <span style={{ fontSize: 10.5, fontWeight: 800, color: '#5A27E0', background: '#f3efff', borderRadius: 99, padding: '1px 7px' }}>Directory</span>}
            </button>
          ))}
          {canAdd && (
            <button type="button" role="option" aria-selected={hi === options.length} onMouseEnter={() => setHi(options.length)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(value.trim(), true)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 0, borderTop: options.length ? '1px solid #f1f5f9' : 0, borderRadius: 7, padding: '8px 9px', font: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer', color: '#5A27E0', background: hi === options.length ? '#f5f3ff' : 'none' }}>
              <Plus size={16} />Add “{value.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}
