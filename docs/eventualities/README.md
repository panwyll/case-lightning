# Eventualities at every junction: catalogue and build plan

These six catalogues list what can realistically happen at each junction of the flow, with sources. For each one they record what the engine should do (the signal, the issue and what it holds, the task or wait, who is told, how the case recovers) and what it does today.

| Catalogue | Covers | Rows | Built today |
|---|---|---|---|
| [parties.md](parties.md) | Who the clients are and how that changes: a co-buyer leaving, divorce, death, capacity, attorneys, insolvency, sanctions, conflicts, fraud | 77 | ~13% |
| [money.md](money.md) | Source of funds (business owners, overseas, loans, gifts), mortgage changes, ISAs, completion money, refunds | 77 | ~30% |
| [property.md](property.md) | Title, unregistered land, planning and building regulations, searches, surveys, leasehold, the Building Safety Act, new build, auctions, tenanted property | 81 | ~35% |
| [tax.md](tax.md) | SDLT edge by edge (second homes, commercial holdings, homes abroad, replacing a main residence, companies, non-residents, transfers of equity), Wales LTT, seller CGT | 72 | ~15% |
| [exchange.md](exchange.md) | The contract, the deposit, the exchange formulae, authority, chains, notice to complete, failure to complete | 54 | ~22% |
| [completion.md](completion.md) | Undertakings, charges, the day itself, delays, money, registration, discharge, file closure | 99 | ~25% |

## Build plan

The catalogues overlap, so the work is built **by theme**: one mechanism handles many rows. Each theme ships with tests, and the stall detector must stay green throughout.

| # | Theme | Rows it covers | State |
|---|---|---|---|
| A | **Consequences: a fact changes, what rested on it is done again.** Changing who the clients are reopens the contract parties, the lender, the funds, the SDLT basis and how they own it. A price or funding change lapses the client's authority to exchange, and they are asked again. Moving the completion date carries the statement, the lender, the advance already received and the linked case with it. A change after exchange holds completion until the seller and lender agree. | parties 1–4, money 2, exchange 3 and 8, tax 3 | **Built** (machine.ts "consequences", tests/unit/engine/consequences.test.ts) |
| B | **Money reconciled, not just recorded.** Every receipt is checked against the completion statement and the deposit. Shortfalls and overpayments become issues. Funds are marked cleared or not, a payment is marked sent, and there is a client ledger for refunds, residual balances and interest. | money 1, 8, 9; completion 5, 9 | Next |
| C | **Readings become typed issues.** Each title, lease, search and contract flag becomes its own issue kind with the right gate and recovery (restrictive covenant, short lease, adverse search, deposit under 10%). This follows the pattern of the TA6 reader. | property 1, 4, 5; exchange 5 | |
| D | **Charges and undertakings.** Charges are a list, so a sale can redeem several, with negative equity checked. TA13 replies and the undertaking to redeem are recorded, and the seller's DS1 is chased after completion. | completion 3, 4 | |
| E | **Dates and clocks.** A completion date is refused on a weekend or bank holiday, or after the offer expires. Searches are aged at completion from the date on the search. Clocks for first registration (2 months), the LISA 90-day window, auction (20 working days) and new-build long-stop dates. | property 2, 3, 8; exchange 4; completion 6 | |
| F | **SDLT per buyer.** The questionnaire at instruction, asked again when facts change. The basis is worked out from the facts, not declared. Wales LTT; the replacing-a-main-residence exception from the client's own chain; a refund diary; the transfer-of-equity charge on debt taken on; a seller CGT flag. | tax 1–10 | SDLT bugs fixed (19% non-UK company, company relief, £40k floor, no skipping the return at £40k+) |
| G | **People events.** Death, loss of capacity, insolvency, a conflict between joint clients, a SAR/DAML hold with no tipping off, sanctions as a hard stop, the seller identity check and Dreamvar red flags. | parties 2, 3, 4, 5 | |
| H | **After completion.** A person can raise an issue after completion. Land Registry cancellation and extension, the register checked at registration, the title document to the client and lender, stricter file closure. | completion 2, 8, 10 | |
| I | **Co-owners' money on the case.** Contributions per buyer from the proof of funds, the declaration of trust model and its figures, a warning for unequal contributions held as joint tenants. | money 10; parties | Calculation built (co-ownership.ts) |

The lender order (the certificate of title only when it can be given unqualified, the advance only against it, an OS1 on every purchase, remortgage checks) was built before this plan.
