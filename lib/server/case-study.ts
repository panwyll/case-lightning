/**
 * The free case study (app/conveyi/case-study): the lead magnet $100M Leads opens with, a short video of one firm's
 * result behind a short form (name, email, phone, as Gym Launch's opt-in asked). Each request is a lead, saved and sent to us at once (reply-to them), as a demo
 * booking is; they are emailed the link to watch. The video is CASE_STUDY_VIDEO_URL (an .mp4), with an optional
 * CASE_STUDY_POSTER_URL; until it is set, the watch page says the video is on its way.
 */
import { Resend } from 'resend';
import { config } from './config';
import { query, queryOne, runAsSystem } from './db';
import { DEMO_HOST } from './demo/bookings';

const env = (k: string) => process.env[k]?.trim() || undefined;

export const CASE_STUDY_TITLE = 'How a conveyancing firm doubled its capacity in a week';

/** The recorded video, once there is one. */
export function caseStudyVideo(): { src: string; poster: string | null; duration: string | null } | null {
  const src = env('CASE_STUDY_VIDEO_URL');
  return src ? { src, poster: env('CASE_STUDY_POSTER_URL') ?? null, duration: env('CASE_STUDY_VIDEO_LENGTH') ?? null } : null;
}

export class CaseStudyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

/**
 * Save the lead and tell us; then email them the link. Five requests from one address a day. A lead is never lost to
 * the table being missing (the migration not yet run): we are emailed it either way.
 */
export async function requestCaseStudy(input: { name: string; email: string; phone: string; firm: string; source: Record<string, string>; ip: string | null }): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (input.ip) {
    const n = await runAsSystem(() => queryOne<{ n: number }>(`select count(*)::int as n from case_study_lead where ip = $1 and created_at > now() - interval '1 day'`, [input.ip])).catch(() => null);
    if ((n?.n ?? 0) >= 5) throw new CaseStudyError('Too many requests from here today. Try again tomorrow.', 429);
  }
  await runAsSystem(() => query(`insert into case_study_lead (name, email, phone, firm, source, ip) values ($1, $2, $3, $4, $5::jsonb, $6)`, [input.name, email, input.phone, input.firm || null, JSON.stringify(input.source), input.ip]))
    .catch((e) => console.error('case study lead not saved (is migration 143 run?)', email, (e as Error).message));
  if (!config.resendApiKey || !config.resendFromEmail) { console.error(`case study lead ${email} not emailed: RESEND_API_KEY / RESEND_FROM_EMAIL not set`); return; }
  const resend = new Resend(config.resendApiKey);
  const link = `${config.appUrl.replace(/\/$/, '')}/conveyi/case-study/watch`;
  const from = Object.entries(input.source ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  const first = input.name.trim().split(/\s+/)[0];
  const send = async (what: string, msg: Parameters<Resend['emails']['send']>[0]) => {
    const r = await resend.emails.send(msg).catch((e) => ({ error: e }));
    if ((r as { error?: unknown }).error) console.error(`case study ${what} email failed`, email, (r as { error?: unknown }).error);
  };
  await Promise.all([
    send('lead', {
      from: config.resendFromEmail, to: DEMO_HOST.email, replyTo: email,
      subject: `New lead: case study for ${input.name} (${input.firm || domainOf(email)})`,
      text: [`${input.name} <${email}>`, `Phone: ${input.phone}`, `Firm: ${input.firm || domainOf(email)}`, from && `\n${from}`, '\nThey asked for the free case study. Reply to this email to write to them.'].filter(Boolean).join('\n'),
    }),
    send('link', {
      from: config.resendFromEmail, to: email, replyTo: DEMO_HOST.email,
      subject: CASE_STUDY_TITLE,
      text: `Hi ${first},\n\nHere's the case study: ${link}\n\nIf you want the same for your firm, book a 15 minute demo: ${config.appUrl.replace(/\/$/, '')}/conveyi/demo\n\n${DEMO_HOST.name}\nCase Lightning`,
    }),
  ]);
}
