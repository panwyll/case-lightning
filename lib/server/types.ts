export type Role = 'ADMIN' | 'CONVEYANCER' | 'ASSISTANT' | 'READ_ONLY';

export interface SessionUser {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  displayName: string | null;
  /** Set when an admin is viewing the app as this user. */
  actor?: { userId: string; email: string; displayName: string | null };
}

export interface AppClaims {
  oid: string;
  preferred_username?: string;
  name?: string;
  tid?: string;
}
