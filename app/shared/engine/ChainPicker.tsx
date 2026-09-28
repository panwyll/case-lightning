'use client';
/**
 * Picking the client's other half of a chain. Cases for the same client (a name or an email in
 * common) are listed straight away; any other case is found by searching its address, client or
 * reference. Never a list of every address.
 */
import { useMemo, useState } from 'react';
import { Check, Search } from '@/app/shared/icons';

export interface ChainOption { matterId: string; matterRef: string | null; propertyAddress: string | null; client: string | null; sameClient?: boolean }

const CSS = `
.cp{display:grid;gap:6px}
.cp-q{position:relative}
.cp-q svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#94a3b8}
.cp-q input{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:7px 9px 7px 32px;font:inherit;font-size:13px}
.cp-q input:focus{outline:2px solid #c4b5fd;border-color:#8b5cf6}
.cp-list{border:1px solid #e6e8ee;border-radius:10px;max-height:220px;overflow-y:auto;background:#fff}
.cp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;align-items:center;width:100%;text-align:left;border:0;border-top:1px solid #f1f5f9;background:#fff;padding:8px 10px;font:inherit;cursor:pointer}
.cp-row:first-child{border-top:0}
.cp-row:hover{background:#faf8ff}
.cp-row.on{background:#f5f3ff}
.cp-row .a{font-size:13px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-row .m{grid-column:1;font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-row .t{grid-row:1 / span 2;grid-column:2;display:flex;align-items:center;gap:6px}
.cp-tag{font-size:10.5px;font-weight:800;color:#15803d;background:#dcfce7;border-radius:99px;padding:1px 8px}
.cp-none{font-size:12.5px;color:#64748b;padding:9px 10px}
`;

export function ChainPicker({ options, value, onChange, want }: { options: ChainOption[]; value: string; onChange: (id: string) => void; want: 'sale' | 'purchase' }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options.filter((o) => o.sameClient || o.matterId === value);
    return options.filter((o) => [o.propertyAddress, o.client, o.matterRef].some((x) => (x ?? '').toLowerCase().includes(needle))).slice(0, 30);
  }, [options, q, value]);
  return (
    <div className="cp">
      <style>{CSS}</style>
      <div className="cp-q"><Search size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${want}s by address, client or reference`} aria-label={`Search ${want}s`} /></div>
      <div className="cp-list" role="listbox" aria-label={`The client's ${want}`}>
        {shown.length ? shown.map((o) => (
          <button key={o.matterId} type="button" role="option" aria-selected={value === o.matterId} className={`cp-row${value === o.matterId ? ' on' : ''}`} onClick={() => onChange(value === o.matterId ? '' : o.matterId)}>
            <span className="a">{o.propertyAddress ?? o.matterRef ?? 'Case'}</span>
            <span className="m">{[o.client, o.matterRef].filter(Boolean).join(' · ')}</span>
            <span className="t">{o.sameClient && <span className="cp-tag">Same Client</span>}{value === o.matterId && <Check size={16} />}</span>
          </button>
        )) : <div className="cp-none">{q.trim() ? `No open ${want} matches.` : `No open ${want} for this client. Search to find another.`}</div>}
      </div>
    </div>
  );
}
