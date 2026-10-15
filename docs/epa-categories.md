# What the time is spent on: the categories

Built in `lib/server/epa/taxonomy.ts`. These labels are what the measurement phase reports at onboarding and what Analytics → Time shows every week: the same list in both places.

## Red, amber, green

- **Green:** only a conveyancer can do it, and it moves the case on.
- **Amber:** moves the case on but someone other than a conveyancer could do it, or needs a conveyancer but does not move the case on.
- **Red:** does not need a lawyer, and does not move the case on. Never called "wasted": a client update keeps the client happy and brings referrals, it just needs no lawyer.

The rule for each colour is its tooltip on the page; the categories carry no tooltips.

## Rules for a category

1. **Named as the work done:** what was done ("Sending", "Answering"), to or for whom, and whether it was proactive or in reply. "Sending Proactive Client Updates" and "Answering Client Status Requests" are different work with different fixes.
2. **One obvious remedy each:** automate (a CONVEYi action set to Send), delegate (an assistant), prevent (stop it happening), or keep (make it faster).
3. **The same label from every source:** an email in Sent Items, a CONVEYi proposal approved on the Tasks list, an InTouch task ticked.
4. **Never a catch-all.** No "Admin", "Requests" or "Other". A chip the list does not know is not counted rather than guessed.

## The list

**Red**
- Sending Client Chasers · Sending Other Side Chasers · Sending Lender Chasers · Sending Agent Chasers · Sending Third Party Chasers
- Answering Client Status Requests · Answering Agent Status Requests · Answering Other Side Status Requests · Answering Lender And Broker Status Requests
- Sending Proactive Client Updates · Sending Proactive Agent Updates · Sending Proactive Other Side Updates · Sending Proactive Lender And Broker Updates
- Resending Documents To The Client · Resending Documents To Others · Sending Acknowledgements
- Filing Emails And Documents · Recording Receipts · Writing File Notes · Closing Files · Resending Failed Emails · Unlocking Protected Files
- Answering Client Process Questions · Checking CONVEYi Drafts

**Amber: moves the case on, someone other than a conveyancer could do it**
- Asking The Client For Documents · Asking Others For Documents · Sending New Documents To The Client · Sending New Documents To Others
- Opening The Case · Ordering Searches · Submitting Land Registry Applications · Filing SDLT Returns
- Arranging Completion Dates And Calls · Verifying Bank Details · Requesting Completion Funds

**Amber: needs a conveyancer, does not move the case on**
- Answering Client Legal Questions · Authorising Payments · Handling Complaints And Difficult Emails

**Green**
- Title Review · Search Review · Raising Enquiries · Reviewing Replies · Contract And Lease Review · Mortgage Offer Review · Report On Title · ID And Source Of Funds · Advising The Client · Negotiating · Resolving Issues · Drafting · Legal Correspondence · Exchange · Completion

## How each source is read

- **Tasks in CONVEYi:** from the chip, the task's kind and what a proposal would send (to whom, asking for what). Deterministic.
- **Sent email:** the scan's category plus the recipient's role on the case gives the label: a chaser to a lender is Sending Lender Chasers; a reply to "any news?" from an agent is Answering Agent Status Requests; an unprompted update is proactive.
- **Received email** is the cause, not the time: the time is the reply, which takes the category of what it answers.
- **InTouch:** filed emails and documents count towards Filing; its completed tasks map once, at onboarding, from the firm's own task names. InTouch records no time.

## The measurement phase (onboarding)

The pitch: plug in the mailbox and InTouch, and within the hour it says where the week goes and what share of it moves cases on.

**What it measures, and how firmly:**

| Figure | From | How firm |
| --- | --- | --- |
| Hours a week per red and amber category sent by email | Sent Items over 13 weeks: each email's category and recipient role, minutes from Outlook's draft-to-send timing where it has one, else the conveyancer's own estimate | Firm: counted, and checked by the conveyancer on a random sample (built) |
| What causes them | The Inbox: status requests, chasers received, documents delivered | Counted |
| Filing | InTouch's folder: emails and documents filed per week | Counted; minutes each estimated |
| Cases per conveyancer | InTouch's matter list by fee earner | Counted |
| Green | Not visible in email or InTouch: reading a title or a search leaves no trace | **The rest of the contracted week**, so the share is shown as "at most" |

So the headline is "**at most** 25% of your week moves cases on": an upper bound, which errs in the firm's favour and still lands, because the red is measured, not estimated.

**Built (2026-10-15):**
- **Where:** Analytics → Measurement (`/conveyi/measure`). Each conveyancer scans their own last two months once (their own mailbox, their own sign-in); the page shows the firm's typical week, never one person's.
- **The scan** (`lib/server/workload/scan.ts`): Sent Items, then the Inbox, then InTouch when it is connected. Up to 15,000 messages a person, enough for 200–300 received and 60–80 sent a day. Classified on the classify model (Haiku), 15 emails a call, the first 900 characters of what was written, nothing stored but the label. It now tells resends from first sends, and process questions from legal ones (prompt `wl-2`).
- **InTouch** (counts only): the person's live cases (InTouch's fee earner is them, by email or name), cases opened in the window, and what was filed. Documents and notes filed by the firm count as Filing and Writing File Notes; email records do not, because InTouch's own Exchange filing may have put them there; client uploads are not our time. InTouch's tasks carry no completion date, so they cannot be placed in a window and are not read. Field names to confirm on a live account.
- **The figures** (`lib/server/epa/measure.ts`): a week per category = how many a week × minutes each (Outlook's own draft-to-send timing where 10 or more were timed, else the typical minutes in the code). Green = the rest of the contracted week, never less than the legal email the inbox shows. Shown as the Time page's bar, Pareto and Actions, under one row of figures: status requests and chasers received a week, live cases per conveyancer. No headline card.
- **The sample check:** the scan still draws 50 sent emails for the conveyancer to confirm (the old Baseline page's check), so the classification can be shown to be right.
