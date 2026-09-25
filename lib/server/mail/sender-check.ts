/**
 * Is this email really from who it says? Conveyancing is the most targeted sector for
 * email fraud in the UK: a message that looks like it is from the other side's solicitor,
 * sent from a look-alike domain or with a forged From, is how completion money gets
 * diverted. So before the sender counts as evidence of which case an email belongs to,
 * it has to survive four checks:
 *
 *   1. Authentication — the receiving server's verdict (Authentication-Results: DMARC,
 *      SPF, DKIM, and Microsoft's composite "compauth"). A failure means the From line
 *      was not sent by that domain.
 *   2. Look-alike domain — one character off, or a lookalike glyph, from a domain this
 *      firm deals with (bart1ett-law.co.uk for bartlett-law.co.uk), or the same name on a
 *      different ending (.co for .co.uk).
 *   3. Display name — the name is one we know (a contact on a case, or someone in the
 *      firm) but the address behind it is not theirs.
 *   4. Reply-To — replies would go to a different domain from the sender's.
 *
 * Any of these makes the sender untrusted: the sender no longer counts towards a match,
 * the match can never be green, and the row says why in plain words.
 */

export type SenderVerdict = 'ok' | 'unverified' | 'suspicious';
export interface SenderCheck { verdict: SenderVerdict; warnings: string[] }

export interface SenderInput {
  fromName: string | null;
  fromAddress: string | null;
  replyTo: string[];
  /** internetMessageHeaders from Graph, when they could be read. */
  headers: Array<{ name: string; value: string }> | null;
}

export interface KnownParties {
  /** Addresses we hold, with the name they go by: case contacts and the firm's own people. */
  contacts: Array<{ email: string; name: string | null }>;
  /** Domains the firm deals with: its own and every case contact's. */
  domains: string[];
}

const domainOf = (a: string | null | undefined) => (a?.split('@')[1] ?? '').toLowerCase().replace(/[>\s]+$/, '') || null;

/** The receiving server's verdict, from every Authentication-Results header on the message. */
export function authVerdict(headers: SenderInput['headers']): 'pass' | 'fail' | 'none' {
  if (!headers?.length) return 'none';
  const results = headers.filter((h) => /^(arc-)?authentication-results$/i.test(h.name)).map((h) => h.value.toLowerCase());
  if (!results.length) return 'none';
  const all = results.join(' ; ');
  if (/\bdmarc=fail\b|\bcompauth=fail\b/.test(all)) return 'fail';
  if (/\bdmarc=pass\b|\bcompauth=pass\b/.test(all)) return 'pass';
  if (/\bspf=(fail|softfail)\b/.test(all) && !/\bdkim=pass\b/.test(all)) return 'fail';
  if (/\bspf=pass\b|\bdkim=pass\b/.test(all)) return 'pass';
  return 'none';
}

/** Letters people and fraudsters swap: 1/l/i, 0/o, rn/m, vv/w, and the like. */
function skeleton(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[1il|]/g, 'l')
    .replace(/0/g, 'o')
    .replace(/5/g, 's')
    .replace(/-/g, '');
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const stem = (d: string) => d.replace(/\.(co\.uk|org\.uk|ltd\.uk|com|co|uk|net|org|law|legal|io)$/i, '');

/** The known domain this one is imitating, if any. Identical domains are not look-alikes. */
export function lookalikeOf(domain: string, known: string[]): string | null {
  const d = domain.toLowerCase();
  for (const k of known) {
    const kk = k.toLowerCase();
    if (!kk || kk === d) continue;
    if (skeleton(kk) === skeleton(d)) return kk;
    if (stem(kk) === stem(d) && stem(kk).length >= 4) return kk; // same name, different ending
    if (kk.length >= 8 && editDistance(stem(kk), stem(d)) === 1) return kk;
  }
  return null;
}

export function checkSender(input: SenderInput, known: KnownParties): SenderCheck {
  const warnings: string[] = [];
  const from = input.fromAddress?.toLowerCase() ?? null;
  const fromDomain = domainOf(from);
  let suspicious = false;

  const auth = authVerdict(input.headers);
  if (auth === 'fail') {
    suspicious = true;
    warnings.push(`This email failed the checks that prove it came from ${fromDomain ?? 'the sender'}: the sender may be forged.`);
  }

  const isKnownDomain = !!fromDomain && known.domains.includes(fromDomain);
  const imitates = fromDomain && !isKnownDomain ? lookalikeOf(fromDomain, known.domains) : null;
  if (imitates) {
    suspicious = true;
    warnings.push(`Sent from ${fromDomain}, which looks like ${imitates} but is not the same address.`);
  }

  const name = input.fromName?.trim().toLowerCase();
  if (name && from && name.length > 3 && !name.includes('@')) {
    const sameName = known.contacts.filter((c) => c.name && c.name.trim().toLowerCase() === name);
    if (sameName.length && !sameName.some((c) => c.email.toLowerCase() === from)) {
      suspicious = true;
      warnings.push(`Signed "${input.fromName}", but ${input.fromName} is on file as ${sameName[0].email}, not ${from}.`);
    }
  }

  const replyDomains = input.replyTo.map(domainOf).filter((d): d is string => !!d && d !== fromDomain);
  if (replyDomains.length) {
    suspicious = true;
    warnings.push(`Replies would go to ${input.replyTo.find((r) => domainOf(r) === replyDomains[0])}, not the sender's own address.`);
  }

  return { verdict: suspicious ? 'suspicious' : auth === 'pass' ? 'ok' : 'unverified', warnings };
}
