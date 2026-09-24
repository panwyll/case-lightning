# The interface: complex model, simple surface

The engine underneath is a state machine with events, gates, dependencies, timers, an
issue taxonomy and AI interpretation. **None of that is the user's problem.** A
conveyancer should meet four familiar ideas and nothing else:

> **Cases. Things to do. Things we're waiting for. Things going wrong.**

LEAP ships automation flows and firms do not use them. The lesson is not "explain the
flows better" — it is that a fee-earner should never be asked to behave like a Jira
administrator. So CONVEYi exposes no workflow builder, no board configuration, no
dependency editor. The system maintains the state; the human does the law.

The one rule everything else follows:

> **Reality changes → CONVEYi observes it → the case representation updates.**

## 1 · The caseload map

`/cases`. The firm's whole book of work on a single sheet of paper: one house per matter,
standing on one of five ruled lines.

```
INSTRUCTION → PRE-EXCHANGE → READY → EXCHANGED → COMPLETION
```

The engine's finer lifecycle values fold into those five bands (`bandOf` in
`app/shared/engine/CaseloadMap.tsx`), so a remortgage with no exchange sits in the same
picture as a leasehold purchase. Fifty houses fit above the fold; a hundred fit on a
screen. The test is simple: someone looking at the whole book should find the eight that
need them without reading the other seventy.

**Health is shown twice over** — by colour and by a badge with its own silhouette, so the
map survives greyscale and colour-blindness:

| Band | House | Badge | What it means |
|---|---|---|---|
| Moving normally | white, grey roof | none | nothing is overdue, blocked or near a deadline |
| Needs attention | amber | `!` in a circle | something has passed its chase point, or a decision is waiting |
| Delayed | orange | clock face | a wait is past escalation, or the phase has badly overrun |
| Blocked | slate | bar in a circle | an open issue holds exchange or completion |
| Critical | red | `!` in a triangle | a deadline is on us, an escalation is unanswered, or payments are stopped |

**Health is not case age.** A ninety-day matter waiting on nothing is healthy; a nine-day
matter whose mortgage offer expires on Friday is not. `lib/server/engine/health.ts`
computes it from what the machine already enforces:

- **waits** — someone owes us something and the SLA clock has passed chase or escalation
- **issues** — something is wrong, and whether it holds a gate
- **decisions** — a person has to decide and hasn't
- **deadlines** — something *we* owe, with a date on it
- **pace** — working days in this phase against what this transaction type should take
  (`expectedWorkingDays` per phase, per profile, in `transactions.ts`)

Pace only speaks when nothing else explains the delay: an overdue search is the reason,
and "slow phase" underneath it would be noise.

Above the paper, the oversight strip — `59 active · 44 moving normally · 8 need attention
· 2 stuck · 5 critical` — doubles as a filter. Below it, the exception list: every case
that is not normal, and clicking one **explains itself** rather than just showing red.

```
85 Priory Gardens, Henley-on-Thames RG9
Search result (LLC1) — the search provider is 7 working days past escalation

  1. Requested 2026-08-14 — 25 working days ago.
  2. Their normal turnaround is 10 working days; we escalate at 18.
  3. 1 chase sent, most recently 2026-09-21.

  Suggested next action: Chase the search provider again (1 sent)
```

## 2 · Progressive disclosure

```
FIRM
 └─ CASELOAD MAP            /cases
     └─ CASE INTELLIGENCE   /engine/<matter>            ← the Case tab
         └─ WORKSTREAM / ISSUE   the Work and Issues tabs
             └─ SOURCE       the document, the email, the event log
```

Each level is richer than the last, and no level asks the user to construct anything.

## 3 · Case intelligence

The first tab of a matter answers, without being asked: where are we, what is complete,
what is outstanding, what is blocked, what is at risk, what needs attention, what happened
recently, what are we waiting for, what happens next.

```
85 PRIORY GARDENS — PRE-EXCHANGE — DAY 40

✓ ID / AML   ○ Title   ● Searches   ● Mortgage   ○ Contract   ○ Deposit

NEEDS ATTENTION (4)
  Search result (LLC1) — the search provider is 7 working days past escalation   Why?
  …

WAITING FOR (4)
  Search result — LLC1     25d elapsed · SLA 10d · 1 chased · escalated

WHAT HAPPENS NEXT
  THIRD PARTY  awaiting search LLC1 (chased 1×) since 2026-08-14
  US           official copies not yet received

RECENT ACTIVITY
  21 Sept 2026  Escalated: no response after 25 working days ×4
  21 Sept 2026  Chased search provider ×4
```

## 4 · The personal work list

Tasks. The decision tray first — what only the conveyancer can decide — then three
things, no new vocabulary.

- **DO** — this person acts now: an issue whose next step is ours, the next thing the
  gate needs.
- **WAITING** — folded away by default. Every line reads *waiting on X to do Y by Z*: who
  owes us what, and the date we expect it (their turnaround from when we asked, then the
  chase cadence from the last chase). When that date passes nobody moves it: the next
  sweep sends the chase, the client and the estate agent are told we chased and when we
  will chase again, and the line is a notch more serious — one chase unanswered is
  attention, two is delayed, an escalation is critical. Chasing is not a pile.
- **ESCALATE** — chasing has failed, or a date we owe is close enough to threaten the
  transaction. Writing again is not the answer: someone picks up the phone, or takes the
  client's instructions.

Two owners, deliberately distinct, so "in their court" never means "out of sight":

| | |
|---|---|
| **Action owner** | who is expected to do the thing (often outside the firm) |
| **Responsibility owner** | the fee-earner accountable for it happening. Never null. |

## 5 · Chasing is a first-class concept

Every waiting relationship carries its own numbers (`DEFAULT_SLA` in `sla.ts`, overridable
per tenant): normal response SLA, first chase, chase cadence, escalation threshold, and
what a re-escalation waits for.

```
Management pack requested
  → WAITING ON THE MANAGING AGENT
  → chase after 10 working days   → CHASE #1
  → every 5 working days          → CHASE #2 …
  → 20 working days               → ESCALATE to the conveyancer
```

The case's health worsens as those thresholds pass and as chases go unanswered —
attention at the chase point or after one chase, delayed past escalation or after two,
critical while an escalation sits unanswered. Chases are sent, not drafted, unless
`ENGINE_CHASE_MODE=draft`. In shadow mode nothing is sent and the chase is listed as
needing a person instead.

### Acknowledgements

The other half of chasing: nobody should have to chase *us* to learn that what they sent
arrived. When a reply to enquiries or the buyer's enquiries come in from the other side,
or a survey, property forms, a mortgage offer or the proof-of-funds form come in from the
client, the sender hears at once that it is received and with the fee-earner. It is a
template (`ACKS` in `comms/templates.ts`), sent — never drafted — from the fee-earner's
mailbox or down the client's channel, and recorded on the log as `acknowledgement_sent`
against the event it answers. One per item; one per party within four hours, so five
attachments are one delivery. Search providers, lenders and HMLR are not acknowledged. In
shadow mode the intent is logged as suppressed. `ENGINE_ACK_MODE=off` turns it off.

## 6 · The day (`/today`)

The operating model the whole product is for. Overnight every active matter is evaluated
against its events, timers, deadlines, blockers and outstanding decisions, and the morning
screen is three numbers and a list:

```
200 active · 23 need you today · 7 at risk · 170 progressing or waiting properly
```

The three groups are disjoint, so they add up to the caseload: a matter that needs you is
not also counted as at risk. You work the 23, not the 200. `End of day` turns the same
data round: what is still open, what the timers will chase tomorrow, which dates land this
week.

## 7 · What the client hears

Two things happen without anyone asking for them.

**A chase is also news.** When a third party is chased, the client is told — "we are still
waiting for the seller's solicitor… we chased them again today… there is nothing you need
to do". Once per matter per day, never when the person being chased is the client, and
never while an issue holds the matter.

**"Any update?" is answered from the case**, not from a leaflet: what is complete, who we
are waiting on, when we last chased, when we chase next, and whether anything is needed
from them. That answer is composed deterministically — no model writes it — and the
channel refuses to answer at all when the matter holds a gate-blocking issue, a critical
issue or a payment hard stop. Then it fetches a person. A reassuring automated summary is
the wrong thing to send on a case with a live legal problem.

## 8 · Conveyancer oversight

The rollup strip and the exception list are the team-lead view: 59 cases, 15 that need
someone, each explaining *why* the system thinks so — the chain of facts, not a colour.
Nobody inspects 59 matters to find the 15.

## 7 · The state maintains itself

State changes because something happened in the real world — an email, a document, a
search result, a signature, an ID check, a lender's offer, a client's decision, a
deadline, a third party's reply. AI interprets the unstructured input; deterministic rules
update the state, the requirements, the chase timers and the gates; a person is asked only
where professional or client judgement is genuinely required (docs/conveyance-engine.md).

## 8 · The graph is a diagnostic, not a workspace

The full case graph — gates, requirements, workstreams, issue chains — still exists,
read-only, on the **Diagnostics** tab. It answers "why can't this exchange?", "what caused
this blocker?", "what becomes possible when this resolves?". Nobody builds or maintains
it; it is drawn from the same state the machine enforces.

## Where the code lives

| Piece | File |
|---|---|
| Health model (bands, reasons, why-chains, pace) | `lib/server/engine/health.ts` |
| DO / WAITING / CHASE derivation | `lib/server/engine/work.ts` |
| Per-phase expectations, per transaction type | `lib/server/engine/transactions.ts` |
| Caseload API (tokens + rollup) | `app/api/v1/engine/caseload/route.ts` |
| Work API | `app/api/v1/engine/my-work/route.ts` |
| The paper and the houses | `app/shared/engine/CaseloadMap.tsx` |
| Case intelligence | `app/shared/engine/CaseIntelligence.tsx` |
| Tests | `tests/unit/engine/health.test.ts` |
| A 50-matter demo book | `npm run caseload:demo` |

## Known limits (honest)

- The five bands are derived from the engine's lifecycle, not chosen per firm. A firm that
  thinks in different phases cannot rename them yet.
- `expectedWorkingDays` are practitioner norms baked into the profiles, not learned from
  the firm's own history. They should eventually be fitted per firm.
- Health is computed on read. At a few hundred matters that is comfortably fast; beyond
  that it wants caching on the engine-state row.
- The map has no keyboard traversal between houses yet (each is focusable, but there is no
  grid navigation), and no saved views or grouping by fee-earner.
- "Suggested next action" comes from the issue taxonomy and the SLA rules. It is a
  sentence, not a workflow: nothing acts on it automatically.
