/**
 * The matter row the board and the matter drawer work from — one definition, so the
 * caseload's drawer and the board's drawer are opened with exactly the same data.
 */
export interface BoardMatter {
  id: string;
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  status: string;
  statusFlag: string;
  exchangeTargetDate: string | null;
  completionTargetDate: string | null;
  assignee: string | null;
  assignedTo: string | null;
  updatedAt: string;
  stageEnteredAt: string;
  openTasks?: number;
  nextDue?: string | null;
}

/** `$1` is always the tenant id. */
export const boardSelect = (withTasks: boolean) => `
       select m.id,
              m.matter_ref           as "matterRef",
              m.property_address     as "propertyAddress",
              m.stage,
              coalesce(m.status, 'OPEN') as status,
              m.status_flag          as "statusFlag",
              m.exchange_target_date as "exchangeTargetDate",
              m.completion_target_date as "completionTargetDate",
              coalesce(u.display_name, u.email) as assignee,
              m.assigned_to          as "assignedTo",
              m.updated_at           as "updatedAt",
              m.stage_entered_at     as "stageEnteredAt"${
                withTasks
                  ? `,
              (select count(*)::int from matter_task t
                where t.matter_id = m.id and t.tenant_id = $1
                  and t.status in ('OPEN','IN_PROGRESS'))       as "openTasks",
              (select min(t.due) from matter_task t
                where t.matter_id = m.id and t.tenant_id = $1
                  and t.status in ('OPEN','IN_PROGRESS') and t.due is not null) as "nextDue"`
                  : ''
              }
         from matter m
         left join app_user u on u.id = m.assigned_to`;
