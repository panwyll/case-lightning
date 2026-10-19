export type Role = 'ADMIN' | 'CONVEYANCER' | 'ASSISTANT';

export interface SessionUser {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  displayName: string | null;
  /** Who they may see (migration 087). */
  caseAccess?: 'all' | 'selected';
  mailboxAccess?: 'own' | 'all' | 'selected';
  /** A developer account added for setup (migration 135): admin privileges, labelled. */
  isDeveloper?: boolean;
  /** Set when an admin is viewing the app as this user. */
  actor?: { userId: string; email: string; displayName: string | null };
}

export interface AppClaims {
  oid: string;
  preferred_username?: string;
  name?: string;
  tid?: string;
}
