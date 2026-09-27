import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature, config } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { UK_POSTCODE_RE } from '@/lib/address';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Found { line1: string; line2: string; town: string; county: string; postcode: string; label: string }

/**
 * Postcode → addresses for the New Case form. With a getAddress.io key the full list of
 * addresses at the postcode comes back to pick from; without one the postcode is checked
 * against postcodes.io and the town, county and country are filled in.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    await requireUser();
    const raw = z.string().min(5).max(10).parse(req.nextUrl.searchParams.get('postcode') ?? '');
    const m = raw.toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
    if (!m || !UK_POSTCODE_RE.test(`${m[1]} ${m[2]}`)) return ok({ valid: false, reason: 'That is not a UK postcode.' });
    const postcode = `${m[1]} ${m[2]}`;
    let town = '';
    let county = '';
    let country = '';
    const addresses: Found[] = [];
    if (config.getAddressApiKey) {
      const r = await fetch(`https://api.getAddress.io/find/${encodeURIComponent(postcode)}?api-key=${encodeURIComponent(config.getAddressApiKey)}&expand=true`, { cache: 'no-store' });
      if (r.status === 404) return ok({ valid: false, reason: 'No addresses found at that postcode.' });
      if (r.ok) {
        const body = (await r.json()) as { addresses?: Array<{ line_1?: string; line_2?: string; town_or_city?: string; county?: string; formatted_address?: string[] }> };
        for (const a of body.addresses ?? []) addresses.push({ line1: a.line_1 ?? '', line2: a.line_2 ?? '', town: a.town_or_city ?? '', county: a.county ?? '', postcode, label: (a.formatted_address ?? []).filter(Boolean).join(', ') });
        town = addresses[0]?.town ?? '';
        county = addresses[0]?.county ?? '';
      }
    }
    const p = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { result?: { admin_district?: string; parish?: string; region?: string; country?: string; admin_county?: string } } | null;
    if (!p?.result && !addresses.length) return ok({ valid: false, reason: 'That postcode is not in the Royal Mail database.' });
    if (p?.result) {
      town = town || (p.result.admin_district ?? '');
      county = county || (p.result.admin_county ?? p.result.region ?? '');
      country = p.result.country ?? '';
    }
    return ok({ valid: true, postcode, town, county, country, addresses });
  } catch (error) {
    return fail(error);
  }
}
