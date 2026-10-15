# What the time is spent on: the categories

Built in `lib/server/epa/taxonomy.ts`. These labels are what the measurement phase reports at onboarding and what Analytics → Time shows every week: the same list in both places.

## Red, amber, green

- **Green:** only a conveyancer can do it, and it moves the case on.
- **Amber:** probably needs a conveyancer, but does not move the case on. A week of only amber leaves the north star where it was.
- **Red:** time wasted. Neither needs a conveyancer nor moves the case on.

## Rules for a category

1. **Named as the work done:** what was done ("Sending", "Answering"), to or for whom, and whether it was proactive or in reply. "Sending Proactive Client Updates" and "Answering Client Status Requests" are different work with different fixes.
2. **One obvious remedy each:** automate (a CONVEYi action set to Send), delegate (an assistant), prevent (stop it happening), or keep (make it faster).
3. **The same label from every source:** an email in Sent Items, a CONVEYi proposal approved on the Tasks list, an InTouch task ticked.
4. **Never a catch-all.** No "Admin", "Requests" or "Other". A chip the list does not know is not counted rather than guessed.

## The list

The description of each is its tooltip on the page.

**Red**
- Sending Client Chasers · Sending Other Side Chasers · Sending Lender Chasers · Sending Agent Chasers · Sending Third Party Chasers
- Answering Client Status Requests · Answering Agent Status Requests · Answering Other Side Status Requests · Answering Lender And Broker Status Requests
- Sending Proactive Client Updates · Sending Proactive Agent Updates · Sending Proactive Other Side Updates · Sending Proactive Lender And Broker Updates
- Resending Documents To The Client · Resending Documents To Others
- Asking The Client For Documents · Asking Others For Documents
- Sending Documents To The Client · Sending Documents To Others · Sending Acknowledgements
- Filing Emails And Documents · Recording Receipts · Writing File Notes · Opening The Case · Ordering Searches · Submitting Land Registry Applications · Filing SDLT Returns · Closing Files · Resending Failed Emails · Unlocking Protected Files
- Answering Client Process Questions · Arranging Completion Dates And Calls · Verifying Bank Details · Requesting Completion Funds · Checking CONVEYi Drafts

**Amber**
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

**What it needs before it can say that, not built yet:**
1. **The classifier learns the new categories it cannot tell yet:** client process questions from legal ones (today all are counted as legal, amber, the kind side), and resends from first sends (today counted as sending).
2. **The scan report uses this page's layout:** the stacked bar, the Pareto and the actions, for "your typical week", instead of the separate Baseline page.
3. **InTouch's folder and matter list read for the counts above.** Field names to confirm on a live account (docs/intouch-integration.md, "Still to confirm").
4. **Green as the remainder of the contracted week,** labelled "at most".
