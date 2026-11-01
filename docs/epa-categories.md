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
| Hours a week per red and amber category sent by email | Sent Items over two months: each email's category and recipient role, minutes from Outlook's draft-to-send timing where it has one, else typical minutes | Counted |
| What causes them | The Inbox: status requests, chasers received, documents delivered | Counted |
| Filing | InTouch's folder: emails and documents filed per week | Counted; minutes each estimated |
| Cases per conveyancer | InTouch's matter list by fee earner | Counted |
| Green | The time before legal emails sent and legal documents filed in InTouch | Measured; the rest of the week is Not Seen, never green |

So the headline is "**at most** 25% of your week moves cases on": an upper bound, which errs in the firm's favour and still lands, because the red is measured, not estimated.

**Built (2026-10-15):**
- **Where:** Tools → Measurement (`/conveyi/integrations/measure`), beside the InTouch connector, with a back button to Tools. Each conveyancer scans their own last two months once (their own mailbox, their own sign-in); the page shows the firm's typical week, never one person's.
- **The scan** (`lib/server/workload/scan.ts`): Sent Items, then the Inbox, then InTouch when it is connected. Up to 15,000 messages a person, enough for 200–300 received and 60–80 sent a day. Classified on the classify model (Haiku), 15 emails a call, the first 900 characters of what was written, nothing stored but the label. It now tells resends from first sends, and process questions from legal ones (prompt `wl-2`).
- **InTouch:** the person's 60 most recently updated cases (InTouch's fee earner is them, by email or name) that were live or touched in the window, completed ones included. Every document and note the firm filed on them in the window, with when it was filed, goes on the person's timeline beside their email (lib/server/epa/measure.ts), classed by what it is: reports on title, enquiries, contracts and transfers are legal work; completion statements, SDLT and Land Registry papers are paperwork; anything else filed is filing. Email records are left out (InTouch's own Exchange filing may have put them there); client uploads are not our time. If no case has the person as fee earner, the page says so and names the fee earners InTouch does have. InTouch's tasks carry no completion date, so they are not read. Who filed an item is not in InTouch's data: items are credited to the case's fee earner. Field names to confirm on a live account. "See What It Read" lists every InTouch document and note it read, with its case.
- **The figures** (`lib/server/epa/measure.ts`): the same model as the live page. Every sent email and every document or note the firm filed in InTouch is an action at a time; the time before it is that kind of work, capped by what the work takes (routine: three times its typical minutes, never under 15; legal work: three hours). Outlook's draft-to-send time is writing. Every received email is reading time of its kind when it arrived. So **green is measured**: the time before legal emails and before the legal documents the firm filed (reports on title, enquiries, contracts, transfers). What nothing accounts for is **Not Seen** (grey): calls, meetings, files read with nothing sent after. It is shown, never counted as green.
- **The page:** a strip of figures (your scan's window; sent, received and set aside as a day's average over its working days; InTouch cases and filings, the firm's average reply time), then A Typical Week and Key Issues (the Pareto), both per conveyancer (the firm's total over the people scanned), with what the red and amber are worth a year (`lib/value.ts`: 30 completions a month at £1,000, 220 days of 7.5 hours; an hour a week is the minutes it frees on each case at £1,314 a minute a case). No actions: this is the measurement, not the action page.
- **Average reply time:** each case email received, to the next email the person sent on that conversation, everyone's averaged, in clock time (what the person waiting goes through). Two people waiting at once are two waits. Never-answered emails, and answers more than 14 days later (a new subject on an old thread), are left out.
- **See What It Read** lists what the scan kept (its subject and who with, as names and domains: migration 128), never reading the mailbox again. Scans before migration 128 show no subjects.
- **No checking:** nobody is asked to mark the model's labels; the scan finishes as complete. The old Baseline page, and its sample check, are retired (it redirects to Measurement).
