/**
 * Where a website visitor first came from (an ad, an email, a search): their first page view that did not come
 * from one of our own buttons (those carry utm_medium=cta), by the cl_vid cookie the pageview beacon sets
 * (app/api/v1/track). Our own buttons replace the tags on the address, so the ad's are only on that first view.
 */
import { queryOne, runAsSystem } from './db';

export interface FirstTouch { path: string; referrer: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null }

export async function firstTouch(visitorId: string | null | undefined): Promise<FirstTouch | null> {
  if (!visitorId || !/^[A-Za-z0-9_-]{8,64}$/.test(visitorId)) return null;
  return runAsSystem(() => queryOne<FirstTouch>(
    `select path, referrer, utm_source, utm_medium, utm_campaign from pageview_event
      where visitor_id = $1 and coalesce(utm_medium, '') <> 'cta' order by created_at asc limit 1`,
    [visitorId]
  )).catch(() => null);
}

/** The same, as flat tags for a record or a booking link. */
export function firstTouchTags(t: FirstTouch | null): Record<string, string> {
  if (!t) return {};
  return Object.fromEntries(Object.entries({ first_path: t.path, first_referrer: t.referrer?.slice(0, 200), first_utm_source: t.utm_source, first_utm_medium: t.utm_medium, first_utm_campaign: t.utm_campaign }).filter((e): e is [string, string] => !!e[1]));
}
