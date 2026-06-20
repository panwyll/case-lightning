import { query, queryOne } from './db';
import { config } from './config';
import { ensureMatterFolder, ensureExcelTracker } from './graph';
import { matterSelfIdentifiers, upsertIdentifiers, domainOf } from './matching';
import { writeAudit } from './audit';
import type { SessionUser } from './types';

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

export interface CreateMatterInput {
  matterRef: string;
  propertyAddress: string;
  buyerNames?: string[];
  sellerNames?: string[];
  counterpartySolicitor?: string;
  counterpartyAgent?: string;
  exchangeTargetDate?: string;
  completionTargetDate?: string;
  lender?: string;
  chainPosition?: string;
}

export interface CreateMatterResult {
  id: string;
  matterRef: string;
  folderPath: string;
  folderWebUrl: string | null;
  trackerWebUrl: string | null;
}

/**
 * Create a matter and provision its user-facing M365 surfaces: a OneDrive folder
 * + a live Excel tracker, plus the matching identifiers and an empty summary.
 *
 * The single source of truth for matter creation — both the interactive
 * `POST /matters` route and the onboarding importer call this so provisioning
 * behaviour stays identical. The matter ref is made unique within the tenant by
 * appending a numeric suffix on collision (important when onboarding proposes
 * several cases at once).
 */
export async function createMatter(user: SessionUser, input: CreateMatterInput): Promise<CreateMatterResult> {
  const policy = await queryOne<{ folder_naming_pattern: string }>(
    `select folder_naming_pattern from policy_config where tenant_id = $1`,
    [user.tenantId]
  );

  const buyerNames = input.buyerNames ?? [];
  const sellerNames = input.sellerNames ?? [];
  const baseRef = input.matterRef.trim() || `AUTO-${new Date().toISOString().slice(0, 10)}`;

  // Settle on a tenant-unique matter ref, then provision against that ref.
  let matterId: string | null = null;
  let matterRef = baseRef;
  let folderPath = '';
  for (let attempt = 0; matterId === null; attempt++) {
    matterRef = attempt === 0 ? baseRef : `${baseRef}-${attempt + 1}`;
    const caseRefToken = matterRef.toUpperCase();
    folderPath = makeMatterFolderPath(matterRef, input.propertyAddress, policy?.folder_naming_pattern);
    try {
      const row = await queryOne<{ id: string }>(
        `insert into matter
          (tenant_id, matter_ref, property_address, buyer_names, seller_names, counterparty_solicitor,
           counterparty_agent, exchange_target_date, completion_target_date, lender, chain_position, created_by, folder_path, case_ref_token)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [
          user.tenantId,
          matterRef,
          input.propertyAddress,
          buyerNames,
          sellerNames,
          input.counterpartySolicitor ?? null,
          input.counterpartyAgent ?? null,
          input.exchangeTargetDate ?? null,
          input.completionTargetDate ?? null,
          input.lender ?? null,
          input.chainPosition ?? null,
          user.userId,
          folderPath,
          caseRefToken,
        ]
      );
      matterId = row!.id;
    } catch (error) {
      // 23505 = unique_violation on (tenant_id, matter_ref); retry with a suffix.
      if ((error as { code?: string })?.code === '23505' && attempt < 25) continue;
      throw error;
    }
  }

  const caseRefToken = matterRef.toUpperCase();
  // Seed matching identifiers: address postcode, party names, our case-ref token,
  // and the counterparty solicitor domain (weak signal, never decisive on its own).
  await upsertIdentifiers(user.tenantId, matterId, [
    ...matterSelfIdentifiers({
      property_address: input.propertyAddress,
      buyer_names: buyerNames,
      seller_names: sellerNames,
      case_ref_token: caseRefToken,
    }),
    ...(domainOf(input.counterpartySolicitor) ? [{ kind: 'DOMAIN' as const, value: domainOf(input.counterpartySolicitor)! }] : []),
  ]);

  // Provision the user-facing M365 surfaces: a OneDrive folder + a live Excel tracker.
  const folder = await ensureMatterFolder(user.userId, folderPath);
  const tracker = await ensureExcelTracker(user.userId, folderPath);

  await query(
    `update matter set drive_id = $1, folder_item_id = $2, folder_web_url = $3,
       tracker_item_id = $4, tracker_web_url = $5 where id = $6 and tenant_id = $7`,
    [
      folder.parentReference?.driveId ?? null,
      folder.id ?? null,
      folder.webUrl ?? null,
      tracker.id ?? null,
      tracker.webUrl ?? null,
      matterId,
      user.tenantId,
    ]
  );

  await query(
    `insert into matter_summary (matter_id, tenant_id, facts, outstanding_items, risks)
     values ($1,$2,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb)
     on conflict (matter_id) do nothing`,
    [matterId, user.tenantId]
  );

  await writeAudit({
    tenantId: user.tenantId,
    matterId,
    actorUserId: user.userId,
    actionType: 'MATTER_CREATED',
    actionStatus: 'SUCCESS',
    payload: { matterRef, folderPath },
  });

  return {
    id: matterId,
    matterRef,
    folderPath,
    folderWebUrl: folder.webUrl ?? null,
    trackerWebUrl: tracker.webUrl ?? null,
  };
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
