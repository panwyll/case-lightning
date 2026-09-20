/**
 * Transaction types (docs/transaction-types.md). One machine, parameterised by a profile:
 * which side we act for, which of the engine's phases the type passes through, which
 * workstreams and sub-flows apply, what the default searches are, and how the coarse
 * lifecycle reads. The commands, gates and requirements consult the profile; nothing is
 * duplicated per type.
 */
import type { SearchType, Stage, SubFlow, TransactionType } from './types';
import type { Workstream } from './issues';

export type Side = 'buyer' | 'seller' | 'owner';

export interface TransactionProfile {
  type: TransactionType;
  label: string;
  side: Side;
  tenure: 'freehold' | 'leasehold' | 'any';
  /** Exchange of contracts happens (purchase / sale); a remortgage or a transfer of equity completes without one. */
  hasExchange: boolean;
  /** The engine phases this type passes through, in order (a subset of STAGES). */
  stages: Stage[];
  /** How the phases read for this type. */
  stageLabels: Partial<Record<Stage, string>>;
  /** What must be true to leave each phase, in this type's own words (mirrors the machine's blockers; checked by tests). */
  stageGates: Partial<Record<Stage, string[]>>;
  workstreams: Workstream[];
  subflows: SubFlow[];
  defaultSearches: SearchType[];
  /** What "the other side" is called in this type. */
  counterparty: string;
  /** Who pays us completion money. */
  fundsFrom: Array<'lender' | 'client' | 'buyer_solicitor' | 'incoming_owner'>;
  /** Registration work after completion. */
  registration: 'ap1' | 'discharge_only' | 'none';
  note: string;
}

const PURCHASE_STAGES: Stage[] = ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'];
const NO_EXCHANGE_STAGES: Stage[] = ['instruction', 'pre_contract', 'pre_completion', 'completed', 'post_completion'];

export const TRANSACTION_PROFILES: Record<TransactionType, TransactionProfile> = {
  freehold_purchase: {
    type: 'freehold_purchase',
    label: 'Freehold purchase',
    side: 'buyer',
    tenure: 'freehold',
    hasExchange: true,
    stages: PURCHASE_STAGES,
    stageLabels: { pre_contract: 'Searches & enquiries', contract_review: 'Title & report', pre_exchange: 'Pre-exchange' },
    stageGates: {
      instruction: ['ID / AML check resolved'],
      pre_contract: ['every required search ordered and resolved', 'every enquiry replied and resolved', 'mortgage offer resolved (lender-funded)'],
      contract_review: ['title resolved', 'report on title sent (drafted → approved by a person → sent)', 'enquiries raised during review resolved'],
      pre_exchange: ['mortgage offer still current', 'no open issue holding exchange', 'proof of funds signed off (firm policy)', 'client satisfied with the physical condition where a survey is on file', "client's authority to exchange (firm policy)", 'exchange conditions met (deposit received)', 'contracts exchanged'],
      exchanged: ['completion statement generated'],
      pre_completion: ['funds received', "completion payment authorised against verified seller's-solicitor details", 'no bank-details change pending (hard stop)', 'completion confirmed'],
      completed: ['SDLT or AP1 submitted'],
      post_completion: ['HMLR requisitions answered', 'registration confirmed'],
    },
    workstreams: ['id_aml', 'source_of_funds', 'title', 'searches', 'enquiries', 'mortgage', 'survey', 'contract', 'deposit', 'chain', 'report_on_title', 'co_ownership', 'completion', 'registration'],
    subflows: ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'chase', 'proof_of_funds'],
    defaultSearches: ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL'],
    counterparty: "seller's solicitor",
    fundsFrom: ['lender', 'client'],
    registration: 'ap1',
    note: 'The buyer-side spine the engine was built on.',
  },
  leasehold_purchase: {
    type: 'leasehold_purchase',
    label: 'Leasehold purchase',
    side: 'buyer',
    tenure: 'leasehold',
    hasExchange: true,
    stages: PURCHASE_STAGES,
    stageLabels: { pre_contract: 'Searches, pack & enquiries', contract_review: 'Lease, title & report', pre_exchange: 'Pre-exchange' },
    stageGates: {
      instruction: ['ID / AML check resolved'],
      pre_contract: ['every required search ordered and resolved', 'every enquiry replied and resolved', 'mortgage offer resolved (lender-funded)', 'management pack reviewed'],
      contract_review: ['title resolved', 'report on title sent (drafted → approved by a person → sent)', 'enquiries raised during review resolved'],
      pre_exchange: ['mortgage offer still current', 'no open issue holding exchange', 'proof of funds signed off (firm policy)', 'client satisfied with the physical condition where a survey is on file', "client's authority to exchange (firm policy)", 'exchange conditions met (deposit received)', 'contracts exchanged'],
      exchanged: ['completion statement generated'],
      pre_completion: ['funds received', "completion payment authorised against verified seller's-solicitor details", 'no bank-details change pending (hard stop)', 'completion confirmed'],
      completed: ['SDLT or AP1 submitted'],
      post_completion: ['HMLR requisitions answered', 'registration confirmed', 'notice of assignment served before close'],
    },
    workstreams: ['id_aml', 'source_of_funds', 'title', 'searches', 'enquiries', 'mortgage', 'survey', 'leasehold', 'contract', 'deposit', 'chain', 'report_on_title', 'co_ownership', 'completion', 'registration'],
    subflows: ['id_check', 'search', 'enquiry', 'mortgage', 'title', 'report_on_title', 'chase', 'proof_of_funds', 'management_pack'],
    defaultSearches: ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL'],
    counterparty: "seller's solicitor",
    fundsFrom: ['lender', 'client'],
    registration: 'ap1',
    note: 'Purchase plus the management pack, lease review and the notice of assignment.',
  },
  freehold_sale: {
    type: 'freehold_sale',
    label: 'Freehold sale',
    side: 'seller',
    tenure: 'freehold',
    hasExchange: true,
    stages: PURCHASE_STAGES,
    stageLabels: { pre_contract: 'Contract pack', contract_review: 'Enquiries & replies', pre_exchange: 'Pre-exchange', completed: 'Completed — redeem & account', post_completion: 'Discharge & close' },
    stageGates: {
      instruction: ['ID / AML check resolved'],
      pre_contract: ['property forms in from the client', 'title resolved (official copies)', 'contract pack sent'],
      contract_review: ["every enquiry from the buyer replied to (passes through while none are outstanding)"],
      pre_exchange: ['redemption statement received (charged property)', "buyer's enquiries all answered", 'no open issue holding exchange', "client's authority to exchange (firm policy)", 'exchange conditions met', 'contracts exchanged'],
      exchanged: ['completion statement generated'],
      pre_completion: ["completion monies received from the buyer's solicitor", 'redemption payment authorised against verified lender details (hard stop)', 'completion confirmed'],
      completed: ['mortgage recorded as redeemed', 'balance to the client authorised against verified client details'],
      post_completion: ["lender's discharge confirmed (DS1 / e-DS1)", 'file closed'],
    },
    workstreams: ['id_aml', 'property_forms', 'title', 'enquiries', 'redemption', 'contract', 'chain', 'completion', 'discharge'],
    subflows: ['id_check', 'title', 'chase'],
    defaultSearches: [],
    counterparty: "buyer's solicitor",
    fundsFrom: ['buyer_solicitor'],
    registration: 'discharge_only',
    note: "Seller side: property forms from the client, contract pack out, the buyer's enquiries answered, the seller's mortgage redeemed and discharged.",
  },
  leasehold_sale: {
    type: 'leasehold_sale',
    label: 'Leasehold sale',
    side: 'seller',
    tenure: 'leasehold',
    hasExchange: true,
    stages: PURCHASE_STAGES,
    stageLabels: { pre_contract: 'Contract pack & management pack', contract_review: 'Enquiries & replies', pre_exchange: 'Pre-exchange', completed: 'Completed — redeem & account', post_completion: 'Discharge & close' },
    stageGates: {
      instruction: ['ID / AML check resolved'],
      pre_contract: ['property forms in from the client', 'title resolved (official copies)', 'management pack reviewed', 'contract pack sent'],
      contract_review: ["every enquiry from the buyer replied to (passes through while none are outstanding)"],
      pre_exchange: ['redemption statement received (charged property)', "buyer's enquiries all answered", 'no open issue holding exchange', "client's authority to exchange (firm policy)", 'exchange conditions met', 'contracts exchanged'],
      exchanged: ['completion statement generated'],
      pre_completion: ["completion monies received from the buyer's solicitor", 'redemption payment authorised against verified lender details (hard stop)', 'completion confirmed'],
      completed: ['mortgage recorded as redeemed', 'balance to the client authorised against verified client details'],
      post_completion: ["lender's discharge confirmed (DS1 / e-DS1)", 'file closed'],
    },
    workstreams: ['id_aml', 'property_forms', 'title', 'leasehold', 'enquiries', 'redemption', 'contract', 'chain', 'completion', 'discharge'],
    subflows: ['id_check', 'title', 'chase', 'management_pack'],
    defaultSearches: [],
    counterparty: "buyer's solicitor",
    fundsFrom: ['buyer_solicitor'],
    registration: 'discharge_only',
    note: 'Sale plus obtaining the management pack from the freeholder / agent for the buyer.',
  },
  remortgage: {
    type: 'remortgage',
    label: 'Remortgage',
    side: 'owner',
    tenure: 'any',
    hasExchange: false,
    stages: NO_EXCHANGE_STAGES,
    stageLabels: { pre_contract: 'Investigation', pre_completion: 'Ready to complete', completed: 'Completed', post_completion: 'Registration' },
    stageGates: {
      instruction: ['ID / AML check resolved'],
      pre_contract: ['title resolved', "lender's searches resolved (if any)", 'mortgage offer resolved', 'redemption statement received (charged property)', 'no open issue holding'],
      pre_completion: ['mortgage deed executed (witnessed)', 'certificate of title sent', 'advance received from the new lender', 'redemption payment authorised against verified lender details (hard stop)', 'completion confirmed'],
      completed: ['AP1 submitted'],
      post_completion: ['HMLR requisitions answered', "old lender's discharge confirmed", 'registration confirmed'],
    },
    workstreams: ['id_aml', 'title', 'searches', 'mortgage', 'redemption', 'completion', 'registration', 'discharge'],
    subflows: ['id_check', 'search', 'mortgage', 'title', 'chase'],
    defaultSearches: [],
    counterparty: 'the lenders',
    fundsFrom: ['lender'],
    registration: 'ap1',
    note: 'No exchange: title and offer investigated, the mortgage deed executed, the certificate of title sent, the old lender redeemed from the new advance, the new charge registered and the old one discharged.',
  },
  transfer_of_equity: {
    type: 'transfer_of_equity',
    label: 'Transfer of equity',
    side: 'owner',
    tenure: 'any',
    hasExchange: false,
    stages: NO_EXCHANGE_STAGES,
    stageLabels: { pre_contract: 'Investigation & consent', pre_completion: 'Execution', completed: 'Completed', post_completion: 'Registration' },
    stageGates: {
      instruction: ['ID / AML check resolved (every party)'],
      pre_contract: ['title resolved', "lender's consent received (charged property)", 'basis of co-ownership decided by the clients', 'no open issue holding'],
      pre_completion: ['transfer deed executed by every party', 'declaration of trust executed (tenants in common)', 'consideration received from the incoming owner (where any)', 'completion confirmed'],
      completed: ['SDLT return filed, or recorded as not required (chargeable consideration)', 'AP1 submitted'],
      post_completion: ['HMLR requisitions answered', 'registration confirmed'],
    },
    workstreams: ['id_aml', 'title', 'lender_consent', 'co_ownership', 'completion', 'registration'],
    subflows: ['id_check', 'title', 'chase'],
    defaultSearches: [],
    counterparty: 'the other party / their solicitor',
    fundsFrom: ['incoming_owner'],
    registration: 'ap1',
    note: "Ownership changes without a sale: identity of every party, the lender's consent where the property is charged, the basis of co-ownership decided by the clients (a declaration of trust where tenants in common), the transfer deed executed, SDLT where there is consideration, the transfer registered.",
  },
};

export const profileOf = (type: TransactionType | null | undefined): TransactionProfile => TRANSACTION_PROFILES[type ?? 'freehold_purchase'];
export const isSale = (type: TransactionType | null | undefined): boolean => profileOf(type).side === 'seller';
export const isPurchase = (type: TransactionType | null | undefined): boolean => profileOf(type).side === 'buyer';
