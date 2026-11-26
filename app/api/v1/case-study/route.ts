import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { CaseStudyError, requestCaseStudy } from '@/lib/server/case-study';
import { firstTouch, firstTouchTags } from '@/lib/server/first-touch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask for the free case study (lib/server/case-study.ts). Where the person first came from goes with it. A filled-in
 * hidden field (`website`) is a bot: it is let through to the video and dropped. Sent as a plain form (the button
 * pressed before the page's script loaded), it answers with the video page, or the form again with what was wrong.
 */
export async function POST(req: NextRequest) {
  const plain = !(req.headers.get('content-type') ?? '').includes('application/json');
  const back = (path: string) => NextResponse.redirect(new URL(path, req.url), 303);
  try {
    const body = plain ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)])) : await req.json();
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
      phone: z.string().trim().min(7, 'A phone number').max(40).regex(/^[0-9 +()-]*$/, 'A phone number, digits only'),
      firm: z.string().trim().max(160).optional().default(''),
      website: z.string().optional().default(''),
      source: z.record(z.string(), z.string().max(200)).optional().default({}),
    }).parse(body);
    if (b.website) return plain ? back('/conveyi/case-study/watch') : ok({ ok: true });
    const source = { ...b.source, ...firstTouchTags(await firstTouch(req.cookies.get('cl_vid')?.value)) };
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    await requestCaseStudy({ name: b.name, email: b.email, phone: b.phone, firm: b.firm, source, ip });
    return plain ? back('/conveyi/case-study/watch') : ok({ ok: true });
  } catch (error) {
    if (plain) return back(`/conveyi/case-study?error=${error instanceof CaseStudyError ? 'busy' : 'form'}#form`);
    if (error instanceof CaseStudyError) return ok({ error: error.message }, { status: error.status });
    return fail(error);
  }
}
