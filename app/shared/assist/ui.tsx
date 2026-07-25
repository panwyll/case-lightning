'use client';
// Shared presentational primitives for the assist UI (icons, cards, form fields),
// used by both the Outlook taskpane and the web inbox.
import { useState } from 'react';
import type * as React from 'react';
import { S } from './styles';

// ── Small presentational helpers ─────────────────────────────────────────────
// Bytes → a short human size for the file-explorer rows.
export function fmtSize(n: number | null): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Turn an UPPER_SNAKE enum or snake_case key into human text for display:
// "IN_PROGRESS" → "In progress". The raw value stays the source of truth.
export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}

// Small inline SVG icons, stroke-based to match the header gear — keeps the

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    reply: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 5 5v4" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 8 9 6 9-6" /></>,
    home: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
    file: <><path d="M14 3v5h5" /><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /></>,
    upload: <><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></>,
    refresh: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>,
    history: <><path d="M3 3v6h6" /><path d="M3.5 9a9 9 0 1 0 2.1-3.4L3 9" /><path d="M12 8v5l4 2" /></>,
    fileCheck: <><path d="M14 3v5h5" /><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 14 2 2 4-4" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
    external: <><path d="M14 3h7v7" /><path d="M21 3l-9 9" /><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
    clip: <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.9-2.9l7.6-7.6" />,
    check: <path d="M20 6 9 17l-5-5" />,
    user: <><circle cx="12" cy="8" r="4" /><path d="M5 21a7 7 0 0 1 14 0" /></>,
    minus: <path d="M5 12h14" />,
    chart: <><path d="M4 4v16h16" /><path d="M8 17v-5" /><path d="M13 17V8" /><path d="M18 17v-3" /></>,
    sparkle: <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />,
    alert: <><path d="M10.3 4 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 4a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
    gift: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" /><path d="M12 8v14" /><path d="M12 8H7.5a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8z" /><path d="M12 8h4.5a2.5 2.5 0 0 0 0-5C13 3 12 8 12 8z" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    housePlus: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.6V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.6" /><path d="M12 11.5v5" /><path d="M9.5 14h5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {paths[name]}
    </svg>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return <section style={S.card}>{children}</section>;
}

export function LoadingRow({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px' }}>
      <span style={S.spinner} />
      <span style={{ fontSize: 12, color: '#64748b' }}>{label}</span>
    </div>
  );
}

// The House tab's property record: controlled fields with validation and an
// explicit Save / Discard (no silent save-on-blur). Keyed by matter id by the
// caller so it re-initialises when the matter changes. Buyers/sellers are
// read-only (the matter PATCH doesn't accept them); stage/status are enum selects

export function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={S.card}>
      <button style={S.sectionHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={{ ...S.label, marginBottom: 0 }}>
          {title}
          {count ? <span style={S.sectionCount}>{count}</span> : null}
        </span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{open ? '▲' : '▾'}</span>
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </section>
  );
}
export function Label({ children }: { children: React.ReactNode }) {
  return <div style={S.label}>{children}</div>;
}
export function SubLabel({ children }: { children: React.ReactNode }) {
  return <div style={S.subLabel}>{children}</div>;
}
export function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label style={{ display: 'block', flex: 1, minWidth: 120 }}>
      <span style={S.fieldLabel}>{label}</span>
      <input style={S.input} type={type ?? 'text'} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// Chip input: type a value and press Enter (or comma) to add it; multiple allowed.
export function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = [...values];
    for (const p of raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      if (!next.includes(p)) next.push(p);
    }
    if (next.length !== values.length) onChange(next);
    setDraft('');
  };
  return (
    <label style={{ display: 'block', marginBottom: 6 }}>
      <span style={S.fieldLabel}>{label}</span>
      <div style={S.tagBox}>
        {values.map((v, i) => (
          <span key={i} style={S.tag}>
            {v}
            <button type="button" style={S.tagX} onClick={() => onChange(values.filter((_, j) => j !== i))} aria-label={`Remove ${v}`}>
              ×
            </button>
          </span>
        ))}
        <input
          style={S.tagInput}
          value={draft}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
        />
      </div>
    </label>
  );
}

// ── Inline styles (self-contained so the taskpane renders the same regardless
