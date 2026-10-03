# CONVEYi product spec (the contract every change keeps)

Short, testable rules. A change — core or a client's variant — is done when it keeps every rule here and the checks below pass. Each file is one area:

| File | Covers |
|---|---|
| [tasks.md](tasks.md) | What a task is, where it comes from, how it is done |
| [triggers.md](triggers.md) | What happens by itself, trust levels, what a "no" means |
| [waits.md](waits.md) | Waiting on others: chasing, answering in place |
| [issues.md](issues.md) | Problems on a case: kinds, resolve-by, outcome forms |
| [decisions.md](decisions.md) | Reviews, alternatives, escalation |
| [ui.md](ui.md) | Where things are shown and how buttons behave |
| [variants.md](variants.md) | The core flow vs a firm's own rules and flows |
| [documents.md](documents.md) | Reading documents, the fact register, search and Ask The File |

## The five non-negotiables

1. **Nothing waits on someone finding a button.** Every step, when due, either happens by itself, is a task on the Tasks list, or is a wait that chases someone. (`tests/unit/engine/no-stall.test.ts`)
2. **Everything is done from the Tasks list.** The case view is for troubleshooting. Every task's action — upload, form, approve, send — works in place on the row. (`ui.md`)
3. **A task appears only when it can be done.** If the engine would refuse its command, it is not offered yet. (`due.ts` gates on the same stage/blockers as `machine.ts`)
4. **Every answer leads somewhere.** Approve, reject, request further, refer, indemnity, escalate: each either finishes the step or brings it back as a task or a wait. (`no-stall.test.ts`, six policies)
5. **Every action says what happened.** A button spins while it works, shows a tick when it worked, and leaves the reason when it did not. Nothing silent.

## Checks (run before shipping)

- `npm run test:unit` — includes the stall detector: 26 case types × 6 answer policies must each reach a closed file doing only what the Tasks list offers.
- `/dev/harness` (local only) — the real Tasks list, case task tab and flowchart over an in-memory case. Click the change through at 1280–1400px before shipping UI.
- A new wait key, due step, decision kind or gate is not done until the simulator answers/does it (see each file's **Adding one** line).
