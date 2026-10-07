# InTouch

LEAP is where a firm's **matters** live. InTouch is where its **clients** live: the online
onboarding pack, the identity and AML checks, the property information forms the seller
fills in at the kitchen table, and the portal where the client and their estate agent
watch the case move.

CONVEYi is neither of those. It is where the case is *reasoned about*. So the InTouch
connector does three things and refuses to do a fourth.

## What it does

| | |
| --- | --- |
| **Intake** | A new instruction in InTouch becomes a mirrored matter with its parties. A *quote* is not an instruction and is skipped — a firm's pipeline is not its caseload. |
| **Facts the client produced** | Every file in the matter's folder (the ID report, the completed TA6/TA7/TA10, the client's uploads) is mirrored and read by the ordinary document reading, with InTouch's name for it as a hint. InTouch's API has no identity-check or form-answer resource, so these arrive as the files they are. |
| **The truth, back out** | The engine knows where the case actually is. With milestones on, the matching InTouch task is completed (that is what moves the client portal), so the client and the agent see it without anyone retyping it. Where the firm's InTouch workflow has no task for the step, it goes on the matter as a note. |

## What it refuses to do

**Decide anything.** An ID report from InTouch is read like any provider's report and
becomes the same flagged decision a conveyancer would get from any other, cited to the
report, waiting for a person.

Everything from InTouch goes through the engine's ordinary front door, as commands a
person could have typed. There is no side entrance.

## The shape

```
InTouch matter (not a quote, not closed)  ──► mirror matter row ──► enrolled at once (no second step)
its primary client                        ──► a matter_contact row
each file in its folder                   ──► document row ──► the ordinary ingest path
  (ID report, completed forms, uploads; email, note and call records are InTouch's own history)
the engine's lifecycle                    ──► the matching InTouch task completed (or a note)
```

Two triggers feed the same functions — **webhooks** (InTouch tells us) and **polling**
with a watermark (we ask what changed; InTouch has no "changed since" filter, so the list is read newest change first and stops at the first older matter) — because InTouch's webhooks only
cover three events and their payload does not reliably say which case they are about.
Both are idempotent: every fact is keyed on InTouch's own id in `intouch_applied`, so a
fact lands exactly once however many times a webhook fires or a sync re-reads the case.

## Nothing done twice

Anything a firm does in InTouch is never asked for again in CONVEYi.

- **Onboarding:** a matter that comes across is enrolled at once. Nobody enrols it again here.
- **Searches and the ID check:** InTouch's API cannot order either, so the conveyancer orders them on the InTouch matter, as they do today. For a case mirrored from InTouch (when the firm's own InfoTrack is not connected to CONVEYi), the engine records each as ordered in InTouch (`EnginePorts.orderedIn`, provider `InTouch`):
  - there is no "Order the search" or "Send the client the ID check" task;
  - there is no order or client email of ours, and no stand-in search result;
  - nothing is chased, because there is nobody for us to chase (`WaitState.via`). An overdue search or ID check is put to a person instead.
  - The Thirdfort report and each search result are read when they land in the matter's folder. A Thirdfort source-of-funds report is filed, never read as the ID check.
- **A firm with its own InfoTrack connected here:** CONVEYi orders, and the conveyancer orders nothing in InTouch.

## What InTouch documents

From InTouch's **Public Customer Matter API** reference (Swagger 2.0, version apiCustomerPublic), supplied by an InTouch firm in October 2026, and its public help centre.

- **Plan.** The API and webhooks are on the **Premium and Enterprise** plans only.
- **Base URL** `https://go.intouchapp.co.uk`, HTTPS only.
- **Auth.** A static API key from **API Management > Keys**, in the `x-intouch-o-token` header. No OAuth.
- **Envelope.** Every response is `{ success, message, errors[], additionalData, data }`; `mapping.ts unwrap` takes `data` and turns `success: false` into an error in InTouch's own words.
- **What the API has** (`endpoints.ts`):

  | | |
  | --- | --- |
  | Matters | `GET /api/v2/public/matters/list` (page, pageSize, orderBy, orderByDirection, where, query): guid, reference, state, template name, address lines, postcode, primary client, fee earner, created and last updated. One matter's fields by data marker (`GET /matters/{guid}?fields=matter.reference`). Create or update by data marker (`POST /matters`). |
  | Tasks | `GET /matters/{guid}/tasks`; `POST /mattertasks/{guid}/complete`. |
  | Folder | `GET /matters/{guid}/folder/list`; `GET …/folder/{item}/download-url`; `POST /matters/{guid}/files` (upload); `POST …/folder/emails`, `/notes`, `/phone-calls` (file a record). |
  | Forms | Quote, and complete a form by creating or updating a matter (not used). |

- **What it does not have:** identity checks, form answers, parties beyond the primary client, a "changed since" filter, or a milestone resource. The connector works around each as described above.
- **Webhooks are set up in InTouch** (API Management), not through the API: Form Completion, Matter State Change, Task State Change, in a flat envelope with literal dotted keys:

  ```json
  { "event": "Form_Completion",
    "triggered.by.name": "…", "triggered.by.email": "…",
    "timestamp": "2020-01-03T17:01:23Z",
    "data": { "…the form's fields…": "…" } }
  ```

  Form Completion carries **no documented matter guid**; it is read from `data` where present (`matterGuid`, `matter.guid`…), else the person who triggered it finds the matter.
- **Delivery.** Not signed. Retried at +10 minutes, +60 minutes, +180 minutes and +24 hours until a 2xx.

## Webhooks

Because InTouch does not sign deliveries, each firm gets its **own webhook URL** carrying
a secret:

```
https://<app>/api/v1/integrations/intouch/webhook?firm=<tenant id>&key=<webhook key>
```

The key is 32 random bytes we generate the first time the firm saves its InTouch details,
stored encrypted with them, and kept across reconnects. The route compares it in constant
time and refuses anything else with a 401 before reading the body. Once connected, the
InTouch page shows the URL with a Copy button; the admin adds it in InTouch under
**API Management** for Form Completion, Matter State Change and Task State Change.

What each event does (the body is a pointer; the case is always re-read from InTouch):

| Event | Does |
| --- | --- |
| Matter State Change | mirrors the matter and its parties (as a sync would), then its facts |
| Form Completion | re-reads the mirrored matter's ID checks, forms and documents |
| Task State Change | the same |
| anything else | skipped |

**Finding the case.** A case id is read from `data` where InTouch includes one
(`matterId`, `matter.id`, `caseId`, `case.id`; a matter event's own `id`). When there is
none, the envelope's `triggered.by.email` is matched against contacts: only if that person
is on **exactly one** open InTouch-mirrored matter of the firm (and is not one of the
firm's own users) is the event applied to it. Otherwise it is skipped and the next poll
picks the change up. Never a guess across several matters.

**Answers.** Once authenticated, the route always answers 2xx — even for a skip — because
a skip will not change on retry. A sync that throws answers 500, so InTouch's retry
schedule re-delivers it. There is no delivery id; the event id is the SHA-256 of the raw
body, which InTouch's retries repeat.

## Details worth knowing

**A TA6 on a purchase.** Property forms are the seller's side, and the machine is right to
refuse one on a purchase. That is a **skip with a reason**, not an error: a firm's sync
summary should go red for faults, not for the engine doing its job. The form is left
unseen, so it lands by itself if the matter is later enrolled as the transaction it is.

**The fee earner is matched by name.** InTouch's matter list carries the fee earner's full name, not their email, so a matter is assigned to the one person at the firm with that name, and to nobody when there is none or more than one.

**What we filed there is never mirrored back.** Write-back labels its uploads `CONVEYi`, and the sync skips files with that label, as well as the ids it recorded.

**Milestones are off until the firm says otherwise.** Reading from InTouch is harmless.
Writing to something a client sees is not. Milestones are off per connection until an
admin turns them on, and even then they only ever move **forwards**, never twice for the
same step, never for a matter in shadow mode, and never for one the engine has not been
asked to run. A client watching their case go backwards loses confidence in everything
else on the page.

The engine's lifecycle is deliberately flattened for the portal — a client does not need
"contract review" and "pre-exchange" as separate facts. Sending the report on title wins
over the phase it happened in, because it is the most reassuring thing a client can see.
A closed or aborted matter says **nothing**: a client portal is not where someone should
learn their purchase fell through.

**Bytes are kept.** A decision must be able to show a client's own document, and InTouch
is not guaranteed to still hold it when someone opens the panel next year.

## Saving received files down (parked until InTouch API access)

Every file that lands on a case in CONVEYi is saved down into each practice system the
firm has connected: LEAP and InTouch today. That covers email attachments, the text of a
linked email, uploads, InfoTrack results, and client uploads from either portal.

- **One step, every system.** It runs after the file is saved and read, the same way the
  LEAP write-back does. It is keyed per system on our document id, so each file is written
  once to each system.
- **No echoes.** A file is never sent back to the system it came from. A client's InTouch
  upload still goes to LEAP, and a LEAP document still goes to InTouch.
- **Filed by what it was read as.** Survey, search, title, enquiry replies and so on, with
  Correspondence when the file was not classified.
- **Bytes** come from wherever CONVEYi holds them: OneDrive, or the database for a case
  with no folder.

**One decision before InTouch is built.** InTouch is what the client and the estate agent
see. Every received file must not land where they can see it: the other side's papers,
the lender's instructions and a note about a gift are for the firm. The step needs
InTouch's staff-only document area, if it has one, and it needs to know which kinds may
be shared with the client. With no staff-only area, only files the client or agent sent
themselves go to InTouch, and everything else goes to LEAP alone.

## Still to confirm on a live account

The reference fixes the paths, auth, models and envelope. These it leaves open, and each lives in one place:

| Open point | File | What we assume |
| --- | --- | --- |
| List paging | `client.ts` | pages start at 1 |
| Ordering | `client.ts` | `orderBy=lastUpdated&orderByDirection=desc`; refused with a 400, the list is read unordered and filtered instead |
| Matter `state` values | `mapping.ts caseStatus` | read by their words: quote / cancelled / completed / anything else is live |
| Template names | `mapping.ts sideFrom` | "Purchase", "Sale", "Remortgage", "Transfer of Equity"; "Sale & Purchase" mirrors as the purchase |
| Upload body | `client.ts uploadDocument` | multipart form data, the file under `file`; InTouch's id read back from the folder |
| Folder item `type` values | `mapping.ts toDocument` | email, note and phone-call records are not files |
| Task names for each milestone | `mapping.ts TASK_WORDS` | read by their words; no match is a note instead |
| A matter guid in each webhook | `mapping.ts toWebhookEvent` | `matterGuid`, `matter.guid`, or a matter event's own `guid` |

`mock.ts` serves the reference's endpoints, envelope, download links (from another host, which never receives the key) and multipart upload, and the tests drive the **real** HTTP client against it.

### Ask InTouch / the firm

- Whether webhooks **can be signed**, so the URL key becomes a second factor.
- The webhook payloads for Matter State Change and Task State Change.
- The task names in the firm's InTouch workflow for each milestone, if the words do not match.
- Whether there is a **staff-only folder area** (see "Saving received files down").

## Configuration

Each firm connects its own InTouch account (Premium or Enterprise plan). An admin enters
at **/conveyi/integrations/intouch**:

```
API Address   https://go.intouchapp.co.uk (filled in; change only if InTouch says so)
API Key       generated in InTouch under API Management > Keys
```

They are stored encrypted against the firm (`intouch_connection.credentials_enc`,
migration 078), with the webhook key we generate. A key left blank on a later edit keeps
the one already saved. **Connect** reads the account back to prove the key; only that
marks the firm connected (it reads one matter: InTouch has no "who am I"). If InTouch refuses, the page says so in plain terms and keeps
what was typed. A row saved in the old OAuth shape (no API key) reads as not connected.

`INTOUCH_API_BASE_URL` and `INTOUCH_API_TOKEN` are only a fallback for a deployment that
serves one firm; the webhook URL still needs the firm to press Connect once so a key is
issued.

The same page carries the webhook URL, the milestone switch and what has come across.
Disconnecting stops all reading and all pushing at once; the saved address and keys stay
so reconnecting is one click, and what is already mirrored stays on the matter, because it
is the firm's own case file.

![The InTouch settings page](demo/34-intouch.png)

## Writing back (InTouch as the system of record)

A firm that keeps InTouch as its file can have CONVEYi write into it (`writeback.ts`, migration 119). Two switches, each **off** until an admin turns it on under Integrations → InTouch, both audited:

| Switch | Does |
| --- | --- |
| **Send Documents To InTouch** | Every document CONVEYi files on a mirrored case (letters it generated, the proof-of-funds declaration with its analysis, emails filed, the client's uploads to our forms) is filed on the InTouch case. **Never** drafts (`REPORT_ON_TITLE_DRAFT`, `PROPOSAL`), internal working papers (dossiers, the bank-details note) or raw bank data (`OPEN_BANKING_ACCOUNT`). A document sent is stamped with InTouch's id for it, so the next sync recognises it and never mirrors it back. |
| **Send Case Notes To InTouch** | One line on the InTouch case for each significant thing the engine records, in the same words as the LEAP file notes: stage moves, searches ordered, ID checks requested, chases and client updates sent, the report on title sent, enquiries raised, issues raised and resolved, proof of funds submitted and signed off, deposit received, exchange, completion. Format: `CONVEYi · <date time> · <what happened>`. |

The rules are the same as for milestones:
- only for a matter the engine runs, never in shadow mode;
- once per document and per event (`intouch_applied` kinds `document_out` / `note_out`);
- it runs with every sync and webhook, so a failure is simply retried next time.

- the upload goes to `POST /matters/{guid}/files` labelled `CONVEYi` (multipart; see "Still to confirm");
- the note goes to `POST /matters/{guid}/folder/notes` as `{ htmlContent, label1: "CONVEYi" }`.

The API can also file a record of an email we sent (`POST …/folder/emails`, `client.fileEmail`); it is not switched on yet.
