# Tasks

A task is something **we** must do, on the person's Tasks list, doable in place.

## Sources (and only these)

| Source | Code | Row button |
|---|---|---|
| Decision (a review, a proposal to send, an escalation) | `surfacedDecisions` → `work.ts decisionTask` | Approve (standard sends) / Review (reads first) |
| Due step (ours, by the case's state) | `due.ts dueSteps` | The step's own action: `STEP_ACTION_LABEL` / `STEP_UPLOADS` |
| Issue of ours (or anyone's, once overdue) | `work.ts` issues loop | Resolve (opens the outcome form) / Try Again / Enter Password |
| Something held back that the case still needs | `due.ts resend:<proposal>` | Send It |
| Deadline we owe | `work.ts` escalate bucket | Review (the case's own to-do in place) |

Waits are not tasks: they are listed under **Waiting** and chase themselves ([waits.md](waits.md)).

## Rules

- **Title is the action**: "Send the client the ID check", "Upload Official Copies", "Approve the contract for signature". No "Proposal:", no "Decide:".
- **Chip is `<who> <kind>`, title is the exact action** (`work.ts proposalChip`, `DUE_CHIP`):
  - Client Acknowledgement · Acknowledge receipt of the client's proof-of-funds form
  - Seller's Solicitor Chaser · Chase the seller's solicitor for replies to our enquiries
  - Lender Request · Ask the lender for a redemption statement
  - Client Request · Send the client the signing pack (anything asking the client to act)
  - Client Update · Update the client: searches ordered
  - Agent Update · Tell the estate agent contracts are exchanged
  - Steps and reviews: Official Copies, Lender Certificate, HMLR Application, Search Result, Mortgage Offer; issues by kind (Building Regs). Never what it holds.
- **Offered only when doable**: a due step's condition includes the stage and blockers the machine checks for its command.
- **Every due key has an action** in `WorkPanel dueAction` and a label in `STEP_ACTION_LABEL` (or an upload in `STEP_UPLOADS`). A key without one falls back to "Open Case", which is a bug.
- **Due date**: set where one exists (a deadline we owe, an issue's resolve-by). Overdue shows red on the row and colours the case.
- **Belongs to one person**: the case handler, or whoever it was escalated to. The badge counts the person's own.
- **One click when there is nothing to fill in**: a step with no form (Send The Form, Send It, Draft Again, Record Lodged — `directStep`) acts on the row; only steps with a form expand, and they open straight onto it. Never a button that reveals the same button.
- **Deletable, restorable**: a red **Delete** (text, never an X that reads as collapse) takes it off the list and counts; **Deleted** restores it.
- **Unsuccessful sends say why and fix in place**: "Chase to the seller's solicitor unsuccessful"; no address → the row takes the email and **Save And Send** (saved to the case's contacts under the role).
- **Done means gone, visibly**: the row shows the success (tick, "Read as the register", "Resolved …") for ~2s, then leaves.

## Adding one

A new due step needs: the condition in `due.ts` (gated like the machine), `dueAction` + label, the simulator's command in `no-stall.test.ts`. The stall detector fails until all three exist.
