# Triggers: what happens by itself

## Rules

- **Every outward step has a trigger.** A request, chase, update, order or pack goes when its moment arrives (an event), not when someone remembers. Where: `service.ts automaticSteps`, `FIRST_REQUESTS`, `CLIENT_UPDATE_TEMPLATES`, the machine's derive loop (`contract_pack_requested`, `signed_transfer_requested`, `exchange_conditions_met`).
- **Each thing goes when it is ready, once**: the mortgage deed when the offer clears, the contract when approved, the TR1 request on exchange. Not bundled behind an unrelated step.
- **Missed moments are caught up**: the daily tick re-checks anything ready but not sent (e.g. deeds ready to sign). A case enrolled late, or moved on by hand, still gets its sends.
- **Trust level decides send vs propose**, per action and subject (`engine_action_level`): `auto` sends, `propose` puts it on the Tasks list to approve, `assist` acts and asks for a confirming look (the engine's auto-clears). The trigger is the same either way.
- **"No" to a message is not "no" to the step.** A person rejecting an essential send (ID check, proof of funds, signing pack, search order, deposit/balance request, property forms, exchange authority, ownership, insurance) leaves a **Send It** task while the case still needs it (`due.ts resend:`). System withdrawals (duplicates, already arrived) do not.
- **Every send is checked** (`messageProblem`): a broken message becomes a task, never an email. A failed send becomes a **Not Sent** task with Try Again.
- **Sandboxes never reach a real mailbox** (`sandbox.ts routeEach`): every sender method is routed to the outbox; a real file uploaded to a sandbox is still read.

## Adding one

A new trigger names: the event, the recipient, the template (in Email Templates), the trust-level key, and what happens if it is rejected (does the case still need it → add to the resend set). If it opens a wait, see [waits.md](waits.md).
