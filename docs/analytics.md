# Analytics: what is recorded

No analytics tab yet. This is the foundation: everything below is recorded from day one, so a tab (or a claim to a firm) can be built later with the full history.

## Already recorded

| Record | Where | Gives |
|---|---|---|
| Every case event, timestamped, with its actor (a person's id, `system`, `ai`, `external`) | `matter_event` (hash-chained) | Share of work done automatically; chases/updates sent unasked; stage times; instruction → exchange → completion |
| Proposals approved / rejected | `matter_event` `action_approved` / `action_rejected` | Trust in each automatic action (tunes `engine_action_level`) |
| Decisions opened before acting | `matter_event` `decision_source_opened` | Whether people read before approving |
| AI calls, tokens, cost | `usage_event` + `v_usage_*` | Cost per case, user, feature |
| Sessions | `audit_log` → `v_user_sessions` (30-minute gap) | Rough time in the app per person |
| Deleted tasks | `task_dismissal` | What the flow asks for that people do not need |

## Added in migration 114 (could not be rebuilt later)

- **`firm_baseline`**: the firm's own figures from before CONVEYi (weeks to complete a purchase / sale, open cases per conveyancer, hours per case). Entered in Firm > Firm Details > Before CONVEYi. Append-only; the latest row is current. This is the "before" in "faster than before".
- **`task_record`**: when each task appeared, when it left, who cleared it (`closed_by` = the actor of the event that cleared it) and how (`done` / `case_closed`). Tasks are computed, never stored, so without this the time a task waited is lost. Written by the event store on every case change (`store.ts refreshReadModels`, exact) and by the Tasks list at most every 5 minutes per firm (tasks that come and go with the clock). `task_id` matches `task_dismissal.ref`.

## Views (sandbox cases excluded)

- `v_task_turnaround`: per firm and kind of work, tasks opened, done, done by a person, median hours open.
- `v_work_by_actor_monthly`: events per month by person / system / ai / external.
- `v_case_duration`: per case, opened → exchanged → completed, weeks to complete, against the firm's baseline weeks.

## Not recorded, on purpose

- **Minutes saved per automatic action**: a table of estimates (e.g. a chase = 5 minutes) applied to the event log when needed; nothing to record.
- **Keystroke or screen time**: not collected.
