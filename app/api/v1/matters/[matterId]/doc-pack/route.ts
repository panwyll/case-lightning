/**
 * Document templates for a matter.
 *
 *   GET  /api/v1/matters/:matterId/doc-pack
 *        → lists the firm's templates available to generate for this matter.
 *
 *   POST /api/v1/matters/:matterId/doc-pack   { templateId, overwrite? }
 *        → fills one template with the matter's data and saves it into the
 *          matter's OneDrive folder, so it appears under "Case files".
 *          If a file of the same name already exists and overwrite !== true,
 *          responds 409 { conflict: true, fileName } so the UI can confirm.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { isPremiumTenant, canUseHeavyLlm } from '@/lib/server/plan';
import { queryOne } from '@/lib/server/db';
import { listMatterFiles, uploadToMatterFolder, appendTrackerRow } from '@/lib/server/graph';
import {
  listTenantTemplates,
  generateTemplateForMatter,
  templateOutputName,
} from '@/lib/server/doc-templates';
import { ok, fail } from '@/lib/server/http';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);

    const [templates, isPremium] = await Promise.all([
      listTenantTemplates(user.tenantId),
      isPremiumTenant(user.tenantId),
    ]);
    return ok({ templates, isPremium });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({ templateId: z.string().uuid(), overwrite: z.boolean().optional() })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    const matter = await queryOne<{ folder_path: string | null; tracker_item_id: string | null }>(
      `select folder_path, tracker_item_id from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter?.folder_path) return fail(new Error('Matter folder not provisioned.'));

    // Look up the output filename before generating, so a conflict short-circuits
    // the (potentially AI-billed) fill.
    const tplRow = await queryOne<{ name: string; has_llm_prompts: boolean }>(
      `select name, has_llm_prompts from doc_template where id = $1 and tenant_id = $2`,
      [body.templateId, user.tenantId]
    );
    if (!tplRow) return fail(new Error('Template not found.'));
    const fileName = templateOutputName(tplRow.name);

    if (!body.overwrite) {
      const existing = await listMatterFiles(user.userId, matter.folder_path).catch(() => [] as any[]);
      const clash = existing.some((it: any) => !it.folder && it.name === fileName);
      if (clash) {
        return NextResponse.json({ conflict: true, fileName }, { status: 409 });
      }
    }

    // Premium plans (Pro, Enterprise) get the AI [[prompt]] fills. Pro is usage-
    // capped on heavy LLM per month — once over, we still generate the document but
    // leave the AI sections blank and tell the user (graceful degrade, not a hard fail).
    const isPremium = await isPremiumTenant(user.tenantId);
    let useAi = isPremium;
    let capped = false;
    if (isPremium && tplRow.has_llm_prompts) {
      const gate = await canUseHeavyLlm(user.tenantId);
      if (!gate.allowed) {
        useAi = false;
        capped = true;
      }
    }
    const { buffer } = await generateTemplateForMatter(user, matterId, body.templateId, useAi);

    const uploaded = await uploadToMatterFolder(user.userId, matter.folder_path, fileName, buffer);

    // Log to the tracker as a generated document — not an arrival, so no review/draft.
    if (matter.tracker_item_id) {
      await appendTrackerRow(user.userId, matter.tracker_item_id, {
        date: new Date().toISOString().slice(0, 10),
        type: 'Document',
        detail: `Generated from template: ${tplRow.name}`,
        owner: user.displayName ?? user.email ?? '',
        due: '',
        status: 'Done',
      }).catch(() => {});
    }

    return ok({ file: { id: uploaded.id, name: fileName, webUrl: uploaded.webUrl ?? null }, capped });
  } catch (error) {
    return fail(error);
  }
}
