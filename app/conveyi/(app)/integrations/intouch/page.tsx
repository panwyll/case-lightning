'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { fmtWhen } from '@/app/shared/engine/types';

/**
 * InTouch — connection status, what it has brought in, and the one switch that matters:
 * whether the engine pushes milestones to the client's portal. Reading from InTouch is
 * harmless; writing to something a client sees is not, so it is off until an admin
 * turns it on deliberately.
 */
interface Status {
  configured: boolean;
  connection: {
    status: string;
    statusDetail: string | null;
    accountName: string | null;
    accountId: string | null;
    webhookSubId: string | null;
    lastSyncAt: string | null;
    lastSyncDetail: { cases: number; created: number; parties: number; identityChecks: number; forms: number; documents: number; milestones: number; skipped: number; errors: string[] } | null;
    connectedAt: string | null;
    milestonesEnabled: boolean;
  } | null;
  counts: { cases: number; identityChecks: number; forms: number; documents: number };
}

export default function InTouchPage() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await api<Status>('/integrations/intouch/status'));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not read the InTouch status.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  };

  const c = s?.connection ?? null;
  const connected = c?.status === 'CONNECTED';
  const d = c?.lastSyncDetail ?? null;

  return (
    <div className="eg" style={{ maxWidth: 880, margin: '0 auto', padding: '16px 16px 48px' }}>
      <style>{ENGINE_CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">InTouch</h1>
        </div>
        <a className="eg-btn" href="/conveyi/cases">← Caseload</a>
      </div>

      {err && <div className="eg-err">{err}</div>}
      {!s && !err && <div className="eg-sub">Loading…</div>}

      {s && !s.configured && (
        <div className="eg-card" style={{ padding: 14 }}>
          <b>Not configured on this deployment.</b>
          <p className="eg-sub" style={{ margin: '6px 0 0' }}>
            InTouch needs <code>INTOUCH_API_BASE_URL</code>, <code>INTOUCH_CLIENT_ID</code> and <code>INTOUCH_CLIENT_SECRET</code>
            {' '}before a firm can connect. See <code>docs/intouch-integration.md</code>.
          </p>
        </div>
      )}

      {s?.configured && (
        <>
          <div className="eg-card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`eg-chip ${connected ? 'ok' : 'muted'}`}>{connected ? 'Connected' : c?.status === 'ERROR' ? 'Error' : 'Not connected'}</span>
              {c?.accountName && <b>{c.accountName}</b>}
              {connected && <span className="eg-sub">{c?.webhookSubId ? 'Webhooks registered' : 'Polling every 15 minutes (no webhook)'}</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {!connected && (
                  <button className="eg-btn primary" disabled={!!busy} onClick={() => act('Connect', async () => {
                    const r = await api<{ authorizeUrl?: string }>('/integrations/intouch/connect', { method: 'POST', body: '{}' });
                    if (r?.authorizeUrl) window.location.assign(r.authorizeUrl);
                  })}>
                    {busy === 'Connect' ? 'Connecting…' : 'Connect InTouch'}
                  </button>
                )}
                {connected && (
                  <>
                    <button className="eg-btn" disabled={!!busy} onClick={() => act('Sync', () => api('/integrations/intouch/sync', { method: 'POST', body: '{}' }))}>
                      {busy === 'Sync' ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button className="eg-btn" disabled={!!busy} onClick={() => act('Full sync', () => api('/integrations/intouch/sync?full=1', { method: 'POST', body: '{}' }))}>
                      Re-read everything
                    </button>
                    <button className="eg-btn" disabled={!!busy} onClick={() => act('Disconnect', () => api('/integrations/intouch/disconnect', { method: 'POST', body: '{}' }))}>
                      Disconnect
                    </button>
                  </>
                )}
              </span>
            </div>
            {c?.statusDetail && <div className="eg-sub" style={{ marginTop: 8 }}>{c.statusDetail}</div>}
            {connected && <div className="eg-sub" style={{ marginTop: 8 }}>Connected {fmtWhen(c!.connectedAt ?? '')}{c?.lastSyncAt ? ` · last sync ${fmtWhen(c.lastSyncAt)}` : ' · not synced yet'}</div>}
          </div>

          {connected && (
            <>
              <div className="eg-card" style={{ padding: 14, marginBottom: 12 }}>
                <b>Client milestones</b>
                <div style={{ height: 8 }} />
                <button
                  className={`eg-btn${c!.milestonesEnabled ? '' : ' primary'}`}
                  disabled={!!busy}
                  onClick={() => act('Milestones', () => api('/integrations/intouch/milestones', { method: 'POST', body: JSON.stringify({ enabled: !c!.milestonesEnabled }) }))}
                >
                  {c!.milestonesEnabled ? 'Turn milestone updates off' : 'Turn milestone updates on'}
                </button>
                <span className="eg-sub" style={{ marginLeft: 10 }}>{c!.milestonesEnabled ? 'On' : 'Off'}</span>
              </div>

              <div className="eg-card" style={{ padding: 14 }}>
                <b>What has come across</b>
                <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 10 }}>
                  {([['Cases', s.counts.cases], ['Identity checks', s.counts.identityChecks], ['Forms', s.counts.forms], ['Documents', s.counts.documents]] as const).map(([label, n]) => (
                    <div key={label}>
                      <div style={{ fontSize: 22, fontWeight: 800 }}>{n}</div>
                      <div className="eg-sub">{label}</div>
                    </div>
                  ))}
                </div>
                {d && (
                  <div className="eg-sub" style={{ marginTop: 12 }}>
                    Last sync: {d.cases} case{d.cases === 1 ? '' : 's'} ({d.created} new), {d.identityChecks} identity check{d.identityChecks === 1 ? '' : 's'}, {d.forms} form{d.forms === 1 ? '' : 's'},{' '}
                    {d.documents} document{d.documents === 1 ? '' : 's'}, {d.milestones} milestone{d.milestones === 1 ? '' : 's'} pushed
                    {d.skipped ? `, ${d.skipped} skipped` : ''}.
                  </div>
                )}
                {d?.errors?.length ? (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#b91c1c', fontSize: 12.5 }}>
                    {d.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                ) : null}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
