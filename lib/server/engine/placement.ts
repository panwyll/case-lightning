/**
 * Placing a case taken on part-way through (docs/spec/triggers.md, "Missed moments"): the steps a person is asked about
 * when they confirm where it is. Each is a step Mark Complete records (types.ts MANUAL_STEPS); `read` says the case's
 * history already shows it done, so it needs no tick. Pure: the Tasks list renders it.
 */
import { profileOf } from './transactions';
import { isResolved } from './types';
import type { TransactionType } from './types';

/** `read`: the state shows it done; `byHand`: a person marked it so (otherwise the file showed it). */
export interface PlacementStep { step: string; label: string; read: boolean; byHand: boolean }

const SEARCH_NAME: Record<string, string> = { LLC1: 'Local Land Charges', CON29: 'Local Authority (CON29)', DRAINAGE_WATER: 'Drainage And Water', ENVIRONMENTAL: 'Environmental', CHANCEL: 'Chancel', MINING: 'Mining' };

/** What the checklist reads: the state's own shape, or the Tasks list's copy of it. */
type St = { status?: string | null } | null | undefined;
export interface PlacementInput {
  transactionType?: string | null; requireProofOfFunds?: boolean; hasLender?: boolean; hasExistingMortgage?: boolean; requiredSearches?: readonly string[] | null;
  idCheck?: St; proofOfFunds?: St; title?: St; propertyForms?: St; mortgage?: St; managementPack?: St; reportOnTitle?: St; redemption?: St;
  searches?: Record<string, St> | null; enquiries?: Record<string, St> | null;
  manualSteps?: Record<string, unknown> | null;
  readiness?: { contractApprovedAt?: string | null } | null; deposit?: { received?: boolean } | null; contractPack?: { sentAt?: string | null } | null;
}

export function placementChecklist(s: PlacementInput): PlacementStep[] {
  const side = profileOf((s.transactionType ?? null) as TransactionType | null).side;
  const leasehold = (s.transactionType ?? '').startsWith('leasehold');
  const out: PlacementStep[] = [];
  const add = (step: string, label: string, read: boolean, when = true) => { if (when) out.push({ step, label, read, byHand: !!s.manualSteps?.[step] }); };
  add('id_check', 'ID And AML Check Done', isResolved(s.idCheck?.status ?? undefined));
  if (side === 'buyer') {
    add('proof_of_funds', 'Source Of Funds Signed Off', isResolved(s.proofOfFunds?.status ?? undefined), !!s.requireProofOfFunds);
    add('title', 'Title Checked', isResolved(s.title?.status ?? undefined));
    for (const t of s.requiredSearches ?? []) add(`search:${t}`, `${SEARCH_NAME[t] ?? t.replace(/_/g, ' ')} Search Back And Reviewed`, isResolved(s.searches?.[t]?.status ?? undefined));
    add('property_forms', 'Property Forms Received', s.propertyForms?.status === 'received');
    add('mortgage', 'Mortgage Offer Received And Checked', isResolved(s.mortgage?.status ?? undefined), !!s.hasLender);
    add('management_pack', 'Management Pack Received', isResolved(s.managementPack?.status ?? undefined), leasehold);
    add('enquiries', 'Enquiries Answered', Object.values(s.enquiries ?? {}).length > 0 && Object.values(s.enquiries ?? {}).every((q) => isResolved(q?.status ?? undefined)));
    add('report_on_title', 'Report On Title Sent', s.reportOnTitle?.status === 'sent');
    add('contract_approved', 'Contract Approved', !!s.readiness?.contractApprovedAt);
    add('deposit', 'Deposit Received', !!s.deposit?.received);
  } else if (side === 'seller') {
    add('property_forms', 'Property Forms Completed', s.propertyForms?.status === 'received');
    add('contract_pack', 'Contract Pack Sent', !!s.contractPack?.sentAt);
    add('management_pack', 'Management Pack Requested Or Received', isResolved(s.managementPack?.status ?? undefined), leasehold);
    add('redemption', 'Redemption Statement Received', !!s.redemption?.status && !['not_started', 'requested', 'not_required'].includes(s.redemption.status), !!s.hasExistingMortgage);
    add('contract_approved', 'Contract Approved', !!s.readiness?.contractApprovedAt);
  } else {
    add('title', 'Title Checked', isResolved(s.title?.status ?? undefined));
    add('mortgage', 'Mortgage Offer Received And Checked', isResolved(s.mortgage?.status ?? undefined), !!s.hasLender);
    add('redemption', 'Redemption Statement Received', !!s.redemption?.status && !['not_started', 'requested', 'not_required'].includes(s.redemption.status), !!s.hasExistingMortgage);
  }
  return out;
}
