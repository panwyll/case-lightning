# CONVEYi by Case Lightning — Certification Testing Notes

_For the Microsoft AppSource validation team. This document is not shown to customers._

## What CONVEYi is
CONVEYi is an Outlook **message-read** add-in for UK conveyancing teams. It reads the
email the user currently has open, matches it to the relevant legal matter, and prepares
a client-ready **draft reply** that is saved to the user's Outlook **Drafts** folder for
review. **The add-in never sends email — it only creates drafts.**

## Test account (paid functionality is comped for you)
CONVEYi requires the user to sign in with a Microsoft 365 work account and to have an
active CONVEYi subscription (a free trial is offered to new users). So that you can
validate all paid functionality without payment, we have provisioned a test account with
a **complimentary paid (Enterprise) subscription** — no card required, no usage caps.

- **Outlook sign-in:** open the add-in in Outlook and click **Sign in**, or visit
  https://www.caselightning.co.uk
- **Email:** `<<FILL IN: test account email>>`
- **Password:** `<<FILL IN: test account password>>`

The add-in is **multi-tenant** — you may also install and sign in from your own Microsoft
365 tenant.

## How to test
1. In Outlook (Windows, Mac, or web), open any email in the test mailbox.
2. On the ribbon, open the **CONVEYi** group → **Open CONVEYi** to launch the task pane.
3. The task pane reads the open email, shows what it found (the matched matter and what
   the email needs), and — when a reply is recommended — prepares a **draft reply**.
4. Open the **Drafts** folder to see the prepared reply. Nothing is ever sent.
5. The other tabs show the case picture (home/matters) and the matter's documents (files).

## Notes for the reviewer
- **Permissions requested and why:**
  - `Mail.ReadWrite` — read the open thread and create draft replies (there is **no**
    send permission; the add-in is draft-only by design).
  - `MailboxSettings.ReadWrite` — create and colour the triage categories
    (Reply / Action / Delegate) on the mailbox.
  - `Files.ReadWrite` — the user's **own** OneDrive matter folder and tracker.
  - We deliberately do **not** request `Files.ReadWrite.All`, `Sites.ReadWrite.All`, or
    any access to other users' mailboxes or SharePoint.
- All AI processing runs on the content of the signed-in user's own mailbox and matters;
  data is used only for the firm it belongs to.
- **Privacy policy:** https://www.caselightning.co.uk/conveyi/privacy
- **Terms of use:** https://www.caselightning.co.uk/conveyi/terms
- **Support:** https://www.caselightning.co.uk/conveyi/faq

## Before you submit (reminder to self — delete this section before exporting)
1. Fill in the test account email + password above.
2. In the CONVEYi admin area, set that account's **comp-plan override** to a paid tier so
   the reviewer is not stopped by the trial cap.
3. Confirm the Entra app registration is **multi-tenant**.
4. Export this file to **PDF** and upload it under **Additional certification info**.
