import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { CaseStudyError, requestCaseStudy } from '@/lib/server/case-study';
import { firstTouch, firstTouchTags } from '@/lib/server/first-touch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask for the free case study (lib/server/case-study.ts). Where the person first came from goes with it. A filled-in
 * hidden field (`website`) is a bot: it is let through to the video and dropped.
 */
export async function POST(req: NextRequest) {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
      firm: z.string().trim().max(160).optional().default(''),
      website: z.string().optional().default(''),
      source: z.record(z.string(), z.string().max(200)).optional().default({}),
    }).parse(await req.json());
    if (b.website) return ok({ ok: true });
    const source = { ...b.source, ...firstTouchTags(await firstTouch(req.cookies.get('cl_vid')?.value)) };
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    await requestCaseStudy({ name: b.name, email: b.email, firm: b.firm, source, ip });
    return ok({ ok: true });
  } catch (error) {
    if (error instanceof CaseStudyError) return ok({ error: error.message }, { status: error.status });
    return fail(error);
  }
}
