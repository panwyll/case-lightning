# UK residential conveyancing — process model (software reference)

**Purpose.** A defensible, code-encodable model of residential conveyancing in
**England & Wales** so the add-in can reason about *where a matter sits* and *what
an incoming email means for it*. This is software-design context, **not legal
advice**. Built from deep research anchored to primary sources (Law Society
Conveyancing Protocol 2019, the Law Society transaction-form pages, HMRC /
GOV.WALES, HMLR Practice Guide 12); remortgage rests on corroborated practitioner
sources (no Protocol equivalent), so treat it as lower confidence.

> ⚠️ **The single most important design constraint.** The Protocol states verbatim
> that its steps *"are not exhaustive and should not be regarded as a conveyancing
> checklist. The transaction may not proceed in a fixed order, and many of the
> processes can take place simultaneously or be undertaken in a changed order."*
> So a stage enum must be a **best-estimate of current state**, never a hard linear
> gate. Stages run concurrently and out of order — especially across a chain.

---

## 1. Stage enum (the spine)

The sale/purchase spine maps to the Protocol's six ordered stages A–F (steps 1–35).
Usable for **freehold and leasehold owner-occupier** transactions — **not new-build**.

| Enum | Protocol | Plain name |
|---|---|---|
| `INSTRUCTION` | A (1–9) | Instructions, client care, ID/AML |
| `CONTRACT_PACK` | B (10–19) | Draft contract + protocol forms issued |
| `SEARCHES_ENQUIRIES` | B/C (parallel) | Searches ordered, enquiries raised & replied |
| `PRE_EXCHANGE` | C (20–21) | Mortgage offer, report on title, signing, deposit |
| `EXCHANGE` | D (22–27) | Contracts exchanged → **legally binding** |
| `PRE_COMPLETION` | D (25–27) | Pre-completion searches, redemption figures, COT/funds |
| `COMPLETION` | E (28–32) | Funds transfer, keys, vacant possession |
| `POST_COMPLETION` | F (33–35) | SDLT/LTT, HMLR registration, lender/landlord notices |

> The current app enum (`INSTRUCTION, CONTRACT_PACK, SEARCHES_ENQUIRIES,
> REVIEW_SIGNING, EXCHANGE, COMPLETION`) is purchase-shaped and **missing
> POST_COMPLETION** — the SDLT/registration tail is real work and a distinct waiting-on
> state. Recommend adding it. `PRE_EXCHANGE` ≈ existing `REVIEW_SIGNING`.

**Note on the Protocol's own grouping:** steps 25–27 ("pre-completion searches",
"redemption figures", "certificate of title") sit under the Protocol's running
header *Stage D: Exchange of contracts*. `PRE_COMPLETION` is our schema grouping,
not a verbatim Protocol stage name.

---

## 2. PURCHASE track

Acting for the **buyer**. `stage | entry | exit / unblocks next | typical outstanding | waiting-on`.

| Stage | Entry | Exit / unblocks next | Typical outstanding | Waiting on |
|---|---|---|---|---|
| `INSTRUCTION` | Client instructs; we're retained | Client care signed + **ID/AML + source-of-funds** cleared | Client-care pack, AML/SoF, deposit funds proof | **Client**, our side |
| `CONTRACT_PACK` | Instruction complete | Seller's contract bundle received & reviewed (draft contract + SCS, official copies <6mo, TA6, TA10; leasehold: TA7, LPE1, freehold/intermediate titles, draft deed of covenant) | The bundle items above | **Other side's solicitor** |
| `SEARCHES_ENQUIRIES` | Contract pack in | Search results in + enquiries replied satisfactorily | Local/water/environmental searches; enquiries raised & answered | **Search providers**, **other side's solicitor** |
| `PRE_EXCHANGE` | Searches/enquiries resolving | Mortgage offer in + report on title to client + client signs + deposit held | Mortgage offer, report on title, signed contract, deposit cleared | **Lender**, **client** |
| `EXCHANGE` | All pre-exchange satisfied; deposit ready | Contracts exchanged (becomes **binding**; completion date fixed) | Agree completion date; synchronise across chain | **Other side's solicitor** (+ whole chain) |
| `PRE_COMPLETION` | Exchanged | Pre-completion searches done (OS1 priority + bankruptcy); redemption figures in; COT/requisition for funds sent to lender; funds drawn | OS1, bankruptcy search, mortgage advance request | **Lender**, **HMLR** |
| `COMPLETION` | Funds + searches ready on completion date | Funds transferred; keys released; vacant possession | Completion monies, key release | **Other side's solicitor** |
| `POST_COMPLETION` | Completed | SDLT/LTT return filed + paid; **HMLR registration lodged within OS1 priority period**; leasehold notices served | SDLT (England/NI, **14 days**) / LTT (Wales, **30 days**); HMLR application; notice of transfer/charge (leasehold) | **HMRC / WRA**, **HMLR**, landlord/managing agent |

**Key state transitions (highest-signal email triggers):**
- **Exchange confirmation** flips the matter from negotiable → binding (deposit
  forfeiture / notice to complete / damages under SCS apply after this point).
- **Completion** ≠ legal ownership: title vests on **registration** at HMLR
  (s.27 LRA 2002); between completion and registration the buyer holds only
  equitable title.

---

## 3. SALE track

Acting for the **seller**. Mirrors purchase; the waiting-on party flips (we produce
the bundle, the buyer's side reviews/raises enquiries).

| Stage | Entry | Exit / unblocks next | Typical outstanding | Waiting on |
|---|---|---|---|---|
| `INSTRUCTION` | Seller instructs | Client care + ID/AML cleared; title obtained | Client-care, AML, office copies | **Client**, our side |
| `CONTRACT_PACK` | Instruction complete | **We** issue the contract bundle (draft contract + SCS, official copies, TA6, TA10; leasehold: TA7, LPE1, titles, deed of covenant draft) | Seller to complete TA6/TA10 (and TA7 if leasehold); order LPE1/management pack | **Client** (forms), **our side** (assembly), managing agent (leasehold pack) |
| `SEARCHES_ENQUIRIES` | Bundle issued | Reply to buyer's enquiries | Enquiry replies (may need client/managing-agent input) | **Other side's solicitor** (to raise), then **client** |
| `PRE_EXCHANGE` | Enquiries resolving | Seller signs; completion date agreed | Signed contract; agree date | **Client** |
| `EXCHANGE` | Both sides ready | Contracts exchanged | Synchronise across chain | **Other side's solicitor** (+ chain) |
| `PRE_COMPLETION` | Exchanged | Reply to requisitions on title (**TA13**); undertaking to redeem seller's mortgage; obtain redemption statement | TA13, redemption statement | **Our side**, **seller's lender** |
| `COMPLETION` | Completion date | Receive funds; release keys; vacant possession | Funds receipt | **Other side's solicitor** |
| `POST_COMPLETION` | Completed | Redeem seller's mortgage; send evidence of discharge (DS1/UN); account to client | Mortgage redemption; discharge evidence | **Seller's lender**, **HMLR** |

**TA13** (Completion Information and Undertakings, 4th ed. 2023) is sent by the
**seller's** solicitor after exchange, before completion (mortgage discharge, keys,
vacant possession; some replies are binding **undertakings**). Its receipt is a
pre-completion gating signal.

---

## 4. REMORTGAGE track — *medium confidence (no Protocol anchor; firm-variable order)*

Not covered by the Protocol; modelled from corroborated practitioner sources.
Order — especially searches vs offer-review — **varies by firm**; treat as soft.

| Stage | Entry | Exit / unblocks next | Typical outstanding | Waiting on |
|---|---|---|---|---|
| `INSTRUCTION` | Lender/client instructs | Client care + ID/AML cleared | Client-care, AML | **Client**, our side |
| `TITLE_CHECK` | Instructed | Title investigated; no blocking defects | Office copies, title review | **HMLR**, our side |
| `REDEMPTION` | Title clear | **Redemption statement** from existing lender obtained (balance + interest + ERC/exit; ~28-day validity) | Redemption statement (final pulled near completion) | **Existing lender** |
| `SEARCHES_OR_INDEMNITY` | Title check done | Searches in **OR** search indemnity insurance accepted (per-lender, UK Finance Handbook Q5.4.6) | Searches *or* indemnity (~£85–£130) | **Search providers** *or* none |
| `OFFER_REVIEW` | New offer issued | Review valuation/mortgage offer + report/certificate on title to new lender | New mortgage offer, COT | **New lender** |
| `COMPLETION` | Offer + funds ready | New advance received → **existing mortgage redeemed in full**; surplus (net of costs) to client | New funds; redemption | **New lender**, existing lender |
| `POST_COMPLETION` | Completed | Remove old lender's charge; **register new lender's charge** at HMLR | DS1/discharge; new charge registration | **HMLR** |

---

## 5. Detours / quirks (flag, don't hard-code)

Most are **firm/matter-variable** — surface them and adjust the outstanding-items
checklist; don't treat as fixed.

- **Leasehold** *(verified — Protocol step 13 + form scope)*: adds **TA7** + **LPE1 /
  management pack**, possible **deed of covenant**, **official copies of freehold /
  intermediate titles**, and post-completion **notice of transfer / notice of charge**
  to the landlord/managing agent. Waiting-on shifts to **landlord / managing agent**.
  (Note: **LPE2** is completed *by the buyer's solicitor* as a summary — not answered
  by the landlord; the Law Society's own summary wording oversimplifies this.)
- **Adverse search results** *(standard practice)*: may be resolved by **indemnity
  insurance** instead of remediation — short-circuits the wait on remediation.
- **New-build** *(verified: outside the Protocol)*: adds reservation, **engrossment**,
  and **longstop dates**; the A–F spine does **not** apply cleanly. (Specifics
  firm-variable — not independently verified here.)
- **Chains / related sale-and-purchase** *(verified: Protocol allows simultaneity)*:
  exchange must happen **simultaneously** across parties; a linked sale+purchase are
  two tracks that must exchange/complete together. Needs cross-matter state.
- **AML / source-of-funds incl. gifted deposits** *(domain context)*: gates
  `INSTRUCTION` — cannot progress until cleared.
- **Shared ownership (purchase)** *(verified — HMRC)*: SDLT is a **market-value
  election** (one-off up front, no further SDLT on staircasing) **or staged** (SDLT
  on initial share; nothing further until owned share **exceeds 80%**). Staircasing
  without the election needs **no SDLT and no return until >80%**.
- **Help to Buy / staircasing specifics, lease extension, short lease** *(domain
  context — not independently verified)*: mark firm/matter-variable.
- **Jurisdiction branch** *(verified)*: **England & NI → SDLT** (HMRC, file **14
  days**); **Wales → LTT** (Welsh Revenue Authority, file **30 days**). The
  England–Wales border decides the post-completion tax task. **Pull live rates from a
  maintained source — do not hard-code** (Budgets change them).

---

## 6. Guardrails — claims that were REFUTED (do NOT encode)

Verification killed these 0–3; encoding them would be wrong:

- ❌ **Rigid "draft contract → searches → enquiries" linear order.** These run in
  parallel; ordering is not fixed.
- ❌ **OS1/OS2 priority period of "6 weeks".** It is **30 working days** (HMLR PG12).
- ❌ **"Pre-completion searches remain valid until registration is submitted."** False
  — they confer a fixed priority window, not open-ended validity.
- ❌ **OS2 (part-of-title) specifics** — treat as **unverified**; don't encode details.

---

## 7. Caveats & open questions

- **Form editions are time-sensitive.** TA6 (6th ed.) & TA7 (5th ed.) are **mandatory
  for CQS members** for instructions **on/after 30 March 2026**; legacy matters may use
  older editions. Don't assume universally.
- **Confidence split.** Sale/purchase spine = **high** (primary sources). Remortgage =
  **medium** (practitioner sources, firm-variable order).
- **Open questions to confirm with the firm before encoding hard logic:**
  1. Live SDLT/LTT rates/bands/surcharges + the maintained source to pull from.
  2. The firm's canonical remortgage step order (searches vs offer-review).
  3. Leasehold post-completion sub-sequence (notice of transfer/charge, deed of
     covenant, share certificate) — which block HMLR registration vs run in parallel.
  4. How to model chains as linked matters with simultaneous exchange/completion.

## 8. Sources (primary)

- Law Society Conveyancing Protocol 2019 (PDF) & topic page
- Law Society transaction forms (TA6/TA7/TA10/TA13, LPE1/LPE2)
- HMRC — SDLT shared ownership guidance; Law Society SDLT/LTT border Q&A; GOV.WALES LTT
- HM Land Registry Practice Guide 12 (official searches, OS1, 30-working-day priority)
- s.27 Land Registration Act 2002 (title vests on registration)
