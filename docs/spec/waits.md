# Waits: things someone else owes us

A wait is opened by the request that asks for the thing, chased on its SLA, escalated when overdue, and closed when the thing arrives — however it arrives.

## Rules

- **Every request opens a wait; every wait has a chase.** Key in `WAIT_KEYS`, rule in `sla.ts` (chase after/every, escalate after, recipient, template), chase text in `comms/templates.ts`.
- **A wait closes on the real thing**, not on a proxy: the contract pack closes only when the contract **and** the title are on file; signing closes when every sent deed is signed.
- **Answerable in place** from the Tasks list **Waiting** row (`WAIT_ACTIONS`):
  - a document → **Upload …** (read with the right role; the row says what it was read as, and why the wait stays if it is not what was asked for);
  - a fact → **Record …** (its completion form opens in place, with the scan where the form asks).
- **Chase Now** from the row, with a spinner and "Sent".
- **Overdue colours the case**: theirs late → Delayed - Others; escalations surface as tasks.
- Client expectations (mortgage, survey) are timer-opened waits: we check in rather than let them drift.

## Adding one

Add the key, SLA rule, chase template, `WAIT_LABEL`/`WAIT_SIGNAL` labels, the opening event, the closing event(s), `WAIT_ACTIONS` entry, and the simulator's answer in `no-stall.test.ts` (it fails on an unanswered wait key).
