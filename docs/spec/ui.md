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
