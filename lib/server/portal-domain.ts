/**
 * A firm's own address for its clients' pages (migration 137, lib/client-host.ts): portal.theirfirm.co.uk.
 *
 * The firm types the address; we add it to the hosting project (Vercel's API), which tells us the DNS record the
 * firm must add and, once that is in place, issues the certificate. Until Vercel reports it verified and correctly
 * pointed, links keep going out on our address; from then on every new portal, file and proof-of-funds link uses
 * theirs. Links already sent keep working on ours.
 */
import { query, queryOne, runAsSystem } from './db';
import { config } from './config';
import { isOwnHost, plainHost } from '../client-host';

export interface DnsRecord { type: 'CNAME' | 'A' | 'TXT'; name: string; value: string }
export interface PortalDomainStatus {
  domain: string | null;
  live: boolean;
  /** What the firm still has to add to its DNS, exactly; empty once it is live. */
  records: DnsRecord[];
  /** Whether we can add addresses at all (the hosting API is configured). */
  available: boolean;
}

const API = 'https://api.vercel.com';
const available = () => !!(config.vercelApiToken && config.vercelProjectId);
const q = () => (config.vercelTeamId ? `?teamId=${encodeURIComponent(config.vercelTeamId)}` : '');

async function vercel<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(`${API}${path}${q()}`, { method, headers: { Authorization: `Bearer ${config.vercelApiToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = (await r.json().catch(() => ({}))) as T;
  return { status: r.status, json };
}

const project = () => `/v9/projects/${encodeURIComponent(config.vercelProjectId!)}/domains`;
/** The name to put in the DNS record: "portal" for portal.firm.co.uk at firm.co.uk; the whole name when we cannot tell. */
const label = (domain: string, apex: string | undefined) => (apex && domain.endsWith(`.${apex}`) ? domain.slice(0, -apex.length - 1) : domain === apex ? '@' : domain);

type ProjectDomain = { name: string; apexName?: string; verified: boolean; verification?: Array<{ type: string; domain: string; value: string }>; error?: { code: string; message: string } };
type DomainConfig = { misconfigured: boolean; recommendedCNAME?: Array<{ rank: number; value: string }>; recommendedIPv4?: Array<{ rank: number; value: string[] }> };

/** Where things stand for the firm's address, from Vercel, recording it live (or not) as it goes. */
export async function portalDomainStatus(tenantId: string): Promise<PortalDomainStatus> {
  const t = await queryOne<{ portal_domain: string | null; portal_domain_live_at: string | null }>(`select portal_domain, portal_domain_live_at from tenant where id = $1`, [tenantId]);
  const domain = t?.portal_domain ?? null;
  if (!domain) return { domain: null, live: false, records: [], available: available() };
  if (!available()) return { domain, live: !!t?.portal_domain_live_at, records: [], available: false };
  let pd = (await vercel<ProjectDomain>('GET', `${project()}/${domain}`)).json;
  if (!pd.verified) {
    await vercel('POST', `${project()}/${domain}/verify`).catch(() => null);
    pd = (await vercel<ProjectDomain>('GET', `${project()}/${domain}`)).json;
  }
  const cfg = (await vercel<DomainConfig>('GET', `/v6/domains/${domain}/config`)).json;
  const records: DnsRecord[] = [];
  // Proof the firm owns the name, when Vercel asks for it (the name is already in use on another Vercel account).
  for (const v of pd.verification ?? []) if (!pd.verified) records.push({ type: v.type === 'TXT' ? 'TXT' : 'CNAME', name: label(v.domain, pd.apexName), value: v.value });
  if (cfg.misconfigured !== false) {
    const apex = domain === pd.apexName;
    if (apex) records.push({ type: 'A', name: '@', value: [...(cfg.recommendedIPv4 ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value?.[0] ?? '76.76.21.21' });
    else records.push({ type: 'CNAME', name: label(domain, pd.apexName), value: [...(cfg.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value?.replace(/\.$/, '') ?? 'cname.vercel-dns.com' });
  }
  const live = !!pd.verified && cfg.misconfigured === false;
  if (live !== !!t?.portal_domain_live_at) await query(`update tenant set portal_domain_live_at = ${live ? 'now()' : 'null'} where id = $1`, [tenantId]);
  return { domain, live, records: live ? [] : records, available: true };
}

/** Take an address for the firm: checked, added to the hosting project, then its status (the DNS record to add). */
export async function connectPortalDomain(tenantId: string, input: string): Promise<PortalDomainStatus> {
  const domain = plainHost(input);
  if (!domain) throw Object.assign(new Error('That is not a web address. Type it like portal.yourfirm.co.uk'), { status: 400 });
  if (isOwnHost(domain, config.appUrl)) throw Object.assign(new Error('That address is ours. Use one on your firm’s own domain, like portal.yourfirm.co.uk'), { status: 400 });
  if (!available()) throw Object.assign(new Error('Your own address cannot be set up yet. Ask us and we will turn it on.'), { status: 503 });
  const taken = await queryOne<{ id: string }>(`select id from tenant where portal_domain = $1 and id <> $2`, [domain, tenantId]);
  if (taken) throw Object.assign(new Error('That address is already in use.'), { status: 409 });
  const cur = await queryOne<{ portal_domain: string | null }>(`select portal_domain from tenant where id = $1`, [tenantId]);
  if (cur?.portal_domain && cur.portal_domain !== domain) await removePortalDomain(tenantId);
  const add = await vercel<ProjectDomain>('POST', `/v10/projects/${encodeURIComponent(config.vercelProjectId!)}/domains`, { name: domain });
  // Already on the project (connecting again) is fine; anything else is Vercel saying no, in its words.
  if (add.status >= 400 && add.json.error?.code !== 'domain_already_in_use_by_project' && add.json.error?.code !== 'domain_already_exists') {
    throw Object.assign(new Error(add.json.error?.message ?? 'The address could not be added. Try again, or ask us.'), { status: 502 });
  }
  await query(`update tenant set portal_domain = $2, portal_domain_live_at = null where id = $1`, [tenantId, domain]);
  return portalDomainStatus(tenantId);
}

/** Back to our address: removed from the project and from the firm. New links use ours at once. */
export async function removePortalDomain(tenantId: string): Promise<PortalDomainStatus> {
  const t = await queryOne<{ portal_domain: string | null }>(`select portal_domain from tenant where id = $1`, [tenantId]);
  if (t?.portal_domain && available()) await vercel('DELETE', `${project()}/${t.portal_domain}`).catch(() => null);
  await query(`update tenant set portal_domain = null, portal_domain_live_at = null where id = $1`, [tenantId]);
  return { domain: null, live: false, records: [], available: available() };
}

/** Where a firm's client links start: its own address once live, else ours. Before migration 137, ours. */
export async function clientBase(tenantId: string): Promise<string> {
  const t = await runAsSystem(() => queryOne<{ portal_domain: string | null; portal_domain_live_at: string | null }>(`select portal_domain, portal_domain_live_at from tenant where id = $1`, [tenantId])).catch(() => null);
  return t?.portal_domain && t.portal_domain_live_at ? `https://${t.portal_domain}` : config.appUrl.replace(/\/$/, '');
}

/** Whether a client page may be served for this firm on this address: ours always; a firm's own only for that firm. */
export async function hostServesTenant(host: string | null, tenantId: string): Promise<boolean> {
  if (!host || isOwnHost(host, config.appUrl)) return true;
  const t = await runAsSystem(() => queryOne<{ portal_domain: string | null }>(`select portal_domain from tenant where id = $1`, [tenantId])).catch(() => null);
  return !!t?.portal_domain && t.portal_domain === host.toLowerCase().replace(/:\d+$/, '');
}

/**
 * For the request being answered: one firm's link never opens on another firm's address (a client of one firm must
 * not see another's case under a name they trust). Outside a request (tests, jobs) there is no address to check.
 */
export async function servedHere(tenantId: string): Promise<boolean> {
  let host: string | null;
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    host = h.get('x-forwarded-host') ?? h.get('host');
  } catch {
    return true;
  }
  return hostServesTenant(host, tenantId);
}
