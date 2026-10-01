/** Local development only: the client portal over the dev harness's in-memory case, on /portal/dev-preview-portal-000000 (code 123456). */
import { devHarness, DEV_MATTER, DEV_TENANT } from './dev-harness';
import { clientPortalView } from './engine/client-portal';

export const DEV_PORTAL_TOKEN = 'dev-preview-portal-000000';
export const DEV_PORTAL_CODE = '123456';
export const isDevPortal = (token: string) => process.env.NODE_ENV === 'development' && token === DEV_PORTAL_TOKEN;

const g = globalThis as unknown as { __devPortalUploads?: Array<{ id: string; name: string; at: string; from: 'you' }> };
export const devPortalUploads = () => (g.__devPortalUploads ??= []);

export async function devPortalContext() {
  const h = await devHarness();
  const state = await h.svc.getState(DEV_TENANT, DEV_MATTER);
  return {
    status: 'open',
    firmName: 'Your Firm LLP',
    propertyAddress: '14 Oak Street, Leeds LS1 2AB',
    clientNames: 'Priya',
    handler: { name: 'Peter Anwyll', email: 'peter@yourfirm.test', phone: '0113 496 0000' },
    firmPhone: '0113 496 0000',
    view: clientPortalView(state, new Date(), { idProviderSendsLink: false }),
    documents: [...devPortalUploads(), { id: 'dev-1', name: 'Report on title.docx', at: new Date(Date.now() - 3 * 86_400_000).toISOString(), from: 'us' as const }, { id: 'dev-2', name: 'Completion statement.docx', at: new Date(Date.now() - 86_400_000).toISOString(), from: 'us' as const }],
  };
}
