'use client';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Loader } from '@/app/shared/icons';

/**
 * A button that shows its own work: a spinner (and "Saving…") while the action runs, a tick
 * and the done label once it has worked, and stays as it was when it fails (the caller shows why).
 * The action resolves to `false` (or throws) when it did not work.
 */
export const BUSY_CSS = `
@keyframes bb-spin{to{transform:rotate(360deg)}}
.bb-spin{animation:bb-spin .8s linear infinite;flex:none}
.bb{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
.bb.ok{background:#16a34a !important;border-color:#16a34a !important;color:#fff !important}
`;

export function BusyButton({ onClick, children, busyLabel = 'Saving…', doneLabel = 'Done', className = 'ep-btn primary', style, disabled, title }: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  busyLabel?: string;
  doneLabel?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
}) {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'ok'>('idle');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = async () => {
    if (phase !== 'idle') return;
    setPhase('busy');
    let worked = false;
    try { worked = (await onClick()) !== false; } catch { worked = false; }
    if (!live.current) return;
    if (!worked) { setPhase('idle'); return; }
    setPhase('ok');
    setTimeout(() => { if (live.current) setPhase('idle'); }, 2500);
  };
  return (
    <>
      <style>{BUSY_CSS}</style>
      <button type="button" title={title} className={`${className} bb${phase === 'ok' ? ' ok' : ''}`} style={{ margin: 0, ...style }} disabled={disabled || phase === 'busy'} aria-busy={phase === 'busy'} onClick={() => void run()}>
        {phase === 'busy' ? <><Loader size={16} className="bb-spin" />{busyLabel}</> : phase === 'ok' ? <><Check size={16} />{doneLabel}</> : children}
      </button>
    </>
  );
}

/**
 * Upload from a button: pick files, the button spins while they go up ("Uploading 2 of 3…"),
 * then says it worked. `onFiles` does the upload and resolves to what to say (or throws with why).
 */
export function UploadButton({ label, onFiles, multiple = true, accept, className = 'ep-btn primary', style }: {
  label: string;
  onFiles: (files: File[], progress: (done: number) => void) => Promise<unknown>;
  multiple?: boolean;
  accept?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [count, setCount] = useState<{ done: number; of: number }>({ done: 0, of: 0 });
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const go = async (files: File[]) => {
    if (!files.length) return;
    setPhase('busy');
    setCount({ done: 0, of: files.length });
    let worked = false;
    try { worked = (await onFiles(files, (done) => live.current && setCount({ done, of: files.length }))) !== false; } catch { worked = false; }
    if (!live.current) return;
    if (!worked) { setPhase('idle'); return; }
    setPhase('ok');
    setTimeout(() => { if (live.current) setPhase('idle'); }, 2500);
  };
  return (
    <>
      <style>{BUSY_CSS}</style>
      <button type="button" className={`${className} bb${phase === 'ok' ? ' ok' : ''}`} style={{ margin: 0, ...style }} disabled={phase === 'busy'} aria-busy={phase === 'busy'} onClick={() => input.current?.click()}>
        {phase === 'busy' ? <><Loader size={16} className="bb-spin" />{count.of > 1 ? `Uploading ${Math.min(count.done + 1, count.of)} of ${count.of}…` : 'Uploading…'}</> : phase === 'ok' ? <><Check size={16} />Uploaded</> : label}
      </button>
      <input ref={input} type="file" hidden multiple={multiple} accept={accept} onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void go(fs); }} />
    </>
  );
}
