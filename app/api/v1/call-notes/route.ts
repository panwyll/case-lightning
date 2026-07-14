import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { query, queryOne } from '@/lib/server/db';
import { transcribeAudio, summarizeTranscript } from '@/lib/server/ai';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // transcription of a longer call can take a while

const COLS = `id, matter_id, title, summary, transcript, duration_seconds, created_at,
  (select matter_ref from matter m where m.id = call_note.matter_id) as matter_ref`;

/** The user's recent call notes (unassigned first, then most recent). */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const notes = await query(
      `select ${COLS} from call_note
        where tenant_id = $1 and user_id = $2
        order by (matter_id is null) desc, created_at desc
        limit 50`,
      [user.tenantId, user.userId]
    );
    return ok({ notes });
  } catch (error) {
    return fail(error);
  }
}

/** Record a call: transcribe the uploaded audio, summarise it, and store it unassigned. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await assertEntitled(user.tenantId);

    const form = await req.formData();
    const file = form.get('audio');
    if (!(file instanceof File) || file.size === 0) return fail(Object.assign(new Error('No audio received.'), { status: 400 }));
    const durationSeconds = Number(form.get('durationSeconds')) || null;

    const buffer = Buffer.from(await file.arrayBuffer());
    const transcript = await transcribeAudio({ buffer, mimeType: file.type, fileName: file.name || 'call.webm' });
    if (!transcript) return fail(Object.assign(new Error('Nothing was transcribed — the recording may have been silent.'), { status: 422 }));

    // Summary is best-effort: a transcript with no summary still saves.
    let title = 'Call note';
    let summary = '';
    try {
      const s = await summarizeTranscript({ userId: user.userId, tenantId: user.tenantId, transcript });
      title = s.title || title;
      summary = s.summary || '';
    } catch { /* keep the transcript even if summarisation fails */ }

    const note = await queryOne(
      `insert into call_note (tenant_id, user_id, title, transcript, summary, duration_seconds)
       values ($1,$2,$3,$4,$5,$6) returning ${COLS}`,
      [user.tenantId, user.userId, title, transcript, summary, durationSeconds]
    );

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'CALL_NOTE_RECORDED',
      actionStatus: 'SUCCESS',
      payload: { durationSeconds, chars: transcript.length },
    }).catch(() => {});

    return ok({ note });
  } catch (error) {
    return fail(error);
  }
}
