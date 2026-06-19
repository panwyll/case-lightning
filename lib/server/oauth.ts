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

export function getAuthUrl(state: string): string {
  const base = `https://login.microsoftonline.com/${config.azureTenantId}/oauth2/v2.0/authorize`;
  const qs = new URLSearchParams({
    client_id: config.azureClientId!,
    response_type: 'code',
    redirect_uri: config.azureRedirectUri,
    response_mode: 'query',
    scope: authScopes(),
    state,
  });
  return `${base}?${qs.toString()}`;
}
