/** Local development only: the client portal over the dev harness's in-memory case, on /portal/dev-preview-portal-000000 (code 123456). */
import { devHistory, devPurchase, DEV_CASE } from './dev-portal-case';
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
  // A purchase part-way through, run by the real engine in memory, with the messages it sent rendered by the real templates.
  const h = await devPurchase();
  const state = await h.svc.getState(h.tenantId, h.matterId);
  const view = clientPortalView(state, new Date(), { idProviderSendsLink: false });
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  return {
    help: clientHelp(view),
    feedback: null,
    status: 'open',
    firmName: DEV_CASE.firmName,
    brand: DEV_BRAND,
    propertyAddress: DEV_CASE.propertyAddress,
    clientNames: DEV_CASE.clientFirstName,
    handler: DEV_CASE.handler,
    firmPhone: DEV_CASE.handler.phone,
    view,
    history: await devHistory(),
    documents: [
      ...devPortalUploads(),
      { id: 'dev-4', name: 'Survey report.pdf', at: ago(8), from: 'you' as const },
      { id: 'dev-3', name: 'Mortgage agreement in principle.pdf', at: ago(39), from: 'you' as const },
      { id: 'dev-2', name: 'Passport.jpg', at: ago(41), from: 'you' as const },
      { id: 'dev-1', name: 'Client care letter.pdf', at: ago(42), from: 'us' as const },
    ],
  };
}
