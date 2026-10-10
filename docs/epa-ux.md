# EPA: what each person sees, built on what the technology can do

A design proposal, not built yet. The method is in docs/epa.md.

**The constraint (Peter, 2026-10-10):**
- Management will happily use a screen.
- Conveyancers are the ones to win over, and they live in InTouch and Outlook.
- So the question is how far their figures can rise with little or no input from them.

Every element below names how it would work, what it needs, and what can go wrong.

## 1. What each surface can do

Status words:
- **In code**: the repo does it today.
- **Possible**: documented by the vendor; needs a change of ours.
- **Not possible**: the vendor documents no way.

Microsoft facts are from learn.microsoft.com and InTouch facts from the API reference a firm supplied (docs/intouch-integration.md), both checked on 2026-10-10.

### The conveyancer's own mailbox (Microsoft Graph, delegated: their token, their mailbox)

| Capability | Status | Detail |
| --- | --- | --- |
| Send as them, kept in Sent Items | In code | `sendMailTracked`, `/send`; engine chases already go from the fee-earner's mailbox |
| Category on a message | In code | Triage applies "Reply · Urgent"-style categories with colours. Needs Mail.ReadWrite (on the message) and MailboxSettings.ReadWrite (the master list) |
| Move to a folder | In code | `autoFileToCase` moves a trusted-link conversation into the case folder or Archive. Needs Mail.ReadWrite. **A moved message gets a new id**: we don't request immutable ids, so anything keyed on the old id (assist_cache) can miss |
| Flag, importance, mark read | In code (flag) / Possible | PATCH, Mail.ReadWrite |
| Inbox rules | Possible | `messageRules`, MailboxSettings.ReadWrite. Not used |
| Focused/Other per sender | Possible | `inferenceClassification` overrides, Mail.ReadWrite, at most 1,000 per mailbox, future mail only. Not used |
| New mail, in near real time | In code | Subscriptions on Inbox and Sent Items (`created`), renewed daily. Microsoft documents an average under 1 minute and a maximum of 3. No lifecycle URL is set |
| **Every email the conveyancer sends, as it is sent** | In code | The Sent Items subscription already feeds the outbound branch of `processIncomingMessage`. **Measuring their red work needs no new scheduled job**: classify there. Each send costs a classification, so it is rule-first, with a model only when the rules can't tell |
| Tasks in their own To Do (shows in Outlook and on the phone) | Possible | `todoTask` with a link back. Needs Tasks.ReadWrite, deliberately held back today (config.ts), so it means re-consent |

Prod sets its own GRAPH_SCOPES in Vercel, overriding the code default. Anything above that needs a scope prod doesn't grant also needs an env change, a redeploy and every user consenting again.

### The Outlook add-in

| Capability | Status | Detail |
| --- | --- | --- |
| Pane on a message the user opens | In code | Read mode only, desktop and web only (no mobile form factor), Mailbox 1.8, pinnable |
| Stays open across emails | In code (when pinned) | Pinning is per mode, and Read doesn't carry to Compose. Unpinned, it closes on every new selection |
| Shows anything without being opened | **Not possible** | No event fires when mail arrives. Notification bars (150 characters, one persistent kind) can only be set by the add-in while it is running on that item, never from the server |
| Silent sign-in | Possible | Nested app authentication is GA on web, Windows, Mac, iOS and Android. **Today**: a Connect pop-up and a 7-day token in local storage, so a conveyancer is asked to sign in again every week |
| On the phone | Possible | Needs a MobileFormFactor in the XML manifest. Read mode only, Mailbox 1.5 plus some later APIs |
| A check as they press Send (Smart Alerts) | Possible | Needs Mailbox 1.12, web and Windows, **admin deployment only**; not mobile |
| Installed for everyone without AppSource | Possible | Admin centralized deployment puts it on every ribbon within 24–72 hours. Auto-pinning is not documented |

**Conclusion:** the add-in is a pull surface, there when they choose to look. It cannot be where work arrives.

### Email from CONVEYi to the conveyancer

| Capability | Status | Detail |
| --- | --- | --- |
| Email to themselves, from their own mailbox | In code | The digest (notify.ts) does this. It has **no links** today |
| Links that open the right task | Possible | They need a signed, longer-lived token (sign-in links are 15-minute, single-use). **Link scanners (Defender Safe Links) open every link in an email**, so a link may never perform an action itself: it opens a page with the button |
| Reply with a number to decide | Possible | Their reply passes through their own Sent Items, which we already watch, so it is theirs and authenticated. Nothing parses replies today |
| Buttons inside the email (Actionable Messages) | Possible, limited | To themselves: works without registration, which Microsoft describes as a testing scenario. Production use that way is not documented. For real use, each firm's Exchange admin approves an Organization-scope provider. Buttons call us with a Microsoft-signed token. New Outlook for Windows is not listed; there's no dark mode; it can be switched off per tenant. **An enhancement per firm, never the foundation** |

### InTouch

| Capability | Status | Detail |
| --- | --- | --- |
| Read matters, tasks, folder; download files | In code | |
| Complete a task | In code | Used for milestones |
| File a note, upload a file | In code | |
| File an email record | **In code, not called** | `client.ts:279`. Filing every case email into the matter would put the whole history where they work |
| Create a task | Not possible | Not in the API |
| Send an email | Not possible | Filing a record only |
| Webhooks (form, matter state, task state) | Possible | Set up by hand in InTouch, unsigned, payloads partly unknown. A daily poll runs as a safety net |

**Conclusion:** InTouch can be kept complete and its tasks ticked. It cannot hold our decisions.

### Teams

Possible but heavy: the firm installs a Teams app for each user, then activity-feed notifications work. It isn't worth it in stage 1.

## 2. What blocks the design today

These need fixing before any screen promises them.

1. **Sends that wait.**
   - A Send clicked in the worklist or add-in becomes a scheduled send with a 2-minute grace.
   - It goes only when someone at the firm next loads the worklist. `cron/send-scheduled` exists but is not in vercel.json.
   - Any "send without asking" or reply-by-number flow needs a send path that doesn't wait for a page load.
   - Running it as a cron every few minutes breaks the cost cap. The options are:
     - send at once, with no grace, when no undo is offered;
     - Exchange's own deferred send, which isn't in our research and must be checked first;
     - an external queue.
2. **Chase mode.** The code defaults ENGINE_CHASE_MODE to `send`. The comments and .env.example say `draft`. Settle which is true on prod.
3. **Moved messages change id.** Request immutable ids (`Prefer: IdType="ImmutableId"`) before moving more mail.
4. **Graph tokens are stored in plain text** (`app_user.graph_refresh_token`). Encrypt them before asking firms to let us act in their mailboxes more widely (docs/security).
5. **The served add-in manifest** still says "CaseLightning" and lags the static one's version: the pinning bug.
6. **The add-in signs out weekly** (7-day token). Silent sign-in fixes it.

## 3. Conveyancers: no new screens in stage 1

Their figure rises because routine work leaves their inbox, decided by the firm and done by CONVEYi and assistants.

| What they notice | How | Needs | Risk, and the answer |
| --- | --- | --- | --- |
| Fewer emails needing them | Routine mail CONVEYi or an assistant has dealt with is categorised "CONVEYi · Handled". Once the firm trusts it, it's moved to the case folder (as trusted links already are) | In code (categories, move); a rule for what counts as dealt with; immutable ids | Mail they think has vanished. The category comes first, the move only when the firm switches it on, and the Friday note lists what moved |
| Replies already sent, in their name | Engine sends from their mailbox. The reply sits in the thread and in Sent Items | In code | A wrong send. Only actions the firm has switched to Send, with the guards (reply arrived, complaint, upset client) |
| Nothing to re-key in InTouch | File every case email, note and document into the InTouch matter; tick InTouch tasks the engine completes | In code, apart from email records (built, not called) | A wrong matter. Only on a definitive match (the definitive-match rule) |
| A decision only they can make | A **decision email** to themselves: the question, the few facts that decide it with where each came from, the recommendation, numbered options. **Reply 1, 2 or 3.** A link opens the same decision in the web app (a page, then the button) | Reply parsing on the Sent Items path; signed links; a send path that doesn't wait | Misread replies. Accept a number or a word from the options; anything else goes to the assistant; confirm every decision by email ("Done: proposed the 30th to Hart & Co") |
| Their week | The **Friday note**: hours taken off them, what was sent in their name, what was filed to InTouch, the decisions they made by reply. One suggestion with its evidence: "47 client updates approved unchanged; reply YES to let them go without asking" | The digest path with links; their Sent Items classification | Nagging. One suggestion at most, and never twice running for the same thing |
| The add-in, if they want it | Silent sign-in; pinned, it shows the case and the decision for the email they're reading | Silent sign-in work; manifest fixes; admin deployment for the pilot firm | Seen as the "third screen". It's optional, never required |

## 4. Assistants: the web app

| Element | How | Needs |
| --- | --- | --- |
| Routine queue by kind | Proposals grouped by kind; varying parts highlighted; Approve Selected; J/K/A/E/U keys | UI work on the Tasks list; bulk approval through the existing perform path |
| Hard emails | A neutral one-line ask, the facts, a calm draft; the original folded underneath | A sentiment and ask reader on inbound mail (none exists); the draft-check rules |
| Send Up | One line to the conveyancer, which becomes their decision email | The decision email above |
| Their working day | Time clipped to each person's own hours | A per-person working day (the firm's today) |

## 5. Management: the web app

Analytics → Efficiency (built), plus:
- the Pareto bar shows the evidence ("204 of 212 approved unchanged") and switches the action;
- people listed by name with hours handed off;
- the case grid's With Us / Delayed By Others / Delayed By Us, which Phil liked.

Stage 2 is the weekly review: hours per completion, legal work by minutes per case, and an action log.

## 6. Stage 2 for conveyancers

Once they're onside, the legal work arrives prepared:
- title points pinned with enquiries drafted;
- search risks with client wording;
- the offer checked;
- replies pre-marked;
- the report on title drafted.

It's still delivered to where they are:
- the decision email for the yes/no ones;
- the web app or the pinned add-in for the reviews that need reading.

A Smart Alert on Send (admin-deployed) can stop a promise the file contradicts ("completion on the 30th" when the chain says the 23rd).

## 7. Decisions needed

1. **Send path:** send at once with no grace, check Exchange deferred send, or use an external queue (cost)?
2. **Moving mail out of a conveyancer's inbox:** category only at first, or a move once the firm switches it on?
3. **Decision by email reply:** acceptable to Phil's firm as the record of a conveyancer's decision?
4. **Filing every case email into InTouch:** wanted, or too much in the matter?
5. **For the pilot firm:** admin-deploy the add-in (no AppSource) and approve Actionable Messages for their tenant, or keep to plain email?
6. **Tasks.ReadWrite** (decisions in their To Do): worth a re-consent?
