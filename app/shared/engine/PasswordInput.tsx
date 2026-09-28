'use client';
import { useState, type CSSProperties } from 'react';

/** A file password: hidden by default, with a toggle to see what was typed (it is a document password, not a login). */
export function PasswordInput({ value, onChange, onEnter, onEscape, autoFocus, className, style }: { value: string; onChange: (v: string) => void; onEnter?: () => void; onEscape?: () => void; autoFocus?: boolean; className?: string; style?: CSSProperties }) {
  const [shown, setShown] = useState(false);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', position: 'relative', ...style }}>
      <input
        className={className}
        type={shown ? 'text' : 'password'}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder="Password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && value) onEnter?.(); if (e.key === 'Escape') onEscape?.(); }}
        style={{ width: '100%', paddingRight: 52, boxSizing: 'border-box' }}
      />
      <button type="button" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide Password' : 'Show Password'} aria-pressed={shown}
        style={{ position: 'absolute', right: 4, border: 0, background: 'none', color: '#5A27E0', fontWeight: 700, fontSize: 11.5, cursor: 'pointer', padding: '4px 6px', fontFamily: 'inherit' }}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}
