/**
 * After go-live (docs/workload-baseline.md §7): what CONVEYi sent on a conveyancer's cases, put in
 * the baseline's own categories and priced with the baseline's own minutes, so "hours handed over"
 * uses exactly the measure the "before" did.
 */
import { query } from '../db';
import { workingWeeks, type Report } from './model';
import { OUT_SPEC, type OutCategory } from './taxonomy';

/** A sent message the engine recorded, as the baseline would have categorised it had the conveyancer written it; null when it is not one of them. */
export function handoverCategory(type: string, payload: Record<string, unknown>): OutCategory | null {
  const template = String(payload.template ?? (payload.update as { template?: string } | undefined)?.template ?? '');
  switch (type) {
    case 'chase_sent': return 'chaser';
    case 'acknowledgement_sent': return 'acknowledgement';
    case 'request_sent': return /_agent$/.test(template) ? 'status_update' : 'first_request';
    case 'signing_pack_sent': case 'contract_pack_sent': case 'certificate_of_title_sent': case 'report_on_title_sent': return 'file_send';
    case 'client_update_sent':
      if (/^(completion_statement|file_copy)$/.test(template)) return 'file_send';
      if (template === 'email_reply') return 'update_reply';
      if (/_request(_again)?$/.test(template)) return 'first_request';
      return 'status_update';
    default: return null;
  }
}

export interface Handover {
  since: string;
  until: string;
  workingWeeks: number;
  lines: Array<{ category: OutCategory; label: string; count: number; perWeek: number; minutes: number; hoursPerWeek: number }>;
  hoursPerWeek: number;
}

/** What CONVEYi sent on the cases this person handles, since `since`, priced with the baseline's minutes. */
export async function handoverSince(tenantId: string, userId: string, since: string, baseline: Report, until = new Date().toISOString()): Promise<Handover> {
  const rows = await query<{ type: string; payload: Record<string, unknown> }>(
    `select e.type, e.payload from matter_event e join matter m on m.id = e.matter_id
      where e.tenant_id = $1 and m.assigned_to = $2 and e.created_at >= $3 and e.created_at < $4
        and e.type in ('chase_sent', 'acknowledgement_sent', 'request_sent', 'client_update_sent', 'signing_pack_sent', 'contract_pack_sent', 'certificate_of_title_sent', 'report_on_title_sent')`,
    [tenantId, userId, since, until]
  );
  const weeks = workingWeeks(since, until);
  const counts = new Map<OutCategory, number>();
  for (const r of rows) {
    const c = handoverCategory(r.type, r.payload ?? {});
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const lines = [...counts.entries()].map(([category, count]) => {
    const minutes = baseline.lines.find((l) => l.category === category)?.minutes ?? 0;
    const perWeek = count / weeks;
    return { category, label: OUT_SPEC[category].label, count, perWeek: Math.round(perWeek * 10) / 10, minutes, hoursPerWeek: Math.round(((perWeek * minutes) / 60) * 100) / 100 };
  }).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);
  return { since, until, workingWeeks: Math.round(weeks * 10) / 10, lines, hoursPerWeek: Math.round(lines.reduce((a, l) => a + l.hoursPerWeek, 0) * 10) / 10 };
}
