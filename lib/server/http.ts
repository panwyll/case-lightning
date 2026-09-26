/**
 * Shared helpers for the /api/v1 route handlers: consistent error→Response
 * mapping (mirrors the error-shape conventions in app/api/waitlist/route.ts).
 */
import { NextResponse } from 'next/server';
import { GraphError } from '@microsoft/microsoft-graph-client';
import { ZodError } from 'zod';
import { UnauthorizedError, ForbiddenError } from './session';
import { FeatureUnavailableError } from './config';
import { describeGraphError } from './graph';

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (error instanceof FeatureUnavailableError) {
    return NextResponse.json(
      {
        error: `This feature is not configured yet (${error.feature}).`,
        action: 'Set the missing environment variables and redeploy.',
        missing: error.missing,
      },
      { status: 503 }
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: 'Invalid request.', details: error.issues }, { status: 400 });
  }
  // Microsoft Graph failures are upstream errors, not server bugs. The SDK's
  // GraphError often has an EMPTY `.message` (e.g. a body-less 401 from a
  // mailbox-less account), which would otherwise surface as a blank "HTTP 500".
  // describeGraphError() always yields a legible string; 502 marks it upstream.
  if (error instanceof GraphError) {
    return NextResponse.json({ error: describeGraphError(error) }, { status: 502 });
  }
  // Rules the DATABASE enforces (migration 068): the ethical wall between handlers of
  // internally-linked matters (42501) and the shared-handler conflict check (23514).
  const pgCode = (error as { code?: unknown } | null)?.code;
  if (pgCode === '42501' && error instanceof Error && /ethical wall/.test(error.message)) {
    return NextResponse.json({ error: 'You act for the other side of this transaction; this case is walled off from you.', action: 'Ask the assigned handler or compliance.' }, { status: 403 });
  }
  if (pgCode === '23514' && error instanceof Error && /conflict of interest/.test(error.message)) {
    return NextResponse.json({ error: error.message, action: 'A handler cannot act for both sides of a linked chain. Use the documented-consent process outside this system.' }, { status: 409 });
  }
  // Errors carrying an explicit HTTP status (e.g. EntitlementError 402, a route's
  // 409/429) — honour it and pass through any `action` hint for the client.
  if (error instanceof Error && typeof (error as { status?: unknown }).status === 'number') {
    const e = error as Error & { status: number; action?: string };
    return NextResponse.json(e.action ? { error: e.message, action: e.action } : { error: e.message }, { status: e.status });
  }
  // describeGraphError also covers plain Errors (falls back to name) and unknown
  // throwables, so the client never receives an empty error string.
  return NextResponse.json({ error: describeGraphError(error) }, { status: 500 });
}
