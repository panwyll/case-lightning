import { query, queryOne } from './db';
import { config } from './config';

export function addressSlug(propertyAddress: string): string {
  return propertyAddress
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Deterministic OneDrive path for a matter's knowledge-base folder, relative to
 * the drive root, e.g. "CaseLightning/AUTO-2026-00124_14-oak-street".
 */
export function makeMatterFolderPath(
  matterRef: string,
  propertyAddress: string,
  pattern = '{matter_ref}_{address_slug}'
): string {
  const slug = propertyAddress ? addressSlug(propertyAddress) : '';
  const resolved = pattern
    .replaceAll('{matter_ref}', matterRef)
    .replaceAll('{address_slug}', slug);
  return `${config.oneDriveRoot}/${resolved}`;
}

export async function getMatterSummary(matterId: string, tenantId: string) {
  const matter = await queryOne<Record<string, unknown>>(
    `select * from matter where id = $1 and tenant_id = $2`,
    [matterId, tenantId]
  );
  if (!matter) return null;

  const summary = await queryOne<Record<string, unknown>>(
    `select facts, outstanding_items, risks, updated_at
     from matter_summary where matter_id = $1 and tenant_id = $2`,
    [matterId, tenantId]
  );

  const timeline = await query<Record<string, unknown>>(
    `select id, event_at, event_type, title, details, source_ref, created_at
     from matter_timeline_event
     where matter_id = $1 and tenant_id = $2
     order by coalesce(event_at, created_at) desc
     limit 100`,
    [matterId, tenantId]
  );

  return {
    matter,
    summary: summary ?? { facts: {}, outstanding_items: [], risks: [] },
    timeline,
  };
}
