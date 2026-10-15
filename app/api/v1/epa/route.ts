import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { epaReport, firmMeasurement } from '@/lib/server/epa/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Analytics → Time (docs/epa.md §3): the whole firm's figures, never one person's. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [report, m] = await Promise.all([epaReport(user.tenantId, 8), firmMeasurement(user.tenantId).catch(() => null)]);
    // The measurement, to compare the weeks with: its split of the time it saw, labelled by when it was run (not "before
    // CONVEYi": a firm may scan again after starting).
    const h = m?.measurement?.hours;
    const seen = h ? h.red + h.amber + h.green : 0;
    const scan = h && seen && m?.scannedAt ? { at: m.scannedAt, share: { red: h.red / seen, amber: h.amber / seen, green: h.green / seen } } : null;
    return ok({ report, scan });
  } catch (e) {
    return fail(e);
  }
}
