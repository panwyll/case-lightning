/**
 * How a firm runs CONVEYi (docs/spec/variants.md "System mode"): as the whole case system, or
 * alongside the practice system it already has (LEAP, InTouch). The mode sets each feature's
 * default; a firm can turn any feature on or off against it. Stored as firm policy (tenant_policy):
 * `systemMode`, and `features` for the overrides. Missing rows are the defaults.
 */
import { getPolicy, setPolicy } from './policy';

export type SystemMode = 'standalone' | 'alongside';
export const SYSTEM_MODE_LABEL: Record<SystemMode, string> = { standalone: 'The Whole Case System', alongside: 'Alongside LEAP Or InTouch' };

export interface FeatureSpec { label: string; standalone: boolean; alongside: boolean }
/** Each feature, and whether it is on by default in each mode. */
export const FEATURES = {
  clientPortal: { label: 'Client Portal', standalone: true, alongside: false },
  orderSearches: { label: 'Order Searches From CONVEYi', standalone: true, alongside: false },
  orderIdChecks: { label: 'Order ID Checks From CONVEYi', standalone: true, alongside: false },
  satisfactionSurveys: { label: 'Ask Clients How We Did', standalone: true, alongside: true },
} satisfies Record<string, FeatureSpec>;
export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export interface FirmFeatures {
  mode: SystemMode;
  flags: Record<FeatureKey, { on: boolean; byDefault: boolean; overridden: boolean }>;
}

/** Pure: the mode's defaults with the firm's overrides on top. */
export function resolveFeatures(mode: SystemMode, overrides: Partial<Record<string, boolean>>): FirmFeatures {
  const flags = {} as FirmFeatures['flags'];
  for (const k of FEATURE_KEYS) {
    const byDefault = FEATURES[k][mode];
    const o = overrides[k];
    flags[k] = { on: typeof o === 'boolean' ? o : byDefault, byDefault, overridden: typeof o === 'boolean' && o !== byDefault };
  }
  return { mode, flags };
}

export async function firmFeatures(tenantId: string): Promise<FirmFeatures> {
  const [mode, overrides] = await Promise.all([getPolicy(tenantId, 'systemMode'), getPolicy(tenantId, 'features')]);
  return resolveFeatures(mode, overrides ?? {});
}

export async function featureOn(tenantId: string, key: FeatureKey): Promise<boolean> {
  return (await firmFeatures(tenantId)).flags[key].on;
}

/** Change the mode (overrides kept, so a firm's own choices survive), or one feature (back to the default clears it). */
export async function setSystemMode(tenantId: string, mode: SystemMode, userId: string | null): Promise<void> {
  await setPolicy(tenantId, 'systemMode', mode, userId);
}
export async function setFeature(tenantId: string, key: FeatureKey, on: boolean, userId: string | null): Promise<void> {
  const cur = { ...((await getPolicy(tenantId, 'features')) ?? {}) };
  const mode = await getPolicy(tenantId, 'systemMode');
  if (on === FEATURES[key][mode]) delete cur[key];
  else cur[key] = on;
  await setPolicy(tenantId, 'features', cur, userId);
}
