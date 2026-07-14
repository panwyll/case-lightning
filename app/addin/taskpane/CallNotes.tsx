'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'cl_token';
async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
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
async function apiUpload<T = any>(path: string, form: FormData): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

interface Note {
  id: string;
  matter_id: string | null;
  matter_ref: string | null;
  title: string;
  summary: string;
  transcript: string;
  duration_seconds: number | null;
  created_at: string;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function CallNotes({ onClose }: { onClose: () => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null); // transcript expanded
  const [assignId, setAssignId] = useState<string | null>(null); // note being assigned
  const [mq, setMq] = useState('');
  const [mResults, setMResults] = useState<Array<{ id: string; matter_ref: string; property_address: string }>>([]);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);

  const load = useCallback(async () => {
    try { setNotes((await api<{ notes: Note[] }>('/call-notes')).notes ?? []); } catch (e: any) { setErr(e?.message || 'Could not load notes.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Tidy up any live recording if the panel unmounts.
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); if (timerRef.current) clearInterval(timerRef.current); }, []);

  const start = async () => {
    setErr(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setErr('Recording isn’t available here.'); return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErr('Microphone blocked. In Outlook, the add-in may not be allowed to use the mic — open CONVEYi in a browser tab to record, or allow microphone access and try again.');
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recRef.current = rec;
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const seconds = elapsedRef.current;
      const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
      setPhase('processing');
      try {
        const form = new FormData();
        form.append('audio', blob, 'call.webm');
        form.append('durationSeconds', String(seconds));
        const { note } = await apiUpload<{ note: Note }>('/call-notes', form);
        setNotes((n) => [note, ...n]);
        setOpenId(note.id);
      } catch (e: any) {
        setErr(e?.message || 'Couldn’t transcribe the recording.');
      } finally {
        setPhase('idle');
      }
    };
    rec.start();
    setPhase('recording');
    setElapsed(0); elapsedRef.current = 0;
    timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(elapsedRef.current); }, 1000);
  };
  const stop = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recRef.current?.stop();
    setPhase('processing');
  };

  // Matter search for the assign step (debounced).
  useEffect(() => {
    if (!assignId || !mq.trim()) { setMResults([]); return; }
    const t = setTimeout(async () => {
      try { setMResults((await api<{ matters: any[] }>(`/matters?q=${encodeURIComponent(mq.trim())}`)).matters ?? []); } catch { setMResults([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [mq, assignId]);

  const assign = async (noteId: string, matterId: string) => {
    try {
      const { note } = await api<{ note: Note }>(`/call-notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ matterId }) });
      setNotes((n) => n.map((x) => x.id === noteId ? note : x));
      setAssignId(null); setMq(''); setMResults([]);
    } catch (e: any) { setErr(e?.message || 'Could not assign.'); }
  };
  const del = async (noteId: string) => {
    if (!window.confirm('Delete this call note?')) return;
    setNotes((n) => n.filter((x) => x.id !== noteId));
    await api(`/call-notes/${noteId}`, { method: 'DELETE' }).catch(() => {});
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 18 }} aria-hidden>📞</span>
          <strong style={{ fontSize: 15, color: '#1C1530', flex: 1 }}>Call notes</strong>
          <button onClick={onClose} style={S.x} aria-label="Close">✕</button>
        </div>
        {/* Recorder — a single mic button; a live timer + red stop while recording. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, padding: '10px 0 16px' }}>
          {phase === 'recording' ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626', letterSpacing: 1, fontVariantNumeric: 'tabular-nums' }}>{mmss(elapsed)}</div>
              <button onClick={stop} title="Stop &amp; transcribe" aria-label="Stop and transcribe" style={round('#dc2626')}>
                <span style={{ display: 'block', width: 16, height: 16, background: '#fff', borderRadius: 3 }} />
              </button>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>Recording — tap to stop</span>
            </>
          ) : phase === 'processing' ? (
            <div style={{ fontSize: 13, color: '#5A27E0', fontWeight: 700, padding: '22px 0' }}><span style={S.spin} /> Transcribing…</div>
          ) : (
            <>
              <button onClick={start} title="Record a call" aria-label="Record a call" style={round('#5A27E0')}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
              <span style={{ fontSize: 11.5, color: '#94a3b8' }}>Record a call</span>
            </>
          )}
        </div>

        {err && <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>{err}</div>}

        {/* Notes list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
          {notes.length === 0 && phase === 'idle' && <div style={{ fontSize: 12.5, color: '#94a3b8', textAlign: 'center', padding: 8 }}>No call notes yet.</div>}
          {notes.map((n) => {
            const open = openId === n.id;
            return (
              <div key={n.id} style={{ border: '1px solid #ECE7F8', borderRadius: 10, background: '#FBFAFF', padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1C1530' }}>{n.title || 'Call note'}</div>
                    <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 1 }}>
                      {new Date(n.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {n.duration_seconds ? ` · ${mmss(n.duration_seconds)}` : ''}
                    </div>
                  </div>
                  {n.matter_ref ? (
                    <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, color: '#5A27E0', background: '#EDE7FB', borderRadius: 999, padding: '2px 8px' }}>{n.matter_ref}</span>
                  ) : (
                    <button onClick={() => { setAssignId(assignId === n.id ? null : n.id); setMq(''); setMResults([]); }} style={{ ...S.miniBtn, color: '#5A27E0', borderColor: '#D9D2EC' }}>+ Assign to matter</button>
                  )}
                </div>

                {n.summary && <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.5, marginTop: 6, whiteSpace: 'pre-wrap' }}>{n.summary}</div>}

                {assignId === n.id && (
                  <div style={{ marginTop: 8, border: '1px solid #E7E2F3', borderRadius: 8, padding: 8, background: '#fff' }}>
                    <input autoFocus value={mq} onChange={(e) => setMq(e.target.value)} placeholder="Search matters (ref, address, name)…" style={S.input} />
                    {mResults.map((m) => (
                      <button key={m.id} onClick={() => assign(n.id, m.id)} style={S.result}>
                        <strong style={{ color: '#1C1530' }}>{m.matter_ref}</strong> <span style={{ color: '#64748b' }}>{m.property_address}</span>
                      </button>
                    ))}
                    {mq.trim() && mResults.length === 0 && <div style={{ fontSize: 11.5, color: '#94a3b8', padding: '4px 2px' }}>No matches.</div>}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
                  <button onClick={() => setOpenId(open ? null : n.id)} style={S.link}>{open ? 'Hide transcript' : 'Full transcript'}</button>
                  <button onClick={() => del(n.id)} style={{ ...S.link, color: '#b91c1c', marginLeft: 'auto' }}>Delete</button>
                </div>
                {open && <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.55, marginTop: 6, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', background: '#fff', border: '1px solid #eef0f4', borderRadius: 8, padding: '8px 10px' }}>{n.transcript || '(no transcript)'}</div>}
              </div>
            );
          })}
        </div>
        <div style={{ textAlign: 'center', margin: '12px 0 0' }}>
          <a href="https://ico.org.uk/for-organisations/" target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#94a3b8', textDecoration: 'underline' }}>UK call-recording rules (ICO) ↗</a>
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

const round = (bg: string): React.CSSProperties => ({
  width: 64, height: 64, borderRadius: '50%', border: 'none', background: bg, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 20px rgba(90,39,224,0.30)',
});
const S: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,15,30,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 12 },
  card: { background: '#fff', borderRadius: 14, padding: 16, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.3)', position: 'relative' },
  x: { width: 26, height: 26, border: 'none', background: '#f1f5f9', borderRadius: 8, cursor: 'pointer', color: '#64748b', fontSize: 12 },
  bigBtn: { marginTop: 6, padding: '11px 22px', borderRadius: 999, border: 'none', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  spin: { display: 'inline-block', width: 13, height: 13, border: '2px solid #ddd2f7', borderTopColor: '#5A27E0', borderRadius: '50%', animation: 'spin 0.8s linear infinite', marginRight: 6, verticalAlign: -2 },
  miniBtn: { flex: 'none', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', cursor: 'pointer' },
  link: { fontSize: 11.5, fontWeight: 700, color: '#5A27E0', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 },
  input: { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px', borderRadius: 8, border: '1px solid #d0d5dd', marginBottom: 6 },
  result: { display: 'block', width: '100%', textAlign: 'left', fontSize: 12, padding: '6px 8px', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer' },
};
