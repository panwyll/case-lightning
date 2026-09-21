# Two-way sync: our views ↔ Microsoft To Do

> The Excel tracker spoke described in earlier versions of this document was retired
> (migration 074): the per-matter `Tracker.xlsx` and the firm-wide "All matters" workbook are
> gone. Tasks, stage, status and the case log live in Postgres and are shown in the app —
> the matter board, the worklist and the conveyancing engine. OneDrive remains the document
> store for every matter. What follows is the sync design that still applies.

## Principle: Postgres is the single source of truth

```
                    matter_task  (Postgres — the hub)
                    id · ref · dedup · updated_at · todo_task_id · todo_synced_at
                         ▲                          ▲
                         │                          │
               Our views (web/taskpane)     Microsoft To Do (per user)
```

Every surface reads from and writes to the hub row. A surface never talks to another surface.

## Canonical task model (the hub row)

`matter_task`: `id, ref, type, detail, assignee, assignee_user_id, due, status, status_label,
source, created_at, updated_at, todo_task_id, todo_user_id, todo_synced_at`.

`ref` (T-0001…) is the stable human key; it is allocated under a per-matter advisory lock so
it can never collide, and derived from `max(ref)` rather than a count so a deletion can't
re-issue one.

## Conflict resolution

Last-write-wins with a confirmed-push guard: an app change wins until it has been confirmed
into To Do (`updated_at <= todo_synced_at`); after that, a differing To Do value is a human
edit and wins. This stops a failed push from reverting a fresh app change on the next pull.

## Spoke 1 — Our views (native)

The taskpane task list, the admin matter board and the worklist all read `matter_task`
directly. Completing a task from the worklist routes through `updateTask` so it fans out
like any other completion.

## Spoke 2 — Microsoft To Do (dormant until consented)

`todo.ts` pushes a task into the assignee's personal To Do list and pulls their edits back
via delta queries. Gated on the `Tasks.ReadWrite` scope: without consent every call is a
silent no-op. Pull is on demand (taskpane open, task list refresh), so a To Do edit shows up
on the next read rather than instantly.

## Latency note

Push *to* To Do is immediate. Pull *back* is on the next read — To Do does not notify us.
