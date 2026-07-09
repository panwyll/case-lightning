# Two-way sync: our views ↔ Excel tracker ↔ Microsoft To Do

Goal: a task/action can be created or edited on **any** of three surfaces and converge
on the others — the web app / taskpane views, the per-matter `Tracker.xlsx`, and native
Microsoft To Do (Outlook Tasks). This is a *hub-and-spoke* design, **not** peer-to-peer.

## Principle: Postgres is the single source of truth

Three surfaces gossiping directly = N² sync paths and unresolvable conflicts. Instead
every surface is a **spoke** that syncs to one **hub** (Postgres `matter_task`). A change
on a spoke is pushed to the hub; the hub pushes to the other spokes. Conflicts are
resolved once, centrally.

```
                    Postgres  matter_task   (hub / truth)
                    id · ref · dedup · updated_at · excel_synced_at · todo_task_id
                   /                |                         \
        push/pull          push/pull                   push/pull
             │                     │                          │
      Excel Tracker         Our views (web/taskpane)     Microsoft To Do
      (LIVE two-way ✅)      (native, hub-backed ✅)       (to build 🔨)
```

## Canonical task model (the hub row)

`matter_task` already carries what we need:
`id, ref (stable per-matter key), type, detail, assignee, assignee_user_id, due, status,
source, created_at, updated_at, excel_synced_at`. To add To Do we add **one column**:
`todo_task_id text` (the To Do task's Graph id, per user/list) + the list id.

`ref` is the cross-surface identity (already used for Excel). It is the join key on every
spoke, so a row is matched by `ref`, never by position.

## Conflict resolution — the actual hard part

Sync plumbing is easy; deciding *who wins* is the work. Rules:

1. **Field-level, not row-level.** Merge per field (status from one edit, due-date from
   another) so a stale surface doesn't clobber unrelated fields. Track a per-field or
   per-surface `updated_at` where it matters (status is the hot field).
2. **Last-write-wins by timestamp** within a field. The hub stamps `updated_at`; a spoke
   edit only wins if it is newer than the hub's last confirmed push to that spoke
   (`excel_synced_at` already does exactly this for Excel — extend the pattern with a
   `todo_synced_at`).
3. **Deletes are soft.** A surface "deleting" a row marks it done/removed on the hub, never
   hard-deletes — otherwise a lagging spoke resurrects it. Converge on a tombstone.
4. **Idempotency.** Every push carries the `ref`; a re-delivered change is a no-op.

## Spoke 1 — Excel tracker  (LIVE ✅)

Already two-way. `mirrorToExcel`/`upsertTrackerRowByRef` push; `syncFromTracker` pulls
human edits back, and only accepts an Excel edit if the Excel row changed *after* our last
confirmed push (`updated_at <= excel_synced_at` guard). Pull is on-demand (taskpane open +
the tasks GET route reconciles first). **Hardening added** (this change): the sheet is
protected — header frozen, no column add/remove, Status is a dropdown — while data cells
stay editable, because a human renaming the keyed columns is the one thing that breaks the
link. Our writes stay safe via `withTrackerWritable` (unprotect → write → restore).

## Spoke 2 — Our views  (native ✅)

Read/write Postgres directly. No sync needed — they *are* the hub's UI.

## Spoke 3 — Microsoft To Do  (TO BUILD 🔨)

Needs the **`Tasks.ReadWrite`** scope (bundle the consent with `Mail.Send`).

- **List:** one To Do list per firm/user, e.g. "CONVEYi — {matter ref}" or a single
  "CONVEYi" list with the matter ref in the title. Store the list id.
- **Push** (hub → To Do): on create/update/complete of a `matter_task`, create/PATCH the
  `todoTask` (`POST/PATCH /me/todo/lists/{id}/tasks[/{taskId}]`); persist `todo_task_id`.
  Map `status DONE ⇄ todoTask.status 'completed'`, `due ⇄ dueDateTime`.
- **Pull** (To Do → hub): a **delta query** on the list
  (`/me/todo/lists/{id}/tasks/delta`, cursor stored per user) run on the existing cron +
  on pane open, reconciled with the same timestamp guard. (Change-notification
  subscriptions on todoTask can replace polling later.)
- **Identity:** `matter_task.todo_task_id` ↔ `todoTask.id`; unmatched To Do tasks the user
  created by hand can be ignored or optionally imported.

## Latency note (set expectations)

Push *to* Excel/To Do is immediate. Pull *back* is not — Excel and To Do don't notify us,
so a human edit there shows in the views on the next reconcile (pane open / cron / delta),
not the same second. Acceptable for this workflow; a subscription tightens To Do later.

## Rollout

1. ✅ Excel hardening (this change) — **needs a live-Outlook smoke test** (create a task →
   appears in Excel; change Status via the dropdown → syncs back; try renaming a header →
   blocked). Can't be verified against live Graph in dev.
2. 🔨 `todo_task_id` column + `Tasks.ReadWrite` scope + re-consent.
3. 🔨 To Do push on task write.
4. 🔨 To Do delta-pull on cron + pane open, with the field-level LWW guard.
