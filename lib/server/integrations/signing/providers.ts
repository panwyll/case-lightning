/**
 * Electronic signing providers. InfoTrack (SignIT), InTouch and LEAP each offer e-signing that
 * HM Land Registry accepts under Practice Guide 82 when it is set up as a witnessed electronic
 * signature. Their APIs are behind partner registration, so each is a stub with the shape the
 * engine needs: create an envelope for one deed, and a webhook (app/api/v1/integrations/<p>/signing)
 * that reports it signed with the signed copy. Until a provider is connected it refuses with a
 * plain reason and the pack falls back to wet ink for that deed.
 */
import type { SignedDocument } from '../../engine/types';

export interface EnvelopeRequest {
  tenantId: string;
  matterId: string;
  document: SignedDocument;
  fileName: string;
  bytes: Buffer;
  signers: string[];
  /** Witnessed electronic signature: the witness is physically present and signs too. */
  witnessRequired: boolean;
  callbackUrl: string;
}
export interface SigningProviderAdapter {
  readonly id: string;
  readonly label: string;
  configured(): boolean;
  createEnvelope(req: EnvelopeRequest): Promise<{ envelopeId: string }>;
}

export class SigningNotConnectedError extends Error {
  constructor(label: string, env: string) {
    super(`${label} e-signing is not connected yet (set ${env}); this deed goes for wet-ink signature instead.`);
    this.name = 'SigningNotConnectedError';
  }
}

/** A provider whose API is not wired yet: the env var it will need, and a refusal until then. */
function stub(id: string, label: string, env: string): SigningProviderAdapter {
  return {
    id,
    label,
    configured: () => !!process.env[env],
    async createEnvelope() {
      if (!process.env[env]) throw new SigningNotConnectedError(label, env);
      // The call itself lands here once the provider's API reference is available.
      throw new SigningNotConnectedError(label, `${env} (connector not built yet)`);
    },
  };
}

/** For tests and sandbox cases: an envelope that exists only here. */
export const mockSigning: SigningProviderAdapter = {
  id: 'mock',
  label: 'Test signing',
  configured: () => true,
  async createEnvelope(req) { return { envelopeId: `mock-env-${req.document}-${Date.now()}` }; },
};

export const SIGNING_PROVIDERS: Record<string, SigningProviderAdapter> = {
  infotrack: stub('infotrack', 'InfoTrack', 'INFOTRACK_SIGNING_API_KEY'),
  intouch: stub('intouch', 'InTouch', 'INTOUCH_SIGNING_API_KEY'),
  leap: stub('leap', 'LEAP', 'LEAP_SIGNING_API_KEY'),
  mock: mockSigning,
};
