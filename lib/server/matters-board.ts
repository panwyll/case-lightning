/**
 * The firm-wide "Jira in Excel" board — one master workbook ("MattersTable")
 * listing every open matter with its stage, status, assignee, dates and
 * open-task count, so the team can monitor the portfolio and filter by status.
 *
 * Built ONCE as a formatted, validated template with exceljs, then kept up to
 * date by upserting rows through the Microsoft Graph workbook table API — which
 * co-authors with an open file, so the board updates live even while someone has
 * it open (no 423 lock errors). Edits made in Excel sync back to Postgres on the
 * next refresh. Postgres stays the source of truth.
 */
import ExcelJS from 'exceljs';
import { query } from './db';
import { config } from './config';
import { putDriveFile, getDriveItemByPath, listTableRows, upsertTableRowsByKey } from './graph';
import type { SessionUser } from './types';

export const MASTER_WORKBOOK_NAME = 'CaseLightning — All matters.xlsx';
const MASTER_PATH = `${config.oneDriveRoot}/${MASTER_WORKBOOK_NAME}`;
const TABLE = 'MattersTable';
const HEADERS = ['Matter', 'Property', 'Stage', 'Status', 'Assignee', 'Buyer', 'Seller', 'Exchange', 'Completion', 'Open tasks', 'Updated'];

const STAGE_LABELS: Record<string, string> = {
  INSTRUCTION: '1 · Instruction',
  CONTRACT_PACK: '2 · Contract pack',
  SEARCHES_ENQUIRIES: '3 · Searches & enquiries',
  REVIEW_SIGNING: '4 · Review & signing',
  EXCHANGE: '5 · Exchange',
  COMPLETION: '6 · Completion',
};
const STATUS_LABELS: Record<string, string> = {
  ON_TRACK: 'On track',
  NEEDS_ATTENTION: 'Needs attention',
  BLOCKED: 'Blocked',
};
const STAGE_ORDER = ['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION'];
// The "Colour" option column on the Statuses list → drives the board's status
// conditional formatting. Firms can see (and the board honours) the mapping.
const STATUS_COLOUR: Record<string, string> = { 'On track': 'Green', 'Needs attention': 'Amber', 'Blocked': 'Red' };
const COLOUR_FILL: Record<string, string> = { Green: 'FFD7F0E1', Amber: 'FFFBE9C7', Red: 'FFF6CDCD', Grey: 'FFEFEFEF' };
const STAGE_BY_LABEL = Object.fromEntries(Object.entries(STAGE_LABELS).map(([k, v]) => [v, k]));
const STATUS_BY_LABEL = Object.fromEntries(Object.entries(STATUS_LABELS).map(([k, v]) => [v, k]));

interface BoardRow {
  matter_ref: string;
  property_address: string | null;
  stage: string;
  status_flag: string;
  assignee: string | null;
  buyer_names: string[];
  seller_names: string[];
  exchange_target_date: string | null;
  completion_target_date: string | null;
  open_tasks: number;
  updated_at: string;
}

async function boardRows(tenantId: string): Promise<BoardRow[]> {
  return query<BoardRow>(
    `select m.matter_ref, m.property_address, m.stage, m.status_flag,
            coalesce(u.display_name, u.email) as assignee,
            m.buyer_names, m.seller_names, m.exchange_target_date, m.completion_target_date,
            (select count(*) from matter_task t where t.matter_id = m.id and t.status <> 'DONE')::int as open_tasks,
            m.updated_at
     from matter m
     left join app_user u on u.id = m.assigned_to
     where m.tenant_id = $1 and m.status = 'OPEN'
     order by
       case m.status_flag when 'BLOCKED' then 0 when 'NEEDS_ATTENTION' then 1 else 2 end,
       m.stage, m.completion_target_date nulls last, m.matter_ref`,
    [tenantId]
  );
}

function dateCell(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** A matter as a header-keyed value map — used for both the template and upserts. */
function rowValues(r: BoardRow): Record<string, string | number> {
  return {
    Matter: r.matter_ref,
    Property: r.property_address ?? '',
    Stage: STAGE_LABELS[r.stage] ?? r.stage,
    Status: STATUS_LABELS[r.status_flag] ?? r.status_flag,
    Assignee: r.assignee ?? 'Unassigned',
    Buyer: (r.buyer_names ?? []).join(', '),
    Seller: (r.seller_names ?? []).join(', '),
    Exchange: dateCell(r.exchange_target_date),
    Completion: dateCell(r.completion_target_date),
    'Open tasks': r.open_tasks,
    Updated: dateCell(r.updated_at),
  };
}

async function teamNames(tenantId: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `select coalesce(display_name, email) as name from app_user where tenant_id = $1 order by name`,
    [tenantId]
  );
  return rows.map((r) => r.name).filter(Boolean);
}

/** One-time formatted template: a real table + dropdowns + status colours. */
async function buildTemplate(tenantId: string): Promise<Buffer> {
  const rows = await boardRows(tenantId);
  const team = await teamNames(tenantId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CaseLightning';

  // Reference tab — each allowed-value list is its own Excel TABLE, so the firm
  // can add their own stages / statuses / people just by typing a new row, and
  // the board dropdowns (which point at the table columns via INDIRECT) pick them
  // up automatically. Kept on its own visible tab so it's editable.
  const stageVals = STAGE_ORDER.map((s) => STAGE_LABELS[s]);
  const statusVals = Object.values(STATUS_LABELS);
  const assigneeVals = ['Unassigned', ...team];
  const lists = wb.addWorksheet('Lists');
  lists.getColumn(1).width = 28;
  lists.getColumn(3).width = 20;
  lists.getColumn(4).width = 12;
  lists.getColumn(6).width = 26;
  lists.addTable({ name: 'StagesTable', ref: 'A1', headerRow: true, style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: [{ name: 'Stage' }], rows: stageVals.map((v) => [v]) });
  lists.addTable({ name: 'StatusesTable', ref: 'C1', headerRow: true, style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: [{ name: 'Status' }, { name: 'Colour' }], rows: statusVals.map((v) => [v, STATUS_COLOUR[v] ?? 'Grey']) });
  lists.addTable({ name: 'AssigneesTable', ref: 'F1', headerRow: true, style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: [{ name: 'Assignee' }], rows: assigneeVals.map((v) => [v]) });
  const note = lists.getCell('H1');
  note.value = 'Add your own stages / statuses / people by typing a new row in these tables — the board dropdowns update automatically.';
  note.font = { italic: true, color: { argb: 'FF64748B' } };

  // The StatusesTable "Colour" column (col D): a dropdown from a hidden colours
  // list, and each cell shows its actual colour (conditional formatting, so it
  // tracks the value). Keeps the option both constrained and self-evident.
  lists.addTable({ name: 'ColoursTable', ref: 'J1', headerRow: true, columns: [{ name: 'Colour' }], rows: Object.keys(COLOUR_FILL).map((c) => [c]) });
  lists.getColumn(10).hidden = true; // hide the colours source (column J)
  for (let r = 2; r <= 60; r++) {
    lists.getCell(`D${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['=INDIRECT("ColoursTable[Colour]")'],
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: 'Pick a colour',
      error: 'Choose one of the listed colours.',
    };
  }
  lists.addConditionalFormatting({
    ref: 'D2:D60',
    rules: Object.entries(COLOUR_FILL).map(([name, argb], i) => ({
      type: 'containsText' as const,
      operator: 'containsText' as const,
      text: name,
      priority: i + 1,
      style: { fill: { type: 'pattern' as const, pattern: 'solid' as const, bgColor: { argb } } },
    })),
  });
  // Dropdowns reference the table columns so they grow as rows are added.
  const stageRange = '=INDIRECT("StagesTable[Stage]")';
  const statusRange = '=INDIRECT("StatusesTable[Status]")';
  const assigneeRange = '=INDIRECT("AssigneesTable[Assignee]")';

  const ws = wb.addWorksheet('Matters', { views: [{ state: 'frozen', ySplit: 1 }] });
  const tableRows = rows.map((r) => HEADERS.map((h) => rowValues(r)[h] ?? ''));
  ws.addTable({
    name: TABLE,
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: HEADERS.map((h) => ({ name: h, filterButton: true })),
    rows: tableRows.length ? tableRows : [HEADERS.map(() => '')],
  });

  const widths = [22, 38, 24, 18, 20, 22, 22, 13, 13, 11, 13];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // Dropdowns on Stage (C) / Status (D) / Assignee (E) — over a generous range so
  // rows added later inherit them too. Reject off-list values.
  const validations: Array<[string, string, boolean]> = [
    ['C', stageRange, false],
    ['D', statusRange, false],
    ['E', assigneeRange, true],
  ];
  for (const [col, range, allowBlank] of validations) {
    for (let r = 2; r <= Math.max(rows.length + 1, 400); r++) {
      ws.getCell(`${col}${r}`).dataValidation = {
        type: 'list',
        allowBlank,
        formulae: [range],
        showErrorMessage: true,
        errorStyle: 'stop',
        errorTitle: 'Pick from the list',
        error: 'Choose one of the allowed values from the dropdown.',
      };
    }
  }

  // Status colour by value (conditional formatting → applies to future rows too).
  const cfFill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, bgColor: { argb } });
  ws.addConditionalFormatting({
    ref: 'D2:D1000',
    rules: statusVals.map((v, i) => ({
      type: 'containsText' as const,
      operator: 'containsText' as const,
      text: v,
      priority: i + 1,
      style: { fill: cfFill(COLOUR_FILL[STATUS_COLOUR[v] ?? 'Grey'] ?? COLOUR_FILL.Grey) },
    })),
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Pull hand edits (stage / status / assignee) from the board table back into
 * Postgres. Conflict policy: if the app changed a matter since we last wrote it
 * to the board (updated_at > board_synced_at) the app wins; otherwise a differing
 * Excel cell is a human edit and is applied.
 */
async function reconcileFromBoard(user: SessionUser, itemId: string): Promise<void> {
  let rows: Awaited<ReturnType<typeof listTableRows>>;
  try {
    rows = await listTableRows(user.userId, itemId, TABLE);
  } catch {
    return; // table not present yet / unreadable
  }
  const users = await query<{ id: string; name: string }>(
    `select id, coalesce(display_name, email) as name from app_user where tenant_id = $1`,
    [user.tenantId]
  );
  const userIdByName = new Map(users.map((u) => [u.name, u.id]));
  const matters = await query<{ id: string; matter_ref: string; stage: string; status_flag: string; assigned_to: string | null; updated_at: string; board_synced_at: string | null }>(
    `select id, matter_ref, stage, status_flag, assigned_to, updated_at, board_synced_at from matter where tenant_id = $1 and status = 'OPEN'`,
    [user.tenantId]
  );
  const byRef = new Map(matters.map((m) => [m.matter_ref, m]));

  for (const row of rows) {
    const m = byRef.get((row.cells['Matter'] ?? '').trim());
    if (!m) continue;
    const synced = m.board_synced_at ? new Date(m.board_synced_at).getTime() : 0;
    if (new Date(m.updated_at).getTime() > synced) continue; // app changed it since → app wins

    // Map a known label back to its enum key; keep a firm-added custom value as
    // the raw label so it round-trips. Blank → leave unchanged.
    const stageRaw = (row.cells['Stage'] ?? '').trim();
    const stage = stageRaw ? STAGE_BY_LABEL[stageRaw] ?? stageRaw : m.stage;
    const statusRaw = (row.cells['Status'] ?? '').trim();
    const status = statusRaw ? STATUS_BY_LABEL[statusRaw] ?? statusRaw : m.status_flag;
    const name = (row.cells['Assignee'] ?? '').trim();
    const assigned = name === 'Unassigned' || name === '' ? null : userIdByName.get(name) ?? m.assigned_to;
    if (stage !== m.stage || status !== m.status_flag || assigned !== m.assigned_to) {
      await query(`update matter set stage = $1, status_flag = $2, assigned_to = $3, updated_at = now() where id = $4 and tenant_id = $5`, [
        stage,
        status,
        assigned,
        m.id,
        user.tenantId,
      ]);
    }
  }
}

/** Just the board's URL if it already exists — fast, no sync (lets the button open it instantly). */
export async function getBoardUrl(user: SessionUser): Promise<string | null> {
  const item = await getDriveItemByPath(user.userId, MASTER_PATH);
  return item?.webUrl ?? null;
}

/**
 * Ensure the board exists and is current, then return its URL. First call builds
 * the formatted template; later calls reconcile Excel edits in and upsert every
 * matter row in place (live, even while the workbook is open).
 */
export async function refreshMasterBoard(user: SessionUser): Promise<{ webUrl: string | null; matters: number; needsClose: boolean }> {
  let item = await getDriveItemByPath(user.userId, MASTER_PATH);

  // Does it already have the live MattersTable? (Old "relic" files, and the
  // first-ever build, don't — they need the formatted template written.)
  let hasTable = false;
  if (item) {
    try {
      await listTableRows(user.userId, item.id, TABLE);
      hasTable = true;
    } catch {
      hasTable = false;
    }
  }

  if (!item || !hasTable) {
    // Build/upgrade the formatted template. This is the one write that overwrites
    // the whole file, so it 423s if the relic is open — tell the user to close it.
    const buffer = await buildTemplate(user.tenantId);
    try {
      item = await putDriveFile(user.userId, MASTER_PATH, buffer);
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 423 && item) {
        const count = (await boardRows(user.tenantId)).length;
        return { webUrl: item.webUrl ?? null, matters: count, needsClose: true };
      }
      throw error;
    }
  } else {
    // Live path: pull Excel edits in, then upsert every row in place (no 423).
    await reconcileFromBoard(user, item.id);
    const rows = await boardRows(user.tenantId);
    await upsertTableRowsByKey(
      user.userId,
      item.id,
      TABLE,
      'Matter',
      rows.map((r) => ({ key: r.matter_ref, values: rowValues(r) }))
    );
  }

  await query(`update matter set board_synced_at = now() where tenant_id = $1 and status = 'OPEN'`, [user.tenantId]);
  const count = (await boardRows(user.tenantId)).length;
  return { webUrl: item?.webUrl ?? null, matters: count, needsClose: false };
}
