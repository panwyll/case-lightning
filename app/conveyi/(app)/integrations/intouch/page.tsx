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
  canManage: boolean;
  credentials: { source: 'firm' | 'deployment'; apiBaseUrl: string; authBaseUrl: string | null; clientId: string; hasSecret: boolean; hasApiKey: boolean; hasWebhookSecret: boolean } | null;
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

const CSS = `
.it-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;margin-top:14px;max-width:760px}
.it-form label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:#475569}
.it-form input{padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13.5px;font-family:inherit;color:#0f172a;background:#fff}
.it-form input:focus{outline:2px solid #c4b5fd;border-color:#8b5cf6}
.it-form .wide{grid-column:1 / -1}
.it-acts{grid-column:1 / -1;display:flex;gap:8px}
@media (max-width:700px){.it-form{grid-template-columns:1fr}}
`;

interface Form { apiBaseUrl: string; authBaseUrl: string; clientId: string; clientSecret: string; apiKey: string; webhookSecret: string }
const EMPTY: Form = { apiBaseUrl: '', authBaseUrl: '', clientId: '', clientSecret: '', apiKey: '', webhookSecret: '' };

/** The firm's InTouch details. Secrets already saved show as dots and stay unless retyped. */
function ConnectForm({ s, busy, onConnect }: { s: Status; busy: boolean; onConnect: (f: Form) => void }) {
  const cr = s.credentials;
  const [f, setF] = useState<Form>({ ...EMPTY, apiBaseUrl: cr?.apiBaseUrl ?? '', authBaseUrl: cr?.authBaseUrl ?? '', clientId: cr?.clientId ?? '' });
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const saved = '••••••••';
  const ready = !!f.apiBaseUrl.trim() && !!f.clientId.trim() && (!!f.clientSecret.trim() || !!cr?.hasSecret);
  return (
    <form className="it-form" onSubmit={(e) => { e.preventDefault(); if (ready) onConnect(f); }}>
      <label className="wide">InTouch API address<input id="it-api" type="url" required placeholder="https://" value={f.apiBaseUrl} onChange={set('apiBaseUrl')} autoComplete="off" /></label>
      <label>Client ID<input id="it-client-id" required value={f.clientId} onChange={set('clientId')} autoComplete="off" /></label>
      <label>Client secret<input id="it-client-secret" type="password" placeholder={cr?.hasSecret ? saved : ''} value={f.clientSecret} onChange={set('clientSecret')} autoComplete="new-password" /></label>
      <label>API key<input id="it-api-key" type="password" placeholder={cr?.hasApiKey ? saved : 'If InTouch issued one'} value={f.apiKey} onChange={set('apiKey')} autoComplete="new-password" /></label>
      <label>Webhook secret<input id="it-webhook-secret" type="password" placeholder={cr?.hasWebhookSecret ? saved : 'If InTouch issued one'} value={f.webhookSecret} onChange={set('webhookSecret')} autoComplete="new-password" /></label>
      <label className="wide">Sign-in address<input id="it-auth" type="url" placeholder="Only if InTouch gave you a separate one" value={f.authBaseUrl} onChange={set('authBaseUrl')} autoComplete="off" /></label>
      <div className="it-acts"><button className="eg-btn primary" type="submit" disabled={busy || !ready}>{busy ? 'Connecting…' : 'Connect InTouch'}</button></div>
    </form>
  );
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
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">InTouch</h1>
        </div>
        <a className="eg-btn" href="/conveyi/cases">← Caseload</a>
      </div>

      {err && <div className="eg-err">{err}</div>}
      {!s && !err && <div className="eg-sub">Loading…</div>}

      {s && (
        <>
          <div className="eg-card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`eg-chip ${connected ? 'ok' : 'muted'}`}>{connected ? 'Connected' : c?.status === 'ERROR' ? 'Error' : 'Not connected'}</span>
              {c?.accountName && <b>{c.accountName}</b>}
              {connected && <span className="eg-sub">{c?.webhookSubId ? 'Webhooks registered' : 'Polling every 15 minutes (no webhook)'}</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {connected && s.canManage && (
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
            {c?.statusDetail && <div className={c.status === 'ERROR' ? 'eg-err' : 'eg-sub'} style={{ marginTop: 8 }}>{c.statusDetail}</div>}
            {!connected && s.canManage && (
              <ConnectForm s={s} busy={busy === 'Connect'} onConnect={(f) => act('Connect', async () => {
                const r = await api<{ authorizeUrl?: string }>('/integrations/intouch/connect', { method: 'POST', body: JSON.stringify(f) });
                if (r?.authorizeUrl) window.location.assign(r.authorizeUrl);
              })} />
            )}
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
