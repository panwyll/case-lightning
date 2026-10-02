# Eventualities: tax and the client's holdings

What a competent conveyancer in England & Wales plans for on **SDLT** (and Welsh **LTT**) for buyers, and on **CGT** for sellers. Each row says what we see (the signal), what the engine should do, what it does today, and priority (P1 = a wrong tax figure, a missed deadline or a client exposed to a penalty; P2 = a common case handled by hand today; P3 = rare or flag-only).

**Where the engine is today.** `sdlt.ts` (`computeSdlt`) works out an estimate from a **per-transaction** basis of five values (`firstTimeBuyer`, `additionalProperty`, `nonUkResident`, `mixedUse`, `linkedConsiderationPennies`) plus `company` from the `company_buyer` shape. That basis is declared once at enrolment (`machine.ts:896–897`, zod at `http.ts:44`, UI at `app/shared/engine/WorkPanel.tsx:609`) and shown on the completion statement (`completion-statement.ts:80–85`), the open-case summary (`open-case.ts:76`) and the 14-day deadline (`sla.ts:180–185`, `due.ts:144–145`). The return is a person's job: `sdlt_submitted` / `sdlt_not_required` (`machine.ts:1348`, `:2284`), and the AP1 is blocked until one of them is done (`machine.ts:1362`). There is **no** questionnaire, no facts per buyer, no way to change the basis after enrolment, no Wales/LTT, no lease NPV, no transfer-of-equity consideration on the case, no refund tracking and nothing about CGT for sellers.

**Bugs found while doing this** (all six since fixed: the 19% rate, company relief, the £40,000 floor, mixed use and linked transactions raised at enrolment, no return refused for a relief, and the refund wording):
1. `sdlt.ts:73–77`: a company buying above £500k pays 17% even when it is non-UK resident. The rate should be **19%** (17% + 2%).
2. `sdlt.ts:73`: the 17% rate is always charged. A company that claims a relief (property rental, development or trading) pays the higher rates instead, and there is nothing to record that claim.
3. `sdlt.ts:71`: the higher-rates surcharge is applied whatever the price. A purchase under £40,000 is never a higher-rates transaction, and if the chargeable consideration is under £40,000 no return is needed.
4. `machine.ts:897`: the `sdlt_basis` issue is raised only for FTB, additional property and non-resident. Mixed use and linked transactions, the two claims HMRC challenges most, raise nothing. `machine.ts:129` (the TypeScript command type) also leaves out `mixedUse` and `linkedConsiderationPennies`, though the zod schema accepts them.
5. `sdlt_not_required` (`machine.ts:2284`) accepts any reason. A first-time buyer paying £0 at £300k still has to file a return (the relief is claimed on it). The engine should refuse "not required" when the chargeable consideration is £40,000 or more.
6. The 2% non-resident refund note in `sdlt.ts:97` says "within the two years around completion". The test is **183 days in a continuous 365-day period** running from 364 days before to 365 days after the effective date. The refund applies only when that test is met in the 365 days *after*.

Sources used throughout. Each is given a short code in the tables:
- [GOV-HR] GOV.UK, *Higher rates of SDLT* — https://www.gov.uk/guidance/stamp-duty-land-tax-buying-an-additional-residential-property
- [SDLTM-HR] HMRC SDLT Manual, higher rates contents SDLTM09730 and its sub-pages (Condition C SDLTM09795, Condition D SDLTM09800, spouses SDLTM09820, non-individuals SDLTM09835, individuals SDLTM09765) — https://www.gov.uk/hmrc-internal-manuals/stamp-duty-land-tax-manual/sdltm09730
- [GOV-RES] GOV.UK, *SDLT residential property rates* — https://www.gov.uk/stamp-duty-land-tax/residential-property-rates
- [SDLTM-FTB] SDLTM29805 (FTB relief) and SDLTM29885 (shared ownership) — https://www.gov.uk/hmrc-internal-manuals/stamp-duty-land-tax-manual/sdltm29805
- [GOV-REL] GOV.UK, *SDLT relief for land or property transactions* — https://www.gov.uk/guidance/stamp-duty-land-tax-relief-for-land-or-property-transactions
- [NRS] Non-resident surcharge, FA 2003 Sch 9A. Summaries: Deloitte https://taxscape.deloitte.com/insights/article/stamp-duty-land-tax--non-uk-resident-surcharge.aspx, Penningtons https://www.penningtonslaw.com/insights/the-new-sdlt-surcharge-for-non-uk-resident-buyers/
- [WRA] Welsh Government, *LTT rates and bands* — https://www.gov.wales/land-transaction-tax-rates-and-bands. The 11 Dec 2024 increase in the higher rates: https://www.icaew.com/insights/tax-news/2024/dec-2024/residential-land-tax-hike-in-wales
- [CGT-UK] GOV.UK, *Report and pay CGT on UK property* — https://www.gov.uk/report-and-pay-your-capital-gains-tax/if-you-sold-a-property-in-the-uk-on-or-after-6-april-2020
- [CGT-NR] GOV.UK, *CGT for non-residents* — https://www.gov.uk/guidance/capital-gains-tax-for-non-residents-uk-residential-property, and HS307
- [PRR] HS283 Private Residence Relief — https://www.gov.uk/government/publications/private-residence-relief-hs283-self-assessment-helpsheet
- [FA03] Finance Act 2003: s.55 (rates), s.55(4) and s.108 (linked transactions), s.76–77A (returns, notifiable transactions), s.116 (residential property; 6+ dwellings), Sch 3 (exemptions), Sch 4 (chargeable consideration, debt), Sch 4ZA (higher rates), Sch 5 (leases, NPV), Sch 6ZA (FTB), Sch 9 (shared ownership), Sch 9A (non-resident), Sch 10 (returns, amendments within 12 months, penalties)

These are facts and figures, not advice. In each row the engine's job is to **capture**, **compute an estimate**, **flag** and **diarise**. The conveyancer confirms the basis, and the client signs the return's declaration.

---

## A. Higher rates for additional dwellings (5% surcharge from 31 Oct 2024)

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| A1 | The buyer owns another dwelling worth £40k+ at the end of the completion day | Questionnaire: "do you own any interest in any residential property anywhere?" | Higher rates on every band (+5pp). Capture each holding (address, country, share, value ≥£40k, how held). The basis is *derived*, not ticked. | **BUILT** — asked as a fact (another home worth £40k+ at the end of completion day) and the basis derived (sdlt-facts.ts `deriveSdltBasis`); holdings are not itemised | P1 | GOV-HR, Sch 4ZA |
| A2 | Joint buyers, and only one owns another home | Per-buyer answers differ | If **any** buyer meets the conditions, the **whole** transaction pays the higher rates. Derive the result at transaction level from the per-buyer facts, and tell the client why. | **BUILT** — asked as "any buyer", which is the rule (sdlt-facts.ts `deriveSdltBasis`) | P1 | GOV-HR |
| A3 | The buyer's spouse or civil partner owns a dwelling, but is not buying | Questionnaire: married/CP? living together? spouse's holdings? | The spouse's holdings count as the buyer's (unless permanently separated). Higher rates apply, and FTB relief is lost as a result. | **BUILT** — the question includes a buyer's spouse (sdlt-facts.ts `deriveSdltBasis`); separation (A4) is for the person answering | P1 | SDLTM09820 |
| A4 | Spouses separated (court order, deed, or separation likely to be permanent) | Questionnaire: separated? date? | The spouse rule is switched off. Record the evidence of separation. | **BUILT** — `spouseSeparated` switches the spouse rule off, with the reason recorded | P2 | SDLTM09820 |
| A5 | The buyer owns only a **share** of another dwelling (e.g. with a parent) | Holding share < 100% | Any share of a major interest worth £40k+ counts. The value tested is the share. | **BUILT** — `holdingCounts`: a share counts at the value of the share (£40,000 or more) | P1 | SDLTM-HR |
| A6 | Inherited share within 3 years | Holding source = inheritance, date, % | Ignore it if it came by inheritance in the 3 years before the effective date **and** the buyer's and spouse's combined share has been ≤50% throughout. Otherwise it counts. Diarise the 3-year date, because the exemption can lapse mid-case on a long transaction. | **BUILT** — `holdingCounts`: an inherited share of 50% or less within three years is ignored, with the date it lapses | P1 | SDLTM-HR (inherited interests) |
| A7 | Dwelling abroad | Holding country ≠ UK | It counts the same as a UK dwelling (worth £40k+ in sterling at the effective date). | **BUILT** — `holdingCounts`: a dwelling abroad counts like one in the UK | P1 | GOV-HR |
| A8 | Minor child's property (bare trust / held by parent) | Questionnaire: "does any child under 18 own property, or hold it on trust for you?" | A dwelling held for a child under 18 is treated as the parent's (and the parent's spouse's). | **BUILT** — `holdingCounts`: a dwelling held for a child counts as the parent's | P2 | GOV-HR |
| A9 | The buyer owns only commercial / non-residential property | Holding type = non-residential | Does not count: no surcharge. Record the type so the decision has a reason. | **BUILT** — `holdingCounts`: commercial property does not count, with the reason | P1 | SDLTM-HR |
| A10 | Caravan, mobile home, houseboat | Holding type | Not counted unless it has become a fixed dwelling. | **BUILT** — `holdingCounts`: a caravan, mobile home or houseboat does not count | P3 | GOV-HR |
| A11 | Other dwelling (or interest in it) worth under £40k | Holding value | Ignored. | **BUILT** — `holdingCounts`: a holding worth under £40,000 is ignored | P2 | GOV-HR |
| A12 | The purchase itself is under £40k | Price < £4,000,000p | Never a higher-rates transaction. No return needed if the chargeable consideration is under £40k (freehold). | **BUILT** — under £40,000: no surcharge (`SURCHARGE_FLOOR`) and `noReturnReason` proposes no return | P2 | GOV-HR, FA03 s.77A |
| A13 | Leasehold holding with ≤21 years unexpired | Holding = lease, years left | Not a major interest for the higher rates: ignore it. | **BUILT** — `holdingCounts`: a lease with 21 years or less left is ignored | P3 | Sch 4ZA |
| A14 | **Replacing a main residence**, with the old one already sold (within 3 years before) | Questionnaire: "have you sold, in the last 3 years, a home that was your only or main residence?" (date, address) | Exception: no surcharge, provided the new property is to be the only or main residence. Capture the sale date and check it is ≤3 years before the effective date. | **BUILT** — selling the main residence and that sale completing first means no higher rates (sdlt-facts.ts `deriveSdltBasis`) | P1 | SDLTM09800 (Condition D) |
| A15 | **Replacing a main residence, sold on the same day** (the firm acts on both: client chain) | Linked sale matter (`service.ts:1158 linkChain`) whose property is the main residence | The exception applies if the sale completes no later than the purchase (same day is fine). The engine should derive `additionalProperty=false` from the chain, and warn that if the sale slips after the purchase, the surcharge is due and the client needs the money for it. | **BUILT** — a linked sale of the client's own home counts as completing first (sdlt-facts.ts `deriveSdltBasis`) | P1 | SDLTM09800 |
| A16 | Buying before selling (bridging / delayed sale) | Old main residence still owned at completion | Higher rates are paid now. **Diarise**: when the old home is sold within 3 years of the effective date → refund task. The claim must be made within 12 months of the later of the sale and the filing date (amend the return if still inside its 12-month window). Put the refund figure in the client's report. | **BUILT** — higher rates, and a three-year refund reminder after completion (sla.ts `sdlt_refund`) (sdlt-facts.ts `deriveSdltBasis`) | P1 | GOV-HR |
| A17 | The sale in the chain collapses after the purchase exchanged | Linked sale withdrawn/unlinked after the purchase exchanged | Recompute at the higher rates. A `completion_funds_shortfall` issue for the extra 5%, and a message telling the client of the refund route. | **BUILT** — a linked sale falling through after the purchase relied on the replacement exception raises the extra higher-rates tax on the purchase, with the refund route | P1 | GOV-HR |
| A18 | A buyer who is a **joint purchaser with someone who already owns a home** (e.g. FTB with a partner who owns a flat) | Per-buyer answers | The whole transaction pays the higher rates, and FTB relief is lost for both. Say so plainly at quote stage. | **BUILT** — any buyer owning another home makes the whole purchase higher rates and every buyer loses first-time buyers' relief (the reasons say so) | P1 | GOV-HR, SDLTM-FTB |
| A19 | Buying two or more dwellings in one transaction (house + separate cottage) | Property has more than one dwelling | Higher rates, even with no other holdings. Since MDR was abolished (1 Jun 2024) there is no MDR, but 6 or more dwellings may be taxed at the **non-residential** rates. | **BUILT** — `dwellingsInPurchase` > 1: higher rates; six or more: the non-residential option noted | P2 | Sch 4ZA, FA03 s.116(7) |
| A20 | Annexe / granny flat with the main house | Survey/pack: self-contained annexe | No surcharge if the annexe is within the grounds and worth less than one third of the whole (a 2018 change). Otherwise as A19. | **BUILT** — `annexeUnderThird`: no higher rates on that account | P2 | SDLTM-HR |
| A21 | Buy-to-let, holiday let or second home | Shape `buy_to_let` | Higher rates, unless there are no other dwellings at all. Cross-check: BTL + FTB claimed is a contradiction (FTB needs the buyer to occupy). | **BUILT** — buy-to-let cross-checks: a main residence or first-time buyers' relief contradicts the shape | P1 | SDLTM-FTB |
| A22 | Partnership or trust interest in a dwelling | Questionnaire | Interests held through a partnership, and a life interest or bare-trust interest, count as the individual's. | **BUILT** — `holdingCounts`: partnership, life-interest and bare-trust interests count as the buyer's | P3 | SDLTM-HR |
| A23 | **Facts change mid-case** (the buyer inherits, buys elsewhere, marries, separates, or sells the old home earlier or later) | Any answer edited; marriage/separation; chain changes | Re-derive the basis. Raise a `sdlt_basis_changed` issue with the old and new estimate, update the completion statement, re-confirm with the client. The test is at the **end of the effective date**. | **BUILT** — the answers can be recorded again until the return is filed; a changed estimate raises `sdlt_basis` with both figures (sdlt-facts.ts `deriveSdltBasis`) | P1 | Sch 4ZA |

## B. First-time buyer relief (0% to £300k, 5% to £500k from 1 Apr 2025)

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| B1 | All buyers are FTBs and the price is ≤ £500k | Every buyer: never owned a major interest in a dwelling **anywhere** | Relief applies. | **BUILT** — every buyer never owned and a main residence gives the relief (sdlt-facts.ts `deriveSdltBasis`) | — | SDLTM-FTB, GOV-RES |
| B2 | Price over £500k | Price | No relief at all: standard rates on the whole price (a cliff). | BUILT `sdlt.ts:81` | — | GOV-RES |
| B3 | One of the joint buyers has owned before (even abroad, even inherited, even a share) | Per-buyer answer | No relief for anyone. | **BUILT** — any buyer having owned before removes it (sdlt-facts.ts `deriveSdltBasis`) | P1 | SDLTM-FTB |
| B4 | The buyer does not intend to live there as their only or main residence | Questionnaire + shape `buy_to_let` / `company_buyer` | No relief. Treat a BTL/company + FTB claim as a contradiction. | **BUILT** — not a main residence: no relief; a buy-to-let answered as a main residence is a contradiction issue (sdlt-facts.ts `deriveSdltBasis`) | P1 | SDLTM-FTB |
| B5 | A non-buying spouse owns a home | A3 | Higher rates apply, so FTB relief is lost. | **BUILT** — `spouseOwns`: the spouse's home counts and first-time buyers' relief is lost | P1 | SDLTM-FTB, SDLTM09820 |
| B6 | Shared ownership, market value election | Shape `shared_ownership` + election | Relief if the market value is ≤£500k. Election is made in the return and cannot be undone. Tax is on the market value; rent is ignored. | **BUILT** — shared ownership market value election on the SDLT sheet; the estimate uses the full value | P2 | SDLTM29885, Sch 9 |
| B7 | Shared ownership, paying in stages (no election) | Shape + no election | Relief on the first share if the market value in the lease is ≤£500k. NPV of rent has its own relief. Later staircasing under 80% pays nothing; staircasing that takes the share above 80% is taxed. | **BUILT** — shared ownership in stages: relief tested on the market value in the lease, tax on the share | P2 | SDLTM29885 |
| B8 | LISA / Help to Buy ISA used | Shapes `lifetime_isa` / `help_to_buy_isa` | These require FTB status too. If FTB relief isn't claimed, raise a contradiction issue (and the reverse). | **BUILT** — a LISA or Help to Buy ISA where a buyer has owned before is a contradiction issue (sdlt-facts.ts `deriveSdltBasis`) | P2 | SDLTM-FTB |
| B9 | Price near the £500k cliff, with chattels apportioned | Chattels in TA10 / contract | Apportionment must be just and reasonable. Flag any apportionment that brings the price under £500k or £300k for the person to justify. | **BUILT** — a chattels price that takes the land under an SDLT threshold is raised from the contract read | P2 | Sch 4 para 4 |
| B10 | Relief claimed but tax is £0 | FTB at ≤ £300k | **A return is still needed** (the relief is claimed on it). `sdlt_not_required` must be refused. | **BUILT** — `sdlt_not_required` refused for £40,000 or more (a relief is claimed on a return) | P1 | FA03 s.76–77A |

## C. Non-UK resident surcharge (2% from 1 Apr 2021)

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| C1 | An individual buyer is in the UK on fewer than 183 days in any continuous 365 days from 364 days before the effective date | Questionnaire: days in UK in the last 12 months; expected days in the next 12 | +2pp on every band, alongside FTB relief or the higher rates (up to +7pp). | **BUILT** — fewer than 183 days in the UK in the last year: the 2% surcharge (sdlt-facts.ts `deriveSdltBasis`) | P1 | NRS |
| C2 | Joint buyers, one non-resident | Per-buyer | The whole transaction pays the surcharge, **unless** the non-resident is the spouse or civil partner of a UK-resident joint buyer (then both are treated as resident). | **BUILT** — asked as "any buyer" (sdlt-facts.ts `deriveSdltBasis`); the spouse exception is for the person answering | P1 | NRS (Sch 9A) |
| C3 | Became resident after completion | 183 days in the 365 days after the effective date | Refund of the 2% by amending the return / claim within 2 years of the effective date. Diarise a check at +12 months and send the client a message. | **BUILT** — a two-year refund reminder after completion when the non-resident surcharge was paid (sla.ts `nrs_refund`) | P2 | NRS |
| C4 | Non-resident company (or a UK close company controlled by non-residents) | Company + residence of the company/controllers | +2pp. At over £500k the flat rate is **19%**. | **BUILT** — a non-UK company above £500,000: 19% | P1 | NRS |
| C5 | Crown employee / serving armed forces abroad | Questionnaire | Treated as UK resident. | **BUILT** — `crownEmployee`: treated as UK resident | P3 | NRS |
| C6 | Residence changes between exchange and completion | Re-confirmation at pre-completion | Re-ask before the completion statement is sent. | **BUILT** — the statement asks for residence and other homes to be confirmed again before it goes | P2 | NRS |

## D. Companies, trusts and other non-individuals

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| D1 | Company buys a dwelling for ≤ £500k | Shape `company_buyer` | Higher rates from the first pound, even if it is the company's first dwelling. | BUILT `sdlt.ts:71` | — | SDLTM09835 |
| D2 | Company buys for > £500k with no relief | Shape | 17% flat (19% if non-resident). | **BUILT** — a company above £500,000 with no relief: 17% (19% non-resident) | P1 | GOV-RES |
| D3 | Company claims a relief from 17% (property rental business, development, trading, employee occupation) | Questionnaire: the company's business | The higher rates instead of 17%. Record the relief claimed and diarise a **3-year clawback** check (if the use changes, the 17% becomes due). Flag ATED (the annual charge on enveloped dwellings) for the client's accountant. | **BUILT** — `companyRelief`: the higher rates instead of 17%, the three-year clawback and ATED in the reasons | P1 | GOV-REL, FA03 Sch 4A |
| D4 | Trustees of a non-bare trust buying | `executors` / trustees captured at enrolment (`machine.ts:886`) | Trustees of a discretionary trust are treated like a company for the higher rates. For a bare trust or life interest, the beneficiary is treated as the buyer. | **BUILT** — `buyerType`: a discretionary trust as a company; a bare trust or life interest by the beneficiary | P2 | SDLTM09835 |
| D5 | Personal representatives buying, or a purchase by an estate | Executors at enrolment | Higher rates generally apply (non-individual). An appropriation to a beneficiary without consideration is exempt. | **BUILT** — `buyerType` personal representatives: higher rates; an appropriation without consideration exempt | P3 | Sch 3 para 3A |
| D6 | Partnership buyer | Questionnaire | Special regime (FA 03 Sch 15): refer to a person. | **BUILT** — `buyerType` partnership: flagged for a person (FA 2003 Sch 15) | P3 | FA03 Sch 15 |
| D7 | Charity buyer | Questionnaire | Charities relief (claimed on the return; clawback if the charitable use stops). | **BUILT** — `buyerType` charity: charities relief and its clawback in the reasons | P3 | GOV-REL |

## E. Mixed use, non-residential, linked transactions, consideration

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| E1 | Mixed use (shop + flat, house + working farmland) | Flag at enrolment | Non-residential rates on the whole price, with no surcharges or reliefs. Evidence that the non-residential part is genuine (HMRC challenges paddocks and woodland, e.g. *How Development 1*, *Suterwalla*). | **BUILT** — asked as a fact; the mixed-use rates (sdlt-facts.ts `deriveSdltBasis`) | P1 | GOV-RES, FA03 s.116 |
| E2 | Linked transactions (house and a separate plot bought from the same seller) | Linked consideration | Rate set on the total; this purchase pays its share. | BUILT `sdlt.ts:49–56`; no issue raised (bug 4) | P2 | FA03 s.55(4), s.108 |
| E3 | Multiple dwellings relief | — | Abolished for transactions effective on or after 1 Jun 2024. Never offer it. | BUILT (not offered; header note `sdlt.ts:7`) | — | GOV-REL |
| E4 | VAT on the price (opted commercial / new commercial part) | Contract VAT clause | SDLT is charged on the VAT-inclusive price. | **BUILT** — `vatPennies` added to the chargeable consideration | P3 | Sch 4 para 2 |
| E5 | Non-cash consideration: part exchange with a developer, works, release of debt | Shape `new_build` + part exchange; contract | The chargeable consideration includes the part-exchange value. The developer's acquisition of the buyer's old home has its own relief. | **BUILT** — `partExchangePennies` added to the chargeable consideration | P2 | Sch 4, GOV-REL |
| E6 | Developer incentives (SDLT "paid by developer", cashback) | New-build pack | Still chargeable on the full contract price. Cashback may reduce the consideration. Make sure the funds and SDLT lines agree. | **BUILT** — the incentive event says SDLT stays on the full contract price (a seller's cashback may reduce it) | P2 | Sch 4 |
| E7 | Right to Buy | Shape `right_to_buy` | Tax on the discounted price actually paid. The higher rates follow the usual tests. | **BUILT** — Right to Buy: tax on the discounted price paid (in the reasons) | P3 | Sch 9 |
| E8 | Price renegotiated before exchange | `price_changed` (`machine.ts:1843`) | Recompute (automatic on the statement). Re-tell the client the SDLT if the band or the FTB cliff changes. | **BUILT** — a price change that moves the SDLT estimate raises the new figure for the client | P2 | — |
| E9 | "Uninhabitable" claim (property not suitable as a dwelling → non-residential rates) | Survey: derelict | Flag for a person. Narrow case law (*Bewley* allowed it; *PN*, *Mudan* refused). Never default to it. | **BUILT** — `uninhabitableClaim`: flagged for a person, the estimate stays residential | P3 | FA03 s.116 |
| E10 | Effective date earlier than completion (substantial performance: early occupation, most of the price paid) | Keys released before completion / rent-to-buy / new-build early access | The effective date (and the 14-day clock) runs from substantial performance. A second return may be needed at completion. | **BUILT** — early access raises substantial performance: the 14 days run from it, a second return may be needed | P2 | FA03 s.44 |
| E11 | Rates change (Budget) between exchange and completion | Rate table dated | Rates follow the **effective date**. Contracts exchanged before an announcement may have transitional rules. The rate tables need to be dated. | **BUILT** — the rates are dated (`RATES_FROM`); an effective date before them is flagged | P2 | — |

## F. Leases, transfers of equity, gifts, divorce

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| F1 | Grant of a new lease (new-build flat, shared ownership, lease of a house) | Leasehold purchase with a **grant** rather than an assignment | SDLT on the premium (residential rates, surcharges apply to the premium only) **plus** 1% on the NPV of the rent above £125k. A return is needed if the term is 7+ years and the premium is ≥£40k or rent ≥£1,000 p.a. | **BUILT** — `newLeaseRentPennies` / `newLeaseTermYears`: 1% on the rent's NPV above £125,000 (`leaseRentTax`) | P2 | FA03 Sch 5, s.77A |
| F2 | Assignment of an existing lease | Leasehold purchase | Tax on the price, as for a freehold. | BUILT (same calculation) | — | — |
| F3 | Statutory lease extension (1993 Act) | Lease variation / new lease | SDLT on the premium. Not a higher-rates transaction where it extends the buyer's own dwelling. | **BUILT** — `statutoryExtension`: SDLT on the premium, not higher rates | P3 | Sch 4ZA |
| F4 | Transfer of equity for money | `transfer_of_equity`, `considerationPennies` (`machine.ts:913`) | Chargeable consideration = cash **plus** the share of mortgage debt taken over. The calculation exists in `co-ownership.ts:170 buyOut` (`sdltConsiderationPennies`) but is not on the case. Estimate on the completion statement. | **BUILT** — the cash and the mortgage debt taken on are the chargeable consideration (`chargeableConsideration`), including for "no return due" | P1 | SDLTM04040, Sch 4 para 8 |
| F5 | Transfer of equity, a gift with no mortgage taken over | TOE with consideration 0 and no debt | Exempt (no chargeable consideration). No return. `sdlt_not_required` with that reason. | **BUILT** — a transfer of equity gift: `noReturnReason` proposes no return with its reason | P2 | Sch 3 para 1 |
| F6 | Transfer on divorce / dissolution / separation | Shape `court_order_transfer` | Exempt (Sch 3 para 3) whatever debt is assumed. | BUILT (shape + issue, `shapes.ts:79`) | — | Sch 3 para 3 |
| F7 | Transfer of equity: the incoming owner owns another dwelling | TOE + holdings | Higher rates may apply to the consideration. Exceptions exist for spouses/CPs buying from each other and for adding to an interest in one's own main residence (check SDLTM-HR). | **BUILT** — `betweenSpouses`: no higher rates on that account; otherwise the incoming owner's holdings decide | P2 | SDLTM-HR |
| F8 | Gift of property to a child (seller side) or a gift with a mortgage | TOE/sale at undervalue | SDLT on the debt assumed. CGT on the donor at market value (see G). | **BUILT** — debt assumed counted; a gift or sale below value flags CGT at market value | P2 | Sch 4 para 8 |
| F9 | Remortgage | `remortgage` | No SDLT (no land transaction). | BUILT (`machine.ts:637` excludes remo) | — | — |

## G. Seller side: CGT (flag, never advise)

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| G1 | UK-resident seller selling a property that was **not their main residence throughout** (BTL, second home, inherited, let for a period) | Sale questionnaire: "has it been your only or main home for the whole time you've owned it?" | An **info issue** (no gate) and a line in the client care letter / completion letter: a CGT return and payment are due **within 60 days of completion** if tax is due. Recommend an accountant. Put the 60-day date on the completion report. | **BUILT** — the sale's CGT answers raise a `cgt_flag` to tell the client about the 60-day report; never advice (sdlt-facts.ts `cgtFlags`) | P1 | CGT-UK |
| G2 | Non-UK-resident seller | Sale questionnaire: residence | Must report to HMRC within 60 days **even if no tax or a loss**. Flag at instruction, and again on completion with the date. | **BUILT** — a non-resident seller raises the flag: the 60-day report is needed even with no tax (sdlt-facts.ts) | P1 | CGT-NR, HS307 |
| G3 | Private residence relief only partly available (absences, let, business use, grounds over 0.5 ha, more than one residence) | Questionnaire answers; title plan area | Flag only. Note the last 9 months are always exempt and lettings relief is now limited to shared occupation. | **BUILT** — CGT flags for partial private residence relief (absences or letting, business use, grounds, another residence) | P2 | PRR |
| G4 | Sale of part of the garden or a plot, or land sold after the house | Sale of part | PRR may not apply (especially after the house is sold). Flag. | **BUILT** — CGT flag for part of the garden or a plot | P3 | PRR |
| G5 | Seller is a company | Shape/party | Corporation tax, not CGT. Flag for the company's accountant only. | **BUILT** — CGT flag: a company seller pays corporation tax | P3 | CGT-NR |
| G6 | Seller is personal representatives / trustees | Executors at enrolment | The estate's or trust's CGT (60-day return if due). Flag. | **BUILT** — CGT flag: personal representatives or trustees, their own 60-day return | P2 | CGT-UK |
| G7 | Seller asks the firm to hold back money for the tax | Client instruction | A retention in the client account against the 60-day payment, shown on the sale completion statement. No duty to withhold (the UK has no withholding regime). | **BUILT** — money held for the client's CGT: a line on the sale statement, owed back (to HMRC on instruction) until paid | P3 | — |

## H. Filing, payment, amendment, refund and jurisdiction

| # | Eventuality | Signal | Correct response | Engine today | P | Source |
|---|---|---|---|---|---|---|
| H1 | Return and payment within 14 days of the effective date | Completion | Deadline task and timer. | BUILT `due.ts:144`, `sla.ts:180` (lead `sla.ts:149`) | — | FA03 s.76 |
| H2 | SDLT5 needed with the AP1 | Registration | AP1 blocked until filed or not required. | BUILT `machine.ts:1362` | — | — |
| H3 | Filed but not paid (or paid a different amount) | Payment record | Record the UTRN, the amount filed and the payment date separately from filing. Compare the amount with the estimate and the money held. | **BUILT** — `sdlt_submitted` records the amount and payment date; a difference from the estimate is raised | P2 | Sch 10 |
| H4 | Return amended within 12 months of the filing date (error, refund of higher rates, non-resident refund) | Refund trigger (A16, C3) or an error found | An `sdlt_amended` event with old and new figures and the reason. A refund comes back to the client via the client account. | **BUILT** — `sdlt_amended` within 12 months: old and new figures, a refund owed back to the client | P2 | Sch 10 para 6 |
| H5 | Overpayment found after 12 months | — | An overpayment relief claim within 4 years. | **BUILT** — `sdlt_amended` after 12 months is an overpayment relief claim, refused after four years | P3 | Sch 10 para 34 |
| H6 | Late filing / payment | Past the 14 days | £100 automatic penalty (£200 after 3 months), a tax-geared penalty after 12 months, plus interest. Escalate a critical issue the day after the deadline. | **BUILT** — `sdlt_overdue` timer the day after the filing date | P2 | Sch 10 |
| H7 | **Property in Wales** | Postcode / title / local authority | **LTT**, not SDLT. Main rates 0% to £225k, 6%, 7.5%, 10%, 12%. Higher rates 5% to £180k, 8.5%, 10%, 12.5%, 15%, 17% (from 11 Dec 2024). **No FTB relief, no non-resident surcharge, no 17% company rate.** Return to the WRA within **30 days**. Replacement-of-main-residence rules similar (3 years). | **BUILT** — answered as a fact: LTT main and higher rates, no FTB relief or non-resident surcharge, a 30-day return to the WRA (sdlt.ts `computeLtt`, sla.ts, due.ts) | P1 | WRA |
| H8 | Property straddles the England–Wales border | Title in both | Split the consideration on a just and reasonable basis: SDLT on the English part, LTT on the Welsh part. | **BUILT** — `welshPercent`: a cross-border split flagged for a person (SDLT on the English part, LTT on the Welsh) | P3 | WRA |
| H9 | Scottish or Northern Irish property | Postcode | Out of scope (LBTT / NI conveyancing): refuse at enrolment. | **BUILT** — Scottish and Northern Irish postcodes are refused when a case is created (`outOfJurisdiction`) | P3 | — |
| H10 | No return due (chargeable consideration under £40k, gift, divorce) | Derived | The engine **proposes** `sdlt_not_required` with the reason it derived, and refuses it when consideration is £40k or more. | **BUILT** — `noReturnReason` proposes 'No Return Due' with its reason; refused for £40,000 or more | P2 | FA03 s.77A |

---

## Top 10 to build first

1. **SDLT questionnaire per buyer (with derived basis).** Replace the three ticks with facts keyed by party (the `partyId` scheme used for ID checks). Add a pure `deriveSdltBasis(facts, transaction, chain)` in `sdlt.ts` that returns the basis *and the reasons* (one line per rule, citing the facts). `computeSdlt` keeps its signature. The client answers on the portal at Instruction (`sdlt_questionnaire` wait, chased like the other first requests). Until the questionnaire is answered, the estimate says "no basis declared" (as today). *Fixes A1–A3, A5–A9, A11, B3, B5, C1–C2.*
2. **Wales/LTT.** Add `jurisdiction: 'england' | 'wales'` on the matter, from the postcode at enrolment (Welsh local authority list) and confirmed by the title. Add an `ltt.ts` with the same `Estimate` shape, a 30-day deadline in `sla.ts` and `due.ts`, and "WRA return" wording on the tile. LTT has no FTB relief and no non-resident surcharge: if those boxes are ticked, raise an issue saying they don't apply in Wales. *H7.*
3. **Basis change mid-case.** Add a `record_sdlt_facts` command (any time before the return), with a projection event that re-derives the basis. If the estimate moves, raise `sdlt_basis_changed` (old and new figures, reason), refresh the completion statement, and send the client a message. Re-confirm automatically at two points: when exchange is proposed, and when the completion statement is generated ("Are these answers still true at completion?"). *A23, C6.*
4. **Client chain → replacement of main residence.** With `linkChain` and the sale's property marked as the main residence, the basis is "replacement" so long as the sale completes on or before the purchase. If the chain is unlinked, or the sale's completion date is after the purchase, recompute at the higher rates and raise `completion_funds_shortfall`. *A15, A17.*
5. **Refund diary.** On completion at the higher rates where the buyer still owns their old main residence, raise a long-lived wait `old_home_sale`, checked monthly to 3 years. When that sale happens (in-firm chain or the client reports it), a task: "Claim the higher-rates refund of £X" (amend if within 12 months of the filing date, else a claim within 12 months of the sale). The same for the non-resident refund at +12 months. *A16, C3, H4.*
6. **Fix the engine bugs.** 19% for non-resident companies. A `companyRelief` field that switches 17% to the higher rates and diarises the 3-year clawback. No surcharge under £40k. Raise the `sdlt_basis` issue for mixed use and linked transactions. Correct the non-resident note. Align the `machine.ts:129` type. *Bugs 1–6, D2–D3, E1–E2, A12.*
7. **Return-or-not derived.** `sdlt_not_required` is refused when chargeable consideration is £40k or more (lease: 7+ years with premium ≥£40k or rent ≥£1k). The engine proposes it with its own reason (gift, divorce exemption, <£40k). `sdlt_submitted` captures the UTRN, the amount filed and the amount paid. *B10, H3, H10.*
8. **Transfer of equity consideration.** Put `co-ownership.ts buyOut` on the case: cash + debt assumed → estimate on the TOE completion statement and the deadline. Exemptions for divorce (shape) and gifts. A higher-rates check for an incoming owner who owns another dwelling. *F4, F5, F7.*
9. **Shape cross-checks.** BTL/company + FTB → contradiction issue. LISA/HTB ISA without FTB → contradiction. Shared ownership → ask about the market value election and compute the staged or MVE figure. New build with part exchange → consideration includes the PX value. *A21, B4, B6–B8, E5.*
10. **Seller CGT flag.** Two questions on the sale questionnaire (main residence throughout? UK resident?) → a non-blocking `cgt_flag` info issue, a line in the client care letter, and the 60-day date on the completion letter ("report and pay by DD/MM/YYYY; speak to your accountant"). Never a figure, never advice. *G1, G2, G6.*

Design rules for all of them: the estimate stays **an estimate** with its reasons listed. Every derived "no" carries the fact that produced it. A person confirms the basis before the return (the `sdlt_basis` issue stays). Every change to the basis is an event, so the file shows when and why the tax changed. Every new wait or task must satisfy `no-stall.test.ts`, so the questionnaire wait needs a simulator answer.

---

## Proposed SDLT questionnaire

Asked at **Instruction** (portal form, alongside ID and proof of funds). Re-confirmed **before exchange** (when the money is planned) and **when the completion statement is sent** (the tests are at the end of the completion day). Any answer can be edited until the return is filed, and an edit re-derives the basis (Top 10 #3).

### Per transaction

| Question | Why | Drives |
|---|---|---|
| Where is the property: England or Wales? (pre-filled from the postcode, confirmed) | SDLT vs LTT | H7–H9 |
| Is it a house/flat only, or does it include a separate dwelling, annexe, commercial part or land used for a business? | Mixed use, multiple dwellings, annexe | E1, A19, A20 |
| Is the seller selling you anything else, now or around the same time (another plot, a garage, a second property)? | Linked transactions | E2 |
| Are you buying through a company, trust, partnership or as personal representatives? | Non-individual rules | D1–D7 |
| (Company) What will the company do with it: let it to unconnected tenants, develop it, use it in a trade, or other? Is the company UK resident and who controls it? | 17% vs relief, 19%, clawback | D2–D3, C4 |
| Is part of the price for furniture/fittings? How much? | Chattels apportionment | B9 |
| Is the developer taking your current home in part exchange, or paying any incentive? | Consideration | E5–E6 |
| (Shared ownership) Do you want to pay SDLT on the full market value now (market value election)? | MVE vs staged | B6–B7 |
| (New lease) Premium, rent and term | NPV and notification | F1 |
| Will you get the keys or move in before completion? | Substantial performance | E10 |
| Will you live there as your only or main home? | FTB, replacement exception | B4, A14 |

### Per buyer (each person named on the purchase)

| Question | Why | Drives |
|---|---|---|
| Have you ever owned, or part-owned, a home anywhere in the world (including inherited, abroad, or through a trust)? | FTB relief | B1, B3 |
| At the end of the completion day, will you own any share of any residential property anywhere, worth £40,000 or more? For each: address, country, your share, value, how you got it (bought / inherited, with date), freehold or lease (years left), residential or commercial, caravan/houseboat | The higher rates and their exceptions | A1, A5–A7, A9–A11, A13 |
| Are you married or in a civil partnership? Do you live together, or are you separated (date, court order or deed)? | Spouse rule | A3–A4, C2 |
| Does your spouse or civil partner own any residential property (the same details)? | Spouse rule | A3, B5 |
| Do you have children under 18 who own property, or for whom you hold property? | Minors rule | A8 |
| Are you selling a home that has been your only or main residence? Address, and has it sold (date) or when will it complete? Are we acting on it? | Replacement exception, refund diary, chain link | A14–A17 |
| In the last 12 months, how many days have you spent in the UK? Do you expect to be in the UK for 183 days or more in the 12 months after completion? Are you a Crown servant or in the armed forces abroad? | Non-resident surcharge and refund | C1–C3, C5 |

### Sale side (per seller, flag only)

| Question | Why | Drives |
|---|---|---|
| Has this property been your only or main home for the whole time you've owned it? (If not: let, second home, inherited, business use, absences) | CGT flag, 60-day return | G1, G3 |
| Are you UK resident for tax? | Non-resident report always required | G2 |
| Are you selling all of it, or part of the garden/land? | PRR on part disposals | G4 |
| Are you selling as a company, trustee or personal representative? | Who pays what | G5–G6 |
