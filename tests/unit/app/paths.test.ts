/**
 * The app's URL shape (docs/sign-in.md). These are cheap tests for an expensive mistake:
 * a wrong prefix here sends a conveyancer to a 404, or — worse — leaves a page outside
 * the sign-in wall.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_BASE, paths, isProtectedPath, PROTECTED_SEGMENTS } from '../../../lib/paths';

test('every app page lives under /conveyi', () => {
  assert.equal(APP_BASE, '/conveyi');
  const built = [paths.cases, paths.tasks, paths.integrations, paths.engineMatter('m1'), paths.account, paths.admin, paths.leap, paths.machineMap, paths.signIn, paths.decision('abc'), paths.matter('m1'), paths.matterShadow('m1')];
  for (const p of built) assert.ok(p.startsWith('/conveyi/'), p);
});

test('the wall covers every app section, and nothing else', () => {
  for (const seg of PROTECTED_SEGMENTS) assert.equal(isProtectedPath(`/conveyi/${seg}`), true, seg);
  for (const seg of PROTECTED_SEGMENTS) assert.equal(isProtectedPath(`/conveyi/${seg}/deeper/still`), true, seg);
  // Marketing, the sign-in page itself and the client's form must stay reachable.
  for (const p of ['/conveyi', '/conveyi/pricing', '/conveyi/support', '/conveyi/privacy', paths.signIn, '/pof/tok', '/get-started', '/']) {
    assert.equal(isProtectedPath(p), false, p);
  }
});

test('a section whose name merely starts the same is not protected by accident', () => {
  assert.equal(isProtectedPath('/conveyi/cases-explained'), false);
  assert.equal(isProtectedPath('/conveyi/todays-news'), false);
});

test('signInTo remembers where the person was going, and refuses anywhere else', () => {
  assert.equal(paths.signInTo('/conveyi/cases'), '/conveyi/sign-in?next=%2Fconveyi%2Fcases');
  // An absolute URL would be an open redirect; so would a protocol-relative one.
  assert.equal(paths.signInTo('https://evil.example/x'), '/conveyi/sign-in');
  assert.equal(paths.signInTo(null), '/conveyi/sign-in');
  assert.equal(paths.signInTo(''), '/conveyi/sign-in');
});

test('after signing in a person lands on their caseload — every open matter, not settings or onboarding', () => {
  assert.equal(paths.afterSignIn, paths.cases);
});
