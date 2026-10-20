# UI rules

## Where

- **Tasks list is the workplace.** Everything to do is there, grouped by case, with its action on the row. Opening the case is never required to finish a task. It refreshes itself every 30 seconds while on screen and on returning to the tab, never while a task is open. Approving counts down 2 seconds on the button (click again to cancel). Highlights in documents are Excel yellow (#FFFF00).
- **Case view is for troubleshooting and overview**: flowchart, documents, timeline. No commands in flowchart lanes; the case's Tasks tab mirrors the Tasks list (same components: `WorkPanel dueAction`, `IssuesPanel`, `DecisionPanel`) plus adding work (Add Note, Raise Enquiry, Raise Issue) — never a step that exists only there.
- **The flowchart documents the flow**: every automatic step shows its marker (email, document, sign-off, gate); each section's status chip sits top right.

## How

- **Buttons show their work** (`BusyButton`, `UploadButton`, `Spin`): spinner + "Saving…" while running, green tick + "Saved/Sent/Uploaded" when it worked, back to normal with the reason shown when it did not. A tick only when the step is actually done (an upload read as the wrong thing does not tick).
- **Outcome in words** next to the thing: "Read as the register", "Filed on the case, but it reads as a contract, not official copies".
- **Delete is red text**, never an X (an X reads as close/collapse).
- **Proper terminology**: "unsuccessful", not "did not go"; the reason in plain words under it.
- **Loading says Loading…**, never "No templates"/"No emails".
- **Title Case** on buttons, headers, labels, chips, dropdown options ("Ready To Exchange", "On Track").
- **Show Me Around** sits in the header bar on every page: a coach-mark tour of the sidebar that opens each page as it shows it, one line each, and returns where it started. Items a person does not have are skipped. After Tasks it works one task: a row, its button, the task opened in place, then its case and the case header's Raise Issue, Something Happened and Take Over, and the case's own Tasks tab (`data-tour` marks; a step whose target never appears is skipped).
- **Edge cases live in the case page's header, not the Tasks list.** Beside the health chip (and on each case's header on the Tasks list): a warning triangle (Raise Issue) and a hand (Take Over Manually; amber in manual mode, where it resumes automation). Raise Issue is the one place to record anything: a concertina of sections (Client, Death Or Capacity, Money Laundering, The Property, The Deal, Completion, ISA, This Case Is Also) that fold open one at a time, each listing only what can happen on this case now; picking one opens its small form under it, and Record says what it added to Tasks. Another Problem On The File, last, opens the full issue form (every kind, a price change, a moved completion date). There is no separate Something Happened button.
- **Undo vs Mark Incomplete** on a done step in the case view.
  - **Undo** is for a step marked done by hand in error: the case is rebuilt as if it had never been marked (only in the stage it was done in).
  - **Mark Incomplete** is for a step that was done but no longer holds (the offer expired, a price change voided the signed papers, a search went stale): outstanding again from now, with the reason, history kept. The mortgage reopens as a withdrawn offer.
  - Both ask why.
- **Dropdowns** (globals.css): one chevron 12px in from the right edge, sized to their content unless a width is set.
- **No fluff text**: no subtitles, no explanatory sub-lines; the title and the control carry it.
- **Icons ≥16px, no glyphs** (use `app/shared/icons`).
- **An email is a conversation**: its source pane shows the thread as chat bubbles (ours right, theirs left, attachments as chips, quoted history recovered); clicking one opens the usual From / To / Cc / Date / Subject view (`EmailThread.tsx`, `email-thread.ts`).
- **Checked at realistic widths** (1280–1400 desktop, narrow panel) on `/dev/harness` before shipping.

- **Filed email shows as Pending until it is read** (`TaskList.tsx usePending`, `/api/v1/mail/pending`, migration 131). An email someone files is read in the background; until that is done it is a Processing row under its case (or in a Pending box below Waiting, above Deleted, when the case has no tasks listed). When it makes a task the list reloads and the task is there; when it needs nothing the row says No Action Required for three seconds and goes. The list asks only while something is processing.

## Client portal

`/portal/<token>` (migration 121, `lib/server/client-portal.ts`, `engine/client-portal.ts`).

**Access:**
- One link per case.
- It opens with the same emailed six-digit code as a secure file link, and the browser then stays in for 7 days.
- The link goes at the foot of every message to the client (`withPortal`, above a short sign-off).
- On the case page, **Client Portal** has Copy Link and Reset Link. Reset revokes the old link at once.
- The page shows how often the client has opened the portal and how many files they have uploaded.

**What the client sees** (phone first, plain words):
- **One section at a time:** tabs on a wide screen, a menu button on a phone, For You first. The section is in the address (`#progress`). A section with nothing in it is not offered (History before anything is sent; For You on a closed case).
- **For You:** each thing waiting on them, when it was asked for, and the way to do it:
  - the ID check link;
  - the proof-of-funds form;
  - an upload for property forms, mortgage offer, survey, signed papers or insurance;
  - **Call Us** for any money. Bank details are never shown, with the "we never change bank details by email" warning.
- **Progress:** the parts of the work side by side, because they run at the same time and take very different lengths of time; never a step-by-step bar.
  - A bar with one segment per part, coloured Done, With You, In Progress or Not Started, with the count of each. Each segment names its part and who has it, and opens its row.
  - A row per part (`PortalProgress`), opening to: what it is, how long it usually takes (`ABOUT` in `engine/client-portal.ts`), who has it now ("With your lender", "With you", "With us"), since when, and when we expect it back.
  - "Expected" is the request date plus the long end of usual. It is never given for what is waiting on the client, nor for a part with no fair duration of its own (the contract, completion).
  - Past its usual time, a part says "Taking longer than usual" and how many times we have chased, and gives no date.
  - The key dates (exchange, completion) below.
- **Documents:** what we have sent them by secure link, and what they have given us. Only listed files can be downloaded.
- **History:** every message we sent the client (email or WhatsApp), newest first, each opening to the message as they got it, less the portal line (`portalHistory`). Never what went to anyone else.
- **Help:** organised by the workflow's macro stages (`engine/client-faq.ts`). These are the flowchart's sections: Instruction, Investigation, Enquiries, Contract & Exchange, Completion, Registration. A remortgage or transfer has Instruction, Investigation, Completion and Registration.
  - **Each stage answers, for the client's side:** "What happens at {stage}?", "How long does {stage} take?", and the one or two questions clients ask then (the deposit at Contract & Exchange, the keys or moving out at Completion).
  - **Current stage first, marked Now:** it adds "What do I need to do?", answered from the case. Its How Long uses the case's own dates.
  - **The rest:** the other stages, in order, behind Other Stages, then General (paying safely, cost, documents, security, contact details, concerns). Search covers everything.
  - Never a question that invites worry, never advice, never an issue.
- **Still Need Help?:** Contact Us opens a message box and the conveyancer's phone and email. A message is read like an email from the client and becomes a reply task on the Tasks list. Ten a day.
- **How Are We Doing?** (Ask Clients How We Did): CSAT after exchange, NPS after completion, once each, at the top of the page. A promoter is offered the firm's review page. The client's exchange and completion messages (every kind of case) ask for it, with the link, in place of the plain portal line.

**Never shown:** an issue, a decision, a flag or an internal code. A step held by an issue reads In Progress; the conveyancer tells the client about a problem, the page does not.

**Uploads:**
- Uploads are 4 MB at most; photos are shrunk in the browser to fit. PDF, photo or Word only.
- Each upload is filed on the case and goes through ingest like any arriving file. Uploaded against a task, the file carries that task's role.
- The conveyancer is notified.

A dev preview is at `/portal/dev-preview-portal-000000` (code 123456), showing the dev harness's case.

- **Tax questions on the portal**: until the answers are on the case, a buyer's For You list starts with Tax Questions (the SDLT questions, yes or no each) and a seller's with the two CGT questions; answering records them as the client's (`record_sdlt_facts` / `record_cgt_facts`) and the firm's matching task clears.
