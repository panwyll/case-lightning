# Decisions: reviews, proposals, escalations

A decision is a person's call on something the engine read or wants to do. It is a task.

## Rules

- **Read first**: a decision on someone else's document needs the source opened (and engaged with) before it can be resolved. Proposals and held clears are the engine's own text.
- **Every option leads somewhere** (`rules.ts OPTIONS_FOR`):
  - approve → the step proceeds;
  - request further → an enquiry/query goes and a wait opens; the answer comes back as a new decision;
  - refer to client / indemnity → recorded, the step proceeds on that basis;
  - reject (a proposal) → not sent; if the case still needs it, **Send It** ([triggers.md](triggers.md)); reject (a report) → **Draft Again**;
  - escalate → see below.
- **Anything but approve needs a reason**, stored on the event.
- **Escalating names a person** who can open the case (`/matters/:id/escalate-to`); the machine refuses without one or to oneself. It leaves the handler's list and lands on theirs. Their answer settles the original in its own terms (a report approved/returned, a proposal sent/not, a held clear applied). Timer escalations go to the case handler.
- **Every decision cites its source** (a document, a page).
- **Quick approve** only for standard sends; anything that reads a document or an AI draft opens to review.

## Adding a kind

Its options in `OPTIONS_FOR`, its events in `resolveEvents` for each option, its origin handling when escalated, and a run of the stall detector (it takes every alternative).
