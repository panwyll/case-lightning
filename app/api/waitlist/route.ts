import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LEN = 200;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function POST(req: NextRequest) {
  const request_id = crypto.randomUUID();

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { first_name, surname, email } = (payload ?? {}) as {
    first_name?: unknown;
    surname?: unknown;
    email?: unknown;
  };

  if (!first_name || !surname || !email) {
    return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
  }

  if (
    typeof first_name !== 'string' || first_name.length > MAX_FIELD_LEN ||
    typeof surname !== 'string' || surname.length > MAX_FIELD_LEN ||
    typeof email !== 'string' || email.length > MAX_FIELD_LEN ||
    !EMAIL_RE.test(email)
  ) {
    return NextResponse.json({ error: 'Invalid field values.' }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!supabaseSecretKey) missing.push('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)');

  if (missing.length > 0) {
    return NextResponse.json(
      {
        request_id,
        stage: 'configuration',
        error: 'Waitlist signup is not configured yet.',
        action: 'Set missing environment variables and redeploy.',
        missing,
      },
      { status: 503 }
    );
  }

  const supabase = createClient(supabaseUrl!, supabaseSecretKey!);

  let error: { code?: string; message: string } | null = null;
  try {
    const result = await supabase.from('leads').insert({ first_name, surname, email });
    error = result.error;
  } catch (unknownError) {
    const message = unknownError instanceof Error ? unknownError.message : 'Unknown error';
    return NextResponse.json(
      {
        request_id,
        stage: 'supabase_connection',
        error: 'Signup service is unreachable right now.',
        action: 'Check Supabase URL and keys, then try again.',
        details: message,
      },
      { status: 503 }
    );
  }

  if (error) {
    // Duplicate submissions should not surface as server errors.
    if (error.code === '23505') {
      return NextResponse.json({ ok: true, already_exists: true, request_id });
    }
    if (error.message.includes('fetch failed')) {
      return NextResponse.json(
        {
          request_id,
          stage: 'supabase_connection',
          error: 'Signup service is unreachable right now.',
          action: 'Check Supabase URL and keys, then try again.',
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        request_id,
        stage: 'database_insert',
        error: 'We could not save your signup right now.',
        action: 'Please try again in a moment.',
        details: error.message,
      },
      { status: 500 }
    );
  }

  // Confirmation email — best-effort. Failure never affects the saved lead, and
  // it's silently skipped when Resend isn't configured.
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (resendApiKey && fromEmail) {
    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: fromEmail,
        to: email,
        subject: "You're on the CONVEYi waitlist",
        html: `<p>Hi ${escapeHtml(first_name)},</p>
<p>Thanks for joining the CONVEYi waitlist — AI for conveyancers, inside Outlook. We'll be in touch the moment intake opens.</p>
<p>Talk soon,<br/>The CONVEYi team</p>`,
      });
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }
  }

  return NextResponse.json({ ok: true, request_id });
}
