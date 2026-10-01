'use client';
import { Spin } from '@/app/shared/engine/BusyButton';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { fmtWhen } from '@/app/shared/engine/types';
import { ArrowLeft } from '@/app/shared/icons';
import { paths } from '@/lib/paths';

/**
 * InfoTrack: the firm's own account (searches, official copies and ID checks are ordered on it and
 * billed to it), and the orders placed on it. Without one, searches come back as placeholders.
 */
interface Order { id: string; matterId: string; matterRef: string; kind: string; subject: string | null; reference: string; status: string; orderedAt: string; updatedAt: string }
interface Status {
  configured: boolean;
  canManage: boolean;
  connection: { status: string; statusDetail: string | null; connectedAt: string | null } | null;
  credentials: { baseUrl: string; clientId: string; tokenUrl: string | null; hasClientSecret: boolean; hasSigningSecret: boolean } | null;
  webhookUrl: string | null;
  orders: Order[];
}

const CSS = `
.it-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;margin-top:14px;max-width:760px}
.it-form label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:#475569}
.it-form input{padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13.5px;font-family:inherit;color:#0f172a;background:#fff}
.it-form input:focus{outline:2px solid #c4b5fd;border-color:#8b5cf6}
.it-acts{grid-column:1 / -1;display:flex;gap:8px}
.it-orders{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
.it-orders th{text-align:left;font-size:11.5px;font-weight:700;color:#64748b;padding:6px 8px;border-bottom:1px solid #e6e8ee}
.it-orders td{padding:8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
.it-orders a{color:#4f46e5;font-weight:700;text-decoration:none}
@media (max-width:700px){.it-form{grid-template-columns:1fr}}
`;

interface Form { baseUrl: string; clientId: string; clientSecret: string; tokenUrl: string; signingSecret: string }

/** The credentials InfoTrack issued the firm. Saved secrets stay unless retyped. */
function ConnectForm({ s, busy, onConnect, onCancel }: { s: Status; busy: boolean; onConnect: (f: Form) => void; onCancel?: () => void }) {
  const cr = s.credentials;
  const [f, setF] = useState<Form>({ baseUrl: cr?.baseUrl ?? '', clientId: cr?.clientId ?? '', clientSecret: '', tokenUrl: cr?.tokenUrl ?? '', signingSecret: '' });
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ready = !!f.baseUrl.trim() && !!f.clientId.trim() && (!!f.clientSecret.trim() || !!cr?.hasClientSecret);
  return (
    <form className="it-form" onSubmit={(e) => { e.preventDefault(); if (ready) onConnect(f); }}>
      <label>API Address<input type="url" required placeholder="https://" value={f.baseUrl} onChange={set('baseUrl')} autoComplete="off" /></label>
      <label>Token Address<input type="url" placeholder="Optional" value={f.tokenUrl} onChange={set('tokenUrl')} autoComplete="off" /></label>
      <label>Client ID<input required value={f.clientId} onChange={set('clientId')} autoComplete="off" /></label>
      <label>Client Secret<input type="password" placeholder={cr?.hasClientSecret ? 'Saved' : ''} value={f.clientSecret} onChange={set('clientSecret')} autoComplete="new-password" /></label>
      <label>Signing Secret<input type="password" placeholder={cr?.hasSigningSecret ? 'Saved' : 'Optional'} value={f.signingSecret} onChange={set('signingSecret')} autoComplete="new-password" /></label>
      <div className="it-acts">
        <button className="eg-btn primary" type="submit" disabled={busy || !ready}>{busy ? <Spin>Connecting…</Spin> : 'Connect'}</button>
        {onCancel && <button className="eg-btn" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

const SEARCH_LABEL: Record<string, string> = { LLC1: 'Local Land Charges', CON29: 'Local Authority', DRAINAGE_WATER: 'Drainage And Water', ENVIRONMENTAL: 'Environmental', CHANCEL: 'Chancel', MINING: 'Mining', FLOOD: 'Flood', HIGHWAYS: 'Highways', PLANNING: 'Planning' };
function orderLabel(o: Order): string {
  if (o.kind === 'search') return `${SEARCH_LABEL[o.subject ?? ''] ?? o.subject ?? ''} Search`;
  if (o.kind === 'official_copies') return `Official Copies${o.subject ? ` (${o.subject})` : ''}`;
  if (o.kind === 'id_check') return `ID Check${o.subject ? `: ${o.subject}` : ''}`;
  return o.kind.toUpperCase();
}
const STATUS: Record<string, [string, string]> = { ORDERED: ['Ordered', 'pending'], RETURNED: ['Returned', 'ok'], FAILED: ['Failed', 'bad'], CANCELLED: ['Cancelled', 'muted'] };

export default function InfoTrackPage() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await api<Status>('/integrations/infotrack/status'));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not read the InfoTrack status.');
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
      setEditing(false);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : `${label} failed.`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const c = s?.connection ?? null;
  const connected = c?.status === 'CONNECTED';
  const firmOwn = !!s?.credentials;
  const connect = (f: Form) => act('Connect', () => api('/integrations/infotrack/connect', { method: 'POST', body: JSON.stringify(f) }));

  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top">
        <h1 className="eg-h1">InfoTrack</h1>
        <a className="eg-btn" href={paths.integrations} style={{ gap: 6 }}><ArrowLeft /> Tools</a>
      </div>

      {err && <div className="eg-err">{err}</div>}
      {!s && !err && <div className="eg-sub">Loading…</div>}

      {s && (
        <>
          <div className="eg-card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`eg-chip ${connected ? 'ok' : c?.status === 'ERROR' ? 'bad' : 'muted'}`}>{connected ? 'Connected' : c?.status === 'ERROR' ? 'Needs Attention' : 'Not Connected'}</span>
              {connected && c?.connectedAt && <span className="eg-sub">Since {fmtWhen(c.connectedAt)}</span>}
              {connected && s.canManage && firmOwn && !editing && (
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <button className="eg-btn" disabled={!!busy} onClick={() => setEditing(true)}>Change Details</button>
                  <button className="eg-btn danger" disabled={!!busy} onClick={() => act('Disconnect', () => api('/integrations/infotrack/disconnect', { method: 'POST', body: '{}' }))}>
                    {busy === 'Disconnect' ? <Spin>Disconnecting…</Spin> : 'Disconnect'}
                  </button>
                </span>
              )}
            </div>
            {c?.statusDetail && <div className={c.status === 'ERROR' ? 'eg-err' : 'eg-sub'} style={{ marginTop: 8 }}>{c.statusDetail}</div>}
            {s.canManage && (!connected || editing) && (
              <ConnectForm key={editing ? 'edit' : 'new'} s={s} busy={busy === 'Connect'} onConnect={connect} onCancel={editing ? () => setEditing(false) : undefined} />
            )}
          </div>

          <div className="eg-card" style={{ padding: 14 }}>
            <b>Orders</b>
            {s.orders.length === 0 ? (
              <div className="eg-sub" style={{ marginTop: 8 }}>None yet.</div>
            ) : (
              <table className="it-orders">
                <thead><tr><th>Case</th><th>Order</th><th>Reference</th><th>Status</th><th>Ordered</th></tr></thead>
                <tbody>
                  {s.orders.map((o) => {
                    const [label, tone] = STATUS[o.status] ?? [o.status, 'muted'];
                    return (
                      <tr key={o.id}>
                        <td><a href={paths.matter(o.matterId)}>{o.matterRef}</a></td>
                        <td>{orderLabel(o)}</td>
                        <td style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12 }}>{o.reference}</td>
                        <td><span className={`eg-chip ${tone}`}>{label}</span></td>
                        <td>{fmtWhen(o.orderedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
