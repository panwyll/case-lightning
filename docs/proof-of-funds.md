# Proof of funds: the automated flow

Source-of-funds verification is the one AML step on every purchase that depends on the
client doing something, and it is the delay clients most often cause themselves (the gift
mentioned late, the statements that never arrive). This flow turns it into a form the
conveyancer fires off, a submission the client makes without logging in, a briefing the
conveyancer reads, and a sign-off decision on the engine log — with the rules deciding what
deserves attention and a person deciding the outcome.

```
conveyancer                         client                              engine
    │  "Send proof-of-funds form"      │                                   │
    ├─────────────────────────────────►│  email / WhatsApp with a link     │ proof_of_funds_requested
    │                                  │  /pof/<token>  (no login)         │ wait: proof_of_funds (chased day 3, 6, 9…)
    │                                  │  sources · evidence · declarations│
    │                                  ├──────────────────────────────────►│ facts → rules → flags
    │                                  │                                   │ declaration document (cited)
    │                                  │                                   │ briefing (AI, validated; else template)
    │  decision: proof of funds ◄──────┼───────────────────────────────────┤ proof_of_funds_submitted  (always a decision)
    │  approve / request further /     │                                   │
    │  escalate / reject               │                                   │
    ├─────────────────────────────────────────────────────────────────────►│ proof_of_funds_reviewed
    │        request further ──────────►  form re-opened with your note    │ (round 2, automatically)
    │        approve  ─────────────────────────────────────────────────────► source_of_funds issues resolved;
    │                                                                       lender_approval issue if a gift
```

## What the client sees

`/pof/<token>` (`app/pof/[token]/page.tsx`). The link is the only credential: a random
token, stored hashed (`proof_of_funds_request.token_hash`, migration 073), single use,
expiring after 30 days. The page shows the firm, the property and the client's first name,
pre-fills the price the engine knows, and asks for:

- **one block per source of money** — type (savings, sale proceeds, mortgage, gift,
  inheritance, investments, pension, equity release, Help to Buy / Lifetime ISA, loan,
  business income, crypto, overseas, other), amount, a description in their words, the
  bank / provider and account holder;
- **evidence per block**, with the form saying exactly what to attach for that type (the
  same list the rules use — `EVIDENCE_EXPECTED` in `proof-of-funds.ts`); photos or PDFs,
  uploaded straight from a phone;
- **for a gift**: who from, their relationship, their address, whether it is repayable,
  whether they live abroad, and the donor's own documents (ID, gift letter, statements);
- **for overseas money**: the country and whether it is already in a UK account;
- a running total against the balance the client must find, so a shortfall is visible
  before they submit;
- **three declarations** (complete and accurate; no third-party interest; no undisclosed
  borrowing) and a free-text note.

Uploads (`POST /api/v1/pof/<token>/upload`) become ordinary rows in `document`
(`source_type CLIENT_UPLOAD`, `doc_type PROOF_OF_FUNDS_EVIDENCE`, bytes in
`document_blob`) tagged to the request, so the submission route can refuse any document id
that was not uploaded against that form.

## What the engine does with it

`POST /api/v1/pof/<token>` validates the submission (zod), stores it verbatim on the request
row, and calls `EngineService.proofOfFundsSubmitted`, which:

1. builds **typed facts** (`factsFromSubmission`): price, mortgage advance, the balance the
   client must find, the declared total, the shortfall, each source with its evidence count,
   the gifted total, the declarations;
2. runs the **deterministic rules** (`evaluateProofOfFunds`). Every flag is a fact about the
   declaration, never a judgement:

   | Flag | When |
   | --- | --- |
   | `POF_DECLARATION_INCOMPLETE` | any of the three declarations unticked |
   | `POF_NO_SOURCES` | nothing declared |
   | `POF_SHORTFALL` | declared (excluding mortgage) < price − mortgage |
   | `POF_PRICE_UNKNOWN` | no price on file or on the form, so the total cannot be checked |
   | `POF_NO_EVIDENCE:<KIND>` | a source with an amount and no document |
   | `POF_GIFT`, `POF_GIFT_NO_DONOR`, `POF_GIFT_REPAYABLE`, `POF_GIFT_DONOR_ABROAD`, `POF_GIFT_NO_DONOR_EVIDENCE` | the gift cases the forums are full of; a repayable "gift" is a loan |
   | `POF_HIGH_RISK:<KIND>` | crypto, overseas, loan, business income (enhanced due diligence) |
   | `POF_LOAN` | a loan forms part of the funds: the mortgage lender must be told |

3. renders the **declaration document** (`renderDeclaration`) — the source the decision
   cites and the conveyancer opens (totals, each source, the attached file names, the
   declarations, the client's note);
4. writes the **briefing**. With Claude configured, `ClaudeProofOfFundsSummariser`
   (`ai.ts`) is given the flags, the facts and the declaration and returns a structured
   briefing (headline, a comment per source, an explanation per flag, questions for the
   client, what to check in the attachments). A **validator** rejects it if any flag or
   source is not covered, if it recommends an outcome or passes judgement on the client,
   or if it contains a figure that is not in the declaration (pennies in the facts and
   pounds in the prose are both allowed). Rejected or unavailable → the deterministic
   `templateBriefing`, which says the same things in fewer words;
5. records `proof_of_funds_submitted` with the facts, the flags and a `DecisionSpec`
   (**always** — sign-off is a person's act even when nothing is flagged), and closes the
   client wait.

## The conveyancer's decision

Kind `proof_of_funds`, in the normal queue with the normal source-and-engagement gate:
open the declaration, read it, then

- **approve** — `proof_of_funds_reviewed`. Any open `source_of_funds` issue on the matter
  is resolved `evidence_provided`. If the declaration includes a gift and the purchase is
  lender-funded, a `lender_approval` issue is raised ("Tell the lender: gifted deposit
  £40,000 from Anita Shah") that holds exchange until the lender confirms — the gift has
  to be declared and the forum experience is that lenders take days to weeks over it.
- **request further** (reason required) — the service automatically issues a **second
  round**: a fresh link, the `proof_of_funds_request_again` message carrying the
  conveyancer's note, and the form pre-loaded with that note. The rounds are counted on
  the projection (`proofOfFunds.rounds`) and each round's request row references the one it
  re-opens.
- **escalate** — the usual chain to a senior with the same source.
- **reject** — `manual_handling_required (proof_of_funds_rejected)`: automation stops, like
  a failed ID check.

## Gates and timers

- A round in flight (requested, or submitted and not signed off) **holds exchange**:
  `exchange_conditions_met` is not derived, `contracts_exchanged` is refused, and the stage
  blockers say "proof of funds requested from the client" / "awaiting sign-off".
  Everything else proceeds. A matter that never had a round is not held — whether every
  matter must have one is firm policy, not the machine's call (add it to the enrol step or
  the go-live checklist).
- The **client wait** (`proof_of_funds`, SLA in `sla.ts`) chases the client on the client
  channel after 3 working days and every 3 after that, and escalates to the handler at 10.
- **Shadow mode** logs the intent (`action_suppressed proof_of_funds_request`), issues no
  link and sends nothing; the wait still opens so the SLA clock is observable.

## Surfaces

- Engine panel: a **Proof of funds** tile (status, round, declared vs needed, "includes a
  gift") and a **Send proof-of-funds form** button with an optional note to the client.
- `GET /api/v1/matters/<id>/proof-of-funds` lists the rounds (never the link).
- The decision panel shows the briefing and opens the declaration like any other source.
- The map (`/engine/map`) has the `proof_of_funds` sub-flow, its commands, the timer and
  the trigger `both.pof_form_submitted`.

## Configuration

Nothing new is required. The form link uses `APP_URL`; the message goes through the
configured client channel (email via Graph / Resend, or WhatsApp) or the mock; the
briefing uses Claude when `ENGINE_AI` / `ANTHROPIC_API_KEY` enable it, else the template.
Run migration 073 (or `db/supabase/engine-one-shot-5.sql`).

## Not done

- No OCR of the attached statements: the rules count evidence, they do not read it. The
  extraction pipeline can be pointed at `PROOF_OF_FUNDS_EVIDENCE` documents later (balance
  building up, unexplained deposits) and the flags will carry the facts.
- One declarant per form. Joint buyers each get their own round (send the form twice), and
  the issue layer's `party` field says whose problem an unevidenced source is.
- The form is English-only and unbranded beyond the firm's name.
