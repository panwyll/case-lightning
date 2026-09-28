/**
 * The email signature. Mail sent through Microsoft Graph does not carry the sender's Outlook
 * signature (Outlook adds that in its own compose window), so the app signs every email itself:
 * the person over the firm, as HTML for the email and as plain lines for a text channel.
 *
 * A template ends with its sign-off ("Kind regards,\nJo Bloggs\nSmith & Co"); the name lines
 * are taken off and the signature goes in their place, so the name is not said twice.
 */
import { queryOne } from './db';
import { getFirmProfile, type FirmProfile } from './firm';
import { sanitizeSignatureHtml } from './html-sanitize';
import { htmlToText } from './text';

export interface SignaturePerson { name: string | null; jobTitle: string | null; phone: string | null; email: string | null; /** Their own signature, pasted as rendered HTML and stored cleaned; null = the firm's standard. */ signatureHtml?: string | null }
export interface Signature { text: string; html: string; names: string[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const siteHref = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`);

export async function getSignaturePerson(tenantId: string, userId: string | null): Promise<SignaturePerson> {
  if (!userId) return { name: null, jobTitle: null, phone: null, email: null };
  const r = await queryOne<{ display_name: string | null; email: string | null; job_title: string | null; phone: string | null; signature_html?: string | null }>(
    `select display_name, email, job_title, phone, signature_html from app_user where id = $1 and tenant_id = $2`, [userId, tenantId]
  ).catch(() => queryOne<{ display_name: string | null; email: string | null; job_title: string | null; phone: string | null }>(
    // Before migration 107: no pasted signature.
    `select display_name, email, job_title, phone from app_user where id = $1 and tenant_id = $2`, [userId, tenantId]
  )).catch(async () => {
    // Before migration 105: name and email only.
    const b = await queryOne<{ display_name: string | null; email: string | null }>(`select display_name, email from app_user where id = $1 and tenant_id = $2`, [userId, tenantId]).catch(() => null);
    return b ? { ...b, job_title: null, phone: null } : null;
  });
  return { name: clean(r?.display_name) ?? clean(r?.email), jobTitle: clean(r?.job_title), phone: clean(r?.phone), email: clean(r?.email), signatureHtml: clean((r as { signature_html?: string | null } | null)?.signature_html) };
}

export function buildSignature(firm: FirmProfile, person: SignaturePerson): Signature {
  // Their own pasted signature, as they made it; the firm's standing notice still goes under it.
  if (person.signatureHtml) {
    const own = sanitizeSignatureHtml(person.signatureHtml);
    const notice = clean(firm.signatureNotice);
    const html = `<div style="margin-top:18px">${own}</div>${notice ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#b45309;margin-top:6px;font-weight:600">${esc(notice).replace(/\n/g, '<br>')}</div>` : ''}`;
    const text = [htmlToText(own), notice].filter(Boolean).join('\n');
    return { text, html, names: [person.name, firm.name].map(clean).filter((x): x is string => !!x) };
  }
  return standardSignature(firm, person);
}

/** The firm's standard signature, built from the firm's details and the person's name. */
export function standardSignature(firm: FirmProfile, person: SignaturePerson): Signature {
  const addr = [firm.addressLine1, firm.addressLine2, firm.town, firm.postcode].map(clean).filter(Boolean).join(', ');
  const sra = firm.sraNumber ? `Authorised and regulated by the Solicitors Regulation Authority (SRA number ${firm.sraNumber})` : null;
  const phones = [person.phone ? `D: ${person.phone}` : null, firm.phone ? `T: ${firm.phone}` : null].filter(Boolean).join(' · ');
  const text = [
    [person.name, person.jobTitle].filter(Boolean).join(', ') || null,
    firm.name || null,
    addr || null,
    [phones || null, firm.website ? firm.website.replace(/^https?:\/\//, '') : null].filter(Boolean).join(' · ') || null,
    sra,
    clean(firm.signatureNotice),
  ].filter(Boolean).join('\n');

  const a = (href: string, label: string) => `<a href="${esc(href)}" style="color:#5A27E0;text-decoration:none">${esc(label)}</a>`;
  const links = [person.email ? a(`mailto:${person.email}`, person.email) : null, firm.website ? a(siteHref(firm.website), firm.website.replace(/^https?:\/\//, '')) : null].filter(Boolean).join(' · ');
  const line = (s: string, style = '') => `<div style="${style}">${s}</div>`;
  const logo = firm.logoUrl && /^https:\/\//i.test(firm.logoUrl) ? `<td style="padding:0 14px 0 0;vertical-align:top"><img src="${esc(firm.logoUrl)}" alt="${esc(firm.name)}" style="max-width:96px;max-height:64px;display:block;border:0"></td>` : '';
  const html = [
    '<table cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;line-height:1.45;color:#334155;border-collapse:collapse"><tr>',
    logo,
    '<td style="vertical-align:top;border-left:3px solid #5A27E0;padding:0 0 0 12px">',
    person.name ? line(esc(person.name), 'font-weight:700;font-size:14px;color:#0f172a') : '',
    person.jobTitle ? line(esc(person.jobTitle), 'color:#64748b') : '',
    firm.name ? line(esc(firm.name), 'font-weight:600;color:#0f172a;margin-top:4px') : '',
    addr ? line(esc(addr)) : '',
    phones ? line(esc(phones)) : '',
    links ? line(links) : '',
    '</td></tr></table>',
    sra ? line(esc(sra), 'font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#94a3b8;margin-top:10px') : '',
    clean(firm.signatureNotice) ? line(esc(firm.signatureNotice!.trim()).replace(/\n/g, '<br>'), 'font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#b45309;margin-top:6px;font-weight:600') : '',
  ].join('');
  return { text, html, names: [person.name, firm.name].map(clean).filter((x): x is string => !!x) };
}

export async function signatureFor(tenantId: string, userId: string | null): Promise<Signature> {
  const [firm, person] = await Promise.all([getFirmProfile(tenantId), getSignaturePerson(tenantId, userId)]);
  return buildSignature(firm, person);
}

/** The body without its trailing name lines (the signature says them), and without a footer the firm pasted into a template. */
export function stripSignOff(body: string, names: string[]): string {
  const lines = body.trimEnd().split('\n');
  const lc = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  while (lines.length && (lc.has(lines[lines.length - 1].trim().toLowerCase()) || lines[lines.length - 1].trim() === '')) lines.pop();
  return lines.join('\n');
}

const escapeText = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

/** An email body as HTML, signed. */
export function signedHtml(body: string, sig: Signature | null | undefined): string {
  const text = sig ? stripSignOff(body, sig.names) : body;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${escapeText(text).replace(/\n/g, '<br>')}</div>${sig ? sig.html : ''}`;
}

/** The same, as plain text (a text-only channel, and the record of what went). */
export function signedText(body: string, sig: Signature | null | undefined): string {
  if (!sig || !sig.text) return body;
  return `${stripSignOff(body, sig.names)}\n\n${sig.text}`;
}
