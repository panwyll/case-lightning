/**
 * Answering a person first, doing the follow-on work after. A route wraps its engine call in
 * `withDeferredEffects(after, …)`: the command is decided and recorded before the response goes,
 * and what it sets off (drafting, sending, acknowledgements, notifications) runs after it, off the
 * person's click. Work run later runs outside the scope, so its own commands act inline.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type Schedule = (work: () => Promise<void>) => void;
const scope = new AsyncLocalStorage<Schedule>();

export function withDeferredEffects<T>(schedule: Schedule, fn: () => Promise<T>): Promise<T> {
  return scope.run(schedule, fn);
}
/** The schedule in force, or null when effects run inline (tests, crons, work already deferred). */
export function deferral(): Schedule | null {
  return scope.getStore() ?? null;
}
export function outsideDeferral<T>(fn: () => Promise<T>): Promise<T> {
  return scope.exit(fn);
}
