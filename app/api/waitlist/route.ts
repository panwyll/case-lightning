import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LEN = 200;

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
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!supabaseAnonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');

  if (missing.length > 0) {
    return NextResponse.json({ error: 'Missing env vars', missing }, { status: 500 });
  }

  try {
    new URL(supabaseUrl!);
  } catch {
    return NextResponse.json({ error: 'Service misconfigured. Please contact support.' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl!, supabaseAnonKey!);

  try {
    const { error } = await supabase.from('leads').insert({ first_name, surname, email });

    if (error) {
      console.error('[waitlist] Supabase insert error:', error.message);
      return NextResponse.json({ error: 'Could not save your details. Please try again.' }, { status: 500 });
    }
  } catch (err) {
    console.error('[waitlist] Unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Service temporarily unavailable. Please try again later.' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
