import { paths } from '@/lib/paths';

/** One fetch helper for every engine page: cookie session, JSON in/out, server error text surfaced. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The session went away while the page was open (expired, signed out in another tab).
    // The middleware catches this on a fresh navigation; a fetch has to be sent itself,
    // otherwise the screen just reads "Unauthenticated" with nowhere to go.
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith(paths.signIn)) {
      window.location.assign(paths.signInTo(window.location.pathname + window.location.search));
    }
    throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status });
  }
  return body as T;
}
