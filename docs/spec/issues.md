# Issues: problems on a case

A typed problem (`issues.ts ISSUE_KIND_SPEC`) with what it stops, who owns the next step, and when it must be sorted.

## Rules

- **Every issue has a resolve-by date**: the kind's window (`escalateAfterWorkingDays`, else 10 working days), capped before the target date of what it stops; changeable (More → Change Resolve-By Date). Past it: ours → Delayed - Us, theirs → Delayed - Others, and it joins the Tasks list whoever owns it.
- **Ownership is from our side**: on a sale, what "the seller's side" owes is ours.
- **Row text is plain**: title, then `Kind · Stops exchange · Resolve by 3 Oct` (red "N days overdue"). No chips saying what it holds.
- **Resolving asks for what the outcome needs** (`RESOLUTION_FIELDS`), enforced by the machine for a person: e.g. indemnity → insurer, premium, who pays, the policy; offer extended → new expiry (moves the offer); dates re-planned → the dates (moves the targets); evidence outcomes → the document (pick from the case or upload in the form); accepted as is → the advice + written-advice confirmation. Effects shown in a few words; lender effects only with a lender.
- **Kinds closed by their own act** (`FORMLESS_KINDS`: not sent, locked file) show that act (Try Again, Enter Password), not Resolve.
- **Context kinds** (seller/buyer delay) hold nothing and make no task; they answer "any update?".
- **Every More action is an inline form**, never a browser prompt; Abandon needs an explicit confirmation.

## Adding a kind

Spec entry (label, group, gate, stages, resolutions, responsible, window), `ISSUE_CHIP`, and — if a resolution needs a new field — `RESOLUTION_FIELDS`. The simulator resolves issues with each kind's first outcome and its required fields.
