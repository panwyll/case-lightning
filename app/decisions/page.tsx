'use client';
import { useCallback, useState } from 'react';
import { DecisionFeed } from '../shared/engine/DecisionFeed';

/**
 * Case-handler decision feed (component #6, "Spark Notes"). The page is deliberately
 * only the feed: everything routine has been handled and logged by the engine, so
 * what is here is exactly the set of things that need a person. `?matterId=` scopes it.
 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

export default function DecisionsPage() {
  const [count, setCount] = useState<number | null>(null);
  const matterId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('matterId') ?? undefined : undefined;
  const onCount = useCallback((n: number) => setCount(n), []);
  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px', fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif", color: '#0f172a' }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 4px' }}>Decisions{count !== null ? ` (${count})` : ''}</h1>
      <p style={{ color: '#64748b', fontSize: 13, margin: '0 0 20px' }}>Only what needs a person. Each item shows the engine's pre-digested summary and the source it is drawn from. Open the source before you decide — the options unlock once you have, and your decision is logged against your name.</p>
      <DecisionFeed api={api} matterId={matterId} onCount={onCount} />
    </div>
  );
}
