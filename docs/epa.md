# Efficiency, Pareto, Action (EPA)

The north star is **efficiency: the share of a conveyancer's working time spent on work only a conveyancer can do.** The conveyancer is the firm's bottleneck (docs/workload-baseline.md), so every hour of theirs spent chasing, updating or filing is an hour of completions lost.

The loop, every week:
1. **Efficiency:** a RAG study of where the time went (red, amber, green).
2. **Pareto:** the red and amber work ranked by hours, biggest first.
3. **Action:** what to do about the top items, mostly a CONVEYi action switched from Propose to Send, and a template or rule fixed.
4. **Monitor:** next week's figures against this week's and against the baseline.

Page: Analytics → Time, the first tab of Analytics (`/conveyi/analytics`). Code: `lib/server/epa/`.

## 1. The kinds of work

One level above the Tasks list's chips: what the time was spent *doing*, not who it was for. A chaser is a chaser whether it went to the client or the other side.

| RAG | Kind | What it is |
| --- | --- | --- |
| Red: needs no conveyancer | Chasing | Asking again for something overdue |
| | Being Chased | Dealing with someone chasing us |
| | Status Updates | Telling someone where the case stands |
| | "Any News?" Replies | Answering an update request |
| | Requesting | Asking for a document or information the first time |
| | Sending Documents | Sending a file or copy someone needs |
| | Acknowledging | Confirming something arrived |
| | Admin | Recording receipts and outcomes, filing, data entry |
| Amber: needs a conveyancer's eye, not their time | Client Questions | Answering a question about the process or the case |
| | Scheduling | Arranging calls, dates, completion logistics |
| | Checking Drafts | Reading what CONVEYi drafted before it goes |
| | Payments | Verifying bank details and authorising money |
| Green: only a conveyancer | Legal Review | Title, searches, replies, contract, offer, report on title, ID and AML judgement |
| | Advising | Advice to the client, their instructions and decisions |
| | Negotiating | Points with the other side, enquiries raised and answered |
| | Exchange And Completion | Exchanging, completing, and the money and undertakings around them |
| Not counted | Internal, Not Case Work | Colleagues; anything else |

Every source maps onto these kinds in one place (`epa/taxonomy.ts`):
- the baseline's email categories;
- each kind of task on the Tasks list (a decision, a proposal by its action, a step by its key, an issue);
- each email read or written in the app.

"Checking Drafts" is amber on purpose. It is what a CONVEYi action costs while it is on Propose, and it shrinks as actions move to Send.

## 2. Measuring time without double counting

Two timestamps and their difference do not measure work. An email received at 09:00 and answered at 15:00 says nothing about the six hours between, during which the conveyancer did twenty other things. Summing "how long each item sat in the in-tray" counts the same hour many times over: three items opened at 09:00 and finished one after another at 09:20, 09:40 and 10:00 sat for 20 + 40 + 60 = 120 minutes, but the person worked for 60.

So there are two different measures, and they are never mixed.

**Queue time (lead time)** is per item: how long it waited, from appearing to being done (`task_record`, email received to reply sent). It shows where cases wait. It is never added up into anyone's hours.

**Touch time** is per person: the minutes they were actually working on something. It is measured as **one attention timeline per person**. At any moment a person is working on at most one thing, so each minute of their day is given to at most one item, and the total can never exceed the time that passed.

### Completions: the time since the last thing finished

The base of the timeline is what each person finished: a task closed by them, an email they sent. Each completion is given the time back to the one before it:
- clipped to the start of the working day when it was finished in working hours;
- less lunch (13:00 to 14:00 by default);
- capped by its kind: an hour for red and amber work (in case the gap was lunch, a call or a meeting), three hours for green;
- completions within a minute of each other are one sitting (a run of approvals), and the time before them is shared equally.

Out-of-hours completions keep their gap (capped), so evening work shows as after hours. Three in-tray items finished at 09:20, 09:40 and 10:00 get 20 minutes each.

### Evidence

Completions are one source among several. The timeline is built from evidence spans, each with a source and a strength:

| Source | What it is | Strength |
| --- | --- | --- |
| **Focus** (measured) | An item open in CONVEYi, in view, with the person active: a task opened from the list, a review, an email read or replied to, a draft being edited. A span starts when it comes into view and ends when it is closed, hidden (another tab, the window minimised) or idle (no keyboard, pointer or scroll for 2 minutes). Only the item in the focused window counts. | 1 (highest) |
| **Outlook compose** (observed) | A sent email's draft being written: Outlook's draft-created to sent (15 seconds to 45 minutes, as in the baseline). | 2 |
| **Completion** (inferred) | The time since the last thing finished, as above. | 3 |
| **Outlook reading** (observed) | An email selected in Outlook with the CONVEYi pane open, until the next selection or 2 minutes idle. | 4 |

### Attribution: a sweep along the day

1. Every span boundary cuts the person's day into slices.
2. In each slice, the spans covering it compete. The strongest source wins; between equals, the most recently started wins, because that is what the person switched to.
3. The whole slice goes to the winner and to nothing else.
4. Time no span covers is **unattributed** (phone calls, meetings, breaks) and is shown, never guessed.

For the in-tray example: opening an item is not evidence of work, so the three items get three separate focus spans, one after another, and 60 minutes in all.

### The week

- **Hours per kind** are the slices given to each kind of work, in and out of working hours (the firm's working day, as in the baseline).
- **Efficiency** = green ÷ (red + amber + green) attributed working time. Unattributed time is left out and reported beside it.
- **Measured share** is the share of attributed time from evidence rather than estimates. The page says how much of the week is measured.

### Context switching

From the same timeline:
- **switches per hour:** changes from one item to a different one within a working stretch;
- **focus blocks:** how long a person stays on one item before switching (the median), and the share of working time in blocks of 25 minutes or more.

These are counted, not costed: no minutes are added for "switching cost". They show whether batching is helping.

## 3. The page

Analytics → Time shows the whole firm, never one person: per-person figures read as a league table, and "efficiency" reads as a witch hunt, so the page says neither. Each person's time is still attributed on their own timeline (§2) and then added up.

- **Last week:** one bar of the last complete week, split into Legal Work (green), Checks (amber) and Routine (red), with each share and its hours. Under it, the same bar before CONVEYi, from the mailbox scans.
- **Week by week:** the same split for each of the last eight weeks.
- **Where routine time goes:** the red and amber kinds for that week, biggest first. Each shows its hours, how many times it happened (emails and tasks), the average minutes each took, and the CONVEYi action that takes it, at its level now, with a link to switch it to Send.

No medians, percentiles or queue times: the readers are not analysts.

## 4. Privacy

- Spans record which item and what kind of work, never content.
- The page shows the firm's hours by kind of work, never one person's, and never a minute-by-minute log of anyone's day.

## 5. What is built, and what is not yet

| Part | Where | State |
| --- | --- | --- |
| Kinds and mappers | `lib/server/epa/taxonomy.ts` | Built |
| Attention timeline and the week's measures | `lib/server/epa/ledger.ts` (pure, `tests/unit/analytics/epa-ledger.test.ts`) | Built |
| Report: weeks cut at Monday, Pareto with the action and its level, queue | `lib/server/epa/report.ts` | Built |
| Focus capture | `app/shared/epa/useAttention.ts`: a task open in place on the Tasks list, a decision on its own page, an email open in Email | Built |
| Storage | `activity_span` (migration 125); `POST /api/v1/epa/spans` (batched: on hide, every 5 minutes of use, and before the Efficiency page loads) | Built |
| Completions | Tasks closed by the person (`task_record`), and sent emails from the mailbox scan (`workload_email`, with Outlook compose when timed) | Built; sent email only for the weeks a scan covers |
| Outlook reading | The add-in's item selection, as `reading` spans | Not yet |
| Sent email after the baseline scan | Reading yesterday's Sent Items each day | Not yet: scheduled work, so it waits to be agreed (the Vercel cost cap) |

A row Approve on the Tasks list is a completion, so it is given the time since the last one. The queue table uses `task_record`, whose older rows may have no kind; those are classified by their chip.
