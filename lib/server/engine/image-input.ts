/**
 * Photos as the model can read them. Claude takes JPEG, PNG, GIF and WebP up to about 5 MB;
 * clients send iPhone HEIC photos, TIFF scans and 12-megapixel pictures. Anything else is turned
 * into a JPEG, upright (EXIF), no longer than 2,000 px on its long side. The original file is
 * untouched; only what the model is shown changes.
 */
import type { EngineDocumentInput } from './llm';

const DIRECT = /^image\/(jpeg|png|gif|webp)$/i;
const MAX_BYTES = 3_500_000; // base64 grows by a third; the API limit is 5 MB encoded
const MAX_SIDE = 2000;

/** A HEIC / HEIF picture, whatever it was labelled: the ISO box brand says so. */
export function isHeic(bytes: Buffer, mime = '', name = ''): boolean {
  if (/heic|heif/i.test(mime) || /\.(heic|heif)$/i.test(name)) return true;
  const brand = bytes.subarray(4, 12).toString('latin1');
  return /^ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(brand);
}

export function isImageFile(bytes: Buffer, mime = '', name = ''): boolean {
  return /^image\//i.test(mime) || /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(name) || isHeic(bytes, mime, name);
}

async function heicToRaw(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const decode = (await import('heic-decode')).default;
  const img = await decode({ buffer: bytes });
  return { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
}

/** The picture as a model input; throws with a plain reason when it cannot be opened. */
export async function imageInput(bytes: Buffer, mime = '', name = ''): Promise<EngineDocumentInput> {
  const title = name || undefined;
  const heic = isHeic(bytes, mime, name);
  if (!heic && DIRECT.test(mime) && bytes.length <= MAX_BYTES) return { kind: 'image', data: bytes.toString('base64'), mimeType: mime, title };
  const sharp = (await import('sharp')).default;
  let pipeline;
  if (heic) {
    let raw;
    try { raw = await heicToRaw(bytes); } catch (err) { throw new Error(`the HEIC photo could not be opened (${(err as Error).message.slice(0, 80)})`); }
    pipeline = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });
  } else {
    pipeline = sharp(bytes, { failOn: 'none' }).rotate();
  }
  const out = await pipeline.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { kind: 'image', data: out.toString('base64'), mimeType: 'image/jpeg', title };
}
