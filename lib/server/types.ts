export type Role = 'ADMIN' | 'CONVEYANCER' | 'ASSISTANT' | 'READ_ONLY';

export interface SessionUser {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  displayName: string | null;
  /** A developer account added for setup (migration 080): admin privileges, labelled. */
  isDeveloper?: boolean;
}

export interface AppClaims {
  oid: string;
  preferred_username?: string;
  name?: string;
  tid?: string;
}
