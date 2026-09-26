'use client';

/** Whose matters a page shows. A select says what it is and what the other choice is. */
export type Scope = 'all' | 'mine';

export function ScopeSelect({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  return (
    <select
      aria-label="Whose cases"
      value={value}
      onChange={(e) => onChange(e.target.value as Scope)}
      style={{ border: '1px solid #d0d5dd', borderRadius: 8, padding: '6px 28px 6px 10px', fontSize: 13, fontWeight: 600, color: '#0f172a', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
    >
      <option value="all">Whole team</option>
      <option value="mine">My cases</option>
    </select>
  );
}
