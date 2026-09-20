# Transaction types — one machine, six profiles

The engine runs six residential transaction types through **one** state machine. Nothing is
duplicated per type: a *profile* (`lib/server/engine/transactions.ts`) tells the machine which
phases the type passes through, which workstreams and sub-flows apply, who pays us, and what
follows completion. Commands, gates, the automatic follow-ons and the two read-only projections
(`graph.ts`) consult the profile. The map at `/engine/map` (and `docs/engine-map.md`) is drawn
from the same profiles; `tests/unit/engine/transaction-types.test.ts` runs each type end to end.

| Type | Side | Exchange | Phases | What is different |
|---|---|---|---|---|
| Freehold purchase | buyer | yes | instruction → searches & enquiries → title & report → pre-exchange → exchanged → pre-completion → completed → post-completion | The spine the engine was built on: ID/AML, searches (auto-ordered), enquiries, mortgage offer, proof of funds, title, report on title, deposit, exchange, completion, SDLT, AP1. |
| Leasehold purchase | buyer | yes | as above | Plus the management pack (LPE1) as a decision, lease facts on the title, the notice of assignment after completion. |
| Freehold sale | seller | yes | instruction → contract pack → enquiries & replies → pre-exchange → exchanged → pre-completion → completed (redeem & account) → discharge & close | Property forms from the client, official copies, the contract pack out, the buyer's enquiries *answered*, the redemption figure, completion monies from the buyer's solicitor, the lender redeemed against verified details, the balance to the client, the charge discharged. No searches, no proof of funds, no report on title, no SDLT/AP1. |
| Leasehold sale | seller | yes | as above | Plus the TA7 and obtaining the management pack from the freeholder / agent for the buyer. |
| Remortgage | owner | **none** | instruction → investigation → ready to complete → completed → registration | Title and the new offer investigated, redemption figure from the old lender, mortgage deed executed (witnessed), certificate of title sent, the advance in, the old lender redeemed against verified details, the new charge registered by AP1, the old one discharged. |
| Transfer of equity | owner | **none** | instruction → investigation & consent → execution → completed → registration | Every party identified, the lender's consent where charged, the clients decide how they hold (declaration of trust for tenants in common), the transfer deed executed by every party, any consideration in, SDLT where there is chargeable consideration (or a person records that none is due), AP1. |

## What the profile carries

```ts
interface TransactionProfile {
  type; label; side: 'buyer' | 'seller' | 'owner'; tenure: 'freehold' | 'leasehold' | 'any';
  hasExchange: boolean;                 // purchase / sale exchange; remortgage / transfer do not
  stages: Stage[]; stageLabels;         // the phases this type passes through, and how they read
  workstreams: Workstream[]; subflows: SubFlow[];
  defaultSearches: SearchType[];        // none on a sale / transfer; the buyer's four on a purchase
  counterparty: string;                 // "seller's solicitor", "buyer's solicitor", "the lenders", …
  fundsFrom: ('lender' | 'client' | 'buyer_solicitor' | 'incoming_owner')[];
  registration: 'ap1' | 'discharge_only' | 'none';
}
```

Enrolment (`enrol`) takes `transactionType`, `parties` (co-owners after completion),
`hasExistingMortgage` (a charge to redeem, or to get consent for) and, on a transfer of
equity, `considerationPennies`. The profile then decides the policies that make sense:
proof of funds is a buyer-side policy (never on a sale); the client's authority to exchange
applies only where there is an exchange; a seller has no lender of ours; the required
searches default from the profile.

## How each side moves

**Buyer (purchase).** Unchanged from docs/conveyance-engine.md and docs/case-model.md. New on a
purchase: the mortgage deed, certificate of title and transfer deed are *advisory*
requirements (recorded, not gating — in practice they are signed with the contract), and
where there are two or more clients the co-ownership lane applies (below).

**Seller (sale).**
- `pre_contract` ("Contract pack") leaves when the property forms are in (`request_property_forms`
  → a client wait the timers chase → `property_forms_received`), the title is resolved
  (official copies filed; a charge is flagged for a person as on a purchase) and the pack has
  gone out (`contract_pack_sent`, refused before the forms and the title are on file; on a
  leasehold sale the management pack must also be resolved).
- `contract_review` ("Enquiries & replies") holds only while a reply to the buyer is owed:
  `buyer_enquiries_received` records their enquiries (numbered BE1… or as given, in rounds);
  `enquiry_replies_sent` — a person's act — closes them. If no enquiries have arrived the
  file passes straight to pre-exchange; enquiries arriving later still hold exchange there
  (the derived exchange conditions are reset when a new round lands).
- `pre_exchange`: the redemption figure must be known on a charged property
  (`request_redemption_statement` → a lender wait → `redemption_statement_received` with the
  figure, its validity date and daily interest). The seller-side `exchange_conditions_met` is
  derived automatically: pack out, enquiries answered, redemption known, no issue holding
  exchange, client authority where the firm requires it. `contracts_exchanged` refuses while
  any of those fails and names the enquiries outstanding.
- `pre_completion`: money arrives from the buyer's solicitor (`funds_received` with
  `fromRole: 'buyer_solicitor'`; there is no funds request of ours). **Hard stop:** where there
  is a charge, `completion_confirmed` requires a payment to the lender authorised by a person
  against the *current verified* lender bank-details record (addendum 2), and refuses while a
  lender bank-details change is unverified.
- `completed` ("Completed — redeem & account"): `mortgage_redeemed` (on or after completion,
  after the authorised lender payment), then the balance to the client authorised against
  verified client details. No SDLT return or AP1 arises (`sdlt_submitted` / `ap1_submitted`
  are refused with a reason).
- `post_completion` ("Discharge & close"): `discharge_confirmed` (DS1 / e-DS1), then
  `close_matter`. The registration gate reads "Redeemed, accounted and discharged".

**Owner (remortgage / transfer of equity) — no exchange.** The phases are instruction →
`pre_contract` (investigation) → `pre_completion` (execution) → completed → post-completion;
the coarse lifecycle reads Instructed → Investigating → Ready to complete → Completed →
Post-completion → Closed, and READY TO COMPLETE is derived from the completion gate, not a
step. There is no exchange gate: requirements that would gate exchange gate completion
instead, and the dependency graph has no `gate:exchange` node.
- *Remortgage* investigation: title (a charge is expected and flagged for a person), the new
  offer (mortgage sub-flow), any searches the lender wants, the redemption figure from the old
  lender. Execution: `mortgage_deed_executed` (refused if not witnessed), `certificate_of_title_sent`
  (a person's act, after a resolved offer), the advance requested to our verified client
  account and received, the old lender's redemption authorised against verified details
  (hard stop), `completion_confirmed`. Then `sdlt_not_required` (a person's determination, with
  the reason) or a return where one is due, `ap1_submitted`, `mortgage_redeemed`,
  `discharge_confirmed`, `ap1_confirmed`, `close_matter`.
- *Transfer of equity* investigation: every party identified, title, the lender's consent
  where the property is charged (`request_lender_consent` → a lender wait → `lender_consent_received`
  with conditions), and the clients' decision on co-ownership. Execution: `transfer_deed_executed`
  (every party, witnessed), the declaration of trust where tenants in common, the consideration
  received from the incoming owner where there is one, `completion_confirmed`. Then SDLT where
  there is chargeable consideration (or `sdlt_not_required`), `ap1_submitted`, `ap1_confirmed`, close.

## Co-ownership (two or more clients)

`parties` ≥ 2 on a purchase or a transfer brings the co-ownership lane. The **clients**
decide how they hold — `client_decision_recorded` with subject `ownership_basis` and one of
`joint_tenants`, `tenants_in_common_equal`, `tenants_in_common_unequal` — recorded by a person
from their instruction, never inferred. For tenants in common `deed_of_trust_executed` becomes
a completion requirement; it is refused before the decision, for joint tenants, and on a
single-client matter. A later decision (instructions change) re-applies the requirement.

## Waits, chases and SLAs added

| Wait key | Owed by | Chase after / every / escalate (working days) | Template |
|---|---|---|---|
| `property_forms` | client | 5 / 3 / 12 | `chase_property_forms` |
| `redemption` | lender | 3 / 3 / 8 | `chase_redemption_statement` |
| `lender_consent` | lender | 5 / 5 / 15 | `chase_lender_consent` |
| `discharge` | lender | 10 / 10 / 30 | `chase_discharge` |

## What the UI does with it

The matter page (`/engine/[matterId]`) reads the profile from the engine route and draws:
the phase strip in the type's own words; **Work** grouped by workstream, each lane showing
only the facts and commands that apply to this type and side (a sale shows property forms,
the buyer's enquiries, redemption and discharge; a transfer shows the lender's consent,
co-ownership and the transfer deed; a remortgage shows the new mortgage's deed and
certificate); **Issues** and **Documents** as their own tabs; **Readiness** and
**Dependencies** over the gates this type actually has. The enrol form asks for the type,
parties, existing mortgage, consideration and lender as the type requires. The queue shows
the type on each row. The map has a type selector that narrows the spine and the command
table.

## Known limits (honest)

- The seller's replies are recorded as sent; the content of the replies is not extracted or
  rule-checked (the buyer's side does that on their engine).
- The property forms' facts are recorded when a document arrives but no rule reads the TA6
  for issues yet (e.g. a disclosed dispute becoming a `boundary_dispute` issue).
- The sale side has no "our client is also buying" chain link beyond the existing chain issue
  kinds; a linked sale-and-purchase is two matters.
- A remortgage's lender may want searches or indemnity; the profile defaults to none and the
  handler adds them at enrolment.
