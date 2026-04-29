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
  const { first_name, surname, email } = await req.json();

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
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!supabaseSecretKey) missing.push('SUPABASE_SECRET_KEY');

  if (missing.length > 0) {
    return NextResponse.json({ error: 'Missing env vars', missing }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl!, supabaseSecretKey!);

  const { error } = await supabase.from('leads').insert({ first_name, surname, email });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Send confirmation email (best-effort — failure does not affect the lead save)
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;

  if (resendApiKey && fromEmail) {
    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: fromEmail,
        to: email,
        subject: "You're on the CaseLightning waitlist",
        html: `<p>Hi ${escapeHtml(first_name)},</p>
<p>Thanks for joining the CaseLightning waitlist! We'll reach out as soon as intake opens.</p>
<p>Talk soon,<br/>The CaseLightning Team</p>`,
      });
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }
  }

  return NextResponse.json({ ok: true });
}
