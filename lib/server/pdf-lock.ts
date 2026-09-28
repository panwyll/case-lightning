/**
 * Password-protected PDFs. Firms receive them (bank statements, ID scans, reports) with the
 * password sent separately; nothing downstream can read one until it is unlocked. mupdf
 * (WebAssembly, no native binary) tells us whether a file needs a password, unlocks it with
 * one, and can protect a PDF we are about to send.
 */

const HEAD = 4096;

async function mupdf() {
  return import('mupdf');
}

/** Cheap first look, then the real answer: does this PDF ask for a password before it can be read? */
export async function isLockedPdf(bytes: Buffer): Promise<boolean> {
  if (!bytes.subarray(0, HEAD).toString('latin1').startsWith('%PDF') && !bytes.toString('latin1').includes('%PDF')) return false;
  if (!bytes.includes('/Encrypt')) return false;
  // Encryption alone is not a password: most bank statements and official copies are encrypted only to
  // restrict printing or copying, and open for anyone. Only a reader that actually asks for a password
  // makes the file locked. A reader that fails is never taken as "locked": a second reader is asked,
  // and if neither can tell, the file is treated as open (reading it will then say what is wrong).
  try {
    const m = await mupdf();
    const doc = m.Document.openDocument(bytes, 'application/pdf');
    return doc.needsPassword();
  } catch (err) {
    console.warn('[pdf-lock] mupdf could not open the file; asking pdf.js instead', (err as Error).message);
  }
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try { await task.promise; return false; } finally { await task.destroy().catch(() => {}); }
  } catch (err) {
    const e = err as { name?: string; code?: number };
    if (e?.name === 'PasswordException') return true;
    console.warn('[pdf-lock] pdf.js could not open the file either; treating it as not password-protected', (err as Error).message);
    return false;
  }
}

/** The same PDF with the password removed, or null when the password is wrong. The original bytes are untouched. */
export async function unlockPdf(bytes: Buffer, password: string): Promise<Buffer | null> {
  const m = await mupdf();
  const doc = m.Document.openDocument(bytes, 'application/pdf') as import('mupdf').PDFDocument;
  if (!doc.needsPassword()) return bytes;
  if (!doc.authenticatePassword(password)) return null;
  return Buffer.from(doc.saveToBuffer('encrypt=none').asUint8Array());
}

/** The PDF protected with a password (AES-256): what we send when the firm's policy is to protect outgoing files. */
export async function protectPdf(bytes: Buffer, password: string): Promise<Buffer> {
  const m = await mupdf();
  const doc = m.Document.openDocument(bytes, 'application/pdf') as import('mupdf').PDFDocument;
  const esc = (s: string) => s.replace(/[,=]/g, '');
  return Buffer.from(doc.saveToBuffer(`encrypt=aes-256,user-password=${esc(password)},owner-password=${esc(password)},permissions=-1`).asUint8Array());
}

/** Candidate passwords in a message that arrived with, or after, a locked file. */
export function passwordCandidates(text: string): string[] {
  const out = new Set<string>();
  const add = (t: string) => { out.add(t); const bare = t.replace(/[.,;:!?)]+$/, ''); if (bare.length >= 4) out.add(bare); };
  for (const m of text.matchAll(/pass(?:word|code)[^\n]{0,60}?(?:\bis\b|:|=)\s*["'“”]?([^\s"'“”<>]{4,40})/gi)) add(m[1]);
  for (const m of text.matchAll(/pass(?:word|code)\s+["'“”]?([^\s"'“”<>]{4,40})/gi)) if (!/^(for|to|is|of|the|and)$/i.test(m[1])) add(m[1]);
  for (const m of text.matchAll(/^\s*([A-Za-z0-9!@#$%^&*_+-]{6,32})\s*$/gm)) if (/\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) out.add(m[1]);
  return [...out].slice(0, 10);
}

/** A password we generate for an outgoing file: memorable enough to read out, not guessable. */
export function generatePassword(): string {
  const words = ['oak', 'river', 'stone', 'meadow', 'harbour', 'copper', 'willow', 'summit', 'garden', 'lantern', 'orchard', 'maple'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${pick()}-${pick()}-${n}`;
}
