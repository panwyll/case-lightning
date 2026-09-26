'use client';
import { useState } from 'react';
import type { DraftCheckView } from './types';

/**
 * A drafted document as checked against the fact register: each sentence with the numbered
 * facts it rests on, what is not from the file struck through, and the sources list. A
 * citation opens the source document at its page.
 */
export function CheckedDraft({ check }: { check: DraftCheckView }) {
  const [active, setActive] = useState<string | null>(null);
  const num = new Map(check.cited.map((f, i) => [f.id, i + 1]));
  const open = (id: string) => {
    const f = check.cited.find((c) => c.id === id);
    if (!f) return;
    setActive(id);
    window.open(`/api/v1/documents/${f.documentId}/raw#page=${f.page ?? 1}`, '_blank', 'noopener');
  };
  // A line break in the draft starts a paragraph.
  const paras: Array<DraftCheckView['sentences']> = [];
  check.sentences.forEach((s, i) => {
    const prev = check.sentences[i - 1];
    if (!prev || (s.para ?? 0) !== (prev.para ?? 0) || s.start - prev.end > 1) paras.push([s]);
    else paras[paras.length - 1].push(s);
  });
  const chip = (id: string) => {
    const f = check.cited.find((c) => c.id === id);
    const n = num.get(id);
    if (!f || !n) return null;
    return <button key={id} className="cd-cite" style={active === id ? { background: '#5A27E0', color: '#fff' } : undefined} title={`${f.documentLabel}${f.page ? ` p.${f.page}` : ''} — ${f.key}: ${f.value}${f.quote ? `\n“${f.quote}”` : ''}`} onClick={() => open(id)}>{n}</button>;
  };
  return (
    <div className="cd">
      <style>{CSS}</style>
      <div className="cd-line">{check.summary.matched} of {check.summary.claims} figures, dates and names match the file · {check.summary.struck} not from the file · {check.summary.cited} sources</div>
      {check.notFromFile.length > 0 && (
        <div className="cd-nff">
          <b>Not From The File</b>
          {check.notFromFile.map((n, i) => <div key={i}><s>{n.text}</s> <span className="cd-kind">{n.kind.replace('_', ' ')}</span> <span className="cd-sent">{n.sentence}</span></div>)}
        </div>
      )}
      <div className="cd-body">
        {paras.map((p, pi) => (
          <p key={pi} className={p.length === 1 && !/[.!?]$/.test(p[0].text) ? 'cd-head' : undefined}>
            {p.map((s, si) => {
              const parts: Array<string | { text: string }> = [];
              let cur = 0;
              for (const k of s.struck) { parts.push(s.text.slice(cur, k.start)); parts.push({ text: s.text.slice(k.start, k.end) }); cur = k.end; }
              parts.push(s.text.slice(cur));
              return (
                <span key={si}>
                  {parts.map((x, i) => (typeof x === 'string' ? <span key={i}>{x}</span> : <s key={i} className="cd-struck" title="Not from the file: no document states this">{x.text}</s>))}
                  {s.factIds.map(chip)}
                  {si < p.length - 1 ? ' ' : ''}
                </span>
              );
            })}
          </p>
        ))}
      </div>
      {check.cited.length > 0 && (
        <div className="cd-src">
          <b>Sources</b>
          {check.cited.map((f, i) => (
            <div key={f.id} className="cd-srcrow" onClick={() => open(f.id)} style={active === f.id ? { background: '#f3efff' } : undefined}>
              <span className="cd-n">{i + 1}</span>
              <span><b>{f.documentLabel}</b>{f.page ? ` p.${f.page}` : ''} · {f.key.replace(/^[a-z_]+\./, '').replace(/[._]/g, ' ')}: {f.value}{f.quote ? <i> — “{f.quote.slice(0, 160)}{f.quote.length > 160 ? '…' : ''}”</i> : null}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CSS = `
.cd{font-size:13px;line-height:1.55;color:#0f172a;max-width:90ch}
.cd-line{font-size:12px;color:#475569;margin-bottom:8px}
.cd-nff{border:1px solid #fecaca;background:#fff5f5;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12.5px}
.cd-nff b{display:block;margin-bottom:4px;color:#7f1d1d}
.cd-nff s{color:#b91c1c}
.cd-kind{font-size:11px;color:#94a3b8;margin-right:6px}
.cd-sent{color:#64748b}
.cd-body p{margin:0 0 10px}
.cd-body p.cd-head{font-weight:800;margin:14px 0 6px}
.cd-struck{color:#b91c1c;text-decoration-color:#b91c1c;background:#fff1f2;border-radius:3px;padding:0 2px}
.cd-cite{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;margin:0 1px 0 3px;border-radius:999px;border:1px solid #c7b8f5;background:#f3efff;color:#5A27E0;font-size:10px;font-weight:800;cursor:pointer;vertical-align:super;line-height:1}
.cd-src{border-top:1px solid #e6e8ee;margin-top:12px;padding-top:8px;font-size:12.5px}
.cd-src>b{display:block;margin-bottom:4px}
.cd-srcrow{display:flex;gap:8px;padding:3px 6px;border-radius:6px;cursor:pointer}
.cd-srcrow:hover{background:#f8fafc}
.cd-n{min-width:18px;height:18px;border-radius:999px;background:#f3efff;color:#5A27E0;font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:none}
.cd-srcrow i{color:#64748b}
`;
