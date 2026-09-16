'use client';
import { use } from 'react';
import { EnginePanel } from '../../shared/engine/EnginePanel';

/** Standalone engine view for one matter — deep-linkable from the decision feed and the Outlook taskpane. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

export default function EngineMatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = use(params);
  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '24px 16px', fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif", color: '#0f172a' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Engine</h1>
        <a href="/decisions" style={{ fontSize: 13, color: '#5A27E0', fontWeight: 600 }}>All decisions →</a>
      </div>
      <EnginePanel matterId={matterId} api={api} />
    </div>
  );
}
