# Eventualities: pre-completion, completion and post-completion

Scope: what can happen from exchange (or, on a remortgage or transfer of equity, from the offer and consent) to file closure, on every transaction type. For each junction there is one row per reasonable eventuality: the signal that tells the engine, what the engine should do (state, issue, gate, task, wait, message, and how it recovers or ends), what the engine does today, and a priority.

**Engine today** is checked against the code at commit `a00f458`:
- **BUILT** with `file:line`.
- **PARTIAL**: some of it is there; the gap is named.
- **MISSING**: nothing models it.

Paths are in `lib/server/engine/`.

**Priority**
- **P1**: money, priority or a lender's security is at risk, or the file stalls silently.
- **P2**: a real and common eventuality that a person currently handles from memory.
- **P3**: rarer, or a refinement.

**Sources** (short keys used in the tables)
- **CCP**: Law Society Code for Completion by Post 2019 (in force 1 May 2019). Para 12 is the seller's solicitor's undertaking to redeem or discharge each charge listed under para 7. The seller's solicitor acts as the buyer's solicitor's unpaid agent. <https://www.lawsociety.org.uk/topics/property/code-for-completion-by-post>
- **TA13**: Law Society Completion Information and Undertakings form (requisitions on title).
- **SCS**: Standard Conditions of Sale, 5th edition. 6.1.2: money received after 2pm is treated as completion on the next working day, for 6.3 (apportionments) and 7.2 (compensation). 6.8: notice to complete, 10 working days. 7.2: compensation at the contract rate on the price less the deposit.
- **LH**: UK Finance Mortgage Lenders' Handbook, Part 1 (England and Wales), cited by topic: certificate of title, bankruptcy search, priority, insurance, delayed completion, registration. Part 2 holds the lender's own numbers; for example, several lenders want the advance returned if completion is delayed beyond a few working days. <https://lendershandbook.ukfinance.org.uk/lenders-handbook/englandandwales/>
- **PG12**: HMLR Practice Guide 12, official searches. An OS1 gives a 30-working-day priority period (Land Registration Rules 2003 r.131).
- **PG50**: HMLR Practice Guide 50, requisition and cancellation (updated March 2026).
  - Section 2: the period is 20 working days, but most applications get 60. A warning goes at day 40, then the application is cancelled.
  - Section 3: an extension needs a written explanation.
  - Section 4: early completion. Where the evidence of discharge is missing, HMLR registers the other applications and leaves the charge on the register.
  - <https://www.gov.uk/government/publications/requisition-and-cancellation-procedures/practice-guide-50-requisition-and-cancellation-procedures>
- **PG31**: HMLR Practice Guide 31, discharges of charges (DS1, e-DS1, ED and END). <https://www.gov.uk/government/publications/discharge-of-charges-pg31/practice-guide-31-discharges-of-charges>
- **FA03**: Finance Act 2003.
  - s.76: the return and the tax are due within 14 days of the effective date.
  - Sch 10 paras 3–4: a flat £100 penalty if filed within 3 months of the filing date, £200 after that. More than 12 months late, a tax-geared penalty up to the amount of the tax.
  - Sch 10 para 6: a return can be amended within 12 months of the filing date.
  - <https://assets.publishing.service.gov.uk/media/5ccaf69ded915d5f6eb69dff/Penalties_for_late_Land_Transaction_return__SD7__guide.pdf>
- **SRA-AR**: SRA Accounts Rules 2019.
  - 2.5: return client money promptly once there is no proper reason to hold it.
  - 5.1(c): residual balances of £500 or less may go to charity under prescribed conditions; above that needs SRA authority.
  - 5.3: withdraw only what is held for that client.
  - <https://www.sra.org.uk/solicitors/guidance/general-granting-authority-withdraw-residual-client-balances/>
- **BoE**: Bank of England, CHAPS. Open 06:00–18:00 Monday to Friday, closed on E&W bank holidays. Customer payment cut-off 17:40, though each bank sets an earlier cut-off of its own. <https://www.bankofengland.co.uk/payments/chaps>
- **CoP**: Pay.UK Confirmation of Payee.
- **LS-Fraud**: Law Society guidance on cybersecurity and conveyancing fraud: verify bank details out of band; a change of details is presumed fraud.
- **MLR40**: Money Laundering Regulations 2017 reg. 40. Keep CDD and transaction records for 5 years after completion or the end of the relationship. <https://www.legislation.gov.uk/uksi/2017/692/regulation/40/made>
- **Retention**: insurer and Law Society guidance. Residential conveyancing files are commonly kept 15 years on a purchase and 6 on a sale (the long-stop for latent damage is 15 years, Limitation Act 1980 s.14B). <https://www.wtwco.com/-/media/wtw/insights/2019/01/file-retention-and-destruction-timeframes-for-the-uk-legal-profession.pdf>
- **HE**: Homes England. Help to Buy equity loan: redemption, consent to a remortgage, and a second charge registered on purchase. A redemption needs a current RICS valuation and a redemption statement from the scheme administrator.

---

## 1 · Pre-completion checks for the lender and the title (OS1, K16, insurance, certificate of title)

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 1.1 | OS1 not yet made at pre-completion | Stage `pre_completion` with no `prioritySearchAt` | Gate on completion. Task: make the OS1 (in practice after exchange, within about 5 working days of completion). | **BUILT**: `machine.ts:518`, `machine.ts:1322`, `graph.ts:261` | P1 | PG12; LH priority |
| 1.2 | OS1 priority expiring before completion | `prioritySearchExpiresAt` within 2 working days, not completed | Deadline task: re-search (a fresh OS1) or complete inside it. | **BUILT**: `sla.ts:187-193` (lead `sla.ts:149`) | P1 | PG12 |
| 1.3 | OS1 lapsed and completion attempted | `completion_confirmed` after expiry | Refuse; ask for a fresh OS1. | **BUILT**: `machine.ts:1323`, `machine.ts:443-447` | P1 | PG12 |
| 1.4 | Completion date moved past the OS1 expiry | `completion_date_changed` to a date after `prioritySearchExpiresAt` | Raise at once (do not wait for the 2-day lead): a task to make a fresh OS1 for the new date. | **PARTIAL**: the 2-day lead catches it eventually. There is no reaction on `completion_date_changed` (`machine.ts:1548`). | P2 | PG12 |
| 1.5 | OS1 made against the wrong title, wrong applicant or wrong lender, or an OS2 needed for part | A person reads the result (OCR'd OS1) | Check the title number, applicant (the buyer and the lender) and the plan against the register. A mismatch raises a `title_defect` issue holding completion. | **MISSING**: `priority_search_made` takes only `expiresAt` (`machine.ts:944`). | P2 | PG12 |
| 1.6 | The OS1 reveals a new entry since the official copies (a pending application, a new charge, a caution) | Entries on the OS1 result | Raise a `title_defect` issue holding completion. Report to the lender and the client. A requisition on title to the seller's solicitor. | **MISSING** | P1 | PG12; LH title |
| 1.7 | K16 bankruptcy search not done | Lender case, no `bankruptcySearchAt` | Gate the certificate of title and completion. | **BUILT**: `machine.ts:453-459`, `machine.ts:517`, `machine.ts:443` | P1 | LH insolvency |
| 1.8 | K16 reveals an entry against a borrower (bankruptcy petition, order or IVA) | K16 result with entries | A new `bankruptcy_search_hit` event. Raise a `bankruptcy_insolvency` issue gated on completion, which blocks the certificate. Report to the lender. Check identity: same person or a namesake (the full K16 with date of birth / address). If a namesake, clear it with evidence; if real, lender instructions are needed and completion is likely aborted. | **PARTIAL**: only a clear result exists (`machine.ts:951`). The `bankruptcy_insolvency` kind is pre-exchange and gates exchange only (`issues.ts:271`), and `raise_issue` cannot set it at pre-completion. | P1 | LH insolvency |
| 1.9 | K16 stale (done weeks before a moved completion), or a borrower added late | `completion_date_changed`, or `add_party` after `bankruptcySearchAt` | Invalidate the K16 (no priority protection). Re-search everyone, including the new party. | **MISSING**: the K16 never expires. `add_party` does not reset it (`machine.ts:928`). | P2 | LH insolvency |
| 1.10 | Buildings insurance not in place from exchange (lender requires) | Lender case, no `insuranceConfirmedAt` | Gate the certificate and completion. Chase the client (`insurance` wait). | **BUILT**: `machine.ts:519`, `machine.ts:446`, `sla.ts:63` | P1 | LH insurance |
| 1.11 | Insurance on the wrong terms: wrong insured names, the lender's interest not noted, cover from completion rather than exchange, wrong address or block policy on a flat | Policy schedule read | Compare the schedule with the offer (borrower names, sum, start date). A mismatch raises `lender_approval` or a task. Leasehold: the block policy from the management pack. | **PARTIAL**: insurer and date only (`machine.ts:938`). | P2 | LH insurance |
| 1.12 | Certificate of title due | Completion date set | Deadline 5 working days before completion. | **BUILT**: `sla.ts:175-179`, `sla.ts:151` | P1 | LH CoT |
| 1.13 | Certificate of title cannot be given unqualified | Any of deed, K16, OS1, insurance or the client's balance outstanding | Refuse the certificate and list what is unmet. | **BUILT**: `machine.ts:2228-2231`, `machine.ts:453-460` | P1 | LH CoT |
| 1.14 | Certificate sent, then the completion date changes | `completion_date_changed` after `certificateOfTitleAt` | Task: notify the lender and re-date the funds request through the portal. If the advance is already held, apply the lender's delayed-completion rule (row 3.7). | **MISSING** | P1 | LH CoT / delayed completion |
| 1.15 | Lender special condition unsatisfied at pre-completion (retention, works, occupier consent, final inspection) | Offer conditions; `mortgage_condition_outstanding` open | Gate the certificate and completion. Final inspection asked for 10 working days before the advance. | **PARTIAL**: issue kinds exist and gate completion. The certificate gate does not read open lender-condition issues (`machine.ts:453`). No 10-day final-inspection timer. | P2 | LH s.4.5 (final inspection) |
| 1.16 | Requisitions on title (TA13) not raised or not answered | Exchange recorded on a purchase | Task: send the TA13 to the seller's solicitor. Wait `requisitions_on_title`, chased. On the reply, record: the undertaking to redeem listed charges (CCP para 7), keys arrangements, deposit holder, completion account. Gate on completion until answered. | **MISSING**: TA13 is known only as a client form (`triggers.ts:47`). | P1 | TA13; CCP para 7 |
| 1.17 | The seller's undertaking does not cover every charge on the register (a second charge, Help to Buy, a charging order, an unregistered bank charge) | Charges register compared with the TA13 reply | Raise an issue gated on completion: each charge needs an undertaking, a DS1/e-DS1 at completion, or the chargee's own release. | **MISSING**: `rules.ts:221` flags each charge on the title at review but never checks it against an undertaking. | P1 | CCP para 7 / 12(ii) |
| 1.18 | The undertaking is unacceptable: the other side is unrepresented, unregulated, or a firm not on the Code | Shape `unrepresented_counterparty`, or a TA13 answer | No reliance on an undertaking. Require the DS1 / redemption money paid direct to the lender, or a completion meeting. The lender is told. | **PARTIAL**: the shape raises a checklist issue (`shapes.ts:73`). No completion mechanics. | P2 | CCP; LS undertakings Q&A |

## 2 · Money in (completion statement, client balance, lender advance)

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 2.1 | Completion statement not produced | Stage `exchanged` | Gate; generate and send it to the client. | **BUILT**: `machine.ts:507`, `machine.ts:1248`, `service.ts:111` | P1 | SCS 6.3 |
| 2.2 | Client's money received is less than the statement balance | `funds_received(client, amount)` below the statement balance | Raise `completion_funds_shortfall` gated on completion, with the difference. The client is asked for the balance. Recovery: a further receipt closes it. | **BUILT** — engine/money.ts: receipts against the figures asked for; `completion_funds_shortfall` holds completion; a further receipt clears it | P1 | SRA-AR 5.3 |
| 2.3 | Statement wrong or changed after funds were requested (SDLT basis, apportionment, a late fee) | A new `completion_statement_generated` | Re-diff the balance. Tell the client the new figure and any top-up. | **PARTIAL**: re-generation is allowed and the last one wins. No diff, no message. | P2 | — |
| 2.4 | Client's funds received but not cleared (cheque, a faster payment held for a fraud check, a same-day CHAPS still pending) | `funds_received` with method or status | Record `cleared: boolean`. Refuse completion and the payment while any of the client's money is uncleared: paying against it uses other clients' money. | **BUILT** — `funds_received.uncleared`; completion and the completion payment refused until `funds_cleared` (one click on the Tasks list) | P1 | SRA-AR 5.3 |
| 2.5 | Client's money from an account not in the source-of-funds evidence | `funds_received(remitter)` | Raise an AML issue gated on completion. | **BUILT**: `machine.ts:1277-1283` | P1 | LSAG 6.17 |
| 2.6 | Lender advance not requested in time (certificate late) | Deadline at completion minus 5 working days | Covered by the certificate deadline. The advance is requested only after the certificate. | **BUILT**: `machine.ts:1260`, `sla.ts:175` | P1 | LH CoT |
| 2.7 | Lender advance not in the day before / the morning of completion | `funds` wait for the lender open on completion day minus 1 working day | Raise `lender_funds_delayed` (critical, gated on completion). Task: call the lender. Warn the seller's solicitor and the chain. Consider moving the date by agreement. | **PARTIAL**: the `funds` SLA chases 2 working days after the request (`sla.ts:42`), not relative to the completion date. `lender_funds_delayed` is never raised automatically. | P1 | LH; SCS 6.1.2 |
| 2.8 | The advance arrives net of a retention or fees, or differs from the offer | `funds_received(lender, amount)` differs from the offer advance | An issue with the difference: is the retention expected (an offer condition)? Recalculate what the client owes. | **MISSING** | P2 | LH retentions |
| 2.9 | Help to Buy ISA / LISA bonus not arrived | `isa_provider` funds wait | Already modelled: an issue gated on completion and a funds wait. | **BUILT**: `machine.ts:1255`, `shapes.ts:97`, `issues.ts:265` | P2 | HM Treasury ISA rules |
| 2.10 | Proceeds from the client's linked sale fund the purchase | Linked matter | The purchase cannot complete before the sale. Model the timing on the day too. | **BUILT**: `service.ts:1188-1193` | P1 | — |

## 3 · Completion day: payment out, timing and failure

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 3.1 | Payee bank details arrive or change (seller's solicitor, lender, client) | `record_bank_details` | Hard stop until verified out of band. Re-check at completion. | **BUILT**: `machine.ts:1378-1412`, `machine.ts:1332-1337`, `machine.ts:523` | P1 | LS-Fraud |
| 3.2 | Confirmation of Payee: no match, a close match, or unavailable | A CoP result on the payee record | Store `copResult`. A close match or no match keeps the hard stop open (a person decides, with the reason recorded). Unavailable: a note plus the out-of-band call. | **MISSING** | P1 | CoP; LS-Fraud |
| 3.3 | Payment authorised but not actually sent, or sent with no reference | `payment_authorised` without `payment_sent(chapsRef, at)` | A new event `payment_sent` (CHAPS reference, time). Completion on a purchase follows `payment_sent` and the seller's solicitor's confirmation of receipt. | **BUILT** — `completion_payment_sent` (CHAPS reference, time) after the authorisation; a purchase completes only once it is recorded (a task on the list) | P1 | CCP |
| 3.4 | Amount authorised does not match the statement or the money held | `payment_authorised.amount` against the statement and receipts | Refuse when the amount is more than the client's cleared money held. Warn when it differs from the statement balance due to the seller. | **MISSING** | P1 | SRA-AR 5.3 |
| 3.5 | Money sent to a fraudulent or wrong account (discovered after) | A person reports it, or the seller's solicitor says the money has not arrived | Emergency issue: call the sending bank at once (recall), report to Action Fraud, notify the insurer, the COLP and the SRA, and tell the client. Completion is not confirmed. A firm's money may have to replace the shortfall. | **MISSING** | P1 | LS-Fraud; SRA |
| 3.6 | Money will reach the seller after 2pm (or the contract time) | Payment time after 14:00 on completion day | Warn before sending (late completion under SCS 6.1.2 leads to 7.2 compensation and an apportionment shift). Record a `late_completion` fact for the interest claim. | **BUILT** — money arriving after 2pm on the day counts as the next working day: the late-completion issue says so (SCS 6.1.2) | P2 | SCS 6.1.2 |
| 3.7 | Completion delayed after the advance is received | Advance held and completion not confirmed for N working days (lender's Part 2 figure) | Task: return the advance to the lender as Part 2 directs, or get the lender's written agreement to hold it. A new event `advance_returned`, which re-opens the funds request. | **MISSING** | P1 | LH delayed completion; Part 2 |
| 3.8 | CHAPS cut-off missed, or the bank's own cut-off earlier than the 17:40 network cut-off | Payment not sent by the firm's cut-off on the day | Raise `completion_failure` same day (not next day). Tell the chain. | **PARTIAL**: `completion_failure` is raised only after the day has passed (`sla.ts:296-302`). | P1 | BoE |
| 3.9 | Completion date set on a weekend or E&W bank holiday | `contracts_exchanged` or `change_completion_date` with a non-working date | Refuse (CHAPS and HMLR are closed). The calendar exists. | **BUILT** — refused at exchange and on a change of date (dates.ts) | P2 | BoE |
| 3.10 | Friday or pre-holiday completion | Completion date is the last working day before a weekend or holiday | Advisory: funds slippage means a 3–4 day delay, removals and keys. Set the funds request and certificate a day earlier. Make sure nothing is left to the afternoon. | **MISSING** | P3 | BoE |
| 3.11 | Completion missed (day passes) | Date passed, not completed | Raise `completion_failure` (critical). | **BUILT**: `sla.ts:296-302`, auto-resolves at `sla.ts:350` | P1 | SCS 7.2 |
| 3.12 | Contract-rate compensation owed or claimable | Late completion recorded and the defaulting party known | Compute: contract rate × (price − deposit) × days of the net default. Show it on the issue. Seller side: add it to the sum due. Buyer side: tell the client and keep it out of the advance. | **MISSING**: wording only (`sla.ts:301`). | P2 | SCS 7.2 |
| 3.13 | Notice to complete served by or on us | `notice_to_complete_served` | Escalation decision plus deadline. On expiry with no completion: a rescission decision (deposit forfeited or returned). | **PARTIAL**: served and the deadline are built (`machine.ts:1556-1572`, `sla.ts:194-197`). No `contract_rescinded` outcome. Abandon is generic. | P1 | SCS 6.8 |
| 3.14 | Keys not released after completion | The client reports no keys after completion (note reader) | An issue after completion (raising issues after completion is refused today; see 8.1). Chase the seller's solicitor and the agent. Completion stands. | **PARTIAL**: checklist tick only (`completion.ts:63`). `raise_issue` refuses after completion (`machine.ts:1633`). | P2 | CCP |
| 3.15 | Vacant possession not given (the seller or an occupier still in, goods left) | Client or agent report | Before completion: do not complete without instructions (hold the money). After: a breach-of-contract issue, a damages claim, the lender told if an occupier. | **MISSING**: `vacant possession` appears only in the forms reader. | P2 | SCS 3.2 |
| 3.16 | Seller's solicitor will not confirm completion, or cannot be reached | `payment_sent`, no confirmation within 1 working hour | Chase (phone). Escalate same day. Keys stay held. | **MISSING** | P2 | CCP |
| 3.17 | A party dies, loses capacity or becomes bankrupt between exchange and completion | Note or K16 hit | A critical issue gated on completion. The contract binds the personal representatives / trustee in bankruptcy. Re-plan the date. The lender is told (death of a borrower ends the offer). | **MISSING** | P2 | SCS 7 (general) |
| 3.18 | Chain upstream fails on the day (our seller cannot complete their purchase) | Seller's solicitor reports it | `completion_failure` and `chain_dependency`. A notice to complete decision. | **PARTIAL**: issues exist and are raised by hand. | P2 | SCS 6.8 |

## 4 · Seller side: redemption, other charges, agent and client

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 4.1 | Redemption statement not requested or not received before exchange | Sale with an existing mortgage | Gate exchange. | **BUILT**: `machine.ts:567-568`, `machine.ts:1222` | P1 | CCP para 7 |
| 4.2 | Redemption statement out of date for the completion date | `validUntil` before completion, or lapsed | Raise an issue (critical once lapsed). Ask for a dated statement. | **BUILT**: `sla.ts:303-312`, `sla.ts:351` | P1 | CCP |
| 4.3 | Completion moves: the daily interest changes the figure | `completion_date_changed` with a redemption on file | Recompute: figure + daily interest × extra days. Update the statement and the payment authorisation. | **BUILT** — moving completion adds the daily interest to the redemption figure; a statement no longer valid on the new date raises its issue | P2 | — |
| 4.4 | More than one charge (second charge, secured loan, charging order, Help to Buy equity loan) | Charges register with more than one financial charge | Model redemptions as a list, one per charge, each with its own statement, payment and discharge. All are gated before exchange (the figure is known) and before close (all discharged). | **BUILT** — every financial charge beyond the mortgage is added from the title read (or by hand), each with its figure before exchange, its line on the statement, paid off, and its own discharge chased; the file closes only when all are off (engine/charges.ts) | P1 | CCP para 7; PG31 |
| 4.5 | Negative equity: the price is less than the total of the redemptions plus costs | Statement balance below zero | Critical issue gated on exchange. Do not exchange or give an undertaking without the shortfall in cleared funds, or the lender's written consent to a short sale and release of its charge. | **BUILT** — every redemption figure against the price: owing more raises a critical shortfall holding exchange, cleared when the figures change (charges.ts `negativeEquity`) | P1 | CCP para 12(ii) |
| 4.6 | Help to Buy equity loan to redeem on sale | Shape or title shows Homes England's charge | Task: a RICS valuation (validity period), the redemption request to the scheme administrator, the figure on the statement, payment, then their discharge. Gate exchange on the figure. | **BUILT** — the Help To Buy Loan To Repay shape puts the loan on the charges (figure before exchange, paid, released) with the RICS valuation checklist holding exchange | P2 | HE |
| 4.7 | Redemption not sent on completion day (daily interest runs; our undertaking is at risk) | `completion_confirmed` (sale) without `mortgage_redeemed` the same day | Raise a same-day task, escalating the next morning. | **PARTIAL**: stage blocker only (`machine.ts:590`), no timer. | P1 | CCP para 12(ii) |
| 4.8 | Lender rejects or returns the redemption money (wrong reference, account closed) | Lender's notice | An issue: re-verify the details (the hard stop again), re-send. Our undertaking is still live. | **MISSING** | P2 | LS-Fraud |
| 4.9 | DS1 / e-DS1 / END not received after redemption | `discharge` wait open | Chase the lender. Escalate. | **BUILT**: `projection.ts:1070`, `sla.ts:64` | P1 | PG31 |
| 4.10 | Discharge received: our undertaking must be discharged to the buyer's solicitor | `discharge_confirmed` on a sale | Task or message: send the DS1 (or confirm the e-DS1/END) to the buyer's solicitor. Release the undertaking. | **BUILT** — our undertaking is recorded before a charged sale can complete; once every charge is discharged a task sends the discharges to the buyer's solicitor, and the file cannot close until it is done | P1 | CCP para 12(ii) |
| 4.11 | Buyer's solicitor chases our undertaking / HMLR early completion left the charge on | Inbound email | Treat as an escalation on the discharge wait. | **PARTIAL**: inbound mail is triaged generally. No link to the undertaking. | P2 | PG50 s.4 |
| 4.12 | Estate agent's commission | Agent invoice on file | Task: check the invoice against the agreed fee and the client's authority to pay, verify the agent's bank details, pay from the proceeds, show it on the statement. | **PARTIAL**: `estate_agent` payee kind exists (`types.ts:763`). The statement lists it "to confirm" (`completion-statement.ts:66`). No task. | P2 | SRA-AR |
| 4.13 | Balance of the proceeds to the client | Completed sale | Gate: payment authorised against verified client details. | **BUILT**: `machine.ts:591`, `graph.ts:284` | P1 | SRA-AR 2.5 |
| 4.14 | Client asks for the proceeds to go to a third party or several accounts | Payee not the client | An AML red flag: written instruction, identity of the payee, MLRO view. Hard stop on the details. | **MISSING**: payee kind `other` is unchecked. | P2 | LSAG; SRA-AR 3.3 (not a banking facility) |
| 4.15 | Completion statement reconciliation on a sale: money received from the buyer's solicitor against the price less the deposit | `funds_received(buyer_solicitor, amount)` | Compare. A shortfall holds completion (do not release keys). | **BUILT** — a sale expects the contract price less the deposit from the buyer's solicitor; short holds completion ("do not release the keys") | P1 | CCP |
| 4.16 | Deposit held as stakeholder: release on completion | Completion on a sale | Task: transfer the stakeholder deposit into the client's ledger and include it in the balance. | **MISSING** | P3 | SCS 2.2 |

## 5 · Remortgage and transfer of equity

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 5.1 | Remortgage: redeem the old lender from the new advance | Remortgage with an existing charge | Gate on payment authorisation. Discharge awaited before close. | **BUILT**: `machine.ts:628`, `machine.ts:1303-1310`, `machine.ts:1756` | P1 | LH; PG31 |
| 5.2 | Remortgage: the new advance is less than the redemption (client top-up) | Advance against redemption | Shortfall issue gated on completion. Request the client's funds (`funds_requested` client). | **BUILT** — an advance below the redemption is a shortfall the client tops up | P1 | SRA-AR 5.3 |
| 5.3 | Remortgage: release of equity / surplus to the client | Advance greater than redemption plus costs | Task: pay the balance to the client against verified details. Gate close on it. | **MISSING**: `ownerBlockers` completed checks only SDLT/AP1 (`machine.ts:636-639`). | P1 | SRA-AR 2.5 |
| 5.4 | Remortgage with a Help to Buy loan: Homes England consent / postponement | Shape or title shows Homes England's charge | Consent gated before completion. Deed of postponement. | **MISSING** for owners. | P2 | HE |
| 5.5 | Remortgage statement of account: the completion statement is built as a purchase | `buildCompletionStatement` with `side='owner'` | An owner statement: advance less redemption less fees, surplus to the client or top-up from the client. | **PARTIAL**: owner falls through to the buyer branch (`completion-statement.ts:52-61`). | P2 | — |
| 5.6 | Transfer of equity: the lender's consent carries conditions (a new deed, the incoming party joins as borrower, the outgoing party released, a fee) | `lender_consent_received(conditions)` | Each condition becomes a task, gated on completion. | **PARTIAL**: conditions are free text, ungated (`projection.ts:1226`). | P1 | LH |
| 5.7 | Transfer of equity: release of the outgoing borrower | ToE where a party leaves | Task: the lender's deed of release or a new mortgage. Gate completion on the release document. Tell the outgoing party in writing if not released. | **MISSING** | P1 | LH |
| 5.8 | Transfer of equity: SDLT on debt assumed (the share of the mortgage taken on counts as consideration) | ToE with a mortgage and a party leaving | Compute the chargeable consideration = cash + the share of the debt assumed. Feed the SDLT determination. | **PARTIAL**: `considerationPennies` is cash only (`machine.ts:913`). | P2 | FA03 Sch 4 para 8 |
| 5.9 | Remortgage completion date drifts from the lender's funds date | `targetCompletionDate` changed after the certificate | Same as 1.14. | **MISSING** | P2 | LH |

## 6 · Registration (SDLT, AP1, requisitions, discharges)

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 6.1 | SDLT return due within 14 days | `completion_confirmed` | Deadline 5 working days ahead, with an estimate. | **BUILT**: `sla.ts:180-186` | P1 | FA03 s.76 |
| 6.2 | SDLT return late (day 15+) | Date past the filing date, not filed | Critical issue: file now. Record the £100 penalty (£200 after 3 months). Tell the client and the insurer if the firm is at fault. | **PARTIAL**: one deadline escalation only. Nothing after the date passes. | P1 | FA03 Sch 10 paras 3–4 |
| 6.3 | SDLT payment not made with the return / tax money not held | `sdlt_submitted` without a payment to HMRC | Model `payment_authorised(payee=hmrc)` (an HMRC account, verified). Gate the AP1 on the SDLT5. | **PARTIAL**: SDLT5 gate on the AP1 (`machine.ts:1362`). No HMRC payee kind (`types.ts:763`). | P2 | FA03 s.76 |
| 6.4 | SDLT return needs amending (wrong figure, relief claimed wrongly, linked transaction found) | Correction or note | `sdlt_amended` event inside 12 months of the filing date. Payment of extra tax plus interest, or a refund claim. | **MISSING** | P2 | FA03 Sch 10 para 6 |
| 6.5 | Higher-rates refund (previous main residence sold within 3 years) | Client says the old home is sold | Advisory task with the refund window. Not the firm's filing unless instructed. | **MISSING** | P3 | FA03 Sch 4ZA |
| 6.6 | AP1 not lodged before the OS1 priority ends | `prioritySearchExpiresAt` approaching after completion | Deadline 2 working days before. | **BUILT**: `sla.ts:187-193` | P1 | PG12 |
| 6.7 | AP1 lodged after priority | `ap1_submitted` after expiry | Critical issue: check the register, tell the lender. | **BUILT**: `machine.ts:1365-1367` | P1 | PG12; LH |
| 6.8 | AP1 lodged without the seller's DS1 (early completion) | `ap1_submitted` on a purchase with a seller's charge and no discharge evidence | Record `dischargeEvidence: pending`. A wait on the seller's solicitor's undertaking (CCP 12(ii)), chased. When HMLR completes early (the charge left on), lodge the DS1 separately. Gate close until the seller's charge is off. | **BUILT** — completing a purchase from a charged seller opens a wait for their DS1 under the undertaking, chased (template chase_seller_discharge); the file does not close until it arrives | P1 | PG50 s.4; CCP |
| 6.9 | Requisition raised | `hmlr_requisition_received` | Decision with deadline. Blocks registration confirmed. | **BUILT**: `machine.ts:1589-1602`, `sla.ts:198-201`, `machine.ts:1373` | P1 | PG50 s.2 |
| 6.10 | Requisition without a stated deadline | `deadline` null | Default the deadline: requisition date + 20 working days (PG50 standard). The deadline timer then runs. | **BUILT** — a requisition with no date gets 20 working days, so the timer runs | P1 | PG50 s.2 |
| 6.11 | Requisition can't be met in time (awaiting a DS1, a certificate of compliance, a deed of covenant) | Deadline near, the dependency open | Task: ask HMLR for an extension with written evidence of the steps taken. Record `requisition_extended(newDeadline)`. | **BUILT** — within five working days of the date a task offers more time (`requisition_extended`, with what is awaited) | P1 | PG50 s.3 |
| 6.12 | Application cancelled (priority lost) | HMLR cancellation notice | A new `ap1_cancelled` event: critical issue. Fresh OS1 (search from the date of the official copy), re-lodge, tell the lender (its charge may not rank first), consider the insurer. AP1 back to not submitted. | **BUILT** — `ap1_cancelled`: critical issues (priority lost; the lender told), the AP1 step returns | P1 | PG50 s.2; LH registration |
| 6.13 | Registration slow (no completion after weeks) | `registration` wait | Chase HMLR at 30 working days. | **BUILT**: `sla.ts:43`, `projection.ts:487` | P2 | — |
| 6.14 | Registration completed but the register is wrong: the lender's charge missing or not first, a seller's charge still there, a wrong name, a restriction missing (tenants in common Form A) | `ap1_confirmed` plus title read | Read the new official copy. Check the proprietors, our charge in the charges register (first), no prior charge left, Form A where tenants in common. A mismatch raises an issue; apply to rectify. | **BUILT** — a task after registration to read the new register; something wrong becomes a `title_defect` issue; an AP1 file closes only once checked | P1 | LH registration |
| 6.15 | TID to the client and confirmation to the lender | `ap1_confirmed` | Send the TID / updated register to the client (the client update exists). Confirm registration to the lender if its Part 2 asks. Lender's deeds policy. | **BUILT** — the client hears about registration once the new register is checked, with the register sent as their title information document (a secure link); the register check records the lender told | P2 | LH registration |
| 6.16 | Help to Buy / second charge to register on a purchase | Shape `second_charge` | The AP1 includes the second charge (Homes England). Confirm both registered in order. | **PARTIAL**: checklist issue to completion (`shapes.ts:62-64`). No registration check. | P2 | HE |
| 6.17 | Leasehold: notice of assignment | Leasehold purchase completed | Serve within the lease's time limit, pay the fee, gate close. | **BUILT**: `machine.ts:2014-2021`, `machine.ts:1757` | P2 | Lease terms |
| 6.18 | Leasehold: notice of charge to the landlord (the lender's) | Leasehold purchase with a lender | Same as 6.17, in the same step. | **PARTIAL**: one notice, no charge element. | P2 | LH leasehold |
| 6.19 | Leasehold: deed of covenant, management company share transfer (stock transfer form, share certificate, register of members), certificate of compliance for a restriction | Pack `consentsRequired` | Model each as its own task. The certificate of compliance goes with the AP1. Gate the AP1 (a restriction) or close (a share). | **PARTIAL**: one free-text issue after completion (`machine.ts:1340-1343`). | P2 | PG50; lease |
| 6.20 | Registration requisition about the SDLT5 or ID evidence (ID1 / conveyancer's certificate) | Requisition text | Part of 6.9; categorise so the right task appears. | **PARTIAL** | P3 | PG50 |

## 7 · After the money (retentions, account, residual balances, close, retention)

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 7.1 | Lender retention to be released after works (a valuer's re-inspection) | Retention on the offer | Post-completion task: works evidenced, re-inspection asked for, release received and paid to the client (or the seller under the contract). A wait. | **BUILT** — a retention agreed against a lender condition opens a wait at completion, chased monthly (chase_retention_release); the file closes only when it is released | P2 | LH retentions |
| 7.2 | Contract retention (new build snagging, a pending indemnity, an apportionment balance, a service-charge year-end) held from the seller | Statement line | A ledger item with the release condition and date. A wait. | **MISSING** | P3 | Contract |
| 7.3 | Final bill not delivered or not paid | Completion | Task: deliver the bill. Transfer fees from client money only after the bill is delivered. | **BUILT** — a task after completion to deliver the final bill; the file cannot close without it | P2 | SRA-AR 4.3 |
| 7.4 | Residual balance on the ledger (overestimated SDLT or HMLR fee, a refund) | Ledger not at zero after registration | Return promptly. If the client can't be traced: reasonable steps, then £500 or less to charity under the conditions, more than £500 to the SRA. | **MISSING** | P2 | SRA-AR 2.5, 5.1(c) |
| 7.5 | Interest on client money held | Money held long enough | Fair sum of interest per policy. | **MISSING** | P3 | SRA-AR 7.1 |
| 7.6 | Close the file | `close_matter` | Gate: registration, discharge, notice of assignment, no open issues. Add: ledger zero, all retentions released, undertakings given and received discharged, TID sent. | **BUILT** — close also needs refunds paid, every charge discharged, our undertaking discharged, the register checked and the seller's DS1 in | P1 | SRA-AR 2.5; CCP |
| 7.7 | Retention and destruction dates | `matter_closed` | Stamp `destroyAfter`: purchase 15 years, sale 6 years. CDD records: 5 years after completion. Original deeds returned to the client or held under a deeds register. | **BUILT** — closing stamps when the file may be destroyed (purchase 15 years, sale 6) and the CDD records (5 years from completion) | P3 | Retention; MLR40 |
| 7.8 | Problem found after completion (a defect, a missing document, a dispute) | A person or a note | Allow post-completion issues (with gate `registration` or `close`), not only requisitions. | **BUILT** — issues can be raised after completion (they hold nothing, but keep the file open) | P1 | — |

---

## Top 10 to build first

1. **Allow issues after completion** (7.8, also 3.14, 4.8, 6.12). Lift the refusal at `machine.ts:1633`.
   - Add post-completion stages (`completed` and `post_completion`) to the kinds that can arise then. Gate `none` / `registration` / `close`; `close_matter` already refuses on open issues.
   - Without this, the problems that come up after completion are invisible: keys, rejected redemption money, a cancelled application, the seller's DS1.
   - Smallest change, unlocks the rest.
2. **Charges as a list, with undertakings on both sides** (1.16, 1.17, 4.4, 4.10, 6.8).
   - Replace `s.redemption` with `s.charges[]`: `{ chargeId, lender, kind (first | second | equity_loan | charging_order), statement, validUntil, dailyInterest, redeemedAt, dischargeEvidence (none | ds1 | eds1 | end | ed), undertakingGivenAt, undertakingDischargedAt }`.
   - Seed it from the charges register (`rules.ts:221` already finds them).
   - Sale side: each charge needs a figure before exchange, a payment at completion and a discharge before close. On `discharge_confirmed`, send the evidence to the buyer's solicitor (a message, not a click).
   - Purchase side: a TA13 step on exchange. Its reply records the seller's undertaking per charge. The AP1 notes the discharge as pending, and a wait chases the seller's solicitor under CCP 12(ii) until the charge is off (PG50 s.4 early completion).
3. **Reconcile the money** (2.2, 3.4, 4.15, 5.2, 5.3, 4.5).
   - Store `balancePennies` and the line items on `completion_statement_generated`.
   - `funds_received` below the expected sum raises `completion_funds_shortfall` (gated on completion).
   - `payment_authorised` greater than the cleared money held for that client is refused (SRA-AR 5.3).
   - A negative sale balance is a critical issue gated on exchange.
   - An owner statement handles redemption against advance, with the surplus or top-up.
4. **Cleared funds and payment sent** (2.4, 3.3, 3.5).
   - `funds_received.cleared`, and an `funds_cleared` event.
   - A new `payment_sent { payeeKind, chapsRef, sentAt }`.
   - A purchase completes only on payment sent plus the other side's confirmation. A "money not arrived" report becomes a fraud-emergency issue with a fixed recovery checklist: bank recall, Action Fraud, insurer, COLP, SRA.
5. **Same-day completion clock** (2.7, 3.6, 3.8, 3.9, 4.7).
   - Use `working-days.ts` to refuse weekend or holiday completion dates.
   - On completion day, a timer at the firm's cut-off (default 14:00 for the contract, with an earlier configurable CHAPS cut-off) raises `lender_funds_delayed` or `completion_failure` the same day, not the next.
   - A sale with no `mortgage_redeemed` by end of day escalates.
   - Re-key the `funds` chase to the completion date (D-1), not the request date.
6. **Cancellation and extension of an HMLR application** (6.10, 6.11, 6.12).
   - Default the deadline to 20 working days when HMLR's letter gives none. `requisition_extended`.
   - `ap1_cancelled` resets `ap1SubmittedAt`, raises a critical `title_defect` holding close, and tasks a fresh OS1 and re-lodgement. Tell the lender (LH registration).
7. **Delayed completion with the lender's money** (1.14, 3.7, 5.9).
   - A completion date changed after the certificate tasks the lender update.
   - An advance held more than the Part 2 limit (lender directory: `advanceReturnAfterWorkingDays`, default 3) raises an issue whose resolution is `advance_returned` (re-opens the funds request) or the lender's written agreement.
8. **K16 hit and K16 freshness** (1.8, 1.9).
   - `bankruptcy_search_hit { subject, entries }` opens a `bankruptcy_insolvency` issue gated on completion and allowed at pre-completion. The certificate refuses while it is open.
   - A K16 older than the lender's window, or a party added after it, clears `bankruptcySearchAt`.
9. **Register check at registration** (6.14, 6.15, 6.16).
   - `ap1_confirmed` reads the new official copy (the extraction pipeline exists).
   - Proprietors match the buyers. The lender's charge is present and first, then any Help to Buy second charge. No seller's charge is left. A Form A restriction is present where tenants in common.
   - Mismatches raise issues. Clean registration sends the TID to the client and the confirmation to the lender.
10. **Close properly** (7.3, 7.4, 7.6, 7.7, 5.3, 4.12).
    - `close_matter` also requires: final bill delivered, ledger at zero (or residual-balance handling recorded), no live undertaking either way, retentions released, sale proceeds / equity release / agent paid against verified details.
    - `matter_closed` stamps `destroyAfter` (15 years purchase, 6 sale) and `cddRetainUntil` (completion + 5 years).

**Design notes**
- Every new step must email, generate a file, or be a task done in place (no button-only steps). `tests/unit/engine/no-stall.test.ts` must stay green. Each item above adds a variant to the 26-case stall fixture.
  - Remortgage with surplus.
  - Sale with two charges.
  - Purchase with early completion.
  - Cancelled AP1.
  - K16 hit then cleared as a namesake.
- Money stays person-only. `payment_sent`, `advance_returned` and residual-balance transfers are user actors, like `payment_authorised` (`machine.ts:1417`).
- Lender-specific numbers belong in the lender directory, not code. These are the advance-return window, the K16 window and whether registration must be confirmed (`lender-directory.ts`, sourced from Part 2).
- Deadlines that are ours (SDLT, OS1, requisitions) stay in `deadlineActions`. States caused by time (late SDLT, a held advance, a lapsed K16) go in `timedIssueActions`, which is idempotent by key, as the offer-expiry pattern already does.
