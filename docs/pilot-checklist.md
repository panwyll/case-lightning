# Pilot checklist

A fully managed pilot: one firm, one conveyancer to start, every action at Propose, InTouch as the firm's case system.
Tick each item as it is done; add what the pilot teaches us.

## Before kickoff

### Ask InTouch (or the firm's InTouch admin)
- [ ] The **data marker list**, and which markers the firm fills in when it opens a matter by hand (reference, client name and email, address, postcode, purchase or sale, fee earner, workflow template). Needed for **Create Cases In InTouch**.
- [ ] Is there a **staff-only folder area**? Until we know, keep **Send Documents To InTouch** off: a document we upload may be visible to the client in their portal.
- [ ] The **Matter State Change** and **Task State Change** webhook payloads (where the matter id sits), and whether webhooks can be signed.
- [ ] Does the firm's InTouch already file their sent email from Outlook? If so, keep **Send Emails To InTouch** off, or each email is there twice.

### Ask the firm
- [ ] Which client requests they run in InTouch's portal (property forms, source of funds, signing). CONVEYi still sends its own today for anything but searches and the ID check; suppressing the rest per firm is not built yet.
- [ ] The pilot conveyancer's name exactly as InTouch spells it (InTouch's case list gives the fee earner's name, not their email). Match their CONVEYi display name to it.
- [ ] Their milestone task names, if milestones are to move the client portal.

### Set up
- [ ] Microsoft: firm IT grants admin consent; the conveyancer signs in at caselightning.co.uk/conveyi.
- [ ] Billing: set the firm to comp (pilot cases logged, never charged).
- [ ] InTouch: API key in Tools → InTouch; webhook URL added in InTouch (API Management → Webhooks: Form Completion, Matter State Change, Task State Change).
- [ ] Write-back: Case Notes on; Emails on (unless InTouch already files them); Task Completions on, then walk **Task Mapping** with the firm against their workflow; Documents off until the staff-only question is answered.
- [ ] Create Cases In InTouch: fill in the data markers from InTouch's list; open one test case and check it in InTouch.
- [ ] Trust levels: everything at Propose (the default).

## Kickoff day
- [ ] Measurement: the conveyancer runs the scan (Tools → Measurement). It becomes the dated comparison bar on Analytics → Cases.
- [ ] First InTouch sync with them watching: compare the cases that came across with the cases they have live (InTouch's status words are unconfirmed; a mismatch skips live cases). Read the sync's error list.
- [ ] Placing: confirm each case taken on part-way through (one Confirm Where This Case Is task per case, about 20 seconds each).
- [ ] Check a new instruction comes across within minutes (webhook), not at the 06:45 daily sync.

## Still to confirm on the live InTouch account
- [ ] List paging, ordering, matter states, template names (docs/intouch-integration.md "Still to confirm").
- [ ] Upload body, folder item types.
- [ ] Task State Change carries the task id; completed tasks reach the Time page.
- [ ] Files uploaded in InTouch reach CONVEYi within 15 minutes (the folder poll), and the folder accepts `orderBy=createdOn`.
- [ ] An email filed with InTouch's Outlook add-in: what its folder record carries (subject, date, sender), and that CONVEYi files the same email to the same case within a minute. Whether its attachments also land as separate files.

## Weekly through the pilot
- [ ] Analytics → Time: red falling; Week By Week against the scan bar.
- [ ] Analytics → Cases → Messages: reply time, waiting on us, follow-ups after our emails, bounces, drafts approved as written.
- [ ] Which Propose actions are approved unchanged often enough to move to Auto (start with acknowledgements and proactive client updates).
