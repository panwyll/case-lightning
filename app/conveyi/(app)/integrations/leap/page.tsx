'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { STAGE_LABEL, ago, fmtWhen } from '@/app/shared/engine/types';

/**
 * LEAP as the backend — connection status, what has been mirrored, what the last sync
 * did, and the two buttons an admin needs: connect (OAuth) and sync now.
 */
interface Status {
  configured: boolean;
  missing: string[];
  connection: { status: string; statusDetail: string | null; firmName: string | null; firmId: string | null; region: string | null; webhookSubId: string | null; lastSyncAt: string | null; lastSyncDetail: { at: string; matters: { seen: number; created: number; enrolled: number; closed: number }; documents: { seen: number; created: number; ingested: number }; contacts: number; errors: string[] } | null; connectedAt: string | null } | null;
  counts: { matters: number; enrolled: number; shadow: number; documents: number; contacts: number; tasks: number; notes: number } | null;
  matters: Array<{ matterId: string; matterRef: string; propertyAddress: string; leapMatterId: string; syncedAt: string | null; shadowMode: boolean; stage: string | null }>;
}

export default function LeapPage() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setS(await api<Status>('/integrations/leap/status'));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the LEAP status.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const sync = async (full: boolean) => {
    setBusy(true);
    try {
      await api(`/integrations/leap/sync?full=${full ? 1 : 0}`, { method: 'POST' });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!window.confirm('Disconnect LEAP? Mirrored matters stay; nothing is deleted.')) return;
    await api('/integrations/leap/disconnect', { method: 'POST' }).catch(() => {});
    await load();
  };
  const c = s?.connection ?? null;
  const connected = c?.status === 'CONNECTED';
  const d = c?.lastSyncDetail ?? null;
  return (
    <div className="eg" style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px 40px' }}>
      <style>{ENGINE_CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">LEAP</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {s?.configured && !connected && <a className="eg-btn accent" href="/api/v1/integrations/leap/connect">Connect LEAP</a>}
          {connected && <button className="eg-btn primary" disabled={busy} onClick={() => sync(false)}>{busy ? 'Syncing…' : 'Sync now'}</button>}
          {connected && <button className="eg-btn" disabled={busy} onClick={() => sync(true)}>Full sync</button>}
          {connected && <button className="eg-btn danger" disabled={busy} onClick={disconnect}>Disconnect</button>}
          <a className="eg-btn" href="/conveyi/decisions">Queue</a>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {s && !s.configured && (
        <div className="eg-empty" style={{ textAlign: 'left' }}>
          <b>LEAP is not configured.</b> Set the following and redeploy: <code>{s.missing.join(', ')}</code>. The hosts come from LEAP's developer console for your region; the API reference is registration-gated.
        </div>
      )}
      {s?.configured && (
        <>
          <div className="eg-card" style={{ padding: '12px 14px', marginBottom: 12, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`eg-chip ${connected ? 'ok' : c?.status === 'ERROR' ? 'bad' : 'muted'}`}>{c?.status ?? 'NOT CONNECTED'}</span>
            <span>{c?.firmName ? <b>{c.firmName}</b> : 'No firm connected'}{c?.region ? ` · ${c.region.toUpperCase()}` : ''}{c?.connectedAt ? ` · connected ${fmtWhen(c.connectedAt)}` : ''}</span>
            <span className="eg-sub">{c?.webhookSubId ? `webhook ${c.webhookSubId}` : 'no webhook subscription — polling only'}{c?.lastSyncAt ? ` · last sync ${ago(c.lastSyncAt)} ago` : ''}</span>
            {c?.statusDetail && <span className="eg-chip bad">{c.statusDetail}</span>}
          </div>
          {s.counts && (
            <div className="eg-tiles">
              <div className="eg-tile"><b>{s.counts.matters}</b><span>matters mirrored</span></div>
              <div className="eg-tile"><b>{s.counts.enrolled}</b><span>in the engine</span></div>
              <div className="eg-tile"><b>{s.counts.shadow}</b><span>in shadow mode</span></div>
              <div className="eg-tile"><b>{s.counts.documents}</b><span>documents (bytes in LEAP)</span></div>
              <div className="eg-tile"><b>{s.counts.contacts}</b><span>parties</span></div>
              <div className="eg-tile"><b>{s.counts.tasks}</b><span>tasks written to LEAP</span></div>
              <div className="eg-tile"><b>{s.counts.notes}</b><span>file notes written</span></div>
            </div>
          )}
          {d && (
            <div className="eg-card" style={{ padding: '12px 14px', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#64748b', marginBottom: 6 }}>Last sync · {fmtWhen(d.at)}</div>
              <div style={{ fontSize: 13 }}>
                Matters: {d.matters.seen} seen · {d.matters.created} new · {d.matters.enrolled} enrolled · {d.matters.closed} closed. Documents: {d.documents.seen} seen · {d.documents.created} new · {d.documents.ingested} handed to the engine. Parties: {d.contacts}.
              </div>
              {d.errors.length > 0 && <div className="eg-err">{d.errors.slice(0, 5).join(' · ')}{d.errors.length > 5 ? ` · +${d.errors.length - 5} more` : ''}</div>}
            </div>
          )}
          <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#64748b', margin: '0 0 8px' }}>Mirrored matters</h2>
          {s.matters.length === 0 && <div className="eg-empty">Nothing mirrored yet. Connect LEAP, or run a full sync.</div>}
          {s.matters.length > 0 && (
            <div className="eg-card">
              {s.matters.map((m) => (
                <a key={m.matterId} className="q-row" href={m.shadowMode ? `/engine/${m.matterId}/shadow` : `/engine/${m.matterId}`}>
                  <div style={{ minWidth: 0 }}>
                    <div className="q-addr">{m.propertyAddress}</div>
                    <div className="q-ref">{m.matterRef} · LEAP {m.leapMatterId}</div>
                  </div>
                  {m.stage ? <span className="eg-chip stage">{STAGE_LABEL[m.stage] ?? m.stage}</span> : <span className="eg-chip muted">not enrolled</span>}
                  <div className="q-cell">{m.shadowMode ? <span className="eg-chip shadow">shadow</span> : m.stage ? <span className="eg-chip ok">live</span> : <span className="eg-chip muted">mirror only</span>}</div>
                  <div className="q-cell hide">synced {ago(m.syncedAt)} ago</div>
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
