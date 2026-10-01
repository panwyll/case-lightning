# Analytics

`/conveyi/analytics` (sidebar: Cases → Analytics). Figures are computed in `lib/server/analytics/kpis.ts`, a pure function; `load.ts` reads the firm's cases. A made-up firm is at `/dev/analytics` (local only).

**Who sees what.** Everyone sees the firm and their own figures. An admin also sees each person. Filters: one person, and one kind of case (purchases, sales, remortgages, transfers).

## How it is built

Built the way target-driven teams such as sales operations and kanban flow teams read their numbers:
- **Every number has a comparison:** the target and the pace towards it, the same point last year, the firm's record month, the firm's own past, and the industry figure.
- **Percentiles, not averages.** Cycle times are skewed, so figures are p50 (median) and p85.
- **Every figure says how many cases it rests on.** A figure resting on fewer than 5 cases is greyed, not hidden.
- **Delay is attributed to a party.** At any moment a case is in one of three states:
  - **with us**: something waits on a person here;
  - **waiting on someone else**: the client, the other side, the lender, the searches or the Land Registry. Time is split equally when several are open at once;
  - **nothing outstanding**.
- **Leading beside lagging.**
  - Instructions now become completions three to four months later.
  - Exchanges with a date are completions already booked.
- **People are listed by name, never ranked.** Each person is shown against their own target and their own six-month average. Research on forced rankings shows they demotivate the middle and the bottom of a team.

## Figures

| Figure | Definition |
| --- | --- |
| **Completions this month** | Done so far, plus booked: exchanged cases whose completion date falls in the rest of the month. Forecast = done + booked. Run rate = done ÷ working days gone × working days in the month, shown once 3 working days have passed. Shown against the target, the same point last year, last year's whole month and the record month. |
| **Instructions** | The last 4 weeks against the same 4 weeks last year. Also this month, and year-to-date completions against last year's. |
| **Instruction to completion** | p50 and p85 days over completions in the last 12 months, against the 12 months before. The p85 is the firm's service level: "85% complete within N days". Also instruction to exchange, and exchange to completion. |
| **Where cases wait** | The last 90 days of every case, attributed as above. "With us of outstanding time" is our share of the time something was open. |
| **What cases wait for** | By wait (searches, enquiry replies, mortgage offer and so on): share of all waiting time, the median length of finished waits, and how many are open now. Last 12 months. |
| **Our turnaround** | Tasks (decisions) finished in the last 90 days: p50 and p85 from raised to done. Also tasks waiting now, how many have waited over 2 working days, and the slowest kinds to clear. |
| **Chases** | Share of chases followed by the answer within 3 days, the median reply time after a chase, and the same by party. |
| **Fee income** | Counted on completion, ex VAT, from the firm's fee scale (Firm → Fees, `analytics/fees.ts`). Each case's fee is the legal fee for its kind of case in the band its price falls in, plus every add-on that applies: per person ID checked, per gift donor, leasehold, acting for the lender, or a case shape (new build, ISA, buy to let, company client, auction, shared ownership, right to buy, second charge), limited to the kinds of case chosen. The tile shows done and booked this month against last year's month, year to date, the average per case and the value of the open pipeline. People get fees over 12 months. Until fees are set, an admin sees Set Your Fees instead. |
| **Pipeline** | Open cases before exchange, cases exchanged and awaiting completion, and cases completing in the next 30 days. |
| **Fall-through** | Cases abandoned ÷ (completed + abandoned) over the last 12 months, by reason. |
| **Cases to look at** | Open cases older than the firm's p85 instruction-to-completion time. Until the firm has 5 completions, the threshold is the industry figure × 1.3. Each shows who it is waiting on now. |
| **Client satisfaction** | Asked on the client portal ("Ask Clients How We Did", migration 122). **CSAT:** 1–5 after exchange; the score is the share giving 4–5. **NPS:** 0–10 after completion; promoters minus detractors. A client who scores 9–10 is offered the firm's review page (`reviewUrl` policy). Response rate = NPS answers ÷ completions. |
| **Read first** | Up to six sentences picked from the above, most important first: pace against target, a record month, the biggest wait, our share, cycle time against last year and the industry, the oldest cases, instructions against last year, fall-through, chases. |

Targets are set under Firm → How CONVEYi Runs → Targets: completions a month for the firm, and for each person.

## Reference figures

| Figure | Value | Source |
| --- | --- | --- |
| Instruction to completion | 123 days | Landmark, *An industry aligned*, 2025, England and Wales |
| Fall-through rate | 23.7% | TwentyEA, Q1 2026 |
| Share of a conveyancer's day spent chasing | 43% | Landmark, 2024. Context only, not shown. |

Both shown reference figures live in `INDUSTRY` in `kpis.ts`.

## Not yet measured

- **A fee agreed for one case** that differs from the scale (a discount, a quote). The scale is used for every case.
- **Reply time to client emails.** Needs the mailbox thread times.
