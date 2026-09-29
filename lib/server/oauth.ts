import { config } from './config';

function tokenEndpoint(): string {
  return `https://login.microsoftonline.com/${config.azureTenantId}/oauth2/v2.0/token`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

function authScopes(): string {
  const scopes = new Set([...config.graphScopes, 'openid', 'profile', 'email', 'offline_access']);
  return Array.from(scopes).join(' ');
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${json.error ?? 'unknown'} ${json.error_description ?? ''}`);
  }
  return json;
}

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  return postToken({
    grant_type: 'authorization_code',
    client_id: config.azureClientId!,
    client_secret: config.azureClientSecret!,
    redirect_uri: config.azureRedirectUri,
    code,
    scope: authScopes(),
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return postToken({
    grant_type: 'refresh_token',
    client_id: config.azureClientId!,
    client_secret: config.azureClientSecret!,
    refresh_token: refreshToken,
    scope: authScopes(),
  });
}

/**
 * Microsoft's admin-consent screen: an IT admin approves CONVEYi for the whole firm in one
 * go, so staff whose Microsoft 365 blocks user consent can sign in. `.default` asks for
 * exactly what the app registration lists (never a scope that is not on it). Microsoft
 * returns to the normal callback with ?admin_consent=True (or ?error=…) and our state,
 * prefixed `ac.` so the callback knows which leg it is.
 */
export function getAdminConsentUrl(state: string): string {
  const qs = new URLSearchParams({
    client_id: config.azureClientId!,
    redirect_uri: config.azureRedirectUri,
    scope: 'https://graph.microsoft.com/.default',
    state,
  });
  return `https://login.microsoftonline.com/organizations/v2.0/adminconsent?${qs.toString()}`;
}

export function getAuthUrl(state: string, prompt?: 'consent' | 'select_account'): string {
  const base = `https://login.microsoftonline.com/${config.azureTenantId}/oauth2/v2.0/authorize`;
  const qs = new URLSearchParams({
    client_id: config.azureClientId!,
    response_type: 'code',
    redirect_uri: config.azureRedirectUri,
    response_mode: 'query',
    scope: authScopes(),
    state,
  });
  // `prompt=consent` forces the consent screen — used by the "reconnect" path after a
  // scope was added, so the user (or admin) actually re-grants instead of hitting a
  // silent AADSTS65001 dead end.
  if (prompt) qs.set('prompt', prompt);
  return `${base}?${qs.toString()}`;
}
