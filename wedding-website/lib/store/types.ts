/** One person's answer within a household's RSVP. */
export type MemberResponse = {
  memberId: string;
  name: string;
  attending: boolean;
  /** courseId -> optionId, from that guest's own menu. */
  choices: Record<string, string>;
  dietary?: string;
};

export type Rsvp = {
  slug: string;
  members: MemberResponse[];
  /** Optional extras the guest opted into, e.g. { brunch: true }. */
  extras: Record<string, boolean>;
  message?: string;
  submittedAt: string;
  updatedAt: string;
};

export type Visit = {
  /** Guest slug, or null for a page on the shared public site. */
  slug: string | null;
  path: string;
  at: string;
  referrer?: string;
};

export type VisitSummary = {
  count: number;
  first: string;
  last: string;
};

export interface Store {
  /** Driver name, surfaced in the admin footer so you know what you're on. */
  readonly name: string;
  ready(): Promise<void>;
  saveRsvp(rsvp: Rsvp): Promise<void>;
  getRsvp(slug: string): Promise<Rsvp | null>;
  listRsvps(): Promise<Rsvp[]>;
  recordVisit(visit: Visit): Promise<void>;
  visitSummary(): Promise<Record<string, VisitSummary>>;
  listVisits(slug: string, limit?: number): Promise<Visit[]>;
}
