import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne, runAsAutomation, runAsSystem } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { markSubmitted, openRequestByToken } from '@/lib/server/engine/pof-store';
import { FUND_SOURCE_KINDS, type ProofOfFundsSubmission } from '@/lib/server/engine/proof-of-funds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The client's side of proof of funds (docs/proof-of-funds.md). No login: the link's
 * token is the credential, stored hashed, single-use, expiring. GET returns what the
 * form needs to render (firm, property, first name, the balance hint); POST takes the
 * completed declaration, stores it verbatim, and hands it to the engine, which
 * produces the facts, the flags, the declaration document and the sign-off decision.
 */
const money = z.number().int().nonnegative().max(1_000_000_000_00);
const docId = z.string().uuid();
const submissionSchema = z.object({
  declarant: z.object({ fullName: z.string().min(2).max(140), email: z.string().email().max(200).nullish(), phone: z.string().max(40).nullish() }),
  purchasePricePennies: money.nullish(),
  mortgageAdvancePennies: money.nullish(),
  sources: z
    .array(
      z.object({
        kind: z.enum(FUND_SOURCE_KINDS),
        amountPennies: money,
        description: z.string().min(1).max(1000),
        accountHolder: z.string().max(140).nullish(),
        bankName: z.string().max(140).nullish(),
        evidenceDocumentIds: z.array(docId).max(12).default([]),
        gift: z.object({ donorName: z.string().min(2).max(140), donorRelationship: z.string().min(1).max(80), donorAddress: z.string().max(300).nullish(), repayable: z.boolean(), donorAbroad: z.boolean(), donorEvidenceDocumentIds: z.array(docId).max(12).default([]) }).nullish(),
        overseas: z.object({ country: z.string().min(2).max(80), alreadyInUk: z.boolean() }).nullish(),
      })
    )
    .max(20),
  declarations: z.object({ accurate: z.boolean(), noThirdPartyInterest: z.boolean(), noUndisclosedBorrowing: z.boolean() }),
  clientNote: z.string().max(2000).nullish(),
});

async function context(token: string) {
  const req = await openRequestByToken(token);
  if (!req) return null;
  const m = await queryOne<{ property_address: string; matter_ref: string; buyer_names: string[] | null; tenant_name: string; price: string | null }>(
    `select m.property_address, m.matter_ref, m.buyer_names, t.name as tenant_name, null::text as price from matter m join tenant t on t.id = m.tenant_id where m.id = $1`,
    [req.matter_id]
  );
  if (!m) return null;
  const state = await engine().getState(req.tenant_id, req.matter_id).catch(() => null);
  return {
    req,
    view: {
      status: req.status,
      firmName: m.tenant_name,
      propertyAddress: m.property_address,
      matterRef: m.matter_ref,
      firstName: (m.buyer_names?.[0] ?? '').split(/\s+/)[0] || null,
      fullName: m.buyer_names?.[0] ?? null,
      purchasePricePennies: state?.purchasePricePennies ?? null,
      hasLender: state?.hasLender ?? null,
      noteToClient: req.note_to_client,
      followUp: !!req.follow_up_of,
      expiresAt: new Date(req.expires_at).toISOString(),
    },
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const ctx = await runAsSystem(() => context(token));
    if (!ctx) return ok({ status: 'unknown' }, { status: 404 });
    return ok(ctx.view);
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = submissionSchema.parse(await req.json());
    const result = await runAsSystem(async () => {
      const ctx = await context(token);
      if (!ctx) throw Object.assign(new Error('This link is not valid.'), { status: 404 });
      if (ctx.req.status !== 'requested') throw Object.assign(new Error(ctx.req.status === 'submitted' ? 'This form has already been submitted. Thank you.' : 'This link has expired; please ask your conveyancer for a new one.'), { status: 410 });
      // Every attached document must be one uploaded against THIS request (the upload route tags it).
      const ids = Array.from(new Set(body.sources.flatMap((s) => [...s.evidenceDocumentIds, ...(s.gift?.donorEvidenceDocumentIds ?? [])])));
      const docs = ids.length
        ? await query<{ id: string; file_name: string | null }>(`select id, file_name from document where id = any($1::uuid[]) and matter_id = $2 and storage_path like $3`, [ids, ctx.req.matter_id, `pof://${ctx.req.id}/%`])
        : [];
      if (docs.length !== ids.length) throw Object.assign(new Error('One of the attached documents does not belong to this form.'), { status: 400 });
      const submission: ProofOfFundsSubmission = { ...body, purchasePricePennies: body.purchasePricePennies ?? null, mortgageAdvancePennies: body.mortgageAdvancePennies ?? null, clientNote: body.clientNote ?? null, sources: body.sources.map((s) => ({ ...s, gift: s.gift ?? null, overseas: s.overseas ?? null })), submittedAt: new Date().toISOString() };
      const evidenceNames = Object.fromEntries(docs.map((d) => [d.id, d.file_name ?? d.id]));
      const run = await runAsAutomation(() => engine().proofOfFundsSubmitted(ctx.req.tenant_id, ctx.req.matter_id, ctx.req.id, submission, evidenceNames));
      const declaration = run.events.find((e) => e.type === 'proof_of_funds_submitted');
      await markSubmitted(ctx.req.id, submission, declaration?.sourceDocumentId ?? null);
      return { flagged: (declaration?.payload as { flags?: unknown[] } | undefined)?.flags?.length ?? 0 };
    });
    return ok({ ok: true, ...result });
  } catch (error) {
    return fail(error);
  }
}
