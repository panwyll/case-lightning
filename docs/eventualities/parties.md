# Eventualities: parties and instructions

Who the clients are, who acts for them, and how that changes over the life of a case — at every
junction from instruction to registration. Each row is something a competent England & Wales
conveyancer plans for; the *Engine today* column is checked against the code on 2026-10-01
(file:line), and the *Correct response* column is the design the engine should implement.

Status: **BUILT** (the engine models it, gate or flag), **PARTIAL** (some of it — what is missing is
said), **MISSING** (a person has to know). Priority: **P1** legal/financial risk or common; **P2**
real but rarer or lower-loss; **P3** edge case. Sources are cited by short name:
LSAG = Legal Sector Affinity Group AML guidance (2025); MLR = Money Laundering Regulations 2017;
Handbook = UK Finance Mortgage Lenders' Handbook Part 1 (by topic); SRA = SRA Code of Conduct for
Solicitors / Firms; LS PN = Law Society practice note; PG = HM Land Registry practice guide;
SDLTM = HMRC Stamp Duty Land Tax Manual; LPA 1925 = Law of Property Act 1925.

What already exists (the parts the rows lean on):

- `enrol` takes `partyNames`, `attorneys`, `officers`, `executors`, `occupiers`, `sdlt` and `shapes`;
  every person beyond the first is an `id_party_added` with their own check that holds Instruction
  and exchange (`machine.ts:869-925`, `machine.ts:1235`).
- `add_party` (`machine.ts:928`) adds a person later — but raises **no** checklist issue for the role.
- `set_clients` (`machine.ts:1442`, projection `projection.ts:731`) edits the client list: an added
  client is identified; a removed one takes an unfinished check with them; the ownership-basis
  question is asked if there are now two or more (`service.ts:724`). Nothing else reacts: not the
  lender, the SDLT basis, proof of funds, the contract, an earlier ownership decision, or exchange
  (it is accepted after exchange).
- Issue kinds for parties: `probate_issue`, `power_of_attorney_issue`, `bankruptcy_insolvency`,
  `company_buyer_checks`, `occupier_consent`, `unrepresented_counterparty`, `court_order_transfer`,
  `aml_kyc_problem`, `transaction_at_risk`, `cdd_refresh` (`issues.ts:243-295`). `seller_capacity`,
  cited in `docs/conditions-register.md` §6 and `spec.ts:315`, is **not** a kind — that row is stale.
- `abandon_matter` reasons (`types.ts:1425`): client_withdrew, seller_withdrew, chain_collapsed,
  gazumped, survey, finance_failed, conflict, other. No death, capacity, AML/sanctions, fraud or
  transferred-to-another-firm reason.
- The SDLT basis is fixed at enrolment (`projection.ts:148`) and is one basis for all buyers.
- The client's exchange authority is a single decision, not one per client (`machine.ts:652`).

---

## J1 · Instruction: who the client is

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 1.1 | Two or more clients (joint buyers / sellers / owners) | enrol `partyNames` | Each identified; joint retainer letter says there is no confidentiality between joint clients and what happens on a conflict; ownership basis asked | **PARTIAL** — each checked (`machine.ts:875-877`), ownership basis asked (`service.ts:724`); no joint-retainer / no-confidentiality term recorded or sent | P1 | MLR reg 28; SRA 6.2, 6.3 |
| 1.2 | A client is under 18 | DOB on the ID document (`IdentityDocumentFacts.dateOfBirth`) or enrol answer | Issue `minor_party` holding exchange: a minor cannot hold a legal estate — a transfer to them takes effect as a declaration of trust; restructure (adults hold on trust for them, or wait). Lender will not lend to a minor | **MISSING** — DOB extracted, never compared | P2 | LPA 1925 s.1(6); TLATA 1996 Sch 1 para 1 |
| 1.3 | Client acts through an attorney (LPA / general POA) | enrol `attorneys` or `add_party(role: attorney)` | Attorney identified; `power_of_attorney_issue`: power registered and in force, covers land, client's confirmation, lender consents to the attorney executing the deed; attorney is not also the witness | **PARTIAL** — BUILT at enrol (`machine.ts:884,892`); `add_party` with role attorney raises no issue (`machine.ts:928-936`) | P1 | LSAG 6.14.9; Handbook (powers of attorney); PG 9 |
| 1.4 | Attorney is buying the donor's property, or the donor is giving / selling at undervalue to the attorney or family | the attorney's name on the other side; price under value | Issue holding exchange: an attorney may not benefit or make gifts beyond MCA s.12 without Court of Protection authority; escalate | **MISSING** | P2 | Mental Capacity Act 2005 s.12, s.9(4); OPG guidance |
| 1.5 | Co-owner trustee sells under a general POA | seller's attorney is acting for a trustee of land | A s.10 PAA 1971 general power cannot be used for trust functions; need s.1 TDA 1999 power (LPA) or s.25 Trustee Act delegation, and two trustees to receive capital money | **MISSING** — `power_of_attorney_issue` note does not say it | P2 | Trustee Delegation Act 1999 s.1, s.7; PG 9 |
| 1.6 | Client lacks capacity and has a deputy | enrol answer; Court of Protection order | Deputy identified; order checked to cover the sale/purchase; COP authority for the specific sale where required | **MISSING** — no `deputy` role | P2 | MCA 2005 s.16-20; PG 9 |
| 1.7 | Company / LLP client | shape `company_buyer`, enrol `officers` | Companies House, directors and PSCs checked, board authority, company funds; corporate SDLT rates | **BUILT** — `shapes.ts:33`, `machine.ts:885,893`; SDLT `company` flag (`sla.ts:183`) | P1 | LSAG 6.14.11, 6.16 |
| 1.8 | Overseas entity buying or selling | company registered outside the UK | Must hold an Overseas Entity ID on the Register of Overseas Entities before HMLR will register it as proprietor; a seller overseas entity has a restriction — check it is compliant; issue holding exchange | **MISSING** | P1 | Economic Crime (Transparency and Enforcement) Act 2022; HMLR PG on overseas entities |
| 1.9 | Trustees buying (trust as client) | enrol answer | Trustees identified (two+), trust deed seen, beneficial owners identified, Trust Registration Service check | **PARTIAL** — `executors` role covers "executor / trustee" (`machine.ts:886`), checklist is probate-worded; no TRS / beneficial-owner check | P2 | LSAG 6.14.16; MLR reg 30A |
| 1.10 | Personal representatives selling (probate sale) | enrol `executors` | All PRs identified (two verified), grant seen before exchange, all PRs sign; buyer side: grant before exchange | **BUILT** — `machine.ts:886,894`; `probate_issue` (`issues.ts:269`) | P1 | LSAG 6.14.16 |
| 1.11 | Charity seller / buyer | enrol answer | Charities Act statements in contract and transfer; trustees' report from a qualified surveyor (s.119) | **MISSING** | P3 | Charities Act 2011 ss.117-122 |
| 1.12 | Client resident outside the UK | address abroad on ID / enrol | Enhanced verification (certified or video ID), high-risk third country check (EDD), SDLT 2% surcharge asked, signing abroad planned (witness / notarisation) | **PARTIAL** — SDLT `nonUkResident` at enrol (`machine.ts:897`); abroad flag only for gift donors (`POF_GIFT_DONOR_ABROAD`); nothing for a client abroad | P1 | MLR reg 33(1)(b); LSAG 6.18; FA 2003 Sch 9A |
| 1.13 | Client is a PEP or family member / close associate | ID provider `PEP_MATCH` flag | EDD: senior-management approval to act, source of wealth and funds, enhanced monitoring; recorded | **PARTIAL** — flag → `id_check` decision, "escalate, never approve alone" (`extraction.ts:380`, `context.ts:681`); no senior-manager approval step, SoW query only via PoF risk rating | P1 | MLR reg 35; LSAG 6.19 |
| 1.14 | Sanctions match on a client, donor or the other side | ID provider `SANCTIONS_MATCH`; screening of seller | Hard stop: no funds move, no further work until cleared or an OFSI licence; report to OFSI; never auto-approve; screen the seller and the seller's other parties too | **PARTIAL** — client flag escalates (`extraction.ts:381`); no hard stop on money, the other side is never screened | P1 | Sanctions and Anti-Money Laundering Act 2018; OFSI guidance; LS PN Sanctions |
| 1.15 | Vulnerable client (age, illness, bereavement, language, undue influence) | enrol answer, a note, an email ("Mum's carer") | Record the vulnerability and adjustments (contact channel, plain letters, see client alone, interpreter); undue-influence check where someone else gives instructions | **MISSING** | P2 | LS PN Meeting the needs of vulnerable clients; SRA 3.4 |
| 1.16 | Instructions come from someone other than the client (child, partner, broker) | sender relation on emails | Confirm instructions with the client directly before acting; never take instructions from a third party | **PARTIAL** — notes reader gates decisions to the client (`notes.ts:100-137`); no standing check at instruction | P1 | LS PN Client care; LSAG 6.14.9 |
| 1.17 | Client's name differs across documents (marriage, deed poll) | document mismatch | Evidence of change; alias joined | **BUILT** — `name_change_evidenced` (`machine.ts:2133`) | P2 | PG 67 |
| 1.18 | Referral from an agent / broker / introducer who is paid a fee | enrol: introducer + fee | Fee disclosed to the client in writing before instruction; client's interests unaffected | **MISSING** | P2 | SRA 5.1(a)-(e); LS PN Referral fees |
| 1.19 | Same firm acts for the other side | `link_related_matter` internal counterparty | Firm-level conflict test, not just handler: SRA "substantially common interest" does not apply to buyer/seller; act only on a recorded justified exception with informed written consent of both; otherwise decline one | **PARTIAL** — same handler refused (`counterparty.ts:31-42,122`); different handlers in the firm accepted with no conflict record or consent | P1 | SRA 6.2; LS PN Conflict of interests in conveyancing |
| 1.20 | Related-party / non-arm's-length sale (family, employer, landlord to tenant) | enrol answer; same surname; seller is a relative | Lender told (non-arm's-length; gifted equity is a deposit); price, SDLT on actual consideration; independent advice to the seller where pressure is possible | **MISSING** | P1 | Handbook (purchase price / incentives, related-party); LSAG red flags |
| 1.21 | Sale at an undervalue (family discount, gifted equity) | price below valuation | Insolvency-undervalue risk if the seller is made bankrupt within 5 years (company 2): title insurance; lender told of gifted equity | **MISSING** | P2 | Insolvency Act 1986 ss.339, 341, 238 |
| 1.22 | Other side unrepresented | shape `unrepresented_counterparty` | Their identity against the title, no undertakings, lender told, no advice to them | **BUILT** (gate) / PARTIAL (chase templates still assume a solicitor) — `shapes.ts:71` | P2 | PG 67 |

## J2 · Joint clients change — before exchange

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 2.1 | One co-buyer withdraws; the other wants to buy alone | client email ("I'm buying on my own now"); note | Confirm in writing from **both** (the leaver's instruction ends the joint retainer for them). Then re-plan: (a) lender — the joint offer is invalid; new application in one name (`mortgage_offer_withdrawn`, `set_funding` if now cash); (b) affordability — proof of funds re-opened: the leaver's money and statements drop out, new shortfall computed; (c) SDLT re-based on the remaining buyer (FTB relief may now be available, higher rates may fall away unless still married and not separated); (d) ownership basis and declaration of trust void; (e) draft contract / TR1 names amended, the seller's solicitor told; (f) occupier: if the leaver still lives there, lender's occupier consent | **PARTIAL** — `set_clients` removes the name and their unfinished check (`machine.ts:1442`, `projection.ts:731`); nothing re-opens the offer, PoF, SDLT, contract, or clears the old ownership decision | P1 | Handbook (borrowers, change of circumstances); SDLTM29800 (FTB: all purchasers); FA 2003 Sch 4ZA para 9 |
| 2.2 | One co-buyer withdraws and the other cannot proceed alone | as above; mortgage refused | Record; abandon with reason; refund of any money on account to the right payer (the one who paid) | **PARTIAL** — `abandon_matter(client_withdrew)`; no refund-to-payer step | P1 | SRA Accounts Rules 2.3, 2.5 |
| 2.3 | Co-buyer added late (new partner, parent joins the mortgage) | client email | Both clients confirm; new person's ID/AML; their funds through PoF; lender must re-underwrite (new borrower = new offer); SDLT re-based on all buyers (an added non-FTB loses relief for both; an added owner of another dwelling brings higher rates); ownership basis asked; contract/TR1 names; an occupier who becomes a buyer drops out of occupier consent | **PARTIAL** — `set_clients` adds and identifies them, asks ownership basis (`service.ts:724`); lender, SDLT, PoF, contract untouched | P1 | MLR reg 28; SDLTM29800, SDLTM09750 |
| 2.4 | Parent or relative contributes and wants to be on the title (not on the mortgage) | client email | Lender usually refuses a non-borrower owner (or requires them to be a party); gift vs. investment: a contribution for a share is not a gift; declaration of trust | **MISSING** — PoF treats them as a gift donor only | P2 | Handbook (gifts, occupiers); LSAG 6.17.2 |
| 2.5 | Joint buyers separate / divorce before exchange and both still want to proceed | client email or one client's note | Conflict check: can we still act for both? If instructions diverge, stop acting for at least one (often both, as we hold confidential information of each). If they agree to proceed: separated spouses lose the "spouse" SDLT treatment (higher rates / non-resident surcharge tested individually); lender told | **MISSING** — no conflict-between-joint-clients mechanism; no `separation` fact | P1 | SRA 6.2, 6.3, 6.5; SDLTM09885; FA 2003 Sch 4ZA para 9(2) |
| 2.6 | Joint buyers separate and one wants to continue alone | as above | As 2.1, plus: written release from the leaver; independent advice for the leaver if their money stays in | **MISSING** (via 2.1 PARTIAL) | P1 | SRA 6.2 |
| 2.7 | Joint clients give conflicting instructions (one authorises exchange, the other does not) | two client decisions that disagree | Exchange authority and every client decision required from **each** client; disagreement = conflict issue holding exchange | **PARTIAL** — `exchange_authority` is one decision, not per client (`machine.ts:652,1234`) | P1 | SRA 6.2; Protocol (exchange authority) |
| 2.8 | One joint client tells us something in confidence (a loan behind the deposit, an affair, plans to sell) | email from one client | No confidentiality between joint clients: either disclose to the other (if the retainer allows) or cease to act; never conceal from the other or the lender | **MISSING** | P1 | SRA 6.3, 6.5; Handbook (disclosure to the lender) |
| 2.9 | Unequal contributions or change of contribution split | PoF figures; client email | Declaration of trust (fixed shares, contributions, floating) recalculated; advised before exchange | **PARTIAL** — `ownership_basis` + deed of trust gate (`machine.ts:513-514`); `co-ownership.ts` models the shares but is "not yet on the case" | P2 | LS PN Joint ownership; Stack v Dowden [2007] UKHL 17 |
| 2.10 | Co-sellers: one seller will not sign / disagrees (separating owners) | seller-side email; our client co-seller | Both legal owners must sign; a hostile co-owner = sale on hold; court order under TLATA s.14 may be needed; conflict check | **MISSING** | P1 | TLATA 1996 s.14; SRA 6.2 |
| 2.11 | Separating owners: sale replaced by a buy-out | client email | Abandon the sale (reason) and open a `transfer_of_equity` (court-order shape if there is one) with the linked history | **PARTIAL** — `transfer_of_equity` + `court_order_transfer` exist (`shapes.ts:76`); no "convert sale → transfer of equity" path | P2 | `docs/transaction-types.md` |
| 2.12 | Spouse of a seller not on the title registers home rights (or claims a beneficial interest) | HMLR notice (HR1) on the register; TA6 occupiers | Vacant possession at risk: spouse's release / cancellation of the notice before exchange; occupier signs the contract | **PARTIAL** — `property-forms.ts` flags occupiers; title decision cites the notice; no home-rights specific step | P1 | Family Law Act 1996 ss.30-31; Williams & Glyn's v Boland [1981] |
| 2.13 | Court order / freezing order / pending land action against a client's property | register entry; email from family solicitor | Hold exchange; check the order permits the sale; the other spouse's solicitors consent | **PARTIAL** — `title_restriction` decision; no order-specific handling | P2 | Matrimonial Causes Act 1973 s.37; LRA 2002 s.87 |

## J3 · Joint clients change — after exchange

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 3.1 | A co-buyer wants out after exchange | client email | The contract binds both; only a deed of variation / release by the seller lets them out. Warn both in writing (deposit forfeiture, damages); remaining buyer must complete or the seller may serve notice to complete. Lender re-underwriting may not fit the date | **MISSING** — `set_clients` is accepted after exchange (`machine.ts:1444`) with no warning, as if the parties could change | P1 | Standard Conditions of Sale 6.8, 7.4; SRA 6.2 |
| 3.2 | A buyer wants the transfer to a different or extra person after exchange (nominee, new partner) | client email | Seller's consent / contract permits direction; SDLT: original buyer's effective date; new person identified; lender approves; TR1 drafted to the transferee | **MISSING** | P2 | FA 2003 Sch 2A (pre-completion transactions) |
| 3.3 | Joint buyers separate after exchange | client email | Both bound; if they refuse to complete, notice to complete and deposit loss; conflict — may have to stop acting for one; lender to be told (offer may be withdrawn) | **MISSING** | P1 | SRA 6.2; SCS 7.4 |
| 3.4 | Co-seller refuses to complete after exchange | other side email / our client | Breach: buyer serves notice; specific performance; our position if we act for both sellers | **MISSING** | P2 | SCS 6.8 |

## J4 · Death

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 4.1 | Sole buyer dies before exchange | email from family / executor | The retainer ends; stop all chasers and portal messages to the deceased at once; do not exchange; abandon (reason `client_died`), refund money on account to the estate on sight of the grant | **MISSING** — no reason, no stop of client messages | P1 | Agency law: death terminates the retainer; SRA Accounts Rules 2.5 |
| 4.2 | One joint buyer dies before exchange | email | Stop messages to the deceased; ask the survivor whether they proceed; if so, as 2.1 (lender, PoF, SDLT re-based on the survivor alone) | **MISSING** | P1 | as 2.1 |
| 4.3 | Sole buyer dies after exchange | email | Contract binds the estate: PRs must complete (or negotiate rescission); the mortgage offer lapses on the borrower's death — funding gap; tell the seller's solicitor; probable notice to complete; manual handling | **MISSING** | P1 | LPA 1925 / law of contract (benefit and burden pass to PRs); Handbook (borrower's death) |
| 4.4 | Joint buyer dies after exchange | email | Survivor and the PRs complete; lender re-underwrites the survivor; if joint tenants on completion the survivor takes; SDLT on the survivor | **MISSING** | P1 | as 4.3 |
| 4.5 | Sole seller dies before exchange (our client or the other side) | email | Sale cannot proceed until a grant: retainer ends with the deceased; re-instructed by the PRs: `executors` added, `probate_issue` holds exchange; buyer side: expect months | **PARTIAL** — `add_party(executor)` + manual `probate_issue` (`issues.ts:269`); no death event, no re-planning of dates | P1 | LSAG 6.14.16 |
| 4.6 | Sole seller dies after exchange | email | Contract binds the estate; completion cannot be registered without the grant — delay; contractual compensation; buyer may serve notice to complete; `probate_issue` must hold **completion** | **PARTIAL** — `probate_issue` defaults to gate exchange and stages PRE (`issues.ts:269`); can be raised with gate completion by hand | P1 | SCS 7.2 (compensation), 6.8 |
| 4.7 | One of two joint-tenant sellers dies | email; death certificate | Survivor can sell alone with the death certificate (if no severance) — the 1964 Act on unregistered, Form A absence on registered; contract and TR1 re-drafted | **MISSING** | P2 | Law of Property (Joint Tenants) Act 1964; PG 16 |
| 4.8 | One of two tenant-in-common sellers dies (Form A restriction) | register shows Form A | Survivor must appoint a second trustee (or the PRs join) so capital money is paid to two trustees; otherwise the buyer does not overreach | **MISSING** | P1 | LPA 1925 ss.2, 27; PG 24 |
| 4.9 | Donor of a POA dies (client acting by attorney) | email | Power ends on death; attorney may not sign; PRs take over (grant) | **MISSING** | P2 | MCA 2005 Sch 1 para 2; Powers of Attorney Act 1971 s.5 |
| 4.10 | Gift donor dies before completion | email | Gift may now be an estate asset: PRs' consent and timing; PoF re-opened; lender told | **MISSING** | P3 | LSAG 6.17.2 |

## J5 · Capacity

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 5.1 | Client loses capacity before exchange, registered LPA in place | family email; GP letter | Retainer: take instructions from the attorney; attorney identified; `power_of_attorney_issue`; lender consent for attorney signing; best-interests check | **PARTIAL** — `add_party(attorney)` identifies; no issue raised by `add_party` | P1 | MCA 2005 ss.1-4, 9; LS PN Mental capacity |
| 5.2 | Client loses capacity, no LPA | as above | Stop: no valid instructions; exchange impossible until a deputy is appointed by the Court of Protection (months); re-plan dates or abandon | **MISSING** | P1 | MCA 2005 s.16; LS PN Mental capacity |
| 5.3 | Client loses capacity after exchange | as above | Contract binds; attorney or deputy completes; an ordinary (non-lasting) power ends on incapacity | **MISSING** | P2 | Powers of Attorney Act 1971; MCA 2005 |
| 5.4 | Co-owner trustee lacks capacity on a sale | as above | Needs a replacement trustee via the Court of Protection, or an attorney with a beneficial interest under s.1 TDA 1999 | **MISSING** | P2 | Trustee Act 1925 s.36(9); TDA 1999 s.1 |
| 5.5 | Doubt about capacity at instruction (elderly seller, family driving the sale) | note; vulnerability | Capacity assessment (medical evidence), see the client alone, record; undue influence check | **MISSING** | P1 | Banks v Goodfellow; LS PN Mental capacity |

## J6 · Insolvency

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 6.1 | K16 bankruptcy search hit against a buyer / borrower | search result | `bankruptcy_insolvency` holds completion; lender told; confirm identity (often a namesake) | **BUILT** — `machine.ts:951`, `issues.ts:271` (lender purchases only) | P1 | Handbook (insolvency) |
| 6.2 | Cash buyer bankrupt | client disclosure / search | A bankrupt's after-acquired property vests in the trustee; dispositions after the petition are void | **MISSING** — K16 only required on lender cases | P2 | Insolvency Act 1986 ss.284, 307 |
| 6.3 | Seller bankrupt (bankruptcy restriction / notice on title) | title register | Trustee in bankruptcy is the seller; their consent and signature; sale price to the trustee | **PARTIAL** — `bankruptcy_insolvency` arisesFrom covers it; raised by hand from the title decision | P1 | IA 1986 s.306; PG 34 |
| 6.4 | Client becomes bankrupt after exchange | email / Gazette | Trustee may complete or disclaim; deposit and our client account money frozen to the trustee | **MISSING** | P2 | IA 1986 ss.315, 284 |
| 6.5 | Company client in liquidation / struck off | Companies House | Liquidator acts; struck-off company's property is bona vacantia — Crown consent | **PARTIAL** — `company_buyer_checks` at instruction only; no re-check before completion | P2 | Companies Act 2006 s.1012; IA 1986 s.127 |

## J7 · AML and sanctions events during the case

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 7.1 | Suspicion arises; MLRO makes a SAR and seeks a DAML | MLRO decision | Hold every money movement and exchange for the 7-working-day notice period (31-day moratorium if refused); **no tipping off**: no chaser, portal note or update that hints why; MLRO-only visibility | **MISSING** — `aml_kyc_problem` holds exchange but client chasers and updates carry on | P1 | POCA 2002 ss.327-329, 333A, 335; LSAG ch. 13 |
| 7.2 | Client designated under sanctions mid-matter | daily screening | Hard stop on funds; OFSI report; no further work without licence | **MISSING** — screening only at ID check; no re-screen | P1 | SAMLA 2018; OFSI |
| 7.3 | Client refuses to provide CDD or source of funds | chases exhausted | Cannot proceed (MLR reg 31): cease to act; consider a SAR | **PARTIAL** — waits escalate; no cease-to-act outcome / reason | P1 | MLR reg 31 |
| 7.4 | CDD over a year old on a long matter | timer | Refresh | **BUILT** — `sla.ts:255` (`cdd_refresh`) | P2 | LSAG 6.21 |
| 7.5 | PEP status discovered after instruction | refreshed screening, adverse media | As 1.13 from that point | **PARTIAL** — only if a new check is run | P2 | MLR reg 35 |

## J8 · The client and the firm

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 8.1 | Client uncontactable | waits escalated, no reply across channels | After escalation, a `client_uncontactable` issue: phone, letter to the property, agent; before exchange put dates on hold; after exchange warn of notice to complete; eventually cease to act | **PARTIAL** — per-wait chase/escalate (`sla.ts`); no matter-level uncontactable state | P2 | SRA 3.2 |
| 8.2 | Client moves to another firm | client email / new firm's letter | Abandon with reason `transferred`; file and client money transferred on authority; outstanding undertakings (redemption, to the lender) honoured or released; lien for unpaid fees | **MISSING** | P2 | SRA 1.3 (undertakings); SRA Accounts Rules 2.5 |
| 8.3 | Firm ceases to act (conflict, non-payment, breakdown, AML) | person's decision | Reasonable notice; tell the other side and the lender; undertakings; no tipping off if AML | **MISSING** — only `abandon_matter(conflict/other)` | P2 | SRA 3.1; LS PN Ceasing to act |
| 8.4 | Client complains | email tone/content | Logged as a complaint, acknowledged in the firm's time, 8-week Legal Ombudsman clock; handled by someone else; case continues | **MISSING** — complaints are only a tone hint for the reply drafter (`ai.ts:509`) | P1 | SRA 8.2-8.5; Legal Ombudsman Scheme Rules |
| 8.5 | Handler changes | person | Reassign | **BUILT** — `record_handler_change` (`machine.ts:1610`) | P3 | — |
| 8.6 | Lender is a separate client and its interests diverge from the buyer's (e.g. information the buyer wants withheld) | buyer's request | We act for the lender too: must report; cease to act for the lender if the buyer forbids disclosure | **PARTIAL** — lender-notify resolutions exist; no "client forbids disclosure" case | P1 | Handbook (conflict); SRA 6.2 |

## J9 · Fraud indicators about the parties

| # | Eventuality | Signal | Correct response | Engine today | Priority | Source |
|---|---|---|---|---|---|---|
| 9.1 | Our seller client's identity does not match the registered proprietor | ID subject vs title proprietorship | Hard check before marketing / contract: name, address history at the property, proprietor's signature where held; mismatch = issue holding exchange | **PARTIAL** — `crosscheck.ts:38` puts `id.subject` in **buyer** names even on a sale, so our seller's ID is never compared with the proprietor | P1 | Dreamvar (UK) Ltd v Mishcon de Reya [2018] EWCA Civ 1082; LS PN Property and registration fraud |
| 9.2 | Seller impersonation red flags on a purchase: unencumbered, unoccupied/tenanted, owner abroad, quick sale below value, new solicitor, seller's address differs | title (no charge), TA6, price | Fraud-risk score; enquiries of the seller's solicitor on how they verified their client; Code for Completion by Post undertakings; consider a Land Registry property alert; manual review before exchange | **MISSING** | P1 | Dreamvar; Code for Completion by Post 2019; HMLR Property Alert |
| 9.3 | Seller's solicitor not genuine (cloned firm) | firm details | Verify the firm on the SRA / Law Society register and Lawyer Checker before sending the deposit | **PARTIAL** — Lawyer Checker only on bank-details change (`machine.ts:2551`) | P1 | LS PN Property and registration fraud |
| 9.4 | Seller has owned less than 6 months / back-to-back sale | title registration date | Report to the lender (most need it); price uplift checked | **MISSING** — proprietorship entries kept verbatim, date not structured | P1 | Handbook (seller's ownership period / back-to-back) |
| 9.5 | Buyer identity used for mortgage fraud (offer names differ, address mismatch) | offer vs ID | Cross-check | **BUILT** — `crosscheck.ts` buyer names | P1 | Handbook |
| 9.6 | Bank details change on email | email | Out-of-band verification hard stop | **BUILT** — `machine.ts:1402,2551` | P1 | LS PN Cybersecurity |
| 9.7 | Money from an unknown payer | receipt | `aml_kyc_problem` holds completion | **BUILT** — `client_account_receipt` (`machine.ts:2119`) | P1 | LSAG 6.17.2 |

---

## Counts

| Junction | Rows | BUILT | PARTIAL | MISSING |
|---|---|---|---|---|
| J1 Instruction | 22 | 4 | 8 | 10 |
| J2 Before exchange | 13 | 0 | 8 | 5 |
| J3 After exchange | 4 | 0 | 0 | 4 |
| J4 Death | 10 | 0 | 2 | 8 |
| J5 Capacity | 5 | 0 | 1 | 4 |
| J6 Insolvency | 5 | 1 | 2 | 2 |
| J7 AML events | 5 | 1 | 2 | 2 |
| J8 Client and firm | 6 | 1 | 2 | 3 |
| J9 Fraud | 7 | 3 | 2 | 2 |
| **Total** | **77** | **10** | **27** | **40** |

## Top 10 to build first

1. **A party-change command with consequences (`client_left` / `client_joined`)** — rows 2.1-2.6, 4.2.
   Replace the bare `set_clients` edit with a typed event carrying *why* (withdrew, separated, died,
   joined) that drives a re-plan: on a lender case raise `lender_approval` and mark the offer
   withdrawn (`mortgage_offer_withdrawn`) because a change of borrower is a new application; reopen
   proof of funds (`source_of_funds` issue) dropping the leaver's statements and declarations; clear
   `clientDecisions.ownership_basis` and the deed-of-trust gate and re-ask; raise `sdlt_basis` to
   re-confirm the basis for the new set of buyers; raise a `contract_parties` task to tell the
   seller's solicitor and re-draft the contract/TR1; ask the remaining client(s) to confirm in
   writing. Refuse it after exchange (see 2).
2. **After exchange, parties are fixed** — rows 3.1-3.4. `set_clients` / the new command refused
   after `contracts_exchanged` unless `variationDeedId` is recorded; instead a `party_post_exchange`
   issue (critical, gate completion) with the options: deed of variation agreed, other buyer
   completes alone, notice to complete expected, abandon with loss of deposit.
3. **Death as an event (`party_died`)** — J4. Payload: party, date, before/after exchange is
   derived. Immediately suppresses every outbound message to that person (chasers, portal,
   updates — a message to a dead client is the worst possible failure), closes their waits, and
   branches: sole client pre-exchange → abandon reason `client_died`; joint → row 1 for the
   survivor; post-exchange → `probate_issue` with gate **completion**, lender told, mortgage offer
   withdrawn on a borrower's death, manual handling; seller side → PRs added, dates re-planned. Add
   `client_died` to `ABANDON_REASONS`; widen `probate_issue.stages` to post-exchange.
4. **SAR / DAML hold with no tipping off** — row 7.1. An MLRO-only `sar_made` event: holds every
   payment, exchange and completion for 7 working days (31 more if refused); suppresses client
   updates that would reveal the hold (chasers carry on as normal so nothing looks different);
   visible only to the MLRO role; ends on `daml_granted` / `daml_refused` / deemed consent timer.
5. **Conflict between joint clients** — rows 2.5, 2.7, 2.8, 2.10, 3.3. Per-client client
   decisions (exchange authority and every client decision keyed by party, all required); a
   disagreement or a one-client confidential instruction raises `joint_client_conflict` (gate
   exchange/completion) with resolutions: both reconfirm, cease to act for one (the other retains
   us with written consent), cease to act for both. Notes reader: "we've split up" from either
   client proposes this issue, never a decision.
6. **Seller-identity fraud screen** — rows 9.1-9.4. Fix the crosscheck so our own seller client's
   ID is compared with `title.proprietor` on a sale; structure the proprietor's name, address and
   registration date from the B register; score red flags (unencumbered + unoccupied/tenanted +
   owner's address elsewhere + owned < 6 months + price under value + new instruction) into a
   `seller_identity_risk` issue holding exchange; on a purchase it drafts the enquiry "how did you
   verify your client's identity and their entitlement" and records a Lawyer Checker / SRA-register
   check of the other firm before the deposit is sent.
7. **Capacity and attorneys added mid-case** — rows 1.3, 5.1-5.5. `add_party(attorney)` raises the
   same `power_of_attorney_issue` as enrol; a `capacity_lost` event: with an LPA → attorney added +
   issue; without → manual handling with a `deputyship` wait (months) and dates re-planned; a
   `deputy` role; the POA checklist names TDA 1999 for trustee co-owners and MCA s.12 for gifts
   and attorney self-dealing.
8. **Firm-level conflict for internal counterparties** — row 1.19. `link_related_matter` across
   the same firm requires a recorded `conflict_exception` (which SRA 6.2 exception, informed written
   consent from both clients, reasons) before either file can exchange; without it, the second
   file is refused. Today only the same handler is refused.
9. **Sanctions as a hard stop, and screening of the other side** — rows 1.14, 7.2. A
   `SANCTIONS_MATCH` that is not cleared blocks every payment authorisation, exchange and completion
   (not just an escalated decision); the seller (and a company seller's PSCs) screened when the
   contract names them; re-screen before completion; `abandon_matter` reason `aml` for decline.
10. **Overseas entity and non-UK resident clients** — rows 1.8, 1.12. Enrol facts `overseasEntity`
    (with OE ID) and `clientAbroad`: an overseas-entity issue holding exchange until the ROE ID is
    verified (HMLR will not register otherwise); a client abroad gets enhanced-verification text,
    a high-risk-third-country check (EDD) and a signing-abroad task (witnessing / notarisation /
    apostille) planned before exchange; and the SDLT basis becomes re-settable (`set_sdlt_basis`)
    so residence, FTB and higher-rates answers can change with the parties (spouses who separate
    are tested individually).

Also cheap and worth doing alongside: fix the stale `seller_capacity` references in
`docs/conditions-register.md` §6 and `spec.ts:315`; add `client_died`, `transferred`, `aml`,
`fraud_suspected`, `capacity` to `ABANDON_REASONS`; a `complaint` record with the 8-week clock (8.4);
referral-fee disclosure on enrol (1.18).
