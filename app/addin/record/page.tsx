'use client';
import { useEffect, useRef, useState } from 'react';

// Standalone recorder, opened as an Office Dialog (a real window, not the sandboxed
// taskpane iframe) so the microphone is actually available. It records, uploads to
// /call-notes, then hands the finished note back to the pane via messageParent.
const TOKEN_KEY = 'cl_token';
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function RecordDialog() {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'processing' | 'done' | 'error'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);

  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); if (timerRef.current) clearInterval(timerRef.current); }, []);

  const back = (payload: Record<string, unknown>) => {
    const Office = (window as any).Office;
    try { Office?.context?.ui?.messageParent?.(JSON.stringify(payload)); } catch { /* not in Office */ }
  };

  const start = async () => {
    setErr('');
    if (!navigator.mediaDevices?.getUserMedia) { setErr('Recording isn’t available on this device.'); setPhase('error'); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setErr('Microphone access was denied. Allow it in your browser and try again.'); setPhase('error'); return; }
    streamRef.current = stream;
    chunksRef.current = [];
    const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recRef.current = rec;
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setPhase('processing');
      try {
        const token = window.localStorage.getItem(TOKEN_KEY);
        const form = new FormData();
        form.append('audio', new Blob(chunksRef.current, { type: mime || 'audio/webm' }), 'call.webm');
        form.append('durationSeconds', String(elapsedRef.current));
        const res = await fetch('/api/v1/call-notes', { method: 'POST', credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setPhase('done');
        back({ note: json.note });
      } catch (e: any) {
        setErr(e?.message || 'Couldn’t transcribe the recording.');
        setPhase('error');
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

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, background: 'linear-gradient(160deg,#F1ECFB,#FBFAFF)', color: '#1C1530' }}>
      <div style={{ background: '#fff', borderRadius: 18, boxShadow: '0 14px 44px rgba(90,39,224,0.16)', padding: '30px 26px 22px', width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 20 }}>📞</span><strong style={{ fontSize: 17 }}>Record a call</strong></div>

      {phase === 'recording' ? (
        <>
          <div style={{ fontSize: 30, fontWeight: 800, color: '#dc2626', letterSpacing: 1, fontVariantNumeric: 'tabular-nums' }}>{mmss(elapsed)}</div>
          <button onClick={stop} style={round('#dc2626')} aria-label="Stop and transcribe"><span style={{ display: 'block', width: 22, height: 22, background: '#fff', borderRadius: 4 }} /></button>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>Recording — tap to stop</span>
        </>
      ) : phase === 'processing' ? (
        <div style={{ fontSize: 14, color: '#5A27E0', fontWeight: 700 }}><span style={spin} /> Transcribing…</div>
      ) : phase === 'done' ? (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 30 }}>✓</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#16a34a' }}>Saved</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>You can close this window.</div>
        </div>
      ) : phase === 'error' ? (
        <>
          <div style={{ fontSize: 13, color: '#b91c1c', textAlign: 'center', maxWidth: 300 }}>{err}</div>
          <button onClick={() => { setPhase('idle'); setErr(''); }} style={{ ...pill, background: '#5A27E0', color: '#fff' }}>Try again</button>
        </>
      ) : (
        <>
          <button onClick={start} style={round('#5A27E0')} aria-label="Record a call">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
          <span style={{ fontSize: 13, color: '#94a3b8' }}>Tap to start</span>
        </>
      )}
      <a href="https://ico.org.uk/for-organisations/" target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#b0a9c0', textDecoration: 'underline', marginTop: 4 }}>UK call-recording rules (ICO) ↗</a>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

const round = (bg: string): React.CSSProperties => ({ width: 86, height: 86, borderRadius: '50%', border: 'none', background: bg, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 26px rgba(90,39,224,0.30)' });
const pill: React.CSSProperties = { padding: '9px 18px', borderRadius: 999, border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const spin: React.CSSProperties = { display: 'inline-block', width: 14, height: 14, border: '2px solid #ddd2f7', borderTopColor: '#5A27E0', borderRadius: '50%', animation: 'spin 0.8s linear infinite', marginRight: 6, verticalAlign: -2 };
