# EPA: who sees what, stage 1 and stage 2

A design proposal, not built yet. The method is in docs/epa.md. This file is what each kind of person sees and does.

## The two stages, and their measures

| | Stage 1: quick wins | Stage 2: compress the green |
| --- | --- | --- |
| Aim | Take the red and amber work off conveyancers, to CONVEYi or to an assistant | Make each piece of legal work take a fraction of the time |
| Measure | **Efficiency**: green ÷ all counted time | **Conveyancer hours per completion** (green minutes per case, by kind) |
| How | Actions moved from Propose to Send; routine routed to assistants; fewer clicks | Each green kind arrives prepared; one is targeted each week, then measured |
| Cadence | Switch on, check after a week | A weekly review with us: the top green kind, one change, the result next week |

Efficiency stops being useful as it nears 100%: once the red is gone, the only way up is less time per case. That is why stage 2 changes the measure.

## The three people

### Management (partner, head of conveyancing)

The question: is it working, what do I switch on next, how many more cases can we take?

**Stage 1**
- **Analytics → Efficiency, firm view by default.** Shows the team's efficiency this week against last week and the baseline, hours of red and amber taken off conveyancers this week (by CONVEYi, and by assistants), and the extra completions a month that time is worth.
- **The Pareto, with the evidence to act.** Each bar shows the action that takes the work and how the firm has treated its drafts, for example "Chases: 204 of 212 approved unchanged in 4 weeks". An admin can switch it from that bar: "Send Chases Without Asking". Going back is one click too.
- **People, by name and not ranked.** For each person: efficiency, hours handed off, and drafts approved unchanged. It shows who is still doing routine work by hand, without a league table.
- **A Monday summary email.** Last week's figures and the top bar of the Pareto. This is a weekly scheduled send, so it waits to be agreed.

**Stage 2**
- **The weekly review.** On Analytics → Efficiency, the top green kinds by minutes per case. An action log records what we change each week, who owns it, and what it did the following week.
- **Capacity.** Cases per conveyancer at today's hours per completion, against what the firm needs. It answers "hire or automate".

### Assistants (including an offshore team)

The question: what do I clear, how fast, and when do I pass it up?

**Stage 1**
- **Tasks → Routine.** The red and amber work grouped by kind, not by case, for example "Chasers 14, Acknowledgements 9, Client Updates 6, File Requests 3".
  - Opening a kind shows its drafts one under another, with the parts that change (names, dates, amounts, documents) highlighted, so the eye checks only those.
  - The assistant ticks the drafts that are right and uses "Approve Selected".
  - Keyboard: J and K to move, A to approve, E to edit, U to send up.
- **Routing.** On a case with an assistant, routine kinds go to the assistant first, and the conveyancer sees them only when sent up. This needs each conveyancer paired with their assistant(s).
- **Send Up (Ask The Conveyancer).** One question in a line ("The buyer wants to move completion to the 28th: agree?"). It reaches the conveyancer as one task with yes/no/note, and the answer comes back to the assistant's draft. There's no email ping-pong.
- **Hard emails.** A rude or hostile email opens with a neutral one-line ask ("They want the completion date confirmed by Friday") and a calm reply draft. The original is folded underneath.
- **Their figures.** Items cleared and hours taken off conveyancers. These are visible to them and admins, never as a minute-by-minute log.
- **Their working day.** Each person has their own working hours (an offshore team's day differs), so time is clipped to their day, not the firm's.

**Stage 2**
- **From doing to checking.** With routine kinds on Send, the assistant's list becomes exceptions only: bounced, angry, unmatched or ambiguous.
  - **Spot checks.** One in ten of what CONVEYi sent is shown afterwards ("Looks Right" or "Wrong"). A "Wrong" pauses that kind and becomes a rule to fix.
- **Preparing the green.** The assistant gets each piece of legal work ready for the conveyancer: the title read with the points pinned, the enquiries drafted, the client's questions gathered. Prep time moves from the conveyancer to the assistant.

### Conveyancers

The question: let me do the legal work, and keep the rest away.

**Stage 1**
- **Tasks → My Work shows green only by default.** Their own legal work and what an assistant has sent up. Routine is one line with a count, and can be opened.
- **Review Block.** "Start Review Block" lines up the green items in order, one at a time. Routine notifications are held until the block ends, then the block shows what was done. Focus blocks on Analytics show whether it helps.
- **Inbox shield.** "Any news?" emails and chasers are answered by CONVEYi or the assistant. The Email view shows the conveyancer only what needs them.
- **The same neutral-ask view for hard emails.**
- **Their own figure.** A small chip in the header ("Conveyancer-only 58%") links to Analytics.

**Stage 2: compress the green**
- **Every green kind arrives prepared.**
  - Title: points pinned, enquiries suggested.
  - Searches: the risks flagged, with client wording drafted.
  - Mortgage offer: checked against the case.
  - Report on title: drafted.
  - Enquiry replies: each pre-marked satisfactory or not.

  The conveyancer reviews and decides rather than reads and writes. Much of this exists already (draft check, the file index, the auto report on title). Stage 2 makes it the default way each kind opens, and measures it.
- **The loop.** Each week, take the green kind with the most minutes per case, change one thing, and measure next week. Keep it or roll it back.

## Decisions needed before building

1. **Pairing.** Is an assistant paired with a conveyancer (all their cases), or set per case?
2. **Who switches actions to Send from the Pareto.** Admins only, or also the conveyancer for their own cases?
3. **Monday summary email.** A weekly scheduled send. Yes or no?
4. **Working hours per person.** Each person's own day, with the firm's day as the default?
5. **Assistant figures.** Shown to the assistant and admins only, or also to their conveyancer?

## Build order for stage 1 (smallest first)

1. Tasks → Routine (grouped by kind, Approve Selected, keyboard).
2. Pareto evidence ("approved unchanged") and the switch on the bar.
3. Hard-email neutral ask and calm draft.
4. "Any news?" emails answered under a trust level (the WhatsApp guard already exists).
5. Pairing, routing and Send Up.
6. Review Block, and My Work green-only.
7. Firm view on Efficiency, per-person working hours, and the Monday summary.
