# Issues: problems on a case

A typed problem (`issues.ts ISSUE_KIND_SPEC`) with what it stops, who owns the next step, and when it must be sorted.

## Rules

- **Every issue has a resolve-by date**: the kind's window (`escalateAfterWorkingDays`, else 10 working days), capped before the target date of what it stops; changeable (More → Change Resolve-By Date). Past it: ours → Delayed - Us, theirs → Delayed - Others, and it joins the Tasks list whoever owns it.
- **Ownership is from our side**: on a sale, what "the seller's side" owes is ours.
- **Row text is plain**: title, then `Kind · Stops exchange · Resolve by 3 Oct` (red "N days overdue"). No chips saying what it holds.
- **Resolving asks for what the outcome needs** (`RESOLUTION_FIELDS`), enforced by the machine for a person: e.g. indemnity → insurer, premium, who pays, the policy; offer extended → new expiry (moves the offer); dates re-planned → the dates (moves the targets); evidence outcomes → the document (pick from the case or upload in the form); accepted as is → the advice + written-advice confirmation. Effects shown in a few words; lender effects only with a lender.
- **Kinds closed by their own act** (`FORMLESS_KINDS`: not sent, locked file) show that act (Try Again, Enter Password), not Resolve.
- **Context kinds** (seller/buyer delay) hold nothing and make no task; they answer "any update?".
- **An issue is never a dead end: Next Steps** (`issueSteps(kind, side)`) sit above the outcome. A message step drafts from the case (the reply drafter, else the step's sentence; `{issue}` names the issue), is edited and sent from the form (client via `email_reply`, anyone else via `party_message`), and is logged on the issue ("Emailed the client: …"); sending does not resolve it. Agree New Dates sets the target dates and logs them; Mark Negotiating and It Has Fallen Through (red, abandons after confirmation) open their forms. Kinds with their own steps: transaction/mortgage at risk, offer expiring/expired/expiry unknown, seller/buyer delay, chain, completion failure, redemption statement, lender funds, funds shortfall. The rest: acting for the buyer, Write To The Other Side + Update The Client; acting for the seller, Ask The Client + Update The Other Side; kinds that hold nothing, Update The Client; money/AML, Update The Client. Endpoint: `GET/POST /matters/:id/issues/:issueId/message`.
- **Transaction at risk** resolves as They Are Proceeding, Chain Ready, Dates Re-Planned, Accepted As Is or Other.
- **One problem, one issue** (`issues.ts duplicateIssue`): raising an issue that matches an open one (same kind and party; a kind a case has one of, like the deal at risk or the offer expiring, or most of the same words) notes "Reported again: …" on the existing issue and keeps the stronger hold. Duplicates already on file are merged by the timer: the later one is withdrawn as a duplicate of the earlier. Timer-keyed issues keep their own idempotence.
- **Every More action is an inline form**, never a browser prompt; Abandon needs an explicit confirmation.

## Adding a kind

Spec entry (label, group, gate, stages, resolutions, responsible, window), `ISSUE_CHIP`, its next steps in `STEPS_BY_KIND` if the defaults do not fit, and — if a resolution needs a new field — `RESOLUTION_FIELDS`. The simulator resolves issues with each kind's first outcome and its required fields.
