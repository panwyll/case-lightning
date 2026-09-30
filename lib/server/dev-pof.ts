/**
 * Local development only: a proof-of-funds form with no database behind it (/pof/dev-preview-pof-000000),
 * so connecting a bank through the demo bank can be walked end to end in the browser. Every route that
 * serves the form checks `isDevPof` first; in production it is never true.
 */
import { DEMO_INSTITUTIONS } from './open-banking/mock';

export const DEV_POF_TOKEN = 'dev-preview-pof-000000';
export const isDevPof = (token: string) => process.env.NODE_ENV === 'development' && token === DEV_POF_TOKEN;
// Shared by the form's routes (each is its own module in development).
const g = globalThis as unknown as { __devPofConnected?: Map<string, { sourceIndex: number; party: 'client' | 'donor'; bank: string }> };
const connected = (g.__devPofConnected ??= new Map());

export const devPofView = () => ({ status: 'requested', firmName: 'Your Firm LLP', propertyAddress: '14 Oak Street, Leeds LS1 2AB', matterRef: 'DEV-001', firstName: 'Priya', fullName: 'Priya Shah', coBuyers: [], purchasePricePennies: 40_000_000, hasLender: true, noteToClient: null, followUp: false, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), round: 1, queries: [], previous: null });
export const devPofBanks = (q: string) => ({ available: true, banks: DEMO_INSTITUTIONS.filter((b) => b.name.toLowerCase().includes(q.toLowerCase())) });
export function devPofConnect(body: { sourceIndex: number; party: 'client' | 'donor'; institutionId: string }, origin: string) {
  const id = `00000000-0000-4000-8000-${String(connected.size + 1).padStart(12, '0')}`;
  connected.set(id, { sourceIndex: body.sourceIndex, party: body.party, bank: DEMO_INSTITUTIONS.find((b) => b.id === body.institutionId)?.name ?? 'Demo Bank' });
  return { connectionId: id, link: `${origin}/pof/${DEV_POF_TOKEN}?connected=${id}` };
}
export const devPofConnections = () => ({ connections: [...connected.entries()].map(([id, c]) => ({ id, sourceIndex: c.sourceIndex, party: c.party, status: 'linked', bank: c.bank, error: null, files: [{ id: `11111111-0000-4000-8000-${id.slice(-12)}`, fileName: `${c.bank} ····4821 (connected, 24 months)` }] })) });
