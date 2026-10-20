/**
 * The Case Lightning people a firm can add as a developer account (migration 135). A
 * developer is always one of ours, never someone a firm types in: the Team page offers
 * only these, and the server refuses any other address for the role.
 */
export const CASE_LIGHTNING_DEVELOPERS: ReadonlyArray<{ name: string; email: string }> = [
  { name: 'Pete Anwyll', email: 'pete@caselightning.co.uk' },
];

export const caseLightningDeveloper = (email: string) =>
  CASE_LIGHTNING_DEVELOPERS.find((d) => d.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
