'use client';
import { useCallback, useRef, useState } from 'react';

/**
 * Import existing matters from a case management system's CSV export.
 *
 * The alternative to deriving matters from email. A firm on LEAP/Osprey/Proclaim
 * already has the authoritative list; the mailbox scan can only find what's still
 * active. Every one of those systems exports CSV, which needs no API and nobody's
 * permission.
 *
 * Two steps on purpose — preview then commit. It creates real matters with real
 * OneDrive folders, so the user sees exactly what was understood from their file
 * (including which columns we recognised) before anything happens.
 */

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

interface Row {
  line: number;
  firmRef: string;
  propertyAddress: string;
  buyerNames: string[];
  sellerNames: string[];
  skip?: string;
}
interface Preview {
  rows: Row[];
  importable: number;
  skipped: number;
  mapping: Record<string, string>;
  unmapped: string[];
  usable: boolean;
  maxRows: number;
}

const PURPLE = '#5A27E0';
const FIELD_LABEL: Record<string, string> = {
  firmRef: 'your reference',
  propertyAddress: 'property',
  buyerNames: 'buyer',
  sellerNames: 'seller',
  counterpartySolicitor: 'other side',
  counterpartyAgent: 'agent',
  exchangeTargetDate: 'exchange',
  completionTargetDate: 'completion',
};

export default function MatterImport({ onImported }: { onImported?: (n: number) => void }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ created: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const choose = useCallback(async (file: File) => {
    setErr(null);
    setResult(null);
    setPreview(null);
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setBusy(true);
    try {
      setPreview(await api<Preview>('/matters/import', { method: 'POST', body: JSON.stringify({ csv: text, dryRun: true }) }));
    } catch (e) {
      setErr((e as Error).message || 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }, []);

  const commit = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    let created = 0;
    let failed = 0;
    try {
      // The server creates a slice per call (each matter provisions a OneDrive
      // folder and tracker), so loop until it reports nothing remaining.
      for (let offset = 0, guard = 0; guard < 100; guard++) {
        const r = await api<{ created: number; failed: any[]; done: number; total: number; remaining: number }>(
          '/matters/import',
          { method: 'POST', body: JSON.stringify({ csv, offset }) }
        );
        created += r.created;
        failed += r.failed.length;
        setProgress({ done: r.done, total: r.total });
        if (r.remaining <= 0) break;
        offset = r.done;
      }
      setResult({ created, failed });
      setPreview(null);
      onImported?.(created);
    } catch (e) {
      setErr((e as Error).message || 'Import failed.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [csv, preview, onImported]);

  return (
    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>Already using a case management system?</div>
      <div style={{ fontSize: 13, color: '#475569', marginTop: 3, lineHeight: 1.5 }}>
        Export your matter list from LEAP, Osprey, Proclaim or whatever you run, and drop the CSV
        here. CONVEYi keeps your own references, so its records line up with your files.
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void choose(f);
          e.target.value = '';
        }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={secondary}>
          {fileName ? 'Choose a different file' : 'Choose CSV file'}
        </button>
        {fileName && <span style={{ fontSize: 12.5, color: '#64748b' }}>{fileName}</span>}
        {busy && !progress && <span style={{ fontSize: 12.5, color: '#64748b' }}>Reading…</span>}
      </div>

      {err && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10 }}>
          {err}
        </div>
      )}

      {preview && !preview.usable && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 10 }}>
          None of the columns looked like matter data. Check it's the right export — we look for a
          reference and a property address, plus buyer, seller, other side and key dates if present.
          {preview.unmapped.length > 0 && <div style={{ marginTop: 4, color: '#a16207' }}>Found: {preview.unmapped.join(', ')}</div>}
        </div>
      )}

      {preview && preview.usable && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12.5, color: '#475569' }}>
            Recognised{' '}
            {Object.entries(preview.mapping).map(([header, field], i, a) => (
              <span key={header}>
                <strong>{header}</strong> as {FIELD_LABEL[field] ?? field}
                {i < a.length - 1 ? ', ' : ''}
              </span>
            ))}
            .
            {preview.unmapped.length > 0 && (
              <span style={{ color: '#94a3b8' }}> Ignoring {preview.unmapped.join(', ')}.</span>
            )}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginTop: 10 }}>
            {preview.importable} matter{preview.importable === 1 ? '' : 's'} to import
            {preview.skipped > 0 && <span style={{ fontWeight: 400, color: '#64748b' }}> · {preview.skipped} skipped</span>}
          </div>

          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 8, marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                {preview.rows.slice(0, 60).map((r) => (
                  <tr key={r.line} style={{ borderBottom: '1px solid #f1f5f9', opacity: r.skip ? 0.55 : 1 }}>
                    <td style={{ padding: '6px 8px', fontWeight: 700, whiteSpace: 'nowrap' }}>{r.firmRef || '—'}</td>
                    <td style={{ padding: '6px 8px', color: '#475569' }}>{r.propertyAddress || '—'}</td>
                    <td style={{ padding: '6px 8px', color: '#64748b' }}>
                      {[r.buyerNames.join(', '), r.sellerNames.join(', ')].filter(Boolean).join(' → ')}
                    </td>
                    <td style={{ padding: '6px 8px', color: '#b45309', whiteSpace: 'nowrap' }}>{r.skip ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 60 && (
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 4 }}>
              Showing the first 60 of {preview.rows.length}.
            </div>
          )}

          <button onClick={commit} disabled={busy || preview.importable === 0} style={{ ...primary, marginTop: 12, opacity: preview.importable === 0 ? 0.5 : 1 }}>
            {busy
              ? progress
                ? `Importing ${progress.done}/${progress.total}…`
                : 'Importing…'
              : `Import ${preview.importable} matter${preview.importable === 1 ? '' : 's'}`}
          </button>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>
            Each one gets its own OneDrive folder and tracker, so this takes a moment.
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12, fontSize: 13, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: 10 }}>
          Imported {result.created} matter{result.created === 1 ? '' : 's'}.
          {result.failed > 0 && <span style={{ color: '#92400e' }}> {result.failed} could not be created.</span>}
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 14 };
const primary: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '9px 16px', borderRadius: 8, border: 'none', background: PURPLE, color: '#fff', cursor: 'pointer' };
const secondary: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '8px 14px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
