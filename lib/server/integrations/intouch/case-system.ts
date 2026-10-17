/**
 * InTouch as the firm's case system (lib/server/integrations/case-system.ts): a new case is created with InTouch's
 * documented `POST /api/v2/public/matters` ({ data: { <data marker>: value } } → { matterGuid, matterLink }). Which data
 * marker takes each field is the firm's own InTouch set-up, so it is set per firm (Tools → InTouch → Create Cases In
 * InTouch, `intouch_connection.create_markers`); creating stays off until the reference, client and address markers are
 * filled in. Our reference goes in as the firm's reference, so the sync links the case even before its id is stored.
 */
import { query, queryOne, runAsSystem } from '../../db';
import type { CaseSystem, NewCase } from '../case-system';
import { CREATE_FIELDS, markersReady, type CreateMarkers } from './create-fields';
export { CREATE_FIELDS, markersReady, type CreateMarkers };

/** The data InTouch is sent: each filled-in marker with the case's value for it. */
export function matterData(c: NewCase, m: CreateMarkers): Record<string, string> {
  const value: Record<string, string | null> = {
    reference: c.reference, clientName: c.clientNames.join(' & ') || null, clientEmail: c.clientEmail, address: c.propertyAddress, postcode: c.postcode,
    side: c.side === 'sale' ? 'Sale' : c.side === 'remortgage' ? 'Remortgage' : 'Purchase', feeEarner: c.feeEarnerEmail ?? c.feeEarnerName,
  };
  const data: Record<string, string> = {};
  for (const f of CREATE_FIELDS) { const marker = m[f.key]?.trim(); const v = value[f.key]; if (marker && v) data[marker] = v; }
  if (m.template?.marker?.trim() && m.template.value?.trim()) data[m.template.marker.trim()] = m.template.value.trim();
  return data;
}

async function markersOf(tenantId: string): Promise<CreateMarkers | null> {
  const r = await runAsSystem(() => queryOne<{ status: string; create_markers: CreateMarkers | null }>(`select status, create_markers from intouch_connection where tenant_id = $1`, [tenantId])).catch(() => null);
  return r?.status === 'CONNECTED' ? r.create_markers ?? {} : null;
}

export const inTouchCaseSystem: CaseSystem = {
  key: 'intouch',
  label: 'InTouch',
  ready: async (tenantId) => markersReady(await markersOf(tenantId)),
  linked: async (tenantId, matterId) => !!(await runAsSystem(() => queryOne<{ intouch_case_id: string | null }>(`select intouch_case_id from matter where id = $1 and tenant_id = $2`, [matterId, tenantId])))?.intouch_case_id,
  create: async (tenantId, c) => {
    const m = await markersOf(tenantId);
    if (!markersReady(m)) throw new Error('the InTouch fields for a new case are not set up');
    const missing = CREATE_FIELDS.filter((f) => f.required && !matterData(c, m!)[m![f.key]!.trim()]).map((f) => f.label.toLowerCase());
    if (missing.length) throw new Error(`the case has no ${missing.join(', ')}`);
    const { inTouchClient } = await import('./adapters');
    const api = await inTouchClient(tenantId);
    const r = await api.saveMatter(matterData(c, m!));
    if (!r.matterGuid) throw new Error('InTouch did not return the new matter');
    await runAsSystem(() => query(`update matter set intouch_case_id = $3, intouch_synced_at = now() where id = $1 and tenant_id = $2 and intouch_case_id is null`, [c.matterId, tenantId, r.matterGuid]));
    return { externalId: r.matterGuid, link: r.matterLink };
  },
};
