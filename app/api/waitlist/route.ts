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
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    return NextResponse.json({ error: 'Missing env vars', missing }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

  const { error } = await supabase.from('leads').insert({ first_name, surname, email });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
