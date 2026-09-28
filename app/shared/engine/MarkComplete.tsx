'use client';
/**
 * Manual handling: a person marks a step complete by hand, saying what was done and filing any
 * supporting documents (a certificate received by post, a search from another provider, a call
 * note). The step then reads as reviewed and the case moves on it like any other.
 */
import { useState } from 'react';
import type { Api } from './types';

const readB64 = (f: File) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(r.error); r.readAsDataURL(f); });

export function MarkComplete({ matterId, api, step, label, busy, cmd }: { matterId: string; api: Api; step: string; label: string; busy: boolean; cmd: (body: Record<string, unknown>) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!note.trim()) return;
    setSaving(true); setErr(null);
    try {
      const documentIds: string[] = [];
      for (const f of files) {
        if (f.size > 25 * 1024 * 1024) throw new Error(`${f.name} is over 25 MB.`);
        const r = await api<{ documentId: string }>(`/matters/${matterId}/engine/upload`, { method: 'POST', body: JSON.stringify({ fileName: f.name, base64: await readB64(f), mimeType: f.type || 'application/octet-stream', role: 'evidence' }) });
        documentIds.push(r.documentId);
      }
      const ok = await cmd({ type: 'complete_step_manually', step, note: note.trim(), documentIds });
      if (ok !== false) { setOpen(false); setNote(''); setFiles([]); }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not save it.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return <button type="button" className="ep-btn" style={{ margin: 0, padding: '2px 9px', fontSize: 11.5 }} disabled={busy} onClick={() => setOpen(true)}>Mark Complete</button>;
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 6, width: '100%' }}>
      <textarea className="eg-ta" rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={`How ${label.toLowerCase()} was done or checked`} style={{ font: 'inherit', fontSize: 13 }} />
      <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} style={{ fontSize: 12 }} aria-label="Supporting documents" />
      {err && <div style={{ color: '#b91c1c', fontSize: 12 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="ep-btn primary" style={{ margin: 0 }} disabled={saving || busy || !note.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Mark Complete'}</button>
        <button type="button" className="ep-btn" style={{ margin: 0 }} disabled={saving} onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
      </div>
    </div>
  );
}
