'use client';
import { ArrowLeft } from '@/app/shared/icons';

/** The way back to the page this one was opened from, left of the page title. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} aria-label={label} title={label} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#334155', textDecoration: 'none', flex: 'none', verticalAlign: 'middle', marginRight: 10 }}>
      <ArrowLeft size={18} />
    </a>
  );
}
