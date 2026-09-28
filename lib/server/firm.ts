/**
 * The firm's own details: where signed originals are posted, the phone and SRA number an email
 * footer carries. Set on the Team page; empty fields are simply left out.
 */
import { query, queryOne } from './db';

export interface FirmProfile {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  town: string | null;
  postcode: string | null;
  phone: string | null;
  sraNumber: string | null;
  website: string | null;
  /** An https image the signature shows beside the firm's details. */
  logoUrl?: string | null;
  /** A standing line under every signature (e.g. "We will never change our bank details by email"). */
  signatureNotice?: string | null;
}

export async function getFirmProfile(tenantId: string): Promise<FirmProfile> {
  type Row = { name: string; address_line1: string | null; address_line2: string | null; town: string | null; postcode: string | null; phone: string | null; sra_number: string | null; website: string | null; logo_url?: string | null; signature_notice?: string | null };
  const base = `name, address_line1, address_line2, town, postcode, phone, sra_number, website`;
  // After migration 105 the logo and notice too; before it, without them; before 102, the name alone.
  const r = (await queryOne<Row>(`select ${base}, logo_url, signature_notice from tenant where id = $1`, [tenantId]).catch(() => null))
    ?? (await queryOne<Row>(`select ${base} from tenant where id = $1`, [tenantId]).catch(() => null));
  if (!r) {
    const n = await queryOne<{ name: string }>(`select name from tenant where id = $1`, [tenantId]).catch(() => null);
    return { name: n?.name ?? '', addressLine1: null, addressLine2: null, town: null, postcode: null, phone: null, sraNumber: null, website: null, logoUrl: null, signatureNotice: null };
  }
  return { name: r.name, addressLine1: r.address_line1, addressLine2: r.address_line2, town: r.town, postcode: r.postcode, phone: r.phone, sraNumber: r.sra_number, website: r.website, logoUrl: r.logo_url ?? null, signatureNotice: r.signature_notice ?? null };
}

export async function saveFirmProfile(tenantId: string, p: Partial<FirmProfile>): Promise<FirmProfile> {
  const cur = await getFirmProfile(tenantId);
  const v = { ...cur, ...p };
  const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
  await query(
    `update tenant set name = $2, address_line1 = $3, address_line2 = $4, town = $5, postcode = $6, phone = $7, sra_number = $8, website = $9 where id = $1`,
    [tenantId, v.name.trim() || cur.name, blank(v.addressLine1), blank(v.addressLine2), blank(v.town), blank(v.postcode)?.toUpperCase() ?? null, blank(v.phone), blank(v.sraNumber), blank(v.website)]
  );
  if (p.logoUrl !== undefined || p.signatureNotice !== undefined) {
    await query(`update tenant set logo_url = $2, signature_notice = $3 where id = $1`, [tenantId, blank(v.logoUrl ?? null), blank(v.signatureNotice ?? null)])
      .catch((e) => { throw Object.assign(new Error(`Could not save the logo or notice (has migration 105 been run?): ${(e as Error).message}`), { status: 500 }); });
  }
  return getFirmProfile(tenantId);
}

/** The postal address as lines, or null when none is set. */
export function postalAddress(p: FirmProfile): string[] | null {
  const lines = [p.addressLine1, p.addressLine2, p.town, p.postcode].map((x) => x?.trim()).filter(Boolean) as string[];
  return lines.length >= 2 ? [p.name, ...lines] : null;
}

/** The lines under a signature: address, phone, website, and the firm's regulated status. */
export function firmFooter(p: FirmProfile): string {
  const addr = [p.addressLine1, p.addressLine2, p.town, p.postcode].map((x) => x?.trim()).filter(Boolean).join(', ');
  return [
    addr || null,
    [p.phone ? `T: ${p.phone}` : null, p.website ? p.website.replace(/^https?:\/\//, '') : null].filter(Boolean).join(' · ') || null,
    p.sraNumber ? `Authorised and regulated by the Solicitors Regulation Authority (SRA number ${p.sraNumber})` : null,
  ].filter(Boolean).join('\n');
}
