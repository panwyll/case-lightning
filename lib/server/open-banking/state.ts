/**
 * The `state` that goes to the bank and comes back: the connection's id, signed, so a callback can
 * only finish a connection we started (and the form's own secret link never leaves the browser).
 */
import crypto from 'node:crypto';
import { config } from '../config';

const sign = (id: string) => crypto.createHmac('sha256', config.sessionJwtSecret ?? 'dev-only').update(`ob:${id}`).digest('base64url').slice(0, 32);
export const connectionState = (connectionId: string): string => `${connectionId}.${sign(connectionId)}`;
/** The connection id a state names, or null if it was not signed by us. */
export function readState(state: string | null | undefined): string | null {
  const [id, mac] = (state ?? '').split('.');
  if (!id || !mac || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const want = sign(id);
  return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac)) ? id : null;
}
/** The one callback every provider sends the client back to (registered with the provider). */
export const callbackUrl = (): string => `${config.appUrl.replace(/\/$/, '')}/api/v1/open-banking/callback`;
