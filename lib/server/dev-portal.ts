/** Local development only: the client portal over the dev harness's in-memory case, on /portal/dev-preview-portal-000000 (code 123456). */
import { devHarness, DEV_MATTER, DEV_TENANT } from './dev-harness';
import { clientPortalView } from './engine/client-portal';
import { clientHelp } from './engine/client-faq';

export const DEV_PORTAL_TOKEN = 'dev-preview-portal-000000';
export const DEV_PORTAL_CODE = '123456';
/** Preview a firm's look with DEV_PORTAL_COLOUR=#1f4e79 and DEV_PORTAL_LOGO=https://… */
export const DEV_BRAND = { logoUrl: process.env.DEV_PORTAL_LOGO ?? null, colour: process.env.DEV_PORTAL_COLOUR ?? null };
export const isDevPortal = (token: string) => process.env.NODE_ENV === 'development' && token === DEV_PORTAL_TOKEN;

const g = globalThis as unknown as { __devPortalUploads?: Array<{ id: string; name: string; at: string; from: 'you' }>; __devFeedback?: boolean };
export const devFeedbackGiven = () => { g.__devFeedback = true; };
export const devPortalUploads = () => (g.__devPortalUploads ??= []);

export async function devPortalContext() {
  const h = await devHarness();
  const state = await h.svc.getState(DEV_TENANT, DEV_MATTER);
  const view = clientPortalView(state, new Date(), { idProviderSendsLink: false });
  return {
    help: clientHelp(view),
    feedback: g.__devFeedback ? null : { milestone: 'exchanged' as const, kind: 'csat' as const },
    status: 'open',
    firmName: 'Your Firm LLP',
    brand: DEV_BRAND,
    propertyAddress: '14 Oak Street, Leeds LS1 2AB',
    clientNames: 'Priya',
    handler: { name: 'Peter Anwyll', email: 'peter@yourfirm.test', phone: '0113 496 0000' },
    firmPhone: '0113 496 0000',
    view,
    history: [
      { id: 'dev-m2', subject: 'Your purchase of 14 Oak Street: your report on title', body: 'Dear Priya,\n\nYour report on title is attached. It sets out what we have found about the property and the contract. Please read it and tell us if anything is unclear.\n\nKind regards,\nPeter', at: new Date(Date.now() - 3 * 86_400_000).toISOString() },
      { id: 'dev-m1', subject: 'Your purchase of 14 Oak Street: welcome', body: 'Dear Priya,\n\nThank you for asking us to act for you. Peter Anwyll will look after your purchase. The first thing we need is your ID check.\n\nKind regards,\nPeter', at: new Date(Date.now() - 12 * 86_400_000).toISOString() },
    ],
    documents: [...devPortalUploads(), { id: 'dev-1', name: 'Report on title.docx', at: new Date(Date.now() - 3 * 86_400_000).toISOString(), from: 'us' as const }, { id: 'dev-2', name: 'Completion statement.docx', at: new Date(Date.now() - 86_400_000).toISOString(), from: 'us' as const }],
  };
}
