# What the time is spent on: the categories

A proposal for sign-off. These labels are what the measurement phase reports at onboarding (from the conveyancer's inbox and InTouch) and what Analytics → Time shows every week, so they are the same list in both places.

## Rules for a category

1. **Named as the work, by who it is with.** "Lender Chasers", not "Requests". Someone reading the label knows what was done and to whom.
2. **One obvious remedy each.** Automate it (a CONVEYi action set to Send), delegate it (an assistant), prevent it (fix what causes it), or keep it (the conveyancer's own work). If two remedies apply, it is two categories.
3. **The same label from every source.** A chaser is "Lender Chasers" whether it was an email in Sent Items, a CONVEYi proposal approved on the Tasks list, or an InTouch task ticked.
4. **A bar is a category.** What was chased (the redemption statement, the offer) is the drill-down under the bar, not a bar of its own.

## The list

### Red: needs no conveyancer

| Category | What it is | Remedy | Task chips it covers |
| --- | --- | --- | --- |
| **Client Chasers** | Asking the client again for something they owe: ID, forms, funds, signed documents, a decision | Automate | Chase The Client; client chase proposals |
| **Other Side Chasers** | Asking the other side's solicitor again: contract pack, replies, transfer deed, completion information | Automate | Chase The Seller's Side; Seller's Solicitor Chaser |
| **Lender Chasers** | Redemption statements, offers, lender consent | Automate | Lender Chaser, Letter To The Lender |
| **Agent Chasers** | Memorandum of sale, buyer details, keys | Automate | |
| **Third Party Chasers** | Search providers, HM Land Registry, managing agents, brokers | Delegate (portal or phone) | Chase The Third Party |
| **Client "Any News?"** | The client asking how it is going | Prevent (portal) / Automate | |
| **Agent Status Requests** | The estate agent asking where the chain is | Automate | |
| **Other Side Status Requests** | The other solicitor asking where we are, or chasing us for something we owe | Automate (status) / Delegate | |
| **Broker And Lender Status Requests** | The broker or lender asking how it is going | Automate | |
| **Client Updates** | Telling the client where it is, unprompted (milestones) | Automate | Client Update |
| **Agent Updates** | Telling the agent | Automate | Agent Update, Letter To The Agent |
| **Other Side Updates** | Telling the other solicitor where we are | Automate | Other Side Update, Letter To The Other Side |
| **Resending To The Client** | "I can't find the thing to sign, can you send it again?", lost links, forms sent twice | Prevent (portal, secure links) / Automate | |
| **Resending To Others** | The other side or lender asking for a copy of something already sent | Automate | |
| **First Requests To The Client** | Asking for ID, forms, funds or documents the first time | Automate | Client Request |
| **First Requests To Others** | Asking the other side, lender or agent for something the first time | Automate | Request proposals (contract pack, redemption) |
| **Sending Documents To The Client** | Signing packs, the contract to sign, the report on title | Automate | Send Client Documents |
| **Sending Documents To Others** | To the other side, the lender, a landlord | Automate | Send Buyer's/Seller's Solicitor Documents, Send Lender Documents, Send Landlord Documents |
| **Acknowledging** | "Thanks, received", to anyone | Automate | Client / Seller's Solicitor Acknowledgement |
| **Filing To InTouch** | Saving emails and documents to the matter | Automate | Upload Documents |
| **Recording Receipts** | Logging that something arrived | Automate | Record Receipt |
| **Notes And Outcomes** | File notes, call notes, recording what was decided | Delegate | Record Outcome |
| **Opening The Case** | Setting the case up, entering details, re-keying between systems | Automate (InTouch mirror) | |
| **Ordering Searches** | Placing and tracking searches | Automate | Search Order, Run Search |
| **Land Registry Applications** | Filling in and submitting the application, answering requisitions' admin | Delegate | Submit Application, HMLR Requisition |
| **SDLT Return** | Completing and filing the return | Delegate | File Return |
| **Closing The File** | Archiving, final letters, file closure | Automate | Close File, Close Case |

### Amber: needs an eye, not the conveyancer's time

| Category | What it is | Remedy | Task chips it covers |
| --- | --- | --- | --- |
| **Client Process Questions** | "What happens next?", "What is a TA6?": the same answer for every client | Automate (from the firm's guide) | |
| **Client Case Questions** | A question about their own case | Delegate (drafted, checked) | Client Advice where it is not advice |
| **Booking Completion** | Agreeing dates across the chain, completion logistics | Delegate | |
| **Calls And Appointments** | Arranging calls and meetings | Delegate | |
| **Bank Details** | Verifying bank details by phone | Delegate (never automated) | Verify Details |
| **Requesting Completion Funds** | The completion statement and funds request | Delegate | Request Funds |
| **Payments** | Authorising and returning money | Keep (sign-off) / Delegate (preparation) | Authorise Payment, Return Money |
| **Checking CONVEYi Drafts** | Reading a CONVEYi draft before it goes, by kind of draft | Automate (set that kind to Send) | every proposal |
| **Difficult Emails** | Upset clients, hostile other sides, complaints | Delegate (neutral summary, calm draft) | |

### Green: only a conveyancer

Title Review · Search Review · Raising Enquiries · Reviewing Replies · Contract And Lease Review · Mortgage Offer Review · Report On Title · ID And Source Of Funds · Advising The Client · Negotiating · Exchange · Completion.

These are not on the Pareto but show in This Week's green, and are what stage 2 shortens.

## How each source is read

- **Tasks in CONVEYi:** from the chip, the task's kind and what a proposal would send (who it is to, what it asks for). Deterministic.
- **Sent emails (the inbox scan, and every email sent once live):** classified into the list above from who it went to (their role on the case), whether the thread already asked for the same thing (a chaser, not a first request), whether it answers an inbound "any news?" (then it is that category), whether it carries a document already sent (a resend), and its words. A reply takes the category of what it answers.
- **Received emails:** classified the same way. They are the cause, not the time: the time is the reply.
- **InTouch:** its completed tasks are mapped once, at onboarding, from the firm's own template task names to these categories. Its filed emails and documents count towards Filing To InTouch. InTouch records no time, so the time comes from the person's mailbox and CONVEYi.

## Questions before building

1. Is a bar "who × what kind of work" (Lender Chasers), with what was chased underneath, the right depth? Or should the bar go one deeper ("Lender Chasers · Redemption Statements")?
2. Do Phil's conveyancers file to InTouch and record receipts by hand today? If InTouch's own Exchange filing already does it, Filing To InTouch drops out.
3. Anything missing that you see them lose hours to?
