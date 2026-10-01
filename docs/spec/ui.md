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
- **Show Me Around** sits in the header bar on every page: a coach-mark tour of the sidebar that opens each page as it shows it, one line each, and returns where it started. Items a person does not have are skipped.
- **Edge cases live in the case page's header, not the Tasks list.** Beside the health chip: a warning triangle (Raise Issue on the case) and a hand (Take Over Manually; amber in manual mode, where it resumes automation). Each asks for its reason in a small form.
- **Undo vs Mark Incomplete** on a done step in the case view.
  - **Undo** is for a step marked done by hand in error: the case is rebuilt as if it had never been marked (only in the stage it was done in).
  - **Mark Incomplete** is for a step that was done but no longer holds (the offer expired, a price change voided the signed papers, a search went stale): outstanding again from now, with the reason, history kept. The mortgage reopens as a withdrawn offer.
  - Both ask why.
- **Dropdowns** (globals.css): one chevron 12px in from the right edge, sized to their content unless a width is set.
- **No fluff text**: no subtitles, no explanatory sub-lines; the title and the control carry it.
- **Icons ≥16px, no glyphs** (use `app/shared/icons`).
- **An email is a conversation**: its source pane shows the thread as chat bubbles (ours right, theirs left, attachments as chips, quoted history recovered); clicking one opens the usual From / To / Cc / Date / Subject view (`EmailThread.tsx`, `email-thread.ts`).
- **Checked at realistic widths** (1280–1400 desktop, narrow panel) on `/dev/harness` before shipping.

## Client portal

`/portal/<token>` (migration 121, `lib/server/client-portal.ts`, `engine/client-portal.ts`).

**Access:**
- One link per case.
- It opens with the same emailed six-digit code as a secure file link, and the browser then stays in for 7 days.
- The link goes at the foot of every message to the client (`withPortal`, above a short sign-off).
- On the case page, **Client Portal** has Copy Link and Reset Link. Reset revokes the old link at once.
- The page shows how often the client has opened the portal and how many files they have uploaded.

**What the client sees** (phone first, plain words):
- **For You:** each thing waiting on them, with the way to do it:
  - the ID check link;
  - the proof-of-funds form;
  - an upload for property forms, mortgage offer, survey, signed papers or insurance;
  - **Call Us** for any money. Bank details are never shown, with the "we never change bank details by email" warning.
- **Progress:** their steps (Getting Started → … → Completed), each workstream as Done, In Progress, With You or Not Started, what we are waiting on from others, and the key dates.
- **Documents:** what we have sent them by secure link, and what they have given us. Only listed files can be downloaded.
- **Help:** answers to what clients ask (`engine/client-faq.ts`).
  - **Stage questions come first:** up to five for the client's stage and side. At the start, "What happens first?"; near exchange, "How do I pay the deposit?"; after exchange, "When do I get the keys?" (or "When do I need to move out?"); after completion, "What happens now?".
  - **The rest:** behind More Questions, by topic. Search covers all of them.
  - **Phrasing:** written to reassure and say what happens next: "What's happening on my purchase now?", never "Why haven't I heard?".
  - **Answers from the case:** where the case can answer, it does (where we are, what is done, what we expect next, what we need from them, the dates).
  - **Never** advice, and never an issue.
- **Still Need Help?:** Contact Us opens a message box and the conveyancer's phone and email. A message is read like an email from the client and becomes a reply task on the Tasks list. Ten a day.
- **How Are We Doing?** (Ask Clients How We Did): CSAT after exchange, NPS after completion, once each, at the top of the page. A promoter is offered the firm's review page. The client's exchange and completion messages (every kind of case) ask for it, with the link, in place of the plain portal line.

**Never shown:** an issue, a decision, a flag or an internal code. A step held by an issue reads In Progress; the conveyancer tells the client about a problem, the page does not.

**Uploads:**
- Uploads are 4 MB at most; photos are shrunk in the browser to fit. PDF, photo or Word only.
- Each upload is filed on the case and goes through ingest like any arriving file. Uploaded against a task, the file carries that task's role.
- The conveyancer is notified.

A dev preview is at `/portal/dev-preview-portal-000000` (code 123456), showing the dev harness's case.
