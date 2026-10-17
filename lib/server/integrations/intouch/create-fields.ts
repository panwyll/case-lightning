/** The fields of a case created in InTouch, and the firm's data marker for each (pure: shared with the settings page). */
/** The fields a new case can carry, and the firm's marker for each. Reference, client name and address are required. */
export const CREATE_FIELDS = [
  { key: 'reference', label: 'Our Reference', required: true },
  { key: 'clientName', label: 'Client Name', required: true },
  { key: 'clientEmail', label: 'Client Email', required: false },
  { key: 'address', label: 'Property Address', required: true },
  { key: 'postcode', label: 'Postcode', required: false },
  { key: 'side', label: 'Purchase Or Sale', required: false },
  { key: 'feeEarner', label: 'Fee Earner', required: false },
] as const;
export type CreateMarkers = Partial<Record<(typeof CREATE_FIELDS)[number]['key'], string>> & {
  /** A fixed value for the workflow template, where the firm's set-up needs one: { marker, value }. */
  template?: { marker: string; value: string } | null;
};

export const markersReady = (m: CreateMarkers | null | undefined): boolean => !!m && CREATE_FIELDS.filter((f) => f.required).every((f) => !!m[f.key]?.trim());

