'use client';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

/**
 * A coach-mark tour: dims the surface, cuts a hole around one control and anchors a
 * tooltip to it. Used to show a new user round the pane — what each icon does — which
 * a checklist can't teach because the answer is spatial, not a list of tasks.
 *
 * Steps target live DOM via a CSS selector. A step whose target isn't on screen is
 * SKIPPED rather than shown against nothing (the tabs, for instance, only exist once a
 * matter is linked), so the same script works whatever state the pane is in.
 */

export interface TourStep {
  /** CSS selector for the element to spotlight. Omit for a centred, targetless step. */
  target?: string;
  title: string;
  body: string;
}

const PURPLE = '#5A27E0';
const PAD = 6; // breathing room around the highlighted control

export default function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [vw, setVw] = useState(0);
  const [vh, setVh] = useState(0);

  // Resolve the step's target, skipping any whose element isn't present.
  const resolve = useCallback(
    (from: number, dir: 1 | -1): number => {
      for (let n = from; n >= 0 && n < steps.length; n += dir) {
        const s = steps[n];
        if (!s.target) return n;
        if (document.querySelector(s.target)) return n;
      }
      return -1;
    },
    [steps]
  );

  // Land on the first showable step on mount.
  useEffect(() => {
    const first = resolve(0, 1);
    if (first < 0) onClose();
    else setI(first);
  }, [resolve, onClose]);

  const measure = useCallback(() => {
    setVw(window.innerWidth);
    setVh(window.innerHeight);
    const sel = steps[i]?.target;
    if (!sel) return setRect(null);
    const el = document.querySelector(sel);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [i, steps]);

  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  // Escape always exits — a tour you can't leave is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const step = steps[i];
  if (!step) return null;

  const next = () => {
    const n = resolve(i + 1, 1);
    if (n < 0) onClose();
    else setI(n);
  };
  const back = () => {
    const p = resolve(i - 1, -1);
    if (p >= 0) setI(p);
  };

  // Position the tooltip below the target when there's room, otherwise above.
  const TIP_W = Math.min(272, (vw || 320) - 24);
  let top = 90;
  let left = Math.max(12, ((vw || 320) - TIP_W) / 2);
  let caret: 'up' | 'down' | null = null;
  if (rect) {
    const below = rect.bottom + PAD + 12;
    const roomBelow = (vh || 600) - rect.bottom;
    if (roomBelow > 190) { top = below; caret = 'up'; }
    else { top = Math.max(12, rect.top - PAD - 12 - 168); caret = 'down'; }
    left = Math.min(Math.max(12, rect.left + rect.width / 2 - TIP_W / 2), (vw || 320) - TIP_W - 12);
  }

  // How many steps will actually show, so the counter doesn't lie about skipped ones.
  const showable = steps.filter((s) => !s.target || document.querySelector(s.target));
  const pos = showable.indexOf(step) + 1;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} role="dialog" aria-label="Product tour">
      {/* The dim + cutout in one element: a huge spread shadow around a transparent hole. */}
      <div
        onClick={next}
        style={
          rect
            ? {
                position: 'fixed',
                top: rect.top - PAD,
                left: rect.left - PAD,
                width: rect.width + PAD * 2,
                height: rect.height + PAD * 2,
                borderRadius: 10,
                boxShadow: `0 0 0 9999px rgba(15,16,31,0.62)`,
                border: `2px solid ${PURPLE}`,
                transition: 'top .22s ease, left .22s ease, width .22s ease, height .22s ease',
                pointerEvents: 'auto',
              }
            : { position: 'fixed', inset: 0, background: 'rgba(15,16,31,0.62)', pointerEvents: 'auto' }
        }
      />

      <div
        style={{
          position: 'fixed', top, left, width: TIP_W,
          background: '#fff', borderRadius: 12, padding: '12px 13px 11px',
          boxShadow: '0 18px 44px rgba(15,16,31,0.34)',
          fontFamily: 'inherit', transition: 'top .22s ease, left .22s ease',
        }}
      >
        {caret && (
          <span
            style={{
              position: 'absolute', left: rect ? Math.min(Math.max(14, rect.left + rect.width / 2 - left - 6), TIP_W - 26) : TIP_W / 2 - 6,
              [caret === 'up' ? 'top' : 'bottom']: -6,
              width: 12, height: 12, background: '#fff', transform: 'rotate(45deg)',
            } as React.CSSProperties}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <strong style={{ fontSize: 13.5, color: '#0f172a', flex: 1 }}>{step.title}</strong>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: '#94a3b8' }}>{pos}/{showable.length}</span>
        </div>
        <p style={{ fontSize: 12.5, lineHeight: 1.5, color: '#475569', margin: '5px 0 10px' }}>{step.body}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={onClose} style={ghost}>Skip</button>
          <span style={{ flex: 1 }} />
          {pos > 1 && <button onClick={back} style={ghost}>Back</button>}
          <button onClick={next} style={primary}>{pos === showable.length ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}

const ghost: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#64748b', background: 'none',
  border: 'none', cursor: 'pointer', padding: '5px 7px',
};
const primary: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: '#fff', background: PURPLE,
  border: 'none', borderRadius: 7, cursor: 'pointer', padding: '6px 13px',
};
