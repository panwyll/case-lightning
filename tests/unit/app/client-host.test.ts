/**
 * A firm's own address for its clients' pages (lib/client-host.ts): it serves those pages and nothing else of ours.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_PATHS, CLIENT_PATHS, isOwnHost, plainHost } from '../../../lib/client-host';

test('our own addresses are ours; a firm\'s is not', () => {
  for (const h of ['www.caselightning.co.uk', 'caselightning.co.uk', 'app.caselightning.co.uk', 'localhost:3002', 'conveyi-git-main.vercel.app', 'app.example.com']) assert.equal(isOwnHost(h, 'https://app.example.com'), true, h);
  for (const h of ['portal.hartleyrowe.co.uk', 'caselightning.co.uk.evil.com', 'notcaselightning.co.uk']) assert.equal(isOwnHost(h, 'https://app.example.com'), false, h);
});

test('on a firm\'s address only the client\'s pages, their calls and the files they need', () => {
  for (const p of ['/portal/abc', '/f/abc', '/pof/abc', '/api/v1/portal/abc/upload', '/api/v1/f/abc', '/api/v1/pof/abc/banks']) assert.ok(CLIENT_PATHS.test(p), p);
  for (const p of ['/', '/conveyi', '/conveyi/admin', '/api/v1/me', '/api/v1/admin/users', '/portalx/abc', '/get-started']) assert.ok(!CLIENT_PATHS.test(p) && !ASSET_PATHS.test(p), p);
  for (const p of ['/_next/static/chunks/main.js', '/favicon.svg']) assert.ok(ASSET_PATHS.test(p), p);
});

test('an address as typed is made plain, and what is not one is refused', () => {
  assert.equal(plainHost('https://Portal.HartleyRowe.co.uk/'), 'portal.hartleyrowe.co.uk');
  assert.equal(plainHost(' portal.hartleyrowe.co.uk. '), 'portal.hartleyrowe.co.uk');
  for (const bad of ['', 'portal', 'portal hartley.co.uk', 'http://', '-x.co.uk', 'a..b.co.uk']) assert.equal(plainHost(bad), null, bad);
});
