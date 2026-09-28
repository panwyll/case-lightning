'use client';
import { useState } from 'react';
import { RefreshCw } from '@/app/shared/icons';
import { forgetApiCache } from '@/app/shared/engine/api';

/** A small refresh beside a page heading: reloads the list in place from the server (the read cache is dropped first), no page reload. */
export function RefreshButton({ onRefresh, label = 'Refresh' }: { onRefresh: () => Promise<unknown> | void; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" aria-label={label} title={label} disabled={busy}
      onClick={async () => { setBusy(true); try { forgetApiCache(); await onRefresh(); window.dispatchEvent(new Event('conveyi:counts')); } finally { setBusy(false); } }}
      style={{ border: 0, background: 'none', padding: 4, margin: 0, display: 'inline-flex', alignItems: 'center', color: busy ? '#5A27E0' : '#94a3b8', cursor: busy ? 'default' : 'pointer', borderRadius: 6 }}>
      <span style={{ display: 'inline-flex', animation: busy ? 'rb-spin .8s linear infinite' : undefined }}><RefreshCw size={16} /></span>
      <style>{'@keyframes rb-spin{to{transform:rotate(360deg)}}'}</style>
    </button>
  );
}
