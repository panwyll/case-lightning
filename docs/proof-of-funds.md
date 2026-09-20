# Proof of funds: requirements, and the automated flow that meets them

Source-of-funds verification is the one anti-money-laundering step on every purchase that
depends on the client doing something, the step the regulators keep finding done badly,
and the delay clients most often cause themselves. This document is in two halves: **what
the law and the guidance actually require** (§1–§4, the research), and **how the flow meets
each requirement** (§5 onwards, the build). Read the first half before changing the
thresholds in the second.

> **How this was researched.** The sandbox cannot fetch the web. What follows is written
> from working knowledge of the Money Laundering, Terrorist Financing and Transfer of Funds
> (Information on the Payer) Regulations 2017 as amended, the Proceeds of Crime Act 2002,
> the Legal Sector Affinity Group (LSAG) anti-money-laundering guidance for the legal sector
> (the 2023 edition and its addenda), the SRA's AML thematic reviews and warning notices,
> the Law Society's conveyancing practice notes, the UK Finance Mortgage Lenders' Handbook,
> and HM Treasury's high-risk third country list. Regulation numbers and the substance of
> the guidance are stated with confidence; exact wording is not quoted. **The firm's MLRO
> must read this against the current LSAG text and the firm's own policy before the flow is
> relied on**, and the thresholds in `POF_POLICY` are theirs to set.

## 1 · The legal basis, in one page

| Source | What it requires of a conveyancer |
| --- | --- |
| **MLR 2017 reg. 28** (customer due diligence) | Identify and verify the client, and — where a transaction is being undertaken — understand the purpose and intended nature of the business relationship, which for a purchase means understanding **where the money is coming from**. Reg. 28(11): "scrutinise transactions… to ensure they are consistent with the relevant person's knowledge of the customer, their business and risk profile". |
| **MLR 2017 reg. 28(3A)–(11) & reg. 33** (enhanced due diligence) | EDD is mandatory when the client or a party is in a **high-risk third country**, is a **politically exposed person** (reg. 35), the transaction is **complex or unusually large**, there is an unusual pattern, no apparent economic purpose, the client was not met face to face without safeguards, or the firm's risk assessment says so. EDD explicitly includes "taking reasonable measures to establish the **source of wealth** and the **source of funds**". |
| **MLR 2017 reg. 18 & 18A** | A written practice-wide risk assessment and a client/matter risk assessment; the SoF check must be proportionate to the assessed risk, and the assessment must be recorded. |
| **MLR 2017 reg. 39–40** (record keeping) | Keep the CDD material, the evidence obtained and the record of the checks for **five years** after the end of the business relationship. "The record" includes what was asked, what was answered, and why a point was not pursued. |
| **POCA 2002 ss. 327–329, 330, 333A** | Handling criminal property is an offence unless a **defence against money laundering (DAML)** is obtained; a person in the regulated sector who knows or suspects, or has reasonable grounds to, must **report to the MLRO** (s.330); and must not **tip off** the client (s.333A). Everything the client sees in this flow — the form, the messages, the queries — is therefore written as routine, never as suspicion. |
| **LSAG guidance, ch. 6 (CDD) and the source-of-funds sections** | The guidance is explicit that source of funds means **the funds used in the specific transaction** and source of wealth means **how the client came to have their overall wealth**; that firms must "look at" the evidence and not merely hold it; that a **bank statement should be reviewed for the transactions that make up the balance**, with unexplained large or unusual credits followed up; that cash, third-party funds, overseas funds, cryptoassets and gifts are higher-risk; and that the record must show the reasoning. |
| **SRA** thematic reviews and warning notices on AML | Recurring findings: SoF "done" by obtaining a statement and filing it; no evidence that unusual transactions were questioned; no matter risk assessment; no record of the decision. The SRA has fined firms specifically for not scrutinising the statements they held. |
| **Law Society** conveyancing protocol / practice notes | Funds must be in the client's own account with the firm before completion; **third-party payments** (gift, family loan) must be identified, verified and, for a mortgage, **disclosed to the lender**; the solicitor should not accept funds before the checks are complete. |
| **UK Finance Mortgage Lenders' Handbook** (part 1, "the source of the deposit") | The conveyancer acting for the lender must report if the purchase price is not being funded as the lender expects — a gift, a loan, a third-party contribution, a discount, or a deposit not passing through the conveyancer — and must obtain the lender's consent. |

## 2 · What "look at the transactions" means in practice

The guidance and the enforcement cases converge on one standard: **a statement is evidence
only once someone has read it line by line and can say why each significant credit is
there.** In practice a competent conveyancer, or the MLRO reviewing their file, expects:

1. **The right account, the right person.** The holder's name matches the client (or the
   donor), the account is the one the money is actually in, and the statements cover the
   period in which it accumulated — normally **three months** minimum, more if the balance
   arrived recently.
2. **The balance is there.** The closing balance supports the amount declared from that
   source, and the statement runs close enough to today that the money is still there.
3. **Every material credit is explained.** Salary from the named employer needs no
   question. Anything else above the firm's threshold — a single credit, a run of smaller
   ones, a cash deposit, a transfer from a person, a transfer from another of the client's
   own accounts (which then needs *its* statement), a maturing policy, a sale — is a
   question until answered and, where the answer points at another document, traced one
   step further back.
4. **The pattern makes sense.** A balance that grows through many small credits without
   salary; money that arrives and leaves within days; several cash deposits below any
   threshold; a large round-sum transfer just before the offer — each is a known pattern
   (structuring, layering, an undisclosed loan) and each must be asked about.
5. **Higher-risk sources get more.** Cryptoassets (the trail from the original purchase and
   how *that* was funded, through the sale, to the sterling transfer); gambling winnings
   (the operator's account history including the stakes); overseas funds (the sending
   account, the country, how the money was earned there); a loan (its terms, and the
   lender's consent); business income (the business's own statements and accounts).
6. **The answers are recorded, and so are the non-questions.** A query that was drafted and
   then not pursued must say why — "considered and discounted" is a defensible record; a
   flag silently dropped is not.
7. **The person signs.** The check ends with a named fee earner (and for EDD, the MLRO)
   recording that the source of funds is verified, on what evidence, before funds are
   accepted and before exchange.

## 3 · The red flags the flow checks for, and the policy numbers

Every flag below is deterministic and quotes the statement line. The thresholds are in
`POF_POLICY` (`lib/server/engine/proof-of-funds.ts`) and are firm policy; the defaults are
the conservative end of common practice.

| Flag | Fires when | Default | Query drafted |
| --- | --- | --- | --- |
| `LARGE_CREDIT` | a single non-salary credit ≥ £5,000, or ≥ 20% of the amount declared for the source the statement supports | `largeCreditPennies`, `largeCreditShareOfSource` | where did it come from, send the sending side |
| `THIRD_PARTY_CREDIT` | a large credit whose payer is not the client, the donor or a known employer | — | who, why, gift or loan? |
| `CASH_DEPOSIT` / `CASH_PATTERN` | a cash / counter credit ≥ £1,000; or ≥ 3 cash deposits in the period | `cashDepositPennies`, `cashDepositCount` | where did the cash come from |
| `IN_AND_OUT` | ≥ 80% of a large credit leaves within 10 days | `inAndOutShare`, `inAndOutDays` | explain both movements |
| `CRYPTO_CREDIT`, `GAMBLING_CREDIT`, `OVERSEAS_CREDIT`, `LOAN_CREDIT` | the description or counterparty matches a known exchange / operator / international transfer / lender | keyword lists in the module | the source-specific evidence |
| `HOLDER_MISMATCH` | the account holder is not the client (or the donor, for donor documents) | — | whose account |
| `STATEMENT_STALE` / `COVERAGE_SHORT` | the statement ends > 45 days before the declaration; covers < 90 days | `staleDays`, `coverageDays` | statements up to date |
| `BALANCE_SHORT` | closing balance < the amount declared from that source | — | where is the rest |
| `NO_SALARY_CREDITS` / `BALANCE_JUMP` | savings "from salary" with no income credits; a balance rising through many small credits | — | which account is salary paid into / what are the credits |
| `STATEMENT_UNREADABLE` / `NO_STATEMENT` | the scan cannot be read; the documents for a source are not statements | — | a legible copy / the statements |
| `QUERY_UNANSWERED` | a query sent with the last round and not answered | — | (stays open) |
| declaration-level: `POF_SHORTFALL`, `POF_NO_EVIDENCE`, `POF_GIFT*`, `POF_HIGH_RISK`, `POF_LOAN`, `POF_DECLARATION_INCOMPLETE` | see §7 | — | (no query; explained in the briefing) |

## 4 · Risk rating and enhanced due diligence

The machine records a **risk rating** on each submission: `enhanced` when any flag is an
EDD trigger (`EDD_TRIGGER_CODES`: crypto, overseas, loan or business-income sources, a
donor abroad, a crypto / gambling / overseas credit, a cash pattern, in-and-out money, a
statement in someone else's name), otherwise `standard`. The rating is shown on the
panel and in the briefing. What EDD *consists of* — the additional measures, the MLRO's
involvement, the source-of-wealth enquiry — is the firm's policy; the machine's part is to
make sure the rating is recorded and the sign-off is a person's, and to keep the
client-facing wording routine (no tipping off). PEP and sanctions screening belongs to the
ID/AML sub-flow, which already flags a referred or failed check.

## 5 · The flow

```
conveyancer                         client                              engine
    │  "Send proof-of-funds form"      │                                   │
    ├─────────────────────────────────►│  email / WhatsApp with a link     │ proof_of_funds_requested
    │                                  │  /pof/<token>  (no login)         │ wait: proof_of_funds (chased day 3, 6, 9…)
    │                                  │  sources · statements · declarations
    │                                  ├──────────────────────────────────►│ statements READ line by line
    │                                  │                                   │ declaration flags + transaction flags
    │                                  │                                   │ each transaction flag DRAFTS a query
    │  decision: proof of funds ◄──────┼───────────────────────────────────┤ proof_of_funds_submitted (always a decision)
    │  add / withdraw queries          │                                   │ query_raised / query_withdrawn (with reason)
    │  sign off ── refused while any query is open                         │
    │  query ──────────────────────────►  round 2: the form shows the      │ proof_of_funds_requested (queries → sent)
    │                                  │  queries; client answers, attaches│
    │                                  ├──────────────────────────────────►│ query_answered · new statements read
    │  decision (round 2) ◄────────────┼───────────────────────────────────┤ unanswered → QUERY_UNANSWERED
    │  sign off ───────────────────────────────────────────────────────────► approvedAt/By · source_of_funds issues closed
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

## 6 · What the engine does with a submission

`POST /api/v1/pof/<token>` validates the submission (zod), stores it verbatim on the request
row, and calls `EngineService.proofOfFundsSubmitted`, which:

1. builds **typed facts** (`factsFromSubmission`): price, mortgage advance, the balance the
   client must find, the declared total, the shortfall, each source with its evidence count,
   the gifted total, the declarations, the round number;
2. **reads every attached document** through the extraction pipeline
   (`extractStatement`): a bank statement becomes every transaction line as printed (date,
   description, signed amount, running balance, counterparty), the period, the opening and
   closing balances, and the credits the extractor recognised as salary; the full account
   number is never extracted. A gift letter or an ID comes back as "not a statement"; an
   unreadable scan is a flag. The client's answers' attachments are read the same way;
3. runs the **transaction-level review** (`reviewTransactions`, §3): every flag quotes the
   line and drafts the query the conveyancer would ask. A line already queried in an
   earlier round — including one withdrawn with a reason — is not queried again;
4. runs the **declaration-level rules** (`evaluateProofOfFunds`). Every flag is a fact about
   the declaration, never a judgement:

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

5. renders the **declaration document** (`renderDeclaration`) — the source the decision
   cites and the conveyancer opens (totals, each source, the attached file names, the
   declarations, the client's note); the statements read are cited alongside it;
6. writes the **briefing**. With Claude configured, `ClaudeProofOfFundsSummariser`
   (`ai.ts`) is given the flags, the facts and the declaration and returns a structured
   briefing (headline, a comment per source, an explanation per flag, questions for the
   client, what to check in the attachments). A **validator** rejects it if any flag or
   source is not covered, if it recommends an outcome or passes judgement on the client,
   or if it contains a figure that is not in the declaration (pennies in the facts and
   pounds in the prose are both allowed). Rejected or unavailable → the deterministic
   `templateBriefing`, which says the same things in fewer words, with the standard
   guidance for each flag (`FLAG_GUIDANCE`), the statements read, the client's answers and
   the queries drafted;
7. records the client's **answers** (`proof_of_funds_query_answered`, only for queries that
   were actually sent), the new **queries** (`proof_of_funds_query_raised`, actor `system`),
   and `proof_of_funds_submitted` with the facts, all the flags, the statements summary, the
   **risk rating** and a `DecisionSpec` (**always** — sign-off is a person's act even when
   nothing is flagged), and closes the client wait.

## 7 · The conveyancer's decision, and the query loop

Kind `proof_of_funds`, in the normal queue with the normal source-and-engagement gate:
open the declaration, read it. On the matter's engine panel the **queries** are listed —
drafted by the rules from the statements, or added by the conveyancer
(`raise_proof_of_funds_query`) — each with its status: draft, sent, answered, withdrawn.
A drafted query that is not needed is **withdrawn with a reason**
(`withdraw_proof_of_funds_query`), which is the "considered and discounted" record §2
asks for. Then:

- **approve** — refused (409) while any query is open: send them (query) or withdraw each
  with a reason. Otherwise `proof_of_funds_reviewed` with `approvedAt` / `approvedBy` on the
  projection. Any open `source_of_funds` issue on the matter
  is resolved `evidence_provided`. If the declaration includes a gift and the purchase is
  lender-funded, a `lender_approval` issue is raised ("Tell the lender: gifted deposit
  £40,000 from Anita Shah") that holds exchange until the lender confirms — the gift has
  to be declared and the forum experience is that lenders take days to weeks over it.
- **query** (`request_further`; a reason, or at least one open query, required) — the
  service automatically issues the next **round**: a fresh link, the
  `proof_of_funds_request_again` message carrying the conveyancer's note, and the form
  showing every drafted query (they move draft → sent), the transaction line each is
  about, an answer box and an upload per query, with the previous declaration pre-filled.
  The client's answers come back as `proof_of_funds_query_answered`; a query left
  unanswered is flagged `QUERY_UNANSWERED` on the next decision and stays open. Rounds are
  counted on the projection and each request row references the one it re-opens.
- **escalate** — the usual chain to a senior with the same source.
- **reject** — `manual_handling_required (proof_of_funds_rejected)`: automation stops, like
  a failed ID check.

## 8 · Where it sits in the state machine

- **Firm policy on enrol** (`requireProofOfFunds`, default **true**): exchange is held until
  proof of funds is signed off — `exchange_conditions_met` is not derived,
  `contracts_exchanged` is refused, and the pre-exchange blockers say "proof of funds not
  yet requested (firm policy)" / "requested from the client" / "awaiting sign-off" /
  "rejected — a new round is needed". Everything else (searches, enquiries, offer, title,
  report) proceeds. A matter enrolled with the flag off is held only while a round is in
  flight.
- **Money before sign-off.** `deposit_received` while the check is not signed off raises an
  `aml_kyc_problem` issue ("Deposit received before proof of funds was signed off") that
  holds exchange until a person resolves it with the MLRO's view — the situation the
  guidance says must not happen silently.
- **Price rises after sign-off.** `price_changed` to a figure the verified funds no longer
  cover raises a `source_of_funds` issue ("Price now exceeds the verified funds by £…")
  holding exchange; a lower price raises nothing.
- **Sign-off effects.** Open `source_of_funds` issues resolve `evidence_provided`; a gift
  on a lender-funded purchase raises `lender_approval` (UK Finance Handbook: the lender must
  consent to a gifted or third-party deposit).
- **Rejection** halts automation (`manual_handling_required: proof_of_funds_rejected`) so
  the MLRO's process — including whether a report is made — runs outside the machine, and
  nothing in the client-facing channel changes tone.
- The **client wait** (`proof_of_funds`, SLA in `sla.ts`) chases the client on the client
  channel after 3 working days and every 3 after that, and escalates to the handler at 10.
- **Shadow mode** logs the intent (`action_suppressed proof_of_funds_request`), issues no
  link and sends nothing; the wait still opens so the SLA clock is observable.

## 9 · Surfaces

- Engine panel: a **Proof of funds** tile (status, round, declared vs needed, "includes a
  gift"), a **Send proof-of-funds form** button with an optional note to the client, and the
  **queries** section (statements read, flags, risk rating, each query with its status and
  the client's answer, add a query, withdraw with a reason).
- `GET /api/v1/matters/<id>/proof-of-funds` lists the rounds (never the link).
- The decision panel shows the briefing and opens the declaration like any other source.
- The map (`/engine/map`) has the `proof_of_funds` sub-flow, its commands, the timer and
  the trigger `both.pof_form_submitted`.

## 10 · Configuration

Nothing new is required. The form link uses `APP_URL`; the message goes through the
configured client channel (email via Graph / Resend, or WhatsApp) or the mock; the
briefing uses Claude when `ENGINE_AI` / `ANTHROPIC_API_KEY` enable it, else the template.
Run migration 073 (or `db/supabase/engine-one-shot-5.sql`).

## 11 · Not done, and what the MLRO must still decide

- **Source of wealth** as a separate enquiry (how the client came to have their overall
  wealth) is not modelled: the form asks where *these* funds come from. For EDD cases the
  MLRO's source-of-wealth questions can be raised as queries, and the answers are on the
  log, but there is no dedicated schema.
- **Matter risk assessment** (reg. 18A) is represented only by the rating the flags
  imply; the firm's own client and matter risk assessment is still done outside.
- **Statement authenticity** (edited PDFs) is not checked; open-banking retrieval would
  replace uploads with bank-sourced data and is the obvious next step.
- **Thresholds** are defaults, not advice. The MLRO sets `POF_POLICY`.
- One declarant per form. Joint buyers each get their own round (send the form twice), and
  the issue layer's `party` field says whose problem an unevidenced source is.
- The form is English-only and unbranded beyond the firm's name.
