'use client';
import { Spin } from '@/app/shared/engine/BusyButton';

/** A document as it reads: the .docx as HTML (formatting kept), or its words when there is no HTML. */
export type DocPreview = { preview: string; html: string | null; fileName: string; previous: string | null; sample?: boolean };

const CSS = `
.dp-page{background:#fff;border:1px solid #e8eaf0;border-radius:10px;padding:34px 40px;font:13.5px/1.6 Georgia,'Times New Roman',serif;color:#1e293b;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.dp-page h1,.dp-page h2,.dp-page h3{font-family:inherit;color:#0f172a;margin:14px 0 8px}
.dp-page h1{font-size:19px}.dp-page h2{font-size:16px}.dp-page h3{font-size:14.5px}
.dp-page p{margin:0 0 9px}
.dp-page table{border-collapse:collapse;width:100%;margin:8px 0 12px}
.dp-page td,.dp-page th{border:1px solid #e2e8f0;padding:5px 8px;vertical-align:top}
.dp-page ul,.dp-page ol{margin:0 0 9px 20px;padding:0}
.dp-page pre{white-space:pre-wrap;font:inherit;margin:0}
`;

export function DocPage({ p }: { p: DocPreview | null }) {
  return (
    <>
      <style>{CSS}</style>
      {!p
        ? <div className="dp-page" style={{ color: '#94a3b8', fontFamily: 'inherit' }}><Spin>Loading…</Spin></div>
        : p.html
        ? <div className="dp-page" dangerouslySetInnerHTML={{ __html: p.html }} />
        : <div className="dp-page"><pre>{p.preview || 'Nothing to show.'}</pre></div>}
    </>
  );
}
