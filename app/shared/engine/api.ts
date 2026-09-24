import { paths } from '@/lib/paths';

/**
 * One fetch helper for every engine page: cookie session, JSON in/out, server error text
 * surfaced.
 *
 * Reads are cached in memory for a minute. A page you come back to paints from what it
 * showed last time and refreshes underneath, instead of going blank and waiting. Any
 * write empties the cache, so nothing stale survives an action.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: unknown; inflight: Promise<unknown> | null }>();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    cache.clear();
    return request<T>(path, init);
  }
  const hit = cache.get(path);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) {
    // Fresh enough to paint with; bring it up to date in the background, once.
    if (!hit.inflight && now - hit.at > 5_000) {
      hit.inflight = request<T>(path, init).then((body) => { cache.set(path, { at: Date.now(), body, inflight: null }); return body; }).catch(() => { hit.inflight = null; return null; });
    }
    return hit.body as T;
  }
  if (hit?.inflight) return hit.inflight as Promise<T>;
  const inflight = request<T>(path, init).then((body) => { cache.set(path, { at: Date.now(), body, inflight: null }); return body; }).catch((err) => { cache.delete(path); throw err; });
  cache.set(path, { at: hit?.at ?? 0, body: hit?.body ?? null, inflight });
  return inflight;
}

/** Forget everything read so far (a page that must see the server's truth right now). */
export function forgetApiCache(): void {
  cache.clear();
}
