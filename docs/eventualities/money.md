# Eventualities: money — source of funds, the mortgage, and completion funds

Every junction where money enters, changes or leaves a matter, and every reasonable way it goes
off the happy path. For each: the signal the engine would see, what the correct response
changes (issue + gate, state fact, client decision, task, wait, message, recalculation) and how
it ends, what the engine does **today**, and a priority.

- **Engine today**: **BUILT** (file:line), **PARTIAL** (some of the response exists; the gap is
  named), **MISSING**. Line numbers are as of commit `a00f458` (`lib/server/engine/…`).
- **Priority**: **P1** a loss, a regulatory breach or a failed completion is likely if it is
  missed; **P2** common and costly in time; **P3** uncommon or advisory.
- **Sources**: MLR = Money Laundering Regulations 2017; LSAG = Legal Sector Affinity Group AML
  guidance (2025 edition; section numbers as already cited in `docs/conditions-register.md`);
  Handbook = UK Finance Mortgage Lenders' Handbook (England & Wales) Part 1 by topic, Part 2 per
  lender (the site refuses automated fetching, so cited by topic, as the register does);
  SCS = Standard Conditions of Sale 5th ed.; SAR = SRA Accounts Rules 2019. The firm's MLRO must
  check the AML rows against the firm's own policy.

What is already strong: the proof-of-funds form and line-by-line statement review
(`proof-of-funds.ts`, `source-of-funds.ts`) with drafted queries, risk rating and a source-of-wealth
query on enhanced risk; donors and joint holders as checked parties; the remitter check on every
receipt; offer expiry timers; price-change → lender + funds re-check; the certificate-of-title
preconditions; the completion money gates. What is weak is everything **after** the
declaration is signed off: the engine checks that money *arrived*, never that the *right amount*
arrived, and it does not re-open the funds check when the funding picture changes (cash ↔
mortgage, smaller advance, retention, scheme money returned).

---

## 1 · Declaring the funds (instruction → proof-of-funds round 1)

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 1.1 | Gift or loan first mentioned late (in an email, after sign-off) | note reader: "dad is giving us £20k" | `source_of_funds` issue (exchange) + the sign-off is **voided**: a new PoF round with the gift block; donor becomes a party | PARTIAL — note reader raises `source_of_funds` (notes.ts:706-714); does not re-open a signed-off PoF or add the donor until a new round is submitted | P1 | LSAG 6.17.2; Handbook (gifts) |
| 1.2 | Declared total short of price + SDLT + fees − advance | form totals | `POF_SHORTFALL`; but the engine computes need as price − advance only | **BUILT** — required = price − advance + the SDLT estimate (`computeSdlt`); shortfall text names Stamp Duty | P1 | LSAG 6.17 (funds for the transaction) |
| 1.3 | Co-buyers declare separately with unequal money | `coDeclarants`, two rounds | each buyer's sources attributed to them; contributions recorded for the trust deed (§10) | PARTIAL — `POF_MISSING_DECLARANT` (proof-of-funds.ts:194); no per-buyer attribution feeds `co-ownership.ts` | P2 | LSAG 6.17.2 |
| 1.4 | Source "other" or free text the rules cannot classify | `kind: 'other'` | a drafted query asking what it is + evidence; never a silent pass | PARTIAL — no flag for `other` beyond evidence-count rules | P2 | LSAG 6.17 |
| 1.5 | Client refuses or stalls on the form | `proof_of_funds` wait chased day 3/6/9, escalated day 10 | escalate to fee earner; exchange held; after N escalations a decision: cease acting (MLR reg 31) | BUILT chase/hold (sla.ts:45, machine.ts:544); MISSING the reg 31 "cannot complete CDD → stop" decision | P2 | MLR reg 31 |

## 2 · Business-owner and employment money

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 2.1 | Deposit is a **dividend** from the client's own company | source `business_income` + company payer on statement | sub-type `dividend`: dividend voucher, board minute, latest filed accounts showing distributable reserves, Companies House check that client is director/shareholder; query on personal tax declared (SA) | PARTIAL — `business_income` is one generic kind (proof-of-funds.ts:35,73) flagged EDD (`POF_HIGH_RISK`); no sub-type, no Companies House link, no reserves check | P1 | LSAG 6.17 (business income); MLR reg 28(11) |
| 2.2 | Deposit is a **director's loan** from the company | statement credit from company, client says "loan from my company" | treat as **borrowing**: `POF_LOAN` + lender told (most lenders refuse borrowed deposits); loan agreement / DLA ledger; note s.455 charge if unrepaid; affordability is the lender's call | MISSING — would pass as `business_income` | P1 | Handbook (borrower's other borrowing / deposit not from own resources); CTA 2010 s.455 |
| 2.3 | Deposit is **salary/bonus** drawn from own company | payslips, PAYE credits | ordinary income evidence; check payroll matches the company (`PAYSLIP_*`) | BUILT — payslip reading (proof-of-funds.ts:472-480) | P3 | LSAG 6.17 |
| 2.4 | **Company pays our client account directly** for an individual buyer | `client_account_receipt` remitter = company | company is a third-party payer: board authority, why the company pays (dividend? loan? gift?), the lender told; company is not "family" for gift rules | **BUILT** — a company remitter for an individual buyer raises an AML issue holding completion | P1 | LSAG 6.17.2; SAR 3.3 |
| 2.5 | Sole trader / partnership drawings | business-account statements | business statements + last SA302/tax calculation; cash-heavy trade → cash rules | PARTIAL — evidence text only (proof-of-funds.ts:73) | P2 | LSAG 6.17 |
| 2.6 | Bonus/commission or redundancy lump sum | large credit from employer | evidenced by payslip/settlement agreement, not queried as unknown | PARTIAL — employer credits matched loosely (`looksLike`, proof-of-funds.ts:527); one-offs above threshold still queried | P3 | — |

## 3 · Overseas money, crypto, other higher-risk sources

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 3.1 | Money from a **high-risk third country** | `overseas.country` on form / SWIFT line | EDD is **mandatory** (not discretionary): MLRO sign-off required on the PoF decision; source of wealth | PARTIAL — `OVERSEAS_CREDIT` → `enhanced` (proof-of-funds.ts:545,607); country never compared to the HMT list; MLRO approval not enforced | P1 | MLR reg 33(1)(b) |
| 3.2 | Payer/donor abroad on a **sanctions list** | name/country | screen donor, joint holder, remitter against the OFSI consolidated list; a hit freezes (hard stop) and goes to MLRO | MISSING for donors/remitters (ID sub-flow only, context.ts:681) | P1 | Sanctions and Anti-Money Laundering Act 2018; OFSI |
| 3.3 | Funds still abroad at exchange (FX risk, slow transfer, receiving-bank compliance hold) | `overseas.alreadyInUk=false` | wait `funds_in_uk` with a deadline N working days before exchange; advise conversion/forward contract; exchange held until cleared in client account | MISSING — flag only | P1 | LSAG 6.17; practice |
| 3.4 | Exchange-rate move creates a shortfall | sterling received < declared | recalc vs need → `completion_funds_shortfall` | MISSING (no amount reconciliation; see 8.1) | P2 | — |
| 3.5 | **Cryptoassets** sold for the deposit | `crypto` source / exchange credit | exchange statements: acquisition, funding of acquisition, disposal, wallet-to-bank trail; query on CGT (tax evasion is a POCA predicate); firm policy may refuse | BUILT flags & query (proof-of-funds.ts:537, FLAG_GUIDANCE 629); MISSING firm "refuse crypto" policy switch and CGT prompt | P2 | LSAG (cryptoassets); POCA s.340 |
| 3.6 | **Inheritance** not yet distributed | `inheritance` + no receipt on statement | estate-dependent wait (like a chain): executors' solicitor letter with expected date; exchange held until in client account or undertaking | PARTIAL — evidence text (proof-of-funds.ts:66); no wait/dependency | P2 | LSAG 6.17 |
| 3.7 | **Sale of shares/investments** | `investment_sale` | platform contract note + transfer; check timing vs exchange (unsettled) | PARTIAL — evidence text; `investment` category in SoF analysis (source-of-funds.ts:73) | P3 | LSAG 6.17 |
| 3.8 | **Pension** lump sum (25% tax-free or taxed drawdown) | `pension` | provider letter; client advised of tax on >25%; check client age eligibility (55/57) | PARTIAL — evidence text only | P3 | Finance Act 2004 |
| 3.9 | **Equity release / remortgage** of another property (client's or donor's) | `remortgage_equity` | new lender's offer + completion statement of that remortgage; a donor's lifetime mortgage = gift traced to it; timing dependency | PARTIAL — evidence text only; no dependency/wait | P2 | LSAG 6.17.2 |
| 3.10 | **Gambling winnings** | operator credit | operator history incl. stakes | BUILT (proof-of-funds.ts:541; source-of-funds.ts:306) | P3 | LSAG |
| 3.11 | **Cash** to be paid in to client account | client asks to pay cash | firm cash policy (most refuse > £500): refuse in the client message; receipt of cash = `aml_kyc_problem` | MISSING — `client_account_receipt` has no cash flag | P1 | LSAG (cash); SAR 3.3 |
| 3.12 | Cash deposits / sudden large credits on statements | statement lines | query per line; sign-off refused while open | BUILT (proof-of-funds.ts:533-565; machine.ts:1890-1910) | — | LSAG 6.17 |

## 4 · Gifts and family loans

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 4.1 | Family **gift**, UK donor | gift block | donor ID/AML, gift letter (non-repayable, no interest), donor statements, lender told | BUILT (proof-of-funds.ts:210-218; donor partyChecks machine.ts:1925-1935; `lender_approval` on sign-off) | — | LSAG 6.17.2.1; Handbook (gifts) |
| 4.2 | "Gift" is really a **family loan** | `repayable=true` or loan source | lender told and must consent; record terms; if the family lender wants security → second charge flow; if they want a share → declaration of trust + they are *not* a gift donor | PARTIAL — `POF_GIFT_REPAYABLE`/`POF_LOAN` flags (proof-of-funds.ts:214,223); no loan sub-form, no route to `second_charge` or trust deed | P1 | Handbook (other borrowing) |
| 4.3 | Donor expects a **share of the property** or will **live there** | form question / note | not a gift: beneficial interest → declaration of trust (they become an owner or the gift letter is impossible); if occupying, occupier waiver + independent advice | PARTIAL — occupiers at enrol (`occupier_consent`); no form question "will the donor live there / expect a share" | P1 | Handbook (occupiers); resulting-trust risk |
| 4.4 | Gift from **non-family** (friend, employer, partner not buying) | relationship text | lender's written acceptance or refuse; employer gift = possible benefit-in-kind | BUILT (proof-of-funds.ts:216; lender directory `acceptsNonFamilyGift`) | — | Handbook Part 2 |
| 4.5 | Gift routed **via a third party** (sibling's account forwards parents' money) | credit from non-donor, `THIRD_PARTY_CREDIT` | each hop traced; the true donor is the donor; the intermediary declared | PARTIAL — line query raised; no "intermediary" concept | P2 | LSAG 6.17.2 |
| 4.6 | **Donor abroad** | `donorAbroad` | EDD; donor's country vs HRTC; certified ID; transfer timing (3.3) | PARTIAL — `POF_GIFT_DONOR_ABROAD` → enhanced (proof-of-funds.ts:215); no country check | P1 | MLR reg 33 |
| 4.7 | Donor's own money arrived just before the gift | donor statements | query | BUILT `GIFT_DONOR_FUNDS_RECENT` (source-of-funds.ts:246) | — | LSAG |
| 4.8 | Gift from a **joint account** / client's account **joint with a non-buyer** | `jointDonorName` / `jointHolderName` / holder mismatch | both treated as contributors | BUILT (proof-of-funds.ts:217,221,500) | — | LSAG 6.17.2.1 |
| 4.9 | Donor dies / withdraws the gift before completion | note / client tells us | `completion_funds_shortfall` (pre-exchange: plan; post-exchange: critical); new source round | **BUILT** — Something Happened → A Gift Is Withdrawn (`completion_funds_shortfall`, critical after exchange) | P1 | — |
| 4.10 | IHT on the gift (donor dies within 7 years) | any gift | advisory line in the report to client / gift letter | MISSING (advisory) | P3 | IHTA 1984 s.3A |

## 5 · Mortgage offer and lender

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 5.1 | Offer advance ≠ advance the client declared | offer facts `amountPennies` vs PoF `mortgageAdvancePennies` | recompute need; if lower, `source_of_funds` "advance smaller than declared" (re-sign-off) | MISSING — never compared | P1 | LSAG 6.17 |
| 5.2 | Offer price / property / borrower names ≠ contract / buyers | offer facts vs contract facts / party names | `lender_approval` issue holding exchange until a corrected offer | PARTIAL — checklist item for the reviewer (context.ts:128); no deterministic comparison | P1 | Handbook (purchase price; borrowers) |
| 5.3 | Offer withdrawn | lender email / note | reopen sub-flow, hold exchange; post-exchange = critical | BUILT (machine.ts:1574; notes.ts:691; sla.ts:291) | — | — |
| 5.4 | Offer expiring / expired / expiry unknown | expiry date | issues + deadline timers | BUILT (sla.ts:171,266-294) | — | — |
| 5.5 | **Product change / re-issued offer** (new rate, new conditions) | second offer document | re-read; diff conditions; new expiry replaces old; decision again | PARTIAL — document revisions supersede (file identity); offer re-judged; no condition diff | P2 | — |
| 5.6 | Special condition not met (proof of deposit, works, occupier) | offer conditions | issue per condition, cleared by evidence | PARTIAL — mortgage decision lists them; `mortgage_condition_outstanding` is manual | P2 | Handbook |
| 5.7 | **Retention** (works / valuation) | offer condition | advance reduced on the completion statement; client funds the gap; post-completion task to request release after re-inspection | **BUILT** — the retention is agreed on the condition's issue and released after completion through a chased wait (completion.md 7.1) | P1 | Handbook (retentions) |
| 5.8 | **Down-valuation** | valuation report / broker | `valuation_issue` → renegotiate / buyer covers / new lender | BUILT (issues.ts valuation_issue; machine.ts:1803-1816) | — | — |
| 5.9 | Buyer covers a down-valuation gap | resolution `buyer_covers_shortfall` | new PoF round for the extra money (it is new money) | MISSING — resolution does not re-open PoF | P1 | LSAG 6.17 |
| 5.10 | Cash ↔ mortgage switch | person sets funding | mortgage sub-flow opened/closed; **PoF re-opened** because the need changed | **BUILT** — `set_funding` raises a re-evidence round for the new need | P1 | — |
| 5.11 | Client's circumstances change (job loss, new debt) | note | `mortgage_at_risk`, lender told before exchange | BUILT (notes.ts:702) | — | Handbook |
| 5.12 | Lender's Part 2 rule on deposits (e.g. no gifts, no borrowed deposit, no builder deposit) | lender directory | applied to PoF flags | PARTIAL — only `acceptsNonFamilyGift` (machine.ts:229); add `acceptsLoanDeposit`, `acceptsDonorAbroad` | P2 | Handbook Part 2 |
| 5.13 | **Second charge** on purchase | shape | consents, postponement | BUILT (shapes.ts:61-65) | — | Handbook |
| 5.14 | **Bridging loan** for the deposit/purchase (pending sale) | loan source named bridging / statement | bridging lender's offer, exit (the sale) linked, any charge over the new property → second charge; main lender consent; daily interest on delay | PARTIAL — `POF_LOAN` generic | P2 | Handbook (other borrowing) |
| 5.15 | Incentives / cashback / developer deposit contribution | new-build pack, Disclosure of Incentives form | lender told (form); net price on the COT | PARTIAL — shape text only | P2 | Handbook (purchase price / incentives); UK Finance DOI form |

## 6 · Price changes and valuation

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 6.1 | Price **increase** pre-exchange | `record_price_change` | lender told; PoF shortfall issue; SDLT re-estimated | BUILT (machine.ts:1838-1848, 2492-2499); SDLT derived from current price in statement | — | Handbook |
| 6.2 | Price **reduction** pre-exchange | issue resolution / note | lender told; less money needed (no PoF issue) | BUILT (machine.ts:1803-1816; notes.ts:753) | — | — |
| 6.3 | Price change crosses a **cliff**: FTB relief ceiling (£500k), LISA cap (£450k), HTB ISA cap (£250k/£450k London) | new price | issue `sdlt_basis` (relief lost) and `isa_bonus` (scheme money no longer usable → shortfall) | **BUILT** — price change over £500k loses FTB relief; LISA £450k; HTB ISA cap (machine.ts priceCliffs) | P1 | FA 2003 Sch 6ZA; LISA rules |
| 6.4 | Price reduced **after completion** (retention released to buyer, defect settlement) | post-completion note | amended SDLT return within 12 months of filing / overpayment relief within 4 years | MISSING | P3 | FA 2003 Sch 10 paras 6, 34 |
| 6.5 | Part of the price is for chattels | contract chattels price | SDLT on land only (statement line); lender told if material | **BUILT** — contract chattels price read; holds exchange when it takes the land under an SDLT threshold | P3 | HMRC SDLTM |
| 6.6 | Higher-rates refund later (old main home sold within 3 years) | completion of client's sale after purchase | reminder task to claim the 5% surcharge refund | MISSING | P2 | FA 2003 Sch 4ZA para 3 |

## 7 · Schemes: LISA, Help to Buy ISA, equity loan, shared ownership

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 7.1 | LISA used on a property **over £450,000** or without a mortgage | shape + price + `hasLender` | reject the shape at enrol / raise on price change; client warned of 25% withdrawal charge | **BUILT** — price over £450k with a LISA raises the 25% charge warning | P1 | gov.uk Lifetime ISA |
| 7.2 | LISA account open < 12 months | form date | hold; bonus-eligible date as wait | MISSING | P2 | gov.uk LISA |
| 7.3 | LISA funds received, **completion not within 90 days** | `funds_received(isa_provider)` + no completion | wait with deadline at 90 days; on breach/abort the money **goes back to the ISA manager**, not the client | **BUILT** — a deadline 90 days from the bonus reaching us; on abandonment it is owed back to the ISA manager (money.ts) | P1 | gov.uk LISA (conveyancer 90-day rule) |
| 7.4 | HTB ISA bonus asked to fund the **exchange deposit** | deposit plan includes bonus | refuse; bonus only on completion | MISSING — `deposit_received` has no source | P1 | HTB ISA scheme rules |
| 7.5 | HTB ISA bonus claim after closing statement (claim within 12 months of closing; by 1 Dec 2030) | closing statement date | deadline timer | PARTIAL — date in issue text (shapes.ts:99) | P2 | HTB ISA scheme rules |
| 7.6 | Both LISA and HTB ISA bonuses on the same purchase | both shapes | only one bonus usable → flag at enrol | MISSING | P2 | gov.uk LISA |
| 7.7 | **HTB equity loan redemption** on a sale or remortgage | seller / remortgage with Homes England charge on title | RICS valuation (valid 3 months) → redemption figure → Homes England consent; redemption paid on completion; remortgage keeping the loan needs postponement | **BUILT** — shape `equity_loan_redemption` puts the Homes England charge on the case | P1 | Homes England equity-loan redemption guidance |
| 7.8 | Shared ownership: SDLT election (market value vs share) | shape | client decision on the election; SDLT computed on the choice | MISSING — sdlt.ts has no SO basis | P2 | FA 2003 Sch 9 |
| 7.9 | Shared ownership staircasing / resale nomination on a sale | sale with SO lease | provider's valuation + nomination period wait | MISSING (shape is buyer-only) | P2 | model SO lease |

## 8 · Deposit and exchange

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 8.1 | Deposit received **≠ contract deposit** | `deposit_received.amountPennies` vs `contract.deposit_pennies` | short → `deposit_issue` (exchange); over → hold the excess for completion with the client's consent | **BUILT** — `deposit_received` compared with the contract deposit (service fills it from the register): short → `deposit_issue` holding exchange, topped up by a further receipt (machine.ts `depositConsequences`) | P1 | SCS 2.2 |
| 8.2 | Deposit **under 10%** agreed | contract deposit < 10% price | special condition needed (balance payable on default); client advised | **BUILT** — see exchange.md 2.3 (findings.ts) | P2 | SCS 2.2.1 |
| 8.3 | Deposit is the **deposit from the client's own sale** passed up the chain | linked sale | SCS 2.2.5 use; chain dependency already holds exchange | **BUILT** — linked purchase deposit larger than the sale deposit raises the gap (SCS 2.2.5) | P2 | SCS 2.2.5 |
| 8.4 | Deposit before PoF sign-off | receipt | `aml_kyc_problem` holds exchange | BUILT (machine.ts:1210) | — | LSAG |
| 8.5 | Deposit from a third party | receipt remitter | stranger → `aml_kyc_problem` | BUILT (machine.ts:2119-2130) | — | LSAG 6.17.2 |
| 8.6 | Deposit paid **direct to the seller/agent** | contract / note | lender told (deposit not through us); evidence of payment | MISSING | P2 | Handbook (purchase price / deposit) |

## 9 · Completion funds

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 9.1 | Client's balance received **short of the statement** | `funds_received(client).amountPennies` < statement balance | `completion_funds_shortfall` (completion gate) auto-raised; chase the difference | **BUILT** — every amount checked against the figure asked for (`funds_requested.amountPennies`, now required on the form): short → `completion_funds_shortfall` (critical, holds completion) and a task to ask the client for the difference; made up → resolved (engine/money.ts `position`) | P1 | — |
| 9.2 | Client **overpays** | received > balance | surplus refund task, returned promptly to the sending account | **BUILT** — the surplus becomes a refund owed to the sending account (`refund_due`), on the Tasks list until `refund_paid`; the file cannot close with one unpaid | P2 | SAR 2.5 |
| 9.3 | Lender advance ≠ offer (arrangement fee/TT fee deducted, retention) | `funds_received(lender)` vs offer | recompute the balance; difference → client shortfall | **BUILT** — the advance compared with the request, else the offer; a deduction is the client's shortfall | P1 | Handbook |
| 9.4 | Client funds late on completion day / CHAPS cut-off missed | wait open on the day | `completion_failure` with late-completion compensation calc at the contract rate; notice to complete if it slips | **BUILT** — completing late raises `completion_failure` with the compensation on the price less the deposit, per 1% of the contract rate (SCS 7.2); the CHAPS cut-off itself is still judged by a person | P1 | SCS 6.1.2, 7.2, 6.8 |
| 9.5 | Lender funds late | funds wait | chase; COT deadline | BUILT (sla.ts:42,178) | — | Handbook (COT) |
| 9.6 | Completion **delayed after the advance arrived** | advance received + completion moves | return the advance within the lender's period (Part 2), with interest; new COT | **BUILT** — completion moved with the advance held: tell the lender, return or consent to hold | P1 | Handbook (holding funds) / Part 2 |
| 9.7 | Remortgage: new advance < redemption + costs | redemption figure vs offer | shortfall from the client before completion | **BUILT** — an advance below the redemption figure is a shortfall (money.ts `position`) | P2 | — |
| 9.8 | Redemption statement expired (sale / remortgage) | validity date | re-request | BUILT kind `redemption_statement_expired` (issues.ts) | — | — |
| 9.9 | Completion money from an unseen account | remitter | `aml_kyc_problem` holds completion | BUILT (machine.ts:1278-1287) | — | LSAG 6.17.2 |
| 9.10 | Chain proceeds short (our sale's net proceeds below the plan) | sale completion statement | purchase-side shortfall issue | MISSING — linked matters do not exchange money facts | P2 | — |

## 10 · After completion, client account, fees, co-owners

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 10.1 | **Abortive** matter with money held | `matter_abandoned` + receipts | refund task: money only to the account it came from (or ISA manager, 7.3); MLRO view if the client asks to send it elsewhere | **BUILT** — abandoning a file owes back the deposit (before exchange) and every receipt: the client's to the client, the ISA bonus to the ISA manager, the advance to the lender (money.ts `heldOnAbandon`); the refunds stay on the Tasks list after the file stops | P1 | LSAG (red flag: returning funds to a different account); SAR 2.5 |
| 10.2 | **Interest** on client money | money held over firm-policy threshold/period | fair-sum interest calculated on the ledger at the end | MISSING — no ledger, `receipts` only (types.ts:1603) | P2 | SAR 7.1 |
| 10.3 | **Residual balance** after completion (SDLT less than estimate, search refund) | final reconciliation | return promptly; statement of account | MISSING | P2 | SAR 2.5 |
| 10.4 | **Fee dispute** / client will not pay the bill | client email | fees taken from completion money only with a bill sent first and the client's agreement; dispute → hold disputed sum, not more | MISSING | P2 | SAR 4.3 |
| 10.5 | Client asks us to pay third parties (agent, builder, family) from proceeds | instruction | only payments tied to the transaction; else refuse (no banking facility) | MISSING | P2 | SAR 3.3 |
| 10.6 | **Unequal contributions** between co-buyers | per-buyer sources (1.3) | recommend tenants in common + declaration of trust; model (fixed, ring-fence, contribution, floating) a client decision; deed generated with the figures | **BUILT** — what each buyer puts in and the model (fixed, ring-fenced, contribution, floating) are recorded from the Tasks list; the shares at purchase come from co-ownership.ts and fill in the declaration of trust; unequal money held as joint tenants raises `co_ownership_advice` holding exchange (co-owners.ts) | P1 | LPA 1925 s.53; *Stack v Dowden* |
| 10.7 | Gift to **one** co-buyer only | gift block + co-buyers | the gift is that buyer's contribution (ring-fence); donor's letter names the recipient | MISSING | P2 | — |
| 10.8 | SDLT paid short / late (funds not held) | completion statement | SDLT is in the balance required; filing deadline gated | BUILT (completion-statement.ts:81; sla.ts SDLT deadline) | — | FA 2003 s.76 |

---

## Top 10 to build first

1. **Completion-money reconciliation (9.1, 9.2, 9.3, 3.4).** Store the approved completion
   statement's balance as `state.completion.balanceRequiredPennies` (and the expected advance).
   On every `funds_received`, sum by role; if client + ISA < required, raise
   `completion_funds_shortfall` (gate completion) with the difference; if over, open a
   `client_refund` task (pays back to the remitter on file). If lender < expected, recompute and
   raise the shortfall on the client. `completion_confirmed` refuses while the sums do not
   balance. Add to the stall fixtures: shortfall then top-up.
2. **Re-open the funds check when the need changes (5.1, 5.9, 5.10, 5.7, 4.9).** One helper,
   `fundsNeedChanged(s, reason)`, called from `funding_changed`, a mortgage decision whose advance
   differs from the PoF's, `buyer_covers_shortfall`, `retention_agreed`, and a new
   `fund_source_withdrawn` command. It recomputes need (price + SDLT estimate + fees − advance,
   fixing 1.2) and, if the verified total no longer covers it, raises `source_of_funds` and
   marks the sign-off stale (`proofOfFundsHolds` true) so a top-up round is sent.
3. **Business-owner money (2.1, 2.2, 2.4).** Split `business_income` into
   `dividend | director_loan | salary_own_company | drawings`. `director_loan` maps to the loan
   rules (lender told, `POF_LOAN`); `dividend` asks for voucher, minute, filed accounts and the
   Companies House record (director/PSC match against the client); a company remitter that is
   a declared source company is "known" for `strangersAmong` but raises a `lender_approval`
   if the lender does not accept company money.
4. **Scheme hard rules (7.1, 7.3, 7.4, 7.6, 6.3).** At enrol and on `price_changed`: price vs
   LISA/HTB caps, `hasLender`, both-shapes conflict → `isa_bonus` issue (critical). On
   `funds_received(isa_provider)` for a LISA open a `lisa_window` deadline at 90 days; on abandon
   or breach a task to return the money to the ISA manager. `deposit_received` gets a `source`
   and refuses an ISA bonus.
5. **Offer vs file comparison (5.2, 5.1).** When the offer is read: price, property address,
   borrower names and advance against the contract, the parties and the PoF. A mismatch is a
   deterministic `lender_approval` (price/property/borrowers) or `source_of_funds` (advance)
   issue, not just a checklist line.
6. **Loans as a structured source (4.2, 4.3, 5.14).** The form's loan block asks lender,
   relationship, terms, secured or not, and whether the lender expects a share or will live
   there. Secured → `second_charge` shape added; a share → a co-owner/trust decision; occupying →
   `occupier_consent`; bridging → linked exit sale and daily-interest note. Lender Part 2 gains
   `acceptsLoanDeposit`.
7. **Overseas funds (3.1, 3.2, 3.3, 4.6).** A country field compared with the HMT high-risk
   list → EDD mandatory with **MLRO approval** required on the PoF decision (a second approver);
   sanctions screening of donors, joint holders and remitters through the ID port; a
   `funds_in_uk` wait due N working days before target exchange, holding exchange.
8. **Deposit checks (8.1, 8.2, 8.6).** Compare the received amount with `contract.deposit_pennies`
   and the price: short → `deposit_issue` holding exchange; < 10% → a contract special-condition
   prompt; a deposit paid direct → `lender_approval`.
9. **Abort, refund, interest (10.1, 10.2, 10.3, 9.6).** A minimal client ledger from receipts and
   payments. On `matter_abandoned` with money held, a refund task that can only pay the remitter
   (a different payee needs the MLRO); interest at the firm's rate on closing; residual
   balances flagged after N days. If completion moves after the advance arrived, a deadline to
   return it under the lender's Part 2 period.
10. **Co-owners' money on the case (1.3, 10.6, 10.7).** Attribute each verified source to a buyer
    (gifts to their recipient) and feed `co-ownership.ts`: unequal contributions with
    `ownership_basis = joint_tenants` raises a warning decision ("advise tenants in common"); the
    chosen model and the figures fill the declaration of trust.

Housekeeping found on the way: `spec.ts` names issue kinds that do not exist
(`funding_shortfall`, `valuation_shortfall` at spec.ts:313,325,330; the real kinds are
`completion_funds_shortfall`, `deposit_issue`, `valuation_issue`) and still lists cash ↔ mortgage
as a gap (spec.ts:310) although `set_funding` is built.
