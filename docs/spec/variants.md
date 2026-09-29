# Core flow and firm variants

The core flow (code) is the product. A firm changes it only through **declared variant points** (data), each of which must still pass the whole spec. No firm gets a hand-edited branch of the engine.

## Layers

1. **Core** (code): steps, waits, gates, issues, decisions, triggers — `machine.ts`, `due.ts`, `service.ts`, `issues.ts`, `sla.ts`.
2. **Firm profile** (data, per tenant): the overrides below, loaded once per run and handed to the engine.
3. **Case** (data, per matter): transaction type, case shapes (`shapes.ts`), funding, parties — chosen at enrol.

## Variant points, safest first

| Point | What a firm changes | Lives in | Risk to the flow |
|---|---|---|---|
| Wording | Email text, document templates | Email Templates / Doc Packs (edited rows only override) | None |
| Timing | Chase/escalate days, resolve-by windows, reminder hours | `engine_sla_override`, `tenant_policy` | None (a wait still chases) |
| Autonomy | Send vs propose vs assist, per action/subject | `engine_action_level` | None (propose = a task) |
| Policy switches | Require proof of funds, exchange authority, protect files, signing provider | `tenant_policy` / enrol defaults | Low — each switch is declared in code with its gate and its task |
| Added rules | "When X, do Y": a task, an email, a document, a wait, optionally holding a gate | Firm > Rules (signal → action, approve/propose) | Medium — must satisfy the contract below |
| Replaced providers | ID check, searches, signing, case system (LEAP/InTouch) | Ports/adapters chosen per firm | Low if the port contract holds |
| Removed steps | Only by a declared switch (a gate "not required by policy") | `tenant_policy` | Medium — never an ad-hoc deletion |

## The contract a variant must meet

(The core already passes it; enforcing it on each firm's saved settings is **Build next** below.)

- An **added step** is a task, an automatic send/document, or a wait — never a button. A step that **holds a gate** must say what clears it (a task or a wait); a rule that holds a gate with nothing to clear it must be refused when saved.
- An **added send** names its trigger, recipient, template, trust-level key, and whether a "no" leaves a Send It task.
- A **switch that removes a gate** also removes its tasks and waits, and the flowchart shows it as not required.
- **The stall detector runs per firm profile**: a firm's saved configuration is exported as a fixture and the 26 × 6 runs must reach a closed file with it. A change to a firm's rules should not go live until that passes.

## Build next (to make this the core offering)

1. `FirmProfile` type + `firmProfile(tenantId)` loader gathering levels, SLA, policies, rules, template overrides in one object; the engine reads it instead of scattered lookups.
2. `no-stall.test.ts` takes a profile; `tests/firms/<firm>.json` fixtures (exported from Firm settings) run in CI.
3. Save-time validation on Firm > Rules against the contract above (gate ⇒ clearer; send ⇒ template + level).
4. A firm variant that needs real code is added to the core behind a declared switch, with its tasks, waits and simulator answers — so every firm's variant is tested for every firm.
