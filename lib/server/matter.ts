import { query, queryOne } from './db';
import { config } from './config';
import { ensureMatterFolder, ensureExcelTracker, hardenTracker, ensureInboxSubfolder, moveMessageToFolder } from './graph';
import { matterSelfIdentifiers, upsertIdentifiers, domainOf } from './matching';
import { writeAudit } from './audit';
import { matterRefFrom, fallbackMatterRef } from '../ref-name';
import type { SessionUser } from './types';

/**
 * Display name for a matter's Inbox subfolder, e.g. "Leaping Llama 14 Oak Street"
 * — the humanised matter ref plus the first line of the property address.
 */
export function mailFolderName(matterRef: string, propertyAddress: string): string {
  const ref = matterRef
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  const firstLine = (propertyAddress || '').split(',')[0].trim();
  return firstLine ? `${ref} ${firstLine}` : ref;
}

export function addressSlug(propertyAddress: string): string {
  return propertyAddress
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Deterministic OneDrive path for a matter's knowledge-base folder, relative to
 * the drive root, e.g. "CaseLightning/jumping-frog".
 *
 * The default pattern is the bare codename — no surname/address mashup. A tenant
 * can still opt into appending the address via the `{address_slug}` token in
 * their folder-naming policy.
 */
export function makeMatterFolderPath(
  matterRef: string,
  propertyAddress: string,
  pattern = '{matter_ref}'
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
  const policy = await queryOne<{ folder_naming_pattern: string; mail_subfolders_enabled: boolean }>(
    `select folder_naming_pattern, mail_subfolders_enabled from policy_config where tenant_id = $1`,
    [user.tenantId]
  );

  const buyerNames = input.buyerNames ?? [];
  const sellerNames = input.sellerNames ?? [];
  const baseRef = input.matterRef.trim() || matterRefFrom(input) || fallbackMatterRef();

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
  // Harden the tracker: freeze the header, forbid column add/remove, Status dropdown —
  // so a human can't rename the columns the two-way sync keys off. Best-effort.
  if (tracker?.id) void hardenTracker(user.userId, tracker.id).catch(() => {});

  // Give the matter its own Inbox subfolder so processed mail can be filed there —
  // but only when the firm has opted in (off by default; toggled in Admin → Policy).
  // Best-effort — a mailbox without folder permissions shouldn't fail matter setup.
  const folderDisplayName = mailFolderName(matterRef, input.propertyAddress);
  let mailFolderId: string | null = null;
  if (policy?.mail_subfolders_enabled) {
    try {
      mailFolderId = await ensureInboxSubfolder(user.userId, folderDisplayName);
    } catch {
      /* no folder permission / mailbox quirk — skip; mail just won't auto-file */
    }
  }

  await query(
    `update matter set drive_id = $1, folder_item_id = $2, folder_web_url = $3,
       tracker_item_id = $4, tracker_web_url = $5, mail_folder_id = $6, mail_folder_name = $7
     where id = $8 and tenant_id = $9`,
    [
      folder.parentReference?.driveId ?? null,
      folder.id ?? null,
      folder.webUrl ?? null,
      tracker.id ?? null,
      tracker.webUrl ?? null,
      mailFolderId,
      mailFolderId ? folderDisplayName : null,
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

/**
 * Files a processed email into its matter's Inbox subfolder (clearing it from the
 * inbox). Best-effort and idempotent-ish: no folder configured / move failure just
 * leaves the email where it is. Returns true if the message was moved.
 */
export async function fileEmailInMatterFolder(
  user: { userId: string; tenantId: string },
  matterId: string,
  messageId: string
): Promise<boolean> {
  const m = await queryOne<{ mail_folder_id: string | null }>(
    `select mail_folder_id from matter where id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  if (!m?.mail_folder_id) return false;
  try {
    await moveMessageToFolder(user.userId, messageId, m.mail_folder_id);
    return true;
  } catch {
    return false;
  }
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

  // The matter's harvested address book (sender/recipients seen on its email
  // traffic). Guarded so a deploy landing before migration 018 doesn't 500.
  let contacts: Record<string, unknown>[] = [];
  try {
    contacts = await query<Record<string, unknown>>(
      `select id, email, name, role, source, last_seen_at
       from matter_contact where matter_id = $1 and tenant_id = $2
       order by role <> 'UNKNOWN' desc, last_seen_at desc`,
      [matterId, tenantId]
    );
  } catch {
    /* matter_contact not migrated yet — return none */
  }

  // Figure history — who/when/why each key figure changed, with its email/doc source.
  // Guarded so a deploy landing before migration 034 doesn't 500.
  let figureHistory: Record<string, unknown>[] = [];
  try {
    figureHistory = await query<Record<string, unknown>>(
      `select fc.id, fc.field, fc.label, fc.old_value, fc.new_value, fc.source, fc.reason,
              fc.ref_kind, fc.ref_id, fc.ref_label, fc.ref_url, fc.created_at,
              coalesce(u.display_name, u.email) as actor
         from matter_figure_change fc
         left join app_user u on u.id = fc.actor_user_id
        where fc.matter_id = $1 and fc.tenant_id = $2
        order by fc.created_at desc
        limit 100`,
      [matterId, tenantId]
    );
  } catch {
    /* matter_figure_change not migrated yet — return none */
  }

  return {
    matter,
    summary: summary ?? { facts: {}, outstanding_items: [], risks: [] },
    timeline,
    contacts,
    figureHistory,
  };
}
