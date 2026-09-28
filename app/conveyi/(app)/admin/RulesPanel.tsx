'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ChevronRight } from '@/app/shared/icons';

type Rule = { id: string; section: string; title: string; rule: string; hash: string; status: 'signed' | 'changed' | 'new' | 'unsigned' };
type Book = { version: string; rules: Rule[]; signoff: { version: string; at: string; by: string | null; note: string | null; current: boolean } | null };

const CSS = `
.rb{display:grid;gap:12px}
.rb-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:12px 14px}
.rb-top .st{font-size:13px;color:#334155}
.rb-top .st b{color:#0f172a}
.rb-top .ok{color:#166534;font-weight:700}
.rb-top .warn{color:#b45309;font-weight:700}
.rb-top .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.rb-in{border:1px solid #cbd5e1;border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;min-width:220px}
.rb-btn{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:7px 14px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit}
.rb-btn.go{background:#5A27E0;color:#fff}
.rb-btn:disabled{opacity:.6;cursor:default}
.rb-sec{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.rb-sec > button{display:flex;width:100%;align-items:center;gap:10px;border:0;background:#fff;padding:11px 14px;font:inherit;font-size:14px;font-weight:800;color:#0f172a;cursor:pointer;text-align:left}
.rb-sec > button .n{font-size:12px;font-weight:600;color:#64748b}
.rb-sec > button .c{font-size:11px;font-weight:800;color:#b45309;background:#fef3c7;border-radius:99px;padding:1px 8px}
.rb-sec > button .chev{margin-left:auto;color:#94a3b8;transition:transform .15s;display:inline-flex}
.rb-sec.open > button .chev{transform:rotate(90deg)}
.rb-r{padding:9px 14px 10px;border-top:1px solid #f1f5f9;display:grid;gap:2px}
.rb-r b{font-size:13px;color:#0f172a}
.rb-r span{font-size:12.5px;color:#475569;line-height:1.5}
.rb-tag{display:inline-block;margin-left:8px;font-size:10.5px;font-weight:800;border-radius:99px;padding:1px 7px;vertical-align:1px}
.rb-tag.changed{background:#fef3c7;color:#92400e}
.rb-tag.new{background:#e0e7ff;color:#3730a3}
@media print{.rb-top .sp,.rb-sec > button .chev{display:none}.rb-sec{break-inside:avoid-page}}
`;

/** Every rule the system applies, as the firm signs them off: by section, with what changed since the last sign-off. */
export function RulesPanel({ canSign }: { canSign: boolean }) {
  const [book, setBook] = useState<Book | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Book>('/admin/rules').then(setBook).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the rules.')); }, []);

  const sections = useMemo(() => {
    const m = new Map<string, Rule[]>();
    const needle = q.trim().toLowerCase();
    for (const r of book?.rules ?? []) {
      if (needle && !`${r.title} ${r.rule}`.toLowerCase().includes(needle)) continue;
      m.set(r.section, [...(m.get(r.section) ?? []), r]);
    }
    return [...m.entries()];
  }, [book, q]);

  if (err) return <div className="eg-err">{err}</div>;
  if (!book) return <div className="eg-sub">Loading…</div>;
  const changed = book.rules.filter((r) => r.status === 'changed' || r.status === 'new').length;
  const sign = async () => {
    if (!window.confirm(`Sign off all ${book.rules.length} rules as the rules this firm works to?`)) return;
    setBusy(true);
    try { setBook(await api<Book>('/admin/rules', { method: 'POST', body: JSON.stringify({ note: note.trim() || null }) })); setNote(''); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not sign off.'); }
    finally { setBusy(false); }
  };
  const toggle = (s: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const all = q.trim().length > 0;

  return (
    <div className="rb">
      <style>{CSS}</style>
      <div className="rb-top">
        <span className="st">
          {book.signoff
            ? book.signoff.current
              ? <><span className="ok">Signed off</span> by <b>{book.signoff.by ?? 'an admin'}</b> on {new Date(book.signoff.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}{book.signoff.note ? ` · ${book.signoff.note}` : ''}</>
              : <><span className="warn">{changed} rule{changed === 1 ? '' : 's'} changed</span> since {book.signoff.by ?? 'an admin'} signed off on {new Date(book.signoff.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</>
            : <span className="warn">Not signed off</span>}
          {' '}· {book.rules.length} rules · version {book.version}
        </span>
        <span className="sp">
          <input className="rb-in" placeholder="Search the rules" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="rb-btn" onClick={() => { setOpen(new Set(sections.map(([s]) => s))); setTimeout(() => window.print(), 50); }}>Print</button>
          {canSign && (!book.signoff || !book.signoff.current) && <>
            <input className="rb-in" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="rb-btn go" disabled={busy} onClick={() => void sign()}>{busy ? 'Signing…' : 'Sign Off'}</button>
          </>}
        </span>
      </div>
      {sections.map(([section, rules]) => {
        const isOpen = all || open.has(section);
        const moved = rules.filter((r) => r.status === 'changed' || r.status === 'new').length;
        return (
          <div key={section} className={`rb-sec${isOpen ? ' open' : ''}`}>
            <button type="button" onClick={() => toggle(section)} aria-expanded={isOpen}>
              {section}<span className="n">{rules.length}</span>{book.signoff && moved > 0 && <span className="c">{moved} changed</span>}<span className="chev"><ChevronRight size={16} /></span>
            </button>
            {isOpen && rules.map((r) => (
              <div key={r.id} className="rb-r">
                <b>{r.title}{book.signoff && r.status === 'changed' && <span className="rb-tag changed">Changed</span>}{book.signoff && r.status === 'new' && <span className="rb-tag new">New</span>}</b>
                <span>{r.rule}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
