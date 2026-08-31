import { NextResponse } from 'next/server';
import { COOKIE } from '@/lib/auth';

export const runtime = 'nodejs';

function clear(url: string) {
  const response = NextResponse.redirect(url);
  for (const name of Object.values(COOKIE)) {
    response.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
  return response;
}

export async function POST(request: Request) {
  return clear(new URL('/login', request.url).toString());
}

export async function GET(request: Request) {
  return clear(new URL('/login', request.url).toString());
}
