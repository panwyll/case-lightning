/**
 * A photo or scan of a client's identity document, read by us. It is never a completed ID/AML
 * check: it goes to a person with what it shows (what the document is, whose name, whether it
 * is in date and readable) set against the clients on the case. A provider (InfoTrack, …)
 * replaces this; nothing here pretends to be one.
 */
import type { Flag, IdCheckFacts } from './types';

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'dame', 'rev', 'lord', 'lady']);
const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s'-]/g, ' ').split(/[\s'-]+/).filter((w) => w && !TITLES.has(w));

/** A client name read off a joint string ("Tomasz & Ewa Nowak") becomes one name per person. */
export function splitClientNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const parts = n.split(/\s*(?:&|\band\b|,)\s*/i).map((p) => p.trim()).filter(Boolean);
    const surname = parts.length > 1 ? parts[parts.length - 1].split(/\s+/).slice(-1)[0] : null;
    for (const p of parts) out.push(surname && p.split(/\s+/).length === 1 ? `${p} ${surname}` : p);
  }
  return out;
}

/** The document names this client when the surname and the first given name both appear on it. */
export function nameMatches(onDocument: string, client: string): boolean {
  const doc = new Set(words(onDocument));
  const c = words(client);
  if (!c.length || !doc.size) return false;
  return doc.has(c[c.length - 1]) && doc.has(c[0]);
}

const TYPE: Record<string, string> = { passport: 'Passport', driving_licence: 'Driving licence', national_identity_card: 'Identity card', residence_permit: 'Residence permit', other: 'Identity document' };
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** What a person needs to see, as flags; the name check is recorded on the facts. */
export function reviewIdDocument(facts: IdCheckFacts, clients: string[], now = new Date()): IdCheckFacts {
  if (facts.source !== 'document') return facts;
  const flags: Flag[] = [];
  const i = facts.identity;
  if (facts.notIdentity || !i) {
    flags.push({ code: 'ID_NOT_IDENTITY_DOCUMENT', severity: 'high', description: 'The file sent as ID is not an identity document.' });
    return { ...facts, flags, nameCheck: null };
  }
  const people = splitClientNames(clients);
  const who = people.find((c) => nameMatches(i.fullName, c)) ?? null;
  if (!who) flags.push({ code: 'ID_NAME_MISMATCH', severity: 'high', description: people.length ? `${TYPE[i.documentType]} in the name of ${i.fullName}; the client${people.length > 1 ? 's are' : ' is'} ${people.join(' and ')}.` : `${TYPE[i.documentType]} in the name of ${i.fullName}; no client name is on the case to check it against.` });
  if (i.expiryDate && /^\d{4}-\d{2}-\d{2}$/.test(i.expiryDate) && new Date(`${i.expiryDate}T23:59:59Z`) < now) flags.push({ code: 'ID_DOCUMENT_EXPIRED', severity: 'high', description: `Expired on ${day(i.expiryDate)}.` });
  if (i.signsOfAlteration.length) flags.push({ code: 'ID_DOCUMENT_ALTERED', severity: 'high', description: `May have been altered: ${i.signsOfAlteration.join('; ')}.` });
  const unclear = [!i.photoPresent ? 'no photo visible' : null, !i.wholeDocumentVisible ? 'not the whole document' : null, i.legibility === 'poor' || i.legibility === 'unreadable' ? 'hard to read' : null].filter(Boolean);
  if (unclear.length) flags.push({ code: 'ID_DOCUMENT_UNCLEAR', severity: 'medium', description: `The photo shows ${unclear.join(', ')}; ask for a clearer one.` });
  return { ...facts, flags, nameCheck: { client: who, matches: !!who } };
}

/** One line on what the document is: "Passport, Priya Shah, expires 3 Mar 2031". */
export function describeIdDocument(facts: IdCheckFacts): string {
  const i = facts.identity;
  if (facts.notIdentity || !i) return 'Not an identity document';
  return [TYPE[i.documentType], i.fullName, i.issuingCountry, i.expiryDate ? `expires ${day(i.expiryDate)}` : 'no expiry date read'].filter(Boolean).join(', ');
}

export { day as idDay, TYPE as ID_DOCUMENT_TYPE };
