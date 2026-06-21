/**
 * The firm-wide "Jira in Excel" board — one master workbook listing every open
 * matter with its stage, status, assignee, dates and open-task count, so a
 * conveyancer can monitor the whole portfolio and filter by status in Excel.
 *
 * Generated from Postgres (the source of truth) with exceljs and uploaded to the
 * OneDrive root, so it's always a clean, formatted, filterable sheet rather than
 * a hand-rolled log. Rebuilt on demand and whenever a matter changes.
 */
import ExcelJS from 'exceljs';
import { query } from './db';
import { config } from './config';
import { putDriveFile } from './graph';
import type { SessionUser } from './types';

export const MASTER_WORKBOOK_NAME = 'CaseLightning — All matters.xlsx';
const MASTER_PATH = `${config.oneDriveRoot}/${MASTER_WORKBOOK_NAME}`;

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
const STATUS_FILL: Record<string, string> = {
  ON_TRACK: 'FFD7F0E1',
  NEEDS_ATTENTION: 'FFFBE9C7',
  BLOCKED: 'FFF6CDCD',
};

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
  folder_web_url: string | null;
}

async function boardRows(tenantId: string): Promise<BoardRow[]> {
  return query<BoardRow>(
    `select m.matter_ref, m.property_address, m.stage, m.status_flag,
            coalesce(u.display_name, u.email) as assignee,
            m.buyer_names, m.seller_names, m.exchange_target_date, m.completion_target_date,
            (select count(*) from matter_task t where t.matter_id = m.id and t.status <> 'DONE')::int as open_tasks,
            m.updated_at, m.folder_web_url
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

/** Team members offered in the Assignee dropdown. */
async function teamNames(tenantId: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `select coalesce(display_name, email) as name from app_user where tenant_id = $1 order by name`,
    [tenantId]
  );
  return rows.map((r) => r.name).filter(Boolean);
}

const STAGE_ORDER = ['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION'];

/** Build the master board workbook as a buffer. */
async function buildWorkbook(tenantId: string): Promise<Buffer> {
  const rows = await boardRows(tenantId);
  const team = await teamNames(tenantId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CaseLightning';

  // Hidden reference tab holding the allowed values — drives the dropdowns so a
  // user can only pick valid statuses/stages/assignees, never free-type junk.
  const stageVals = STAGE_ORDER.map((s) => STAGE_LABELS[s]);
  const statusVals = Object.values(STATUS_LABELS);
  const assigneeVals = ['Unassigned', ...team];
  const lists = wb.addWorksheet('Lists');
  lists.getCell('A1').value = 'Stages';
  lists.getCell('B1').value = 'Statuses';
  lists.getCell('C1').value = 'Assignees';
  stageVals.forEach((v, i) => (lists.getCell(`A${i + 2}`).value = v));
  statusVals.forEach((v, i) => (lists.getCell(`B${i + 2}`).value = v));
  assigneeVals.forEach((v, i) => (lists.getCell(`C${i + 2}`).value = v));
  const stageRange = `Lists!$A$2:$A$${stageVals.length + 1}`;
  const statusRange = `Lists!$B$2:$B$${statusVals.length + 1}`;
  const assigneeRange = `Lists!$C$2:$C$${assigneeVals.length + 1}`;
  lists.state = 'hidden';

  const ws = wb.addWorksheet('Matters', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'Matter', key: 'ref', width: 22 },
    { header: 'Property', key: 'property', width: 38 },
    { header: 'Stage', key: 'stage', width: 24 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Assignee', key: 'assignee', width: 20 },
    { header: 'Buyer', key: 'buyer', width: 22 },
    { header: 'Seller', key: 'seller', width: 22 },
    { header: 'Exchange', key: 'exchange', width: 13 },
    { header: 'Completion', key: 'completion', width: 13 },
    { header: 'Open tasks', key: 'tasks', width: 11 },
    { header: 'Updated', key: 'updated', width: 13 },
    { header: 'Folder', key: 'folder', width: 12 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.height = 20;
  header.alignment = { vertical: 'middle' };
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A27E0' } };
  });

  for (const r of rows) {
    const row = ws.addRow({
      ref: r.matter_ref,
      property: r.property_address ?? '',
      stage: STAGE_LABELS[r.stage] ?? r.stage,
      status: STATUS_LABELS[r.status_flag] ?? r.status_flag,
      assignee: r.assignee ?? 'Unassigned',
      buyer: (r.buyer_names ?? []).join(', '),
      seller: (r.seller_names ?? []).join(', '),
      exchange: dateCell(r.exchange_target_date),
      completion: dateCell(r.completion_target_date),
      tasks: r.open_tasks,
      updated: dateCell(r.updated_at),
      folder: r.folder_web_url ? 'Open' : '',
    });
    const statusCell = row.getCell('status');
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[r.status_flag] ?? 'FFEFEFEF' } };
    statusCell.font = { bold: r.status_flag !== 'ON_TRACK' };
    if (r.folder_web_url) {
      const fc = row.getCell('folder');
      fc.value = { text: 'Open', hyperlink: r.folder_web_url };
      fc.font = { color: { argb: 'FF5A27E0' }, underline: true };
    }

    // The only editable cells: stage, status, assignee — each a dropdown of valid
    // values, and unlocked so they survive the sheet protection below.
    const editable: Array<[string, string, boolean]> = [
      ['stage', stageRange, false],
      ['status', statusRange, false],
      ['assignee', assigneeRange, true],
    ];
    for (const [key, range, allowBlank] of editable) {
      const cell = row.getCell(key);
      cell.protection = { locked: false };
      cell.dataValidation = {
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

  // Filter dropdowns on every column — "filter by status" is one click.
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };

  // Lock everything except the three editable columns; still allow filter + sort.
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    autoFilter: true,
    sort: true,
  });
  await lists.protect('', { selectLockedCells: false, selectUnlockedCells: false });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** Rebuild the master board and upload it; returns its OneDrive web URL. */
export async function refreshMasterBoard(user: SessionUser): Promise<{ webUrl: string | null; matters: number }> {
  const buffer = await buildWorkbook(user.tenantId);
  const item = await putDriveFile(user.userId, MASTER_PATH, buffer);
  const count = (await boardRows(user.tenantId)).length;
  return { webUrl: item?.webUrl ?? null, matters: count };
}
