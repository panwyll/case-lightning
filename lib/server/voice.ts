/**
 * Per-user writing-voice profile: learn how someone writes from their own sent
 * mail, so their drafts read as theirs rather than as generic competent prose.
 *
 * Captured once from a sample of Sent Items during the initial scan (best-effort,
 * never blocks it) and read back into the drafter. Style only — the profile never
 * licenses changing facts or dropping professional care; the drafter's accuracy
 * rules always win over matching the voice.
 */
import { query, queryOne } from './db';
import { listRecentSent } from './graph';
import { profileVoice } from './ai';
import { stripHtml } from './text';

export interface VoiceProfile {
  salutation: string;
  signOff: string;
  formality: string;
  guide: string;
}

/** Enough of a body to carry voice (incl. the sign-off), not a one-line "ok thanks". */
const MIN_SAMPLE_CHARS = 120;
const SAMPLE_COUNT = 12;

/**
 * Sample the user's sent mail, derive a voice profile, store it. Best-effort and
 * idempotent-ish (overwrites the previous profile). Skips silently when there isn't
 * enough substantive sent mail to tell — a bad guess is worse than none.
 */
export async function captureVoiceProfile(user: { userId: string; tenantId: string }): Promise<VoiceProfile | null> {
  let messages: any[] = [];
  try {
    messages = await listRecentSent(user.userId, 25);
  } catch {
    return null; // no sent-items access / token lapsed — try again next scan
  }

  const samples = messages
    .map((m) => {
      const body = (stripHtml(m?.body?.content ?? '') || m?.bodyPreview || '').trim();
      return body;
    })
    // Drop the terse ones and obvious auto-replies — they carry no voice.
    .filter((b) => b.length >= MIN_SAMPLE_CHARS && !/^automatic reply|out of office/i.test(b))
    .slice(0, SAMPLE_COUNT);

  if (samples.length < 3) return null; // too thin to characterise honestly

  let profile: VoiceProfile;
  try {
    profile = await profileVoice({ userId: user.userId, tenantId: user.tenantId, samples });
  } catch {
    return null;
  }

  try {
    await query(
      `update app_user set voice_profile = $1::jsonb, voice_profile_at = now() where id = $2 and tenant_id = $3`,
      [JSON.stringify(profile), user.userId, user.tenantId]
    );
  } catch {
    /* pre-064 — column not present yet */
  }
  return profile;
}

/** The stored profile rendered as a compact steer for a draft prompt (or ''). */
export async function getVoiceGuide(userId: string, tenantId: string): Promise<string> {
  try {
    const row = await queryOne<{ voice_profile: VoiceProfile | null }>(
      `select voice_profile from app_user where id = $1 and tenant_id = $2`,
      [userId, tenantId]
    );
    const v = row?.voice_profile;
    if (!v) return '';
    return [
      v.guide,
      v.salutation ? `Typical opening: ${v.salutation}` : '',
      v.signOff ? `Typical sign-off: ${v.signOff}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  } catch {
    return '';
  }
}
