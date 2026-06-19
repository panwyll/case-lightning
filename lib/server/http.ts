/**
 * Shared helpers for the /api/v1 route handlers: consistent error→Response
 * mapping (mirrors the error-shape conventions in app/api/waitlist/route.ts).
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { UnauthorizedError, ForbiddenError } from './session';
import { FeatureUnavailableError } from './config';

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
  const message = error instanceof Error ? error.message : 'Unknown error';
  return NextResponse.json({ error: message }, { status: 500 });
}
