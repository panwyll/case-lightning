import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const policy = await queryOne<any>(
      `select tenant_id, default_disclaimer, folder_naming_pattern, allowed_external_domains, updated_at
       from policy_config where tenant_id = $1`,
      [user.tenantId]
    );
    return ok({
      policy:
        policy ?? {
          tenant_id: user.tenantId,
          default_disclaimer: '',
          folder_naming_pattern: '{matter_ref}',
          allowed_external_domains: [],
        },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z
      .object({
        defaultDisclaimer: z.string().default(''),
        folderNamingPattern: z.string().default('{matter_ref}'),
        allowedExternalDomains: z.array(z.string()).default([]),
      })
      .parse(await req.json());

    const policy = await queryOne<any>(
      `insert into policy_config (tenant_id, default_disclaimer, folder_naming_pattern, allowed_external_domains, updated_by)
       values ($1,$2,$3,$4,$5)
       on conflict (tenant_id) do update set
         default_disclaimer = excluded.default_disclaimer,
         folder_naming_pattern = excluded.folder_naming_pattern,
         allowed_external_domains = excluded.allowed_external_domains,
         updated_by = excluded.updated_by,
         updated_at = now()
       returning tenant_id, default_disclaimer, folder_naming_pattern, allowed_external_domains, updated_at`,
      [user.tenantId, body.defaultDisclaimer, body.folderNamingPattern, body.allowedExternalDomains, user.userId]
    );
    return ok({ policy });
  } catch (error) {
    return fail(error);
  }
}
