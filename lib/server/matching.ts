/**
 * Case-matching engine.
 *
 * GDPR posture (deliberate):
 *  - Candidate matters are narrowed by HARD structural signals BEFORE any scoring.
 *    An unmatched email is never compared against all matters' content — only
 *    against matters surfaced by a concrete identifier (linked thread, our own
 *    case-ref token, a known participant/domain, an address token).
 *  - Matching is deterministic and explainable: every score carries the exact
 *    signals that produced it, recorded in email_triage for audit/override.
 *  - No single flimsy signal (e.g. sender domain) can reach the AUTO band; a
 *    counterparty firm or repeat investor touches many matters, so AUTO requires
 *    either our own token, an already-linked thread, or ≥2 independent corroborating
 *    signals.
 */
import { query } from './db';

export type Band = 'AUTO' | 'STRONG' | 'WEAK' | 'NONE';

export interface MatchSignal {
  kind: 'LINKED_THREAD' | 'CASE_REF_TOKEN' | 'PARTICIPANT_EMAIL' | 'ADDRESS' | 'NAME' | 'SENDER_DOMAIN';
  detail: string;
  weight: number;
}

export interface Candidate {
  matterId: string;
  matterRef: string;
  propertyAddress: string;
  score: number;
  band: Band;
  signals: MatchSignal[];
}

export interface MessageSignals {
  conversationId?: string;
  fromAddress?: string;
  recipientAddresses: string[];
  subject: string;
  bodyText: string;
}

const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
const CASE_REF_RE = /\[#([A-Z0-9][A-Z0-9\-_/.]{2,40})\]/gi;

export function domainOf(email?: string): string | null {
  const d = email?.split('@')[1]?.toLowerCase().trim();
  return d || null;
}

export function extractPostcodes(text: string): string[] {
  return Array.from(text.matchAll(POSTCODE_RE)).map((m) => m[0].replace(/\s+/g, '').toUpperCase());
}

export function extractCaseRefTokens(text: string): string[] {
  return Array.from(text.matchAll(CASE_REF_RE)).map((m) => m[1].toUpperCase());
}

/** Build the structural fingerprint of an incoming message used for matching. */
export function messageSignals(message: any): MessageSignals {
  const from = message.from?.emailAddress?.address?.toLowerCase();
  const recipients = [
    ...(message.toRecipients ?? []),
    ...(message.ccRecipients ?? []),
  ]
    .map((r: any) => r.emailAddress?.address?.toLowerCase())
    .filter(Boolean) as string[];
  return {
    conversationId: message.conversationId,
    fromAddress: from,
    recipientAddresses: recipients,
    subject: message.subject ?? '',
    bodyText: typeof message.body?.content === 'string' ? message.body.content : (message.bodyPreview ?? ''),
  };
}

function bandFor(score: number, signals: MatchSignal[]): Band {
  const kinds = new Set(signals.map((s) => s.kind));
  const hasDefinitive = kinds.has('LINKED_THREAD') || kinds.has('CASE_REF_TOKEN');
  const corroborating = ['PARTICIPANT_EMAIL', 'ADDRESS', 'NAME'].filter((k) => kinds.has(k as MatchSignal['kind'])).length;
  // AUTO requires a definitive signal OR at least two independent corroborating ones.
  if (score >= 0.9 && (hasDefinitive || corroborating >= 2)) return 'AUTO';
  if (score >= 0.6) return 'STRONG';
  if (score >= 0.3) return 'WEAK';
  return 'NONE';
}

/**
 * Returns ranked candidate matters for a message. `tenantId` scopes everything;
 * candidates are produced only from hard identifiers + linked threads.
 */
export async function matchMessage(tenantId: string, signals: MessageSignals): Promise<Candidate[]> {
  const haystack = `${signals.subject}\n${signals.bodyText}`;
  const tokens = extractCaseRefTokens(haystack);
  const postcodes = extractPostcodes(haystack);
  const participants = [signals.fromAddress, ...signals.recipientAddresses].filter(Boolean) as string[];
  const domains = Array.from(new Set(participants.map(domainOf).filter(Boolean) as string[]));

  // 1) Candidate narrowing — union of matters reachable via a hard signal.
  const candidateIds = new Set<string>();

  if (signals.conversationId) {
    const linked = await query<{ matter_id: string }>(
      `select matter_id from email_thread where tenant_id = $1 and graph_conversation_id = $2`,
      [tenantId, signals.conversationId]
    );
    linked.forEach((r) => candidateIds.add(r.matter_id));
  }

  if (tokens.length) {
    const byToken = await query<{ id: string }>(
      `select id from matter where tenant_id = $1 and upper(case_ref_token) = any($2)`,
      [tenantId, tokens]
    );
    byToken.forEach((r) => candidateIds.add(r.id));
  }

  const idValues = [...participants, ...domains, ...postcodes];
  if (idValues.length) {
    const byIdent = await query<{ matter_id: string }>(
      `select distinct matter_id from matter_identifier
       where tenant_id = $1 and lower(value) = any($2)`,
      [tenantId, idValues.map((v) => v.toLowerCase())]
    );
    byIdent.forEach((r) => candidateIds.add(r.matter_id));
  }

  if (!candidateIds.size) return [];

  // 2) Load candidates + their identifiers, then score deterministically.
  const ids = [...candidateIds];
  const matters = await query<{ id: string; matter_ref: string; property_address: string; case_ref_token: string | null; buyer_names: string[]; seller_names: string[] }>(
    `select id, matter_ref, property_address, case_ref_token, buyer_names, seller_names
     from matter where tenant_id = $1 and id = any($2)`,
    [tenantId, ids]
  );
  const idents = await query<{ matter_id: string; kind: string; value: string }>(
    `select matter_id, kind, value from matter_identifier where tenant_id = $1 and matter_id = any($2)`,
    [tenantId, ids]
  );
  const identsByMatter = new Map<string, Array<{ kind: string; value: string }>>();
  for (const i of idents) {
    if (!identsByMatter.has(i.matter_id)) identsByMatter.set(i.matter_id, []);
    identsByMatter.get(i.matter_id)!.push({ kind: i.kind, value: i.value.toLowerCase() });
  }

  const linkedSet = new Set<string>();
  if (signals.conversationId) {
    const linked = await query<{ matter_id: string }>(
      `select matter_id from email_thread where tenant_id = $1 and graph_conversation_id = $2`,
      [tenantId, signals.conversationId]
    );
    linked.forEach((r) => linkedSet.add(r.matter_id));
  }

  const lcHay = haystack.toLowerCase();
  const candidates: Candidate[] = matters.map((m) => {
    const signalsHit: MatchSignal[] = [];
    const mIdents = identsByMatter.get(m.id) ?? [];

    if (linkedSet.has(m.id)) {
      signalsHit.push({ kind: 'LINKED_THREAD', detail: 'Thread already linked to this matter', weight: 1.0 });
    }
    if (m.case_ref_token && tokens.includes(m.case_ref_token.toUpperCase())) {
      signalsHit.push({ kind: 'CASE_REF_TOKEN', detail: `Subject/body carries [#${m.case_ref_token}]`, weight: 0.9 });
    }
    // Exact participant email (strong, but capped — counterparties recur)
    const emailMatches = mIdents.filter((i) => i.kind === 'EMAIL' && participants.includes(i.value));
    if (emailMatches.length) {
      signalsHit.push({ kind: 'PARTICIPANT_EMAIL', detail: `Known participant: ${emailMatches[0].value}`, weight: 0.35 });
    }
    // Address / postcode
    const addrMatch = mIdents.find((i) => i.kind === 'POSTCODE' && lcHay.includes(i.value));
    if (addrMatch) {
      signalsHit.push({ kind: 'ADDRESS', detail: `Property postcode ${addrMatch.value.toUpperCase()} present`, weight: 0.35 });
    }
    // Party name
    const names = [...(m.buyer_names ?? []), ...(m.seller_names ?? [])].map((n) => n.toLowerCase()).filter(Boolean);
    const nameHit = names.find((n) => n.length > 3 && lcHay.includes(n));
    if (nameHit) {
      signalsHit.push({ kind: 'NAME', detail: `Party name "${nameHit}" present`, weight: 0.2 });
    }
    // Sender domain only — weak, never decisive
    const senderDomain = domainOf(signals.fromAddress);
    const domainMatch = senderDomain && mIdents.some((i) => i.kind === 'DOMAIN' && i.value === senderDomain);
    if (domainMatch && !emailMatches.length) {
      signalsHit.push({ kind: 'SENDER_DOMAIN', detail: `Sender domain ${senderDomain} seen on this matter`, weight: 0.1 });
    }

    const score = Math.min(1, signalsHit.reduce((s, x) => s + x.weight, 0));
    return {
      matterId: m.id,
      matterRef: m.matter_ref,
      propertyAddress: m.property_address,
      score,
      band: bandFor(score, signalsHit),
      signals: signalsHit,
    };
  });

  return candidates.filter((c) => c.band !== 'NONE').sort((a, b) => b.score - a.score);
}

// ── Identifier harvesting ────────────────────────────────────────────────────

/** Persist the structural identifiers that future matching will rely on. */
export async function upsertIdentifiers(
  tenantId: string,
  matterId: string,
  rows: Array<{ kind: MatchSignal['kind'] | 'DOMAIN' | 'POSTCODE' | 'NAME' | 'EMAIL' | 'REF_TOKEN'; value: string }>
): Promise<void> {
  for (const r of rows) {
    const value = r.value.trim();
    if (!value) continue;
    await query(
      `insert into matter_identifier (tenant_id, matter_id, kind, value)
       values ($1,$2,$3,$4) on conflict (tenant_id, matter_id, kind, value) do nothing`,
      [tenantId, matterId, r.kind, value]
    );
  }
}

/** Derive identifiers from a matter's own fields (address postcode, names, token). */
export function matterSelfIdentifiers(matter: {
  property_address: string;
  buyer_names?: string[];
  seller_names?: string[];
  counterparty_solicitor?: string | null;
  case_ref_token?: string | null;
}): Array<{ kind: 'POSTCODE' | 'NAME' | 'REF_TOKEN'; value: string }> {
  const out: Array<{ kind: 'POSTCODE' | 'NAME' | 'REF_TOKEN'; value: string }> = [];
  for (const pc of extractPostcodes(matter.property_address)) out.push({ kind: 'POSTCODE', value: pc });
  for (const n of [...(matter.buyer_names ?? []), ...(matter.seller_names ?? [])]) {
    if (n && n.trim().length > 3) out.push({ kind: 'NAME', value: n.trim() });
  }
  if (matter.case_ref_token) out.push({ kind: 'REF_TOKEN', value: matter.case_ref_token });
  return out;
}
