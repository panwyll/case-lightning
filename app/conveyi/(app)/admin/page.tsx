'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { fallbackMatterRef } from '@/lib/ref-name';
import EmailTemplates from './EmailTemplates';
import NewMatter from './NewMatter';
import { ADMIN_TABS_IN_NAV, type AdminTab } from '@/app/shared/AppNav';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { paths } from '@/lib/paths';
import { Inbox, PenLine, FolderKanban, Settings, Target, Calendar, CheckCircle, Sparkles, Check } from '@/app/shared/icons';
import EngineWork, { decisionTask } from './EngineWork';
import DecisionTray from './DecisionTray';

interface MatterHit {
  id: string;
  matterRef: string;
  propertyAddress: string | null;
}

interface Template {
  id: string;
  name: string;
  category: string;
  subjectTemplate?: string;
  bodyTemplate: string;
  styleTag: string;
  isActive: boolean;
}

interface DocTemplate {
  id: string;
  name: string;
  description: string | null;
  file_name: string;
  file_size_bytes: number;
  has_llm_prompts: boolean;
  sort_order: number;
  created_at: string;
}

const TOKEN_KEY = 'cl_token';

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const t = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  return json as T;
}

function money(pennies: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: (currency || 'GBP').toUpperCase() }).format(pennies / 100);
}

function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  if (h < 24) return `${h < 10 ? h.toFixed(1) : Math.round(h)} hr${h >= 2 ? 's' : ''}`;
  const d = h / 24;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} day${d >= 2 ? 's' : ''}`;
}

// Turn a raw audit row (action_type + payload) into a plain-English sentence. Weaves in the
// payload's specifics (subject, counts, rule names, reasons) so the log reads like a story of
// what actually happened, not a wall of enum codes.
// Every action_type sorted into a bucket the filter can offer. Anything unmapped falls
// into 'other' rather than disappearing, so a new event type is still visible.
const AUDIT_CATEGORY: Record<string, string> = {
  EMAIL_SENT: 'email', AUTO_REPLY_SENT: 'email', DRAFT_GENERATED: 'email',
  OUTLOOK_DRAFT_CREATED: 'email', EMAIL_TRIAGED: 'email', EMAIL_FILED: 'email',
  EMAIL_SAVED_TO_MATTER: 'email', OUTLOOK_CATEGORY_UPDATED: 'email',
  THREAD_LINKED: 'email', THREAD_SUMMARISED: 'email', FACTS_EXTRACTED: 'email',
  MATCH_CONFIRMED: 'email', USER_ACTION_CHOSEN: 'email',
  STAGE_CHANGED: 'matter', MATTER_CREATED: 'matter', MATTER_MERGED: 'matter',
  CALL_NOTE_RECORDED: 'matter', CALL_NOTE_UNASSIGNED: 'matter',
  WORKFLOW_TASKS_CREATED: 'tasks',
  DOCUMENT_UPLOADED: 'docs', DOCUMENT_REVIEWED: 'docs', FILE_PROCESSED: 'docs',
  AUTO_RULE_APPLIED: 'automation', AUTO_RULE_CREATED: 'automation',
  AUTO_RULE_UPDATED: 'automation', AUTO_RULE_DELETED: 'automation',
  TEAMS_SUMMARY_POSTED: 'automation',
  USER_ROLE_CHANGED: 'admin', AI_KEY_SET: 'admin', AI_KEY_REMOVED: 'admin',
  ONBOARDING_STARTED: 'admin', ONBOARDING_CONFIRMED: 'admin',
  ONBOARDING_CASE_PROVISIONED: 'admin', ONBOARDING_CANCELLED: 'admin',
};
const AUDIT_FILTERS: Array<[string, string]> = [
  ['', 'Everything'], ['email', 'Email'], ['matter', 'Case & status'], ['tasks', 'Tasks'],
  ['docs', 'Documents'], ['automation', 'Automation'], ['admin', 'Admin & access'], ['other', 'Other'],
];
const auditCategory = (row: any) => AUDIT_CATEGORY[String(row.action_type)] ?? 'other';

function describeAudit(row: any): string {
  const p = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, any>;
  const q = (s: any) => (s ? `“${String(s).slice(0, 80)}”` : '');
  switch (row.action_type as string) {
    case 'EMAIL_SENT':
      return `Sent an email${p.subject ? ` ${q(p.subject)}` : ''}${p.source === 'SCHEDULED' ? ' (on the send delay)' : p.source === 'WORKLIST_WEB' ? ' from My work' : ''}`;
    case 'AUTO_REPLY_SENT':
      return row.action_status === 'SUCCESS'
        ? `${p.scheduled ? 'Scheduled an auto-reply' : 'Auto-sent a reply'}${p.recipients ? ` to ${p.recipients}` : ''}${p.scheduled ? ' (on the send delay — cancellable)' : ''}`
        : `Auto-reply held back — ${p.reason || 'safety check failed'}`;
    case 'DRAFT_GENERATED':
      return `Drafted a reply${p.tone ? ` (${p.tone} tone)` : ''}`;
    case 'OUTLOOK_DRAFT_CREATED':
      return p.kind === 'FORWARD' ? `Prepared a forward${p.toEmail ? ` to ${p.toEmail}` : ''}` : row.action_status !== 'SUCCESS' ? `Draft blocked — ${p.reason || 'not allowed'}` : 'Created an Outlook draft';
    case 'EMAIL_TRIAGED':
      return `Triaged an incoming email${p.band ? ` (${String(p.band).toLowerCase()} confidence match)` : ''}`;
    case 'EMAIL_SAVED_TO_MATTER':
      return `Filed ${p.count ?? 'some'} document${p.count === 1 ? '' : 's'} from an email${p.auto ? ' automatically' : ''}`;
    case 'EMAIL_FILED':
      return `Filed an email to the case${p.moved ? ' and moved it out of the inbox' : ''}`;
    case 'FILE_PROCESSED':
      return `Processed ${q(p.fileName) || 'a file'}${p.substantive === false ? ' (not substantive — skipped)' : p.drafted ? ' and drafted an acknowledgement' : ''}`;
    case 'DOCUMENT_UPLOADED':
      return `Uploaded a document${p.fileName ? ` ${q(p.fileName)}` : ''}`;
    case 'DOCUMENT_REVIEWED':
      return `Reviewed a document${p.fileName ? ` ${q(p.fileName)}` : ''}`;
    case 'STAGE_CHANGED':
      return `Moved the case${p.from ? ` from ${String(p.from).toLowerCase().replace(/_/g, ' ')}` : ''} to ${String(p.to || '').toLowerCase().replace(/_/g, ' ')}`;
    case 'WORKFLOW_TASKS_CREATED':
      return `Case Flow raised ${p.count ?? 'some'} task${p.count === 1 ? '' : 's'} for the ${String(p.stage || '').toLowerCase().replace(/_/g, ' ')} stage`;
    case 'MATTER_CREATED':
      return `Created a new case`;
    case 'MATTER_MERGED':
      return `Merged case ${p.mergedRef || ''} into ${p.keepRef || ''}`.replace(/\s+/g, ' ').trim();
    case 'MATCH_CONFIRMED':
      return `Confirmed an email belongs to this case${p.band ? ` (${String(p.band).toLowerCase()})` : ''}`;
    case 'THREAD_LINKED':
      return 'Linked an email thread to the case';
    case 'THREAD_SUMMARISED':
      return 'Summarised an email thread';
    case 'FACTS_EXTRACTED':
      return 'Extracted case facts from a thread';
    case 'OUTLOOK_CATEGORY_UPDATED':
      return `Tagged an email in Outlook${p.category ? ` as ${q(p.category)}` : ''}`;
    case 'USER_ACTION_CHOSEN':
      return `Chose the “${p.action || 'action'}” action on an email`;
    case 'AUTO_RULE_APPLIED':
      return `Applied the auto-rule ${q(p.ruleName) || ''}`.trim();
    case 'AUTO_RULE_CREATED':
      return `Created an auto-rule${p.enabled === false ? ' (disabled)' : ''}`;
    case 'AUTO_RULE_UPDATED':
      return `Updated an auto-rule${p.enabled === false ? ' — turned off' : p.enabled ? ' — turned on' : ''}`;
    case 'USER_ROLE_CHANGED':
      return `Changed a team member’s role to ${p.role || 'a new role'}`;
    case 'AI_KEY_SET':
      return 'Connected a personal AI key';
    case 'AI_KEY_REMOVED':
      return 'Removed the personal AI key';
    case 'TEAMS_SUMMARY_POSTED':
      return 'Posted a case summary to Teams';
    case 'ONBOARDING_STARTED':
      return 'Started importing existing cases';
    case 'ONBOARDING_CONFIRMED':
      return 'Confirmed the cases to import';
    case 'ONBOARDING_CASE_PROVISIONED':
      return `Provisioned a case during import${p.summary ? ` — ${String(p.summary).slice(0, 80)}` : ''}`;
    case 'ONBOARDING_CANCELLED':
      return 'Cancelled the case import';
    default:
      // Prettify an unmapped code: EMAIL_SENT → "Email sent".
      return String(row.action_type || 'Action').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}

type TabKey = AdminTab;

// One entry per tab — just the label; the section content speaks for itself.
const TAB_META: Record<TabKey, { label: string; subtitle: string }> = {
  mywork: { label: 'Tasks', subtitle: '' },
  billing: { label: 'Billing', subtitle: '' },
  workload: { label: 'Workload', subtitle: '' },
  templates: { label: 'Email Templates', subtitle: '' },
  docpacks: { label: 'Doc Packs', subtitle: '' },
  team: { label: 'Team', subtitle: '' },
  policy: { label: 'Policy', subtitle: '' },
  actions: { label: 'Tools', subtitle: '' },
  audit: { label: 'Audit Log', subtitle: '' },
  help: { label: 'Help & Support', subtitle: '' },
};

// The sidebar itself lives in app/shared/AppNav.tsx (shared with every app page).
const TAB_KEYS: TabKey[] = [...ADMIN_TABS_IN_NAV];
// Tabs that need the ADMIN role. Billing and Help are per-user, so a non-admin who
// lands here from "click your name" still sees those.
const ADMIN_ONLY: TabKey[] = ['workload', 'templates', 'docpacks', 'team', 'policy', 'actions', 'audit', 'billing'];

// Conveyancing stage model — the board's columns, in workflow order.
// Grey → red over ten steps: the age-dot ramp on board cards (one dot per 10 days).
const AGE_RAMP = ['#cbd5e1', '#bcc2cc', '#c3bcb4', '#d0b48d', '#dda36a', '#e58d4f', '#e5743a', '#dd5a2e', '#cf3f26', '#b91c1c'];
const STAGE_ORDER = ['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION', 'POST_COMPLETION'] as const;
// Each stage gets a hue — column headers and card accents key off it, Monday-style.
const STAGE_COLOR: Record<string, string> = {
  INSTRUCTION: '#8b5cf6',
  CONTRACT_PACK: '#3b82f6',
  SEARCHES_ENQUIRIES: '#06b6d4',
  REVIEW_SIGNING: '#f59e0b',
  EXCHANGE: '#ec4899',
  COMPLETION: '#22c55e',
  POST_COMPLETION: '#64748b',
};
const STAGE_LABEL: Record<string, string> = {
  INSTRUCTION: 'Instruction',
  CONTRACT_PACK: 'Contract pack',
  SEARCHES_ENQUIRIES: 'Searches & enquiries',
  REVIEW_SIGNING: 'Review & signing',
  EXCHANGE: 'Exchange',
  COMPLETION: 'Completion',
  POST_COMPLETION: 'Post-completion',
};
const FLAG_DOT: Record<string, string> = { ON_TRACK: '#16a34a', NEEDS_ATTENTION: '#f59e0b', BLOCKED: '#dc2626' };

const STATUS_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  active: { label: 'Active', bg: '#dcfce7', color: '#166534' },
  trialing: { label: 'Trial', bg: '#ede9fe', color: '#6d28d9' },
  past_due: { label: 'Past due', bg: '#fef3c7', color: '#92400e' },
  canceled: { label: 'Canceled', bg: '#fee2e2', color: '#b91c1c' },
  none: { label: 'No subscription', bg: '#f1f5f9', color: '#64748b' },
};

// A matter search box with a results dropdown; calls onSelect with the chosen matter.

const PERSON_CSS = `
.pp-veil{position:fixed;inset:0;background:rgba(15,23,42,.38);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:72px 16px 16px;overflow-y:auto}
.pp{background:#fff;border-radius:14px;width:100%;max-width:600px;box-shadow:0 24px 64px rgba(15,23,42,.24);overflow:hidden}
.pp-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px 14px;border-bottom:1px solid #eef1f5}
.pp-head h2{margin:0;font-size:17px;font-weight:800}
.pp-head span{font-size:13px;color:#64748b}
.pp-body{padding:18px 22px;display:grid;gap:18px}
.pp-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.pp-field{display:grid;gap:6px}
.pp-field label,.pp-set > label{font-size:12px;font-weight:700;color:#475569;letter-spacing:.02em;text-transform:uppercase}
.pp-field input{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:14px;font-family:inherit;box-sizing:border-box;background:#fff}
.pp-field input:focus{outline:none;border-color:#5A27E0;box-shadow:0 0 0 3px rgba(90,39,224,.15)}
.pp-set{display:grid;gap:8px;justify-items:start}
.pp-chips{justify-self:stretch}
.pp-seg{display:inline-flex;border:1px solid #cbd5e1;border-radius:9px;overflow:hidden;background:#fff}
.pp-seg button{padding:8px 16px;border:0;border-left:1px solid #cbd5e1;background:#fff;color:#334155;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;line-height:1.2}
.pp-seg button:first-child{border-left:0}
.pp-seg button.on{background:#5A27E0;color:#fff}
.pp-chips{display:flex;gap:6px;flex-wrap:wrap;padding:10px 12px;border:1px dashed #cbd5e1;border-radius:9px;background:#f8fafc}
.pp-chips button{padding:5px 12px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.pp-chips button.on{background:#ede9fe;border-color:#5A27E0;color:#4c1d95}
.pp-chips i{font-size:12.5px;color:#94a3b8;font-style:normal;padding:5px 0}
.pp-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 22px;background:#f8fafc;border-top:1px solid #eef1f5}
.pp-btn{padding:9px 16px;border-radius:9px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;border:1px solid #cbd5e1;background:#fff;color:#334155}
.pp-btn.primary{background:#5A27E0;border-color:#5A27E0;color:#fff}
.pp-btn:disabled{opacity:.5;cursor:default}
@media (max-width:640px){.pp-row{grid-template-columns:1fr}.pp-veil{padding-top:24px}}
`;

/** One person's account and access, in a dialog: role, whose cases they may see, whose inboxes they may file from. */
function PersonPanel({ person, setPerson, users, isNew, busy, onSave, onClose, toggleIn }: {
  person: PersonPanelProps;
  setPerson: (p: PersonPanelProps) => void;
  users: any[];
  isNew: boolean;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
  toggleIn: (list: string[], id: string) => string[];
}) {
  const colleagues = users.filter((u) => u.email !== person.email);
  const chips = (which: 'covers' | 'mailboxes') => (
    <div className="pp-chips">
      {colleagues.map((u) => (
        <button key={u.id} type="button" className={person[which].includes(u.id) ? 'on' : ''} onClick={() => setPerson({ ...person, [which]: toggleIn(person[which], u.id) })} title={which === 'covers' ? `Every case ${u.display_name || u.email} handles` : `${u.display_name || u.email}'s inbox, to file from`}>
          {u.display_name || u.email}
        </button>
      ))}
      {colleagues.length === 0 && <i>No colleagues yet</i>}
    </div>
  );
  const seg = <T extends string>(value: T, options: Array<[T, string, string]>, set: (v: T) => void) => (
    <div className="pp-seg" role="radiogroup">
      {options.map(([v, l, h]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => set(v)} title={h}>{l}</button>
      ))}
    </div>
  );
  const canSave = !busy && (!isNew || (person.name.trim().length > 0 && /\S+@\S+\.\S+/.test(person.email)));
  return (
    <div className="pp-veil" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <style>{PERSON_CSS}</style>
      <div className="pp" role="dialog" aria-modal="true" aria-labelledby="pp-title">
        <div className="pp-head">
          <h2 id="pp-title">{isNew ? 'New Team Member' : person.name || person.email}</h2>
          {!isNew && <span>{person.email}</span>}
        </div>
        <div className="pp-body">
          {isNew && (
            <div className="pp-row">
              <div className="pp-field">
                <label htmlFor="pp-name">Name</label>
                <input id="pp-name" autoFocus value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} autoComplete="off" />
              </div>
              <div className="pp-field">
                <label htmlFor="pp-email">Email</label>
                <input id="pp-email" type="email" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} autoComplete="off" />
              </div>
            </div>
          )}
          <div className="pp-set">
            <label>Role</label>
            {seg(person.role, [['ADMIN', 'Admin', 'Everything, including this page.'], ['CONVEYANCER', 'Conveyancer', 'Cases and decisions.'], ['ASSISTANT', 'Assistant', 'Files email and works cases; no decisions on money or reports.']], (v) => setPerson({ ...person, role: v }))}
          </div>
          <div className="pp-set">
            <label>Cases</label>
            {seg(person.caseAccess, [['all', 'All', 'Every case in the firm, including those of people who join later.'], ['selected', 'Selected', 'Their own cases, plus the cases of the colleagues picked below.']], (v) => setPerson({ ...person, caseAccess: v }))}
            {person.caseAccess === 'selected' && chips('covers')}
          </div>
          <div className="pp-set">
            <label>Inboxes</label>
            {seg(person.mailboxAccess, [['own', 'Own', 'Only their own email.'], ['all', 'All', "Every colleague's email, including people who join later. Filing only; nothing is sent from it."], ['selected', 'Selected', 'Their own, plus the colleagues picked below.']], (v) => setPerson({ ...person, mailboxAccess: v }))}
            {person.mailboxAccess === 'selected' && chips('mailboxes')}
          </div>
        </div>
        <div className="pp-foot">
          <button type="button" className="pp-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="pp-btn primary" disabled={!canSave} onClick={onSave} title={isNew ? 'Creates the account and emails a sign-in link.' : 'Saves role and access. Logged.'}>{busy ? 'Saving…' : isNew ? 'Create Account' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
type PersonPanelProps = { name: string; email: string; role: string; caseAccess: 'all' | 'selected'; mailboxAccess: 'own' | 'all' | 'selected'; covers: string[]; mailboxes: string[] };

function MatterPicker({ selected, onSelect }: { selected: MatterHit | null; onSelect: (m: MatterHit | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MatterHit[]>([]);
  useEffect(() => {
    if (selected) return; // collapsed once chosen
    let active = true;
    if (q.trim().length < 1) { setResults([]); return; }
    const id = setTimeout(() => {
      api<{ matters: MatterHit[] }>(`/matters?q=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (active) setResults(r.matters ?? []); })
        .catch(() => {});
    }, 200);
    return () => { active = false; clearTimeout(id); };
  }, [q, selected]);

  const card: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', marginBottom: 4 };
  const inp: React.CSSProperties = { width: '100%', padding: 8, border: '1px solid #cbd5e1', borderRadius: 6 };

  if (selected) {
    return (
      <div style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div>
          <strong style={{ fontSize: 13 }}>{selected.matterRef}</strong>
          {selected.propertyAddress && <div style={{ fontSize: 12, color: '#64748b' }}>{selected.propertyAddress}</div>}
        </div>
        <button style={{ padding: '4px 10px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' }} onClick={() => { onSelect(null); setQ(''); }}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div>
      <input style={inp} placeholder="Search reference or address…" value={q} onChange={(e) => setQ(e.target.value)} />
      {results.map((m) => (
        <div
          key={m.id}
          style={{ ...card, marginTop: 4, cursor: 'pointer' }}
          onClick={() => { onSelect(m); setResults([]); }}
        >
          <strong style={{ fontSize: 13 }}>{m.matterRef}</strong>
          {m.propertyAddress && <div style={{ fontSize: 12, color: '#64748b' }}>{m.propertyAddress}</div>}
        </div>
      ))}
    </div>
  );
}

function AdminPageInner() {
  const [me, setMe] = useState<{ userId?: string; role: string; email: string; displayName: string | null; tenantName?: string } | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const isAdmin = me?.role === 'ADMIN';
  // Show the full nav immediately (static) — only collapse it once we've CONFIRMED a
  // non-admin. Gating on the async /me would otherwise pop the sidebar from 2 → all.
  const visibleTabs = me && !isAdmin ? TAB_KEYS.filter((k) => !ADMIN_ONLY.includes(k)) : TAB_KEYS;

  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabKey>('mywork');
  // The sidebar is a set of links to ?tab=…; this is what makes them switch in place.
  const urlTab = searchParams?.get('tab') ?? null;
  useEffect(() => {
    if (urlTab && (TAB_KEYS as string[]).includes(urlTab)) setTab(urlTab as TabKey);
    else if (!urlTab) setTab('mywork');
  }, [urlTab]);
  // Onboarding progress (admins only) — drives the "Get started" nav item + auto-open.
  const [onb, setOnb] = useState<{ completed: number; total: number; onboarded: boolean } | null>(null);
  const onbAutoNav = useRef(false);
  const [workload, setWorkload] = useState<Array<{ id: string | null; name: string; role: string | null; open_matters: number; needs_attention: number; overdue_chases: number; drafts_waiting: number }>>([]);
  // "My work": the same worklist the taskpane shows — chases + ready-to-send drafts —
  // so the web app is operable day-to-day without the add-in.
  /** Whose tasks the tray shows: '' is everyone's. */
  const [assignee, setAssignee] = useState('');
  const [myworkSort, setMyworkSort] = useState<'smart' | 'due' | 'matter'>('smart');
  const [myworkFolded, setMyworkFolded] = useState<Set<string>>(new Set());
  const [myworkOpen, setMyworkOpen] = useState<string>('');
  const [myworkTl, setMyworkTl] = useState<Record<string, { loading?: boolean; matter?: any; timeline?: any[] }>>({});
  async function toggleMyworkMatter(matterId: string) {
    const opening = myworkOpen !== matterId;
    setMyworkOpen(opening ? matterId : '');
    if (!opening || myworkTl[matterId]) return;
    setMyworkTl((t) => ({ ...t, [matterId]: { loading: true } }));
    try {
      const r = await api<{ matter: any; timeline: any[] }>(`/matters/${matterId}`);
      setMyworkTl((t) => ({ ...t, [matterId]: { matter: r.matter, timeline: r.timeline ?? [] } }));
    } catch {
      setMyworkTl((t) => ({ ...t, [matterId]: { matter: null, timeline: [] } }));
    }
  }
  // Capture a token from the URL fragment (desktop deep-link), load the user, and
  // open the tab named in ?tab= so links from the add-in land in the right place.
  useEffect(() => {
    const m = window.location.hash.match(/token=([^&]+)/);
    if (m) {
      window.localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    api<{ userId?: string; role: string; email: string; displayName: string | null; tenantName?: string }>('/me')
      .then(setMe)
      .catch(() => {})
      .finally(() => setMeLoading(false));
  }, []);
  // Never leave a non-admin parked on an admin-only tab.
  useEffect(() => {
    if (me && !isAdmin && ADMIN_ONLY.includes(tab)) setTab('mywork');
  }, [me, isAdmin, tab]);
  function go(t: TabKey) {
    setTab(t);
    router.push(`${paths.admin}?tab=${t}`);
  }

  const [aiGen, setAiGen] = useState({ name: '', instructions: '' });
  const [aiGenBusy, setAiGenBusy] = useState(false);
  const aiGenFileRef = useRef<HTMLInputElement>(null);
  const [billing, setBilling] = useState<any>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [importStats, setImportStats] = useState<any>(null);
  const [board, setBoard] = useState<any[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardAssignee, setBoardAssignee] = useState('');
  const [boardFlag, setBoardFlag] = useState('');
  const [boardSort, setBoardSort] = useState<'stage_age' | 'completion' | 'ref' | 'updated'>('stage_age');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [boardBusyId, setBoardBusyId] = useState<string | null>(null);
  const [openMatter, setOpenMatter] = useState<any | null>(null);
  const [boardQuery, setBoardQuery] = useState('');
  const [doneTotal, setDoneTotal] = useState(0);
  // Audit log: filters and per-row expansion. Client-side over the fetched page — a few
  // hundred rows, so no round trip per keystroke.
  const [auditCat, setAuditCat] = useState('');
  const [auditStatus, setAuditStatus] = useState('');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditOpen, setAuditOpen] = useState<string | null>(null);
  // What each card shows — the board is customisable per browser, Jira-style.
  const BOARD_PREF_DEFAULTS = { address: true, owner: true, dates: true, tasks: true, age: true, quickEdit: true };
  const [boardPrefs, setBoardPrefs] = useState<Record<string, boolean>>(() => {
    try {
      if (typeof window === 'undefined') return BOARD_PREF_DEFAULTS;
      return { ...BOARD_PREF_DEFAULTS, ...JSON.parse(window.localStorage.getItem('cl_board_prefs') || '{}') };
    } catch {
      return BOARD_PREF_DEFAULTS;
    }
  });
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const togglePref = (k: string) =>
    setBoardPrefs((p) => {
      const next = { ...p, [k]: !p[k] };
      try { window.localStorage.setItem('cl_board_prefs', JSON.stringify(next)); } catch {}
      return next;
    });
  // Quick-add a matter straight into a column, Trello-style.
  const [addingStage, setAddingStage] = useState<string | null>(null);
  const [newMatterAddr, setNewMatterAddr] = useState('');
  const [creatingMatter, setCreatingMatter] = useState(false);
  // Collapsed kanban columns — remembered per browser so the layout survives reloads.
  // The Completed pile starts collapsed: it's history, not work in flight.
  const [collapsedStages, setCollapsedStages] = useState<string[]>(() => {
    try {
      if (typeof window === 'undefined') return ['__DONE'];
      const stored = window.localStorage.getItem('cl_board_collapsed');
      return stored ? JSON.parse(stored) : ['__DONE'];
    } catch {
      return ['__DONE'];
    }
  });
  const toggleStage = (stage: string) =>
    setCollapsedStages((prev) => {
      const next = prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage];
      try { window.localStorage.setItem('cl_board_collapsed', JSON.stringify(next)); } catch {}
      return next;
    });

  // The board is editable in place — drag a card to another stage, or change its status /
  // assignee on the card. Optimistic; reverts to server truth if the PATCH fails.
  async function patchMatter(id: string, patch: Record<string, unknown>) {
    setBoardBusyId(id);
    if ('status' in patch) {
      const prev = board.find((m) => m.id === id);
      const wasClosed = prev?.status === 'CLOSED';
      const isClosed = patch.status === 'CLOSED';
      if (wasClosed !== isClosed) setDoneTotal((n) => Math.max(0, n + (isClosed ? 1 : -1)));
    }
    setBoard((b) =>
      b.map((m) => {
        if (m.id !== id) return m;
        const next: any = { ...m };
        if (patch.stage) {
          next.stage = patch.stage;
          next.stageEnteredAt = new Date().toISOString();
        }
        if (patch.statusFlag) next.statusFlag = patch.statusFlag;
        if ('assignedTo' in patch) {
          next.assignedTo = patch.assignedTo;
          const mem = users.find((u: any) => u.id === patch.assignedTo);
          next.assignee = mem ? mem.display_name || mem.email : null;
        }
        // Figure edits from the matter drawer — keep the card's date chip in step.
        if ('exchangeTargetDate' in patch) next.exchangeTargetDate = patch.exchangeTargetDate || null;
        if ('completionTargetDate' in patch) next.completionTargetDate = patch.completionTargetDate || null;
        // Pile moves (Up next / active / Completed) — the card re-renders into its pile.
        if ('status' in patch) {
          next.status = patch.status;
          next.updatedAt = new Date().toISOString(); // freshly completed sorts to the top of the pile
        }
        return next;
      })
    );
    try {
      await api(`/matters/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    } catch {
      try {
        setBoard((await api<{ matters: any[] }>('/admin/board')).matters);
      } catch {
        /* keep optimistic state */
      }
    } finally {
      setBoardBusyId(null);
    }
  }

  // Trello-style quick add: type an address into a column, get a matter there. The ref
  // is an auto-generated codename (same convention as the taskpane); everything else is
  // filled in later from the drawer or as email arrives.
  async function quickCreateMatter(stage: string) {
    const addr = newMatterAddr.trim();
    if (!addr || creatingMatter) return;
    setCreatingMatter(true);
    try {
      const created = await api<{ id: string }>('/matters', {
        method: 'POST',
        body: JSON.stringify({ matterRef: fallbackMatterRef(), propertyAddress: addr }),
      });
      if (stage !== 'INSTRUCTION') await api(`/matters/${created.id}`, { method: 'PATCH', body: JSON.stringify({ stage }) }).catch(() => {});
      setNewMatterAddr('');
      setAddingStage(null);
      const b = await api<{ matters: any[]; doneTotal?: number }>('/admin/board');
      setBoard(b.matters);
      setDoneTotal(b.doneTotal ?? 0);
    } catch (e: any) {
      setStatus(e?.message || 'Could not create the case.');
    } finally {
      setCreatingMatter(false);
    }
  }
  const [copiedRef, setCopiedRef] = useState(false);
  const [showNewMatter, setShowNewMatter] = useState(false);
  const [stages, setStages] = useState<Array<{ key: string; name: string }>>([]);
  const [referrals, setReferrals] = useState<any>(null);
  const [mergeKeep, setMergeKeep] = useState<MatterHit | null>(null);
  const [mergeAway, setMergeAway] = useState<MatterHit | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  type Access = { caseAccess: 'all' | 'selected'; mailboxAccess: 'own' | 'all' | 'selected'; covers: string[]; mailboxes: string[] };
  const blankPerson = { name: '', email: '', role: 'CONVEYANCER', caseAccess: 'all' as const, mailboxAccess: 'own' as const, covers: [] as string[], mailboxes: [] as string[] };
  const [editing, setEditing] = useState<string | 'new' | null>(null); // user id, 'new', or closed
  const [person, setPerson] = useState<{ name: string; email: string; role: string; caseAccess: 'all' | 'selected'; mailboxAccess: 'own' | 'all' | 'selected'; covers: string[]; mailboxes: string[] }>(blankPerson);
  const [personBusy, setPersonBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('CONVEYANCER');
  const [inviteBusy, setInviteBusy] = useState(false);
  // Everyone in the firm, for the "Assigned to" picker — not just the people who happen to
  // have work, and not gated on the admin check (which resolves after the first load).
  const [members, setMembers] = useState<Array<{ id: string; display_name: string | null; email: string }>>([]);
  useEffect(() => {
    api<{ members: Array<{ id: string; display_name: string | null; email: string }> }>('/team/members').then((r) => setMembers(r.members)).catch(() => {});
  }, []);
  const [status, setStatus] = useState('');
  const [docTemplates, setDocTemplates] = useState<DocTemplate[]>([]);
  const [docUpload, setDocUpload] = useState({ name: '', description: '' });
  const [docUploading, setDocUploading] = useState(false);
  const docFileRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [policy, setPolicy] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  // Automations (auto-rules + playbooks, merged) live in the self-contained
  // <Automations /> component — no page-level state needed here.
  const [t, setT] = useState({ name: '', category: 'enquiry_response', subjectTemplate: '', bodyTemplate: '', styleTag: 'NEUTRAL' });

  const load = useCallback(async () => {
    try {
      if (tab === 'billing') {
        setBilling(await api('/billing/account'));
        setReferrals(await api('/referrals'));
        api('/admin/import-analytics').then(setImportStats).catch(() => {});
      }
      if (tab === 'templates') setTemplates((await api<{ templates: Template[] }>('/admin/templates')).templates);
      if (tab === 'docpacks') setDocTemplates((await api<{ templates: DocTemplate[] }>('/admin/doc-templates')).templates);
      if (tab === 'policy') setPolicy((await api<{ policy: any }>('/admin/policies')).policy);
      if (tab === 'audit') setAudit((await api<{ logs: any[] }>('/admin/audit?limit=100')).logs);
      if (tab === 'team') setUsers((await api<{ users: any[] }>('/admin/users')).users);
      if (tab === 'workload') setWorkload((await api<{ workload: any[] }>('/admin/workload')).workload ?? []);
      setStatus('');
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  async function createTemplate() {
    try {
      await api('/admin/templates', { method: 'POST', body: JSON.stringify(t) });
      setT({ name: '', category: 'enquiry_response', subjectTemplate: '', bodyTemplate: '', styleTag: 'NEUTRAL' });
      await load();
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function uploadDocTemplate() {
    const file = docFileRef.current?.files?.[0];
    if (!file) { setStatus('Select a .docx file first.'); return; }
    if (!docUpload.name.trim()) { setStatus('Give the template a name.'); return; }
    setDocUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', docUpload.name.trim());
      form.append('description', docUpload.description.trim());
      const res = await fetch('/api/v1/admin/doc-templates', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDocUpload({ name: '', description: '' });
      if (docFileRef.current) docFileRef.current.value = '';
      await load();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setDocUploading(false);
    }
  }

  async function manageSubscription() {
    setBillingBusy(true);
    try {
      const { url } = await api<{ url: string }>('/billing/portal', { method: 'POST' });
      window.location.href = url;
    } catch (e: any) {
      if (e.status === 409) { window.location.href = '/start-trial'; return; }
      setStatus(e.message || 'Could not open the billing portal.');
      setBillingBusy(false);
    }
  }

  async function subscribe() {
    setBillingBusy(true);
    try {
      const res = await api<{ url?: string }>('/billing/checkout', { method: 'POST' });
      if (res.url) { window.location.href = res.url; return; }
      await load(); // already subscribed → nothing to change; refresh
    } catch (e: any) {
      setStatus(e.message || 'Could not start your subscription.');
    } finally {
      setBillingBusy(false);
    }
  }

  async function generateAiTemplate() {
    const file = aiGenFileRef.current?.files?.[0] ?? null;
    if (!aiGen.name.trim()) { setStatus('Give the template a name.'); return; }
    if (!file && aiGen.instructions.trim().length < 10) {
      setStatus('Describe the document, or upload an existing one to turn into a template.');
      return;
    }
    setAiGenBusy(true);
    setStatus('');
    try {
      const form = new FormData();
      form.append('name', aiGen.name.trim());
      form.append('instructions', aiGen.instructions.trim());
      if (file) form.append('file', file);
      const tok = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
      const res = await fetch('/api/v1/admin/doc-templates/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: form,
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      setAiGen({ name: '', instructions: '' });
      if (aiGenFileRef.current) aiGenFileRef.current.value = '';
      await load();
      setStatus(`Created “${r.name}”${r.fromDocument ? ' from your document' : ''}${r.hasLlmPrompts ? ' (with AI sections)' : ''}. Download it to review before using.`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setAiGenBusy(false);
    }
  }

  async function deleteDocTemplate(id: string) {
    try {
      await api(`/admin/doc-templates/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function loadExampleTemplates() {
    try {
      await api('/admin/doc-templates/examples', { method: 'POST' });
      await load();
      setStatus('Example templates loaded.');
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function openPerson(u: any) {
    try {
      const a = await api<Access>(`/admin/users/${u.id}/access`);
      setPerson({ name: u.display_name || '', email: u.email, role: u.role, ...a });
      setEditing(u.id);
    } catch (e) {
      setStatus((e as Error).message);
    }
  }
  function openNew() {
    setPerson(blankPerson);
    setEditing('new');
  }
  async function savePerson() {
    setPersonBusy(true);
    try {
      const access = { caseAccess: person.caseAccess, mailboxAccess: person.mailboxAccess, covers: person.covers, mailboxes: person.mailboxes };
      if (editing === 'new') {
        const r = await api<{ signInLinkSent: boolean }>('/admin/users', { method: 'POST', body: JSON.stringify({ name: person.name, email: person.email, role: person.role, ...access }) });
        setStatus(r.signInLinkSent ? `Account created. A sign-in link has been emailed to ${person.email}.` : `Account created. Email is not configured here, so send ${person.email} the sign-in page yourself.`);
      } else if (editing) {
        const u = users.find((x) => x.id === editing);
        if (u && u.role !== person.role) await api(`/admin/users/${editing}`, { method: 'PATCH', body: JSON.stringify({ role: person.role }) });
        await api(`/admin/users/${editing}/access`, { method: 'PUT', body: JSON.stringify(access) });
      }
      setEditing(null);
      await load();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setPersonBusy(false);
    }
  }
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function viewAs(userId: string) {
    try {
      await api(`/admin/users/${userId}/view-as`, { method: 'POST' });
      window.location.href = paths.cases;
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function setUserRole(userId: string, role: string) {
    try {
      await api(`/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      await load();
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function savePolicy() {
    try {
      await api('/admin/policies', {
        method: 'POST',
        body: JSON.stringify({
          defaultDisclaimer: policy.default_disclaimer ?? '',
          folderNamingPattern: policy.folder_naming_pattern ?? '{matter_ref}',
          allowedExternalDomains: policy.allowed_external_domains ?? [],
          mailSubfoldersEnabled: !!policy.mail_subfolders_enabled,
        }),
      });
      setStatus('Policy saved.');
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function mergeCases() {
    if (!mergeKeep || !mergeAway) return;
    if (mergeKeep.id === mergeAway.id) { setStatus('Pick two different cases.'); return; }
    if (!window.confirm(`Merge ${mergeAway.matterRef} into ${mergeKeep.matterRef}? All of ${mergeAway.matterRef}’s emails, documents, tasks and contacts move to ${mergeKeep.matterRef}, and ${mergeAway.matterRef} is archived. This can’t be undone automatically.`)) return;
    setMergeBusy(true);
    try {
      const r = await api<{ keepRef: string; mergedRef: string }>('/matters/merge', {
        method: 'POST',
        body: JSON.stringify({ keepId: mergeKeep.id, mergeId: mergeAway.id }),
      });
      setStatus(`Merged ${r.mergedRef} into ${r.keepRef}.`);
      setMergeKeep(null);
      setMergeAway(null);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setMergeBusy(false);
    }
  }

  // Full width — no artificial cap, so wide content (the matter board, the doc grid)
  // uses the space instead of scrolling horizontally when there's room.
  const box: React.CSSProperties = { width: '100%', margin: 0, padding: '0 24px', color: '#0f172a', boxSizing: 'border-box' };
  const spinnerStyle: React.CSSProperties = { width: 16, height: 16, borderRadius: 999, border: '2px solid #e2e8f0', borderTopColor: '#5A27E0', animation: 'adm-spin 0.7s linear infinite', display: 'inline-block' };
  const filterSelect: React.CSSProperties = { padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 13, background: '#fff', color: '#0f172a' };
  const clearBtn: React.CSSProperties = { padding: '5px 10px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 12, background: '#fff', color: '#475569', cursor: 'pointer' };
  const navItem = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    textAlign: 'left',
    padding: '4px 9px',
    borderRadius: 8,
    border: 'none',
    // No inline background when inactive so the .adm-nav:hover class can show through.
    ...(active ? { background: '#ede9fe', boxShadow: 'inset 3px 0 0 #5A27E0' } : {}),
    color: active ? '#5A27E0' : '#334155',
    fontWeight: active ? 700 : 500,
    fontSize: 13,
    cursor: 'pointer',
    marginBottom: 2,
    fontFamily: 'inherit',
  });
  const input: React.CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid #cbd5e1', borderRadius: 8, marginBottom: 8, fontSize: 14, boxSizing: 'border-box' };
  const card: React.CSSProperties = { border: '1px solid #e8eaf0', borderRadius: 14, padding: 18, marginBottom: 14, background: '#fff', boxShadow: '0 1px 2px rgba(16,24,40,0.04)' };
  const btnPrimary: React.CSSProperties = { padding: '9px 16px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, cursor: 'pointer', fontSize: 14 };
  const btnGhost: React.CSSProperties = { padding: '9px 16px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 9, fontWeight: 600, cursor: 'pointer', fontSize: 14 };
  const overline: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#64748b' };
  const navGroupLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: '#9aa6b8', padding: '0 4px 3px', marginBottom: 3, borderBottom: '1px solid #eef1f5' };
  const planBadge: React.CSSProperties = { background: '#ede9fe', color: '#6d28d9', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 800 };

  // Gate the whole page on auth: a 'logging you in' spinner while /me is in flight,
  // a sign-in prompt if unauthenticated. Don't show the shell to a stranger.
  if (meLoading || !me) {
    const brand = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#5A27E0" />
          <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
        </svg>
        <strong style={{ fontSize: 17 }}>CONVE<span style={{ color: '#5A27E0' }}>Yi</span></strong>
      </div>
    );
    return (
      <div style={{ background: '#f6f7fb', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'var(--font-manrope), ui-sans-serif, system-ui, sans-serif', color: '#0f172a' }}>
        <style>{`@keyframes adm-spin{to{transform:rotate(360deg)}}`}</style>
        {meLoading ? (
          <div style={{ textAlign: 'center', color: '#475569' }}>
            {brand}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#64748b' }}>
              <span style={spinnerStyle} /> Logging you in…
            </div>
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #e8eaf0', borderRadius: 16, boxShadow: '0 4px 24px rgba(16,24,40,0.07)', padding: '34px 36px', maxWidth: 420, width: '100%' }}>
            {brand}
            <h2 style={{ fontSize: 21, margin: '0 0 8px', color: '#0f172a', letterSpacing: -0.2 }}>Connect your inbox</h2>
            <p style={{ fontSize: 13.5, color: '#475569', lineHeight: 1.55, margin: '0 0 14px' }}>
              Sign in with the Microsoft 365 account you do conveyancing from. Nothing to install — CONVEYi starts working on your mail straight away:
            </p>
            <ul style={{ margin: '0 0 18px', paddingLeft: 0, listStyle: 'none' }}>
              {([
                [Inbox, 'Incoming email matched to the right case and tagged'],
                [PenLine, 'Replies drafted into your Outlook Drafts — nothing sends itself'],
                [FolderKanban, 'Every case on the caseload, chases never forgotten'],
              ] as Array<[typeof Inbox, string]>).map(([Ic, txt]) => (
                <li key={txt} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: '#334155', marginBottom: 8 }}>
                  <span style={{ flexShrink: 0, color: '#5A27E0', marginTop: 1 }}><Ic size={16} /></span>
                  <span>{txt}</span>
                </li>
              ))}
            </ul>
            <a href="/api/v1/auth/login" style={{ ...btnPrimary, textDecoration: 'none', display: 'block', textAlign: 'center' }}>Connect Microsoft 365</a>
            {/* Escape hatch for a stale consent / added scope — forces the Microsoft consent screen. */}
            <a href="/api/v1/auth/login?consent=1" style={{ display: 'block', textAlign: 'center', margin: '10px 0 0', color: '#5A27E0', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>
              Trouble connecting? Reconnect with fresh permissions
            </a>
            <p style={{ fontSize: 12, color: '#94a3b8', margin: '14px 0 0', lineHeight: 1.5 }}>
              Also using the Outlook add-in? Same account, same firm — sign in wherever suits and everything stays in step.
            </p>
          </div>
        )}
      </div>
    );
  }

  const initials = (me.displayName || me.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w: string) => w[0]?.toUpperCase())
    .join('');

  return (
    <div>
      {/* Board/card hover states and scrollbars the inline styles can't express. */}
      <style>{`
        .adm-bcard{box-shadow:0 1px 2px rgba(16,24,40,0.05);transition:box-shadow .13s ease,transform .13s ease}
        .adm-bcard:hover{box-shadow:0 5px 14px rgba(16,24,40,0.11);transform:translateY(-1px)}
        ::-webkit-scrollbar{height:8px;width:8px}
        ::-webkit-scrollbar-thumb{background:#d7dce3;border-radius:999px}
        ::-webkit-scrollbar-track{background:transparent}
      `}</style>
        <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>{TAB_META[tab].label}</h1>
          {tab === 'mywork' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#64748b' }}>Assigned to</span>
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ border: '1px solid #d0d5dd', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, fontWeight: 700, color: '#0f172a', background: '#fff', cursor: 'pointer' }}>
                  <option value="">Anyone</option>
                  {members.map((u) => (<option key={u.id} value={u.id}>{u.display_name || u.email}{u.id === me?.userId ? ' (me)' : ''}</option>))}
                </select>
              </label>
              <button onClick={() => setShowNewMatter(true)} style={{ marginLeft: 0, padding: '6px 14px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>＋ New case</button>
            </>
          )}
        </div>

        {status && <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c' }}>{status}</div>}




        {tab === 'billing' && (
          !billing ? (
            <div style={card}>Loading your account…</div>
          ) : (
            <>
              <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div>
                    <div style={overline}>Your plan</div>
                    <div style={{ fontSize: 26, fontWeight: 800, marginTop: 2 }}>{money(billing.pricePerCasePennies ?? 10000, billing.currency ?? 'gbp')} per case</div>
                  </div>
                  {(() => {
                    const s = STATUS_STYLE[billing.status] ?? { label: billing.status, bg: '#f1f5f9', color: '#64748b' };
                    return <span style={{ background: s.bg, color: s.color, borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 700 }}>{s.label}</span>;
                  })()}
                </div>
                {billing.status === 'past_due' && (
                  <p style={{ background: '#fffbeb', color: '#92400e', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginTop: 12 }}>
                    Your last payment failed. Update your card to keep your team running.
                  </p>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 14 }}>
                  {[
                    ['Cases this month', String(billing.cases?.thisMonth ?? 0)],
                    ['Billed this month', money(billing.cases?.billedPenniesThisMonth ?? 0, billing.currency ?? 'gbp')],
                    ['Free on trial', String((billing.cases?.thisMonth ?? 0) - (billing.cases?.billedThisMonth ?? 0))],
                    ['Cases all time', String(billing.cases?.allTime ?? 0)],
                  ].map(([k, v]) => (
                    <div key={k} style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ fontSize: 12, color: '#64748b' }}>{k}</div>
                      <div style={{ fontSize: 20, fontWeight: 800 }}>{v}</div>
                    </div>
                  ))}
                </div>
                <p style={{ color: '#64748b', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
                  A case is charged once, the first time CONVEYi drafts, reviews, generates or reconciles something on it.
                  Triage, matching and summaries are free. Cases opened on your trial are never charged.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
                  {!billing.hasSubscription && (
                    <button style={btnPrimary} disabled={billingBusy} onClick={subscribe}>{billingBusy ? 'Working…' : 'Add payment details'}</button>
                  )}
                  {billing.hasSubscription && (
                    <button style={btnGhost} disabled={billingBusy} onClick={manageSubscription}>Manage subscription</button>
                  )}
                </div>
                {billing.hasSubscription && (
                  <p style={{ color: '#64748b', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
                    “Manage subscription” opens Stripe for your card, invoices &amp; cancellation.
                  </p>
                )}
              </div>

              {/* Impact — response-time stats from the historical import (renewal value). */}
              {importStats?.available && (
                <div style={card}>
                  <div style={overline}>Your correspondence, from the import</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22, marginTop: 12 }}>
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a' }}>{fmtDuration(importStats.medianResponseMins)}</div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>Typical time to reply</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a' }}>{fmtDuration(importStats.avgCaseResponseMins)}</div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>Avg reply time per case</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a' }}>{importStats.responses.toLocaleString()}</div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>replies · {importStats.cases.toLocaleString()} cases</div>
                    </div>
                  </div>
                  <p style={{ color: '#475569', fontSize: 13, margin: '14px 0 0', lineHeight: 1.5 }}>
                    Across the case emails you actually replied to. For this volume of replies, CONVEYi’s drafting
                    saves an estimated <strong>~{importStats.estimatedHoursSaved.toLocaleString()} hours</strong> of
                    writing — and helps you reply faster.
                  </p>
                </div>
              )}

              <div style={card}>
                <div style={overline}>Team · {billing.seatCount} {billing.seatCount === 1 ? 'seat' : 'seats'}</div>
                <div style={{ marginTop: 8 }}>
                  {(billing.seats ?? []).map((s: any) => (
                    <div key={s.email} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid #f1f5f9' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14 }}>{s.displayName || s.email}</div>
                        {s.displayName && <div style={{ fontSize: 12, color: '#64748b' }}>{s.email}</div>}
                      </div>
                      <span style={{ background: '#f1f5f9', color: '#475569', borderRadius: 999, padding: '2px 10px', fontSize: 12 }}>{String(s.role).toLowerCase()}</span>
                    </div>
                  ))}
                </div>
                <p style={{ color: '#64748b', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
                  Colleagues join by signing in with their Microsoft 365 account — in the CONVEYi add-in, or just at this web address. Seats are free: you pay per case, not per person.
                </p>
              </div>

              {/* Referrals — merged in under Billing. */}
              <div style={card}>
                <div style={overline}>Refer a firm, earn credit</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 800 }}>{money(billing.creditBalancePennies, billing.currency)}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>Credit balance</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 800 }}>{billing.referrals.active} / {billing.referrals.total}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>Active / referred</div>
                  </div>
                  {referrals?.commissions && (
                    <div>
                      <div style={{ fontSize: 22, fontWeight: 800 }}>{money(referrals.commissions.appliedPennies, billing.currency)}</div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>Earned to date</div>
                    </div>
                  )}
                </div>
                <p style={{ color: '#64748b', fontSize: 13, margin: '0 0 8px' }}>
                  Earn up to {money(billing.commissionPennies, billing.currency)}/month for every firm you refer (a quarter of what they pay), for as long as they stay subscribed.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <input readOnly value={billing.referralLink} onFocus={(e) => e.currentTarget.select()} style={{ ...input, flex: 1, minWidth: 220, marginBottom: 0 }} />
                  <button
                    style={btnGhost}
                    onClick={() => navigator.clipboard?.writeText(billing.referralLink).then(() => { setCopiedRef(true); setTimeout(() => setCopiedRef(false), 1600); })}
                  >
                    {copiedRef ? 'Copied!' : 'Copy link'}
                  </button>
                </div>
                {referrals?.referrals?.list?.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    {referrals.referrals.list.map((r: any, i: number) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #f1f5f9', padding: '6px 0', fontSize: 13 }}>
                        <span>{r.plan ?? '—'} · joined {new Date(r.created_at).toLocaleDateString()}</span>
                        <span style={{ color: r.status === 'active' ? '#16a34a' : '#94a3b8' }}>{r.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )
        )}

        {tab === 'help' && (
          <>
            <div style={card}>
              <div style={overline}>Frequently asked</div>
              <div style={{ marginTop: 6 }}>
                {[
                  ['Does CONVEYi ever send email on my behalf?', 'Yes, for the routine admin: acknowledgements that something arrived, chases when a response is overdue, and the status note to the client and agent that says we chased. Anything with a professional judgement in it — a report on title, a reply on a legal point — is a decision for you first.'],
                  ['What does auto-triage do?', 'On each incoming email it matches the message to a case, tags it in Outlook, and pre-analyses it (thread summary + a drafted reply) so the email opens ready. It’s always on and never sends.'],
                  ['How are emails matched to a case?', 'By hard signals first — a thread already linked to a case, or your case-ref token in the subject — then corroborating ones like the property postcode, party names and known participants. A match needs more than one signal to be confident.'],
                  ['How do document templates work?', 'Upload (or AI-generate) Word .docx templates in Automation → Doc packs using {{placeholders}} for case data and, on premium plans, [[AI sections]]. On any case, a conveyancer clicks Generate and the file is filled and saved to the case folder.'],
                  ['How is billing handled?', 'You pay per case — £100 the first time CONVEYi does work on a case, invoiced monthly. The card, invoices and cancellation are handled securely by Stripe via “Manage subscription”.'],
                  ['Where is our data stored?', 'Case data lives in your firm’s own Microsoft 365 (OneDrive) plus CONVEYi’s database for matching and analysis. AI drafting uses Claude; nothing is sent to third parties beyond what’s needed to draft and never auto-sent.'],
                ].map(([q, a]) => (
                  <details key={q} style={{ borderTop: '1px solid #f1f5f9', padding: '10px 0' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>{q}</summary>
                    <p style={{ color: '#475569', fontSize: 13, lineHeight: 1.5, margin: '8px 0 0' }}>{a}</p>
                  </details>
                ))}
              </div>
            </div>

            <div style={card}>
              <div style={overline}>Support</div>
              <p style={{ color: '#475569', fontSize: 14, margin: '8px 0 12px' }}>
                Stuck or have a question we haven’t covered? We’re happy to help — typically within one business day.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <a href={`mailto:support@conveyi.app?subject=${encodeURIComponent('CONVEYi support' + (me?.email ? ` — ${me.email}` : ''))}`} style={{ ...btnPrimary, textDecoration: 'none', display: 'inline-block' }}>
                  Email support
                </a>
                <a href="mailto:hello@conveyi.app?subject=Sales%20enquiry" style={{ ...btnGhost, textDecoration: 'none', display: 'inline-block' }}>
                  Contact sales
                </a>
              </div>
              <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                When emailing, include your firm and a short description — it helps us resolve things faster.
              </p>
            </div>
          </>
        )}

        {tab === 'mywork' && (
          <>
            <DecisionTray userId={assignee || me?.userId || ''} all={assignee === ''} />
            <EngineWork who={assignee} />
          </>
        )}

        {tab === 'workload' && (
          <div style={card}>
            <p style={{ fontSize: 13, color: '#475569', margin: '0 0 12px', lineHeight: 1.5 }}>
              Who’s carrying what right now. Assign cases from the board or a case’s drawer; anything without an owner shows in its own row so nothing slips.
            </p>
            {workload.length === 0 ? (
              <p style={{ fontSize: 13, color: '#64748b' }}>No open cases yet.</p>
            ) : (
              <div style={{ overflowX: 'auto', border: '1px solid #e8eaf0', borderRadius: 10 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['Fee-earner', 'Open cases', 'Needs attention', 'Overdue chases', 'Drafts waiting'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i === 0 ? 'left' : 'center', fontWeight: 700, color: '#334155', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const maxOpen = Math.max(1, ...workload.map((w) => w.open_matters));
                      const initialsOf = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
                      return workload.map((r) => {
                        const num = (v: number, colour: string) => (
                          <td style={{ padding: '10px 12px', textAlign: 'center', color: v ? colour : '#cbd5e1', fontWeight: v ? 700 : 400 }}>{v}</td>
                        );
                        return (
                          <tr key={r.id ?? 'unassigned'} style={{ borderTop: '1px solid #eef2f7', background: r.id ? '#fff' : '#fffbeb' }}>
                            <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                                <span style={{ width: 26, height: 26, borderRadius: 999, background: r.id ? '#ede9fe' : '#fef3c7', color: r.id ? '#5A27E0' : '#b45309', fontSize: 10.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  {r.id ? initialsOf(r.name) : '!'}
                                </span>
                                <span style={{ fontWeight: 700, color: '#0f172a' }}>
                                  {r.name}
                                  {!r.id && <span style={{ fontWeight: 500, color: '#b45309' }}> · needs an owner</span>}
                                </span>
                              </div>
                            </td>
                            {/* Open matters as a capacity bar — who's loaded, at a glance */}
                            <td style={{ padding: '10px 12px', minWidth: 160 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, height: 7, background: '#eef1f5', borderRadius: 999, overflow: 'hidden' }}>
                                  <div style={{ width: `${Math.round((r.open_matters / maxOpen) * 100)}%`, height: '100%', background: r.id ? '#8b5cf6' : '#f59e0b', borderRadius: 999 }} />
                                </div>
                                <span style={{ fontWeight: 700, color: r.open_matters ? '#0f172a' : '#cbd5e1', width: 22, textAlign: 'right' }}>{r.open_matters}</span>
                              </div>
                            </td>
                            {num(r.needs_attention, '#b45309')}
                            {num(r.overdue_chases, '#dc2626')}
                            {num(r.drafts_waiting, '#5A27E0')}
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}


        {tab === 'templates' && <EmailTemplates />}

        {tab === 'docpacks' && (
          <>
            {/* Create with AI — the headline feature, up top */}
            <div style={{ ...card, background: 'linear-gradient(180deg,#faf5ff,#ffffff)', borderColor: '#d8b4fe', boxShadow: '0 2px 10px rgba(124,58,237,0.10)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#6d28d9', display: 'flex' }}><Sparkles size={18} /></span>
                <h2 style={{ margin: 0, fontSize: 18 }}>Create a template with AI</h2>
                <span style={{ fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 4, padding: '2px 6px', fontWeight: 700 }}>Beta</span>
              </div>
              <p style={{ fontSize: 13, color: '#475569', margin: '8px 0 14px' }}>
                Two ways: <strong>upload an existing Word document</strong> and we’ll turn it into a fillable
                template — keeping your wording and swapping the client/property/date details for case
                placeholders automatically — <strong>or describe</strong> the document and we’ll draft it from
                scratch. Nothing is sent; the template is saved here to download and review first.
              </p>

              <input
                style={input}
                placeholder="Template name (e.g. Notice to complete)"
                value={aiGen.name}
                onChange={(e) => setAiGen({ ...aiGen, name: e.target.value })}
              />

              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6d28d9', margin: '8px 0 4px' }}>
                Turn an existing document into a template
              </label>
              <input ref={aiGenFileRef} type="file" accept=".docx,.txt" style={{ ...input, padding: '7px 8px' }} />

              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6d28d9', margin: '8px 0 4px' }}>
                …or describe it (and add notes to refine an upload)
              </label>
              <textarea
                style={{ ...input, minHeight: 84 }}
                placeholder="e.g. 'A formal notice to complete to the other side's solicitor, citing the missed completion date and giving 10 working days.'  — optional if you uploaded a file"
                value={aiGen.instructions}
                onChange={(e) => setAiGen({ ...aiGen, instructions: e.target.value })}
                maxLength={4000}
              />
              <button
                style={{ padding: '9px 18px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, cursor: 'pointer', fontSize: 14, opacity: aiGenBusy ? 0.6 : 1 }}
                onClick={generateAiTemplate}
                disabled={aiGenBusy}
              >
                {aiGenBusy ? 'Generating…' : 'Generate template'}
              </button>
            </div>

            {/* How it works */}
            <div style={{ ...card, background: '#f0f9ff', borderColor: '#bae6fd' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <h3 style={{ marginTop: 0, fontSize: 15 }}>Document templates</h3>
                <a href="/conveyi/doc-packs" target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#0369a1', fontWeight: 600 }}>
                  Full guide →
                </a>
              </div>
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>Placeholder syntax</p>
              <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                <tbody>
                  {[
                    ['{{matter_ref}}', 'Case reference, e.g. CL-0042'],
                    ['{{property_address}}', 'Full property address'],
                    ['{{buyer_names}}', 'Comma-separated buyer names'],
                    ['{{seller_names}}', 'Comma-separated seller names'],
                    ['{{exchange_date}}', 'Target exchange date (formatted)'],
                    ['{{completion_date}}', 'Target completion date (formatted)'],
                    ['{{counterparty_solicitor}}', 'Other side\'s solicitor'],
                    ['{{counterparty_agent}}', 'Estate agent'],
                    ['{{lender}}', 'Lender name'],
                    ['{{track}}', 'Purchase / Sale / Remortgage'],
                    ['{{stage}}', 'Current stage name'],
                    ['{{today}}', 'Today\'s date (formatted)'],
                    ['{{firm_name}}', 'Your firm name'],
                    ['{{assigned_to}}', 'Conveyancer handling the case'],
                  ].map(([placeholder, desc]) => (
                    <tr key={placeholder} style={{ borderTop: '1px solid #e0f2fe' }}>
                      <td style={{ padding: '3px 8px 3px 0', fontFamily: 'monospace', color: '#0369a1', whiteSpace: 'nowrap' }}>{placeholder}</td>
                      <td style={{ padding: '3px 0', color: '#475569' }}>{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: '#64748b', marginTop: 10, marginBottom: 0 }}>
                <strong>Pro plan and up:</strong> use{' '}
                <code style={{ background: '#e0f2fe', padding: '1px 4px', borderRadius: 3 }}>
                  [[Write a short welcome paragraph for the client]]
                </code>{' '}
                to have Claude generate that section. Write any natural-language instruction between{' '}
                <code style={{ background: '#e0f2fe', padding: '1px 4px', borderRadius: 3 }}>[[</code> and{' '}
                <code style={{ background: '#e0f2fe', padding: '1px 4px', borderRadius: 3 }}>]]</code>.
              </p>
            </div>

            {/* Upload form */}
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>Upload template</h3>
              <input
                ref={docFileRef}
                type="file"
                accept=".docx"
                style={{ ...input, padding: '6px 8px' }}
              />
              <input
                style={input}
                placeholder="Template name (e.g. Client care letter)"
                value={docUpload.name}
                onChange={(e) => setDocUpload({ ...docUpload, name: e.target.value })}
              />
              <input
                style={input}
                placeholder="Description (optional)"
                value={docUpload.description}
                onChange={(e) => setDocUpload({ ...docUpload, description: e.target.value })}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={{ padding: '8px 16px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', opacity: docUploading ? 0.6 : 1 }}
                  onClick={uploadDocTemplate}
                  disabled={docUploading}
                >
                  {docUploading ? 'Uploading…' : 'Upload'}
                </button>
                {docTemplates.length === 0 && (
                  <button
                    style={{ padding: '8px 16px', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}
                    onClick={loadExampleTemplates}
                  >
                    Load example templates
                  </button>
                )}
              </div>
            </div>

            {/* Template list */}
            {docTemplates.length === 0 && (
              <div style={{ ...card, textAlign: 'center', color: '#94a3b8' }}>
                No templates yet. Upload your first .docx or load the examples above.
              </div>
            )}
            {docTemplates.map((tpl) => (
              <div key={tpl.id} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <strong>{tpl.name}</strong>
                    {tpl.has_llm_prompts && (
                      <span style={{ marginLeft: 8, fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>
                        AI prompts · Team only
                      </span>
                    )}
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                      {tpl.file_name} · {(tpl.file_size_bytes / 1024).toFixed(0)} KB
                    </div>
                    {tpl.description && (
                      <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>{tpl.description}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <a
                      href={`/api/v1/admin/doc-templates/${tpl.id}`}
                      download={tpl.file_name}
                      style={{ padding: '4px 10px', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, textDecoration: 'none', fontWeight: 600 }}
                    >
                      Download
                    </a>
                    <button
                      style={{ padding: '4px 10px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => deleteDocTemplate(tpl.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {docTemplates.length > 0 && (
              <button
                style={{ padding: '6px 12px', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
                onClick={loadExampleTemplates}
              >
                + Add example templates
              </button>
            )}
          </>
        )}

        {tab === 'policy' && policy && (
          <div style={card}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Default disclaimer</label>
            <textarea style={{ ...input, minHeight: 80 }} value={policy.default_disclaimer ?? ''} onChange={(e) => setPolicy({ ...policy, default_disclaimer: e.target.value })} />
            <label style={{ fontSize: 13, fontWeight: 600 }}>Folder naming pattern</label>
            <input style={input} value={policy.folder_naming_pattern ?? ''} onChange={(e) => setPolicy({ ...policy, folder_naming_pattern: e.target.value })} />
            <label style={{ fontSize: 13, fontWeight: 600 }}>Allowed external domains (comma separated)</label>
            <input
              style={input}
              value={(policy.allowed_external_domains ?? []).join(',')}
              onChange={(e) => setPolicy({ ...policy, allowed_external_domains: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })}
            />
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, margin: '6px 0 12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!policy.mail_subfolders_enabled}
                onChange={(e) => setPolicy({ ...policy, mail_subfolders_enabled: e.target.checked })}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong>Per-case Inbox subfolders.</strong> Give each case its own Outlook Inbox subfolder and
                move matched emails into it as they’re actioned. Off keeps your inbox untouched (matched mail is still
                tagged, just not moved).
              </span>
            </label>
            <button style={{ padding: '8px 16px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }} onClick={savePolicy}>
              Save policy
            </button>
          </div>
        )}

        {tab === 'team' && (
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Team</h3>
              <span style={{ fontSize: 13, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{users.length} of 100</span>
              <button style={{ ...btnPrimary, marginLeft: 'auto', padding: '7px 14px', fontSize: 13 }} onClick={openNew} title="Create the account now — name, role and access — and email them a sign-in link.">New</button>
            </div>
            {editing === 'new' && (
              <PersonPanel person={person} setPerson={setPerson} users={users} isNew busy={personBusy} onSave={() => void savePerson()} onClose={() => setEditing(null)} toggleIn={toggleIn} />
            )}
            {users.map((u) => (
              <div key={u.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {u.display_name || u.email}
                      {u.email === me?.email ? <span style={{ color: '#94a3b8', fontWeight: 500 }}> · you</span> : null}
                      {u.signed_in === false ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#78350f', background: '#fef3c7', borderRadius: 999, padding: '1px 8px' }} title="The account exists; they have not signed in yet.">Not signed in yet</span> : null}
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{u.email} · {String(u.role).toLowerCase().replace('_', ' ')} · {u.case_access === 'all' ? 'all cases' : 'selected cases'} · {u.mailbox_access === 'all' ? 'all inboxes' : u.mailbox_access === 'selected' ? 'selected inboxes' : 'own inbox'}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {u.email !== me?.email && (
                      <button style={{ ...btnGhost, padding: '6px 12px', fontSize: 13 }} onClick={() => void viewAs(u.id)} title="See the app exactly as this person does. A banner at the top brings you back. Both ends are logged.">View As</button>
                    )}
                    <button style={{ ...btnGhost, padding: '6px 9px', fontSize: 13, display: 'inline-flex', alignItems: 'center' }} onClick={() => (editing === u.id ? setEditing(null) : void openPerson(u))} title="Role, cases and inboxes for this person" aria-label={`Settings for ${u.display_name || u.email}`}><Settings size={16} /></button>
                  </div>
                </div>
                {editing === u.id && (
                  <PersonPanel person={person} setPerson={setPerson} users={users.filter((x) => x.id !== u.id)} isNew={false} busy={personBusy} onSave={() => void savePerson()} onClose={() => setEditing(null)} toggleIn={toggleIn} />
                )}
              </div>
            ))}
          </div>
        )}


        {tab === 'actions' && (
          <>
            <div style={card}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Keep this case</label>
              <div style={{ marginTop: 4, marginBottom: 12 }}>
                <MatterPicker selected={mergeKeep} onSelect={setMergeKeep} />
              </div>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Merge this one into it (archived)</label>
              <div style={{ marginTop: 4, marginBottom: 12 }}>
                <MatterPicker selected={mergeAway} onSelect={setMergeAway} />
              </div>
              <button
                style={{ padding: '8px 16px', background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', opacity: !mergeKeep || !mergeAway || mergeBusy ? 0.5 : 1 }}
                onClick={mergeCases}
                disabled={!mergeKeep || !mergeAway || mergeBusy}
              >
                {mergeBusy ? 'Merging…' : 'Merge cases'}
              </button>
            </div>
          </>
        )}

        {tab === 'audit' && (() => {
          const q = auditQuery.trim().toLowerCase();
          const rows = audit.filter((r) =>
            (!auditCat || auditCategory(r) === auditCat) &&
            (!auditStatus || String(r.action_status) === auditStatus) &&
            (!q || `${describeAudit(r)} ${r.actor_name || ''} ${r.acting_name || ''} ${r.matter_ref || ''} ${r.action_type}`.toLowerCase().includes(q))
          );
          return (
          <div style={card}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              <input
                value={auditQuery}
                onChange={(e) => setAuditQuery(e.target.value)}
                placeholder="Search the log…"
                style={{ ...filterSelect, flex: 1, minWidth: 180, cursor: 'text' }}
              />
              <select value={auditCat} onChange={(e) => setAuditCat(e.target.value)} style={filterSelect}>
                {AUDIT_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select value={auditStatus} onChange={(e) => setAuditStatus(e.target.value)} style={filterSelect}>
                <option value="">Any result</option>
                <option value="SUCCESS">Done</option>
                <option value="BLOCKED">Blocked</option>
                <option value="FAILED">Failed</option>
              </select>
              <span style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                {rows.length} of {audit.length}
              </span>
            </div>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th style={{ padding: '6px 10px 8px 0', fontWeight: 700, whiteSpace: 'nowrap' }}>When</th>
                  <th style={{ padding: '6px 10px 8px 0', fontWeight: 700 }}>Who</th>
                  <th style={{ padding: '6px 10px 8px 0', fontWeight: 700, width: '100%' }}>What happened</th>
                  <th style={{ padding: '6px 0 8px', fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap' }}>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = String(row.action_status || '');
                  const sc = status === 'SUCCESS' ? { c: '#166534', b: '#dcfce7' } : status === 'BLOCKED' ? { c: '#92400e', b: '#fef3c7' } : { c: '#b91c1c', b: '#fee2e2' };
                  const when = new Date(row.created_at);
                  const open = auditOpen === row.id;
                  const detail = Object.entries((row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, any>);
                  return (
                    <Fragment key={row.id}>
                    <tr
                      onClick={() => setAuditOpen(open ? null : row.id)}
                      style={{ borderTop: '1px solid #eef2f7', verticalAlign: 'top', cursor: 'pointer', background: open ? '#f8fafc' : undefined }}
                    >
                      <td style={{ padding: '9px 10px 9px 0', color: '#64748b', whiteSpace: 'nowrap' }} title={when.toLocaleString()}>
                        {when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}<span style={{ color: '#cbd5e1' }}> · </span>{when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td style={{ padding: '9px 10px 9px 0', color: '#334155', whiteSpace: 'nowrap' }}>{row.acting_name ? `${row.acting_name} on behalf of ${row.actor_name}` : row.actor_name || 'System'}</td>
                      <td style={{ padding: '9px 10px 9px 0', color: '#0f172a', lineHeight: 1.45 }}>
                        <span aria-hidden style={{ color: '#cbd5e1', marginRight: 6, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>›</span>
                        {describeAudit(row)}
                        {row.matter_ref && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: '#5A27E0', background: '#ede9fe', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>{row.matter_ref}</span>}
                      </td>
                      <td style={{ padding: '9px 0', textAlign: 'right' }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, color: sc.c, background: sc.b, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                          {status === 'SUCCESS' ? 'Done' : status === 'BLOCKED' ? 'Blocked' : 'Failed'}
                        </span>
                      </td>
                    </tr>
                    {open && (
                      <tr style={{ background: '#f8fafc' }}>
                        <td colSpan={4} style={{ padding: '2px 0 14px 0' }}>
                          <div style={{ background: '#fff', border: '1px solid #e8eaf0', borderRadius: 10, padding: '10px 12px' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', fontSize: 12 }}>
                              <span style={{ color: '#94a3b8' }}>Event <code style={{ color: '#475569' }}>{row.action_type}</code></span>
                              <span style={{ color: '#94a3b8' }}>When <span style={{ color: '#475569' }}>{when.toLocaleString()}</span></span>
                              {row.matter_ref && <span style={{ color: '#94a3b8' }}>Case <span style={{ color: '#475569' }}>{row.matter_ref}</span></span>}
                              {row.trace_id && <span style={{ color: '#94a3b8' }}>Trace <code style={{ color: '#475569' }}>{row.trace_id}</code></span>}
                              {row.request_id && <span style={{ color: '#94a3b8' }}>Request <code style={{ color: '#475569' }}>{row.request_id}</code></span>}
                            </div>
                            {detail.length > 0 && (
                              <table style={{ marginTop: 10, fontSize: 12, borderCollapse: 'collapse' }}>
                                <tbody>
                                  {detail.map(([k, v]) => (
                                    <tr key={k}>
                                      <td style={{ padding: '2px 14px 2px 0', color: '#94a3b8', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
                                      <td style={{ padding: '2px 0', color: '#334155', wordBreak: 'break-word' }}>
                                        {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                            {detail.length === 0 && <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8' }}>No extra detail recorded for this event.</div>}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>
                    {audit.length === 0 ? 'No activity recorded yet.' : 'Nothing matches those filters.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          );
        })()}
        </div>

      {showNewMatter && (
        <NewMatter
          onClose={() => setShowNewMatter(false)}
          onCreated={async (id) => {
            setShowNewMatter(false);
            setStatus('Case created — OneDrive folder provisioned.');
            router.push(paths.matter(id));
          }}
        />
      )}
    </div>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <AdminPageInner />
    </Suspense>
  );
}
