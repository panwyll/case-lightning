'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fallbackMatterRef } from '@/lib/ref-name';
import MatterDrawer from './MatterDrawer';

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

type TabKey = 'mywork' | 'billing' | 'board' | 'workload' | 'templates' | 'docpacks' | 'playbooks' | 'rules' | 'team' | 'policy' | 'actions' | 'audit' | 'help';

// One entry per tab — the label and a subtitle that matches what the section does,
// so a deep link (e.g. ?tab=docpacks) lands somewhere coherent.
const TAB_META: Record<TabKey, { label: string; subtitle: string }> = {
  mywork: { label: 'My work', subtitle: 'Replies drafted and waiting in your Outlook Drafts, and threads that need a chase.' },
  billing: { label: 'Billing & referrals', subtitle: 'Your plan, subscription, seats and referral credit. Card, invoices and cancellation are handled by Stripe.' },
  board: { label: 'Matter board', subtitle: '' },
  workload: { label: 'Workload', subtitle: 'Who’s carrying what — open matters, what needs attention, overdue chases and drafts waiting, per fee-earner.' },
  templates: { label: 'Email templates', subtitle: 'Reusable reply templates the assistant drafts from, organised by tone.' },
  docpacks: { label: 'Doc packs', subtitle: 'Word (.docx) document templates filled with a matter’s data on demand — upload or generate with AI.' },
  playbooks: { label: 'Workflows', subtitle: 'Named multi-step actions your team runs against an email in one click. Nothing is sent.' },
  rules: { label: 'Auto-rules', subtitle: 'Premium automation that fires only on very-high-confidence matches.' },
  team: { label: 'Team', subtitle: 'Who can access the firm, and their roles.' },
  policy: { label: 'Policy', subtitle: 'Firm-wide disclaimer, case-folder naming and allowed external domains.' },
  actions: { label: 'Tools', subtitle: 'One-off admin operations, such as merging duplicate matters.' },
  audit: { label: 'Audit log', subtitle: 'Recent actions taken across the firm.' },
  help: { label: 'Help & support', subtitle: 'Common questions and how to reach us.' },
};

// Grouped left-nav. Empty groups (after role filtering) are hidden.
const NAV_GROUPS: { label: string; tabs: TabKey[] }[] = [
  { label: 'Work', tabs: ['mywork', 'board', 'workload'] },
  { label: 'Automation & templates', tabs: ['templates', 'docpacks', 'playbooks', 'rules'] },
  { label: 'Firm', tabs: ['team', 'policy'] },
  { label: 'Tools', tabs: ['actions', 'audit'] },
  { label: 'Account', tabs: ['billing', 'help'] },
];

// Small icon per tab — the nav reads at a glance, Monday/Jira style.
const TAB_ICON: Record<TabKey, string> = {
  mywork: '☑️',
  board: '🗂️',
  workload: '⚖️',
  templates: '✉️',
  docpacks: '📄',
  playbooks: '⚡',
  rules: '🤖',
  team: '👥',
  policy: '🛡️',
  actions: '🔧',
  audit: '🕘',
  billing: '💳',
  help: '💬',
};
const TAB_KEYS = NAV_GROUPS.flatMap((g) => g.tabs);
// Tabs that need the ADMIN role. Billing and Help are per-user, so a non-admin who
// lands here from "click your name" still sees those.
const ADMIN_ONLY: TabKey[] = ['board', 'workload', 'templates', 'docpacks', 'playbooks', 'rules', 'team', 'policy', 'actions', 'audit'];

// Conveyancing stage model — the board's columns, in workflow order.
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

const PLAN_LABEL: Record<string, string> = { plus: 'Solo', pro: 'Pro', enterprise: 'Firm' };
const STATUS_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  active: { label: 'Active', bg: '#dcfce7', color: '#166534' },
  trialing: { label: 'Trial', bg: '#ede9fe', color: '#6d28d9' },
  past_due: { label: 'Past due', bg: '#fef3c7', color: '#92400e' },
  canceled: { label: 'Canceled', bg: '#fee2e2', color: '#b91c1c' },
};

// A matter search box with a results dropdown; calls onSelect with the chosen matter.
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

export default function AdminPage() {
  const [me, setMe] = useState<{ role: string; email: string; displayName: string | null; tenantName?: string } | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const isAdmin = me?.role === 'ADMIN';
  // Show the full nav immediately (static) — only collapse it once we've CONFIRMED a
  // non-admin. Gating on the async /me would otherwise pop the sidebar from 2 → all.
  const visibleTabs = me && !isAdmin ? TAB_KEYS.filter((k) => !ADMIN_ONLY.includes(k)) : TAB_KEYS;

  const [tab, setTab] = useState<TabKey>('mywork');
  const [workload, setWorkload] = useState<Array<{ id: string | null; name: string; role: string | null; open_matters: number; needs_attention: number; overdue_chases: number; drafts_waiting: number }>>([]);
  // "My work": the same worklist the taskpane shows — chases + ready-to-send drafts —
  // so the web app is operable day-to-day without the add-in.
  const [mywork, setMywork] = useState<{ items: any[]; team: boolean; isAdmin: boolean; assignedTo: string } | null>(null);
  const [myworkBusy, setMyworkBusy] = useState<string | null>(null);
  const loadMywork = useCallback((assignee?: string) => {
    api<{ items: any[]; team: boolean; isAdmin: boolean; assignedTo: string }>(
      `/worklist${assignee !== undefined ? `?assignedTo=${encodeURIComponent(assignee || 'any')}` : ''}`
    )
      .then(setMywork)
      .catch(() => setMywork({ items: [], team: false, isAdmin: false, assignedTo: '' }));
  }, []);
  // The primary action on a chase is the EMAIL: one click drafts the chaser server-
  // side, the draft appears inline for review, and Send fires it — all without
  // leaving the web app. (It also sits in Outlook Drafts, so either surface works.)
  type ChaserDraft = 'busy' | { id: string; webLink: string | null; subject: string; bodyHtml: string };
  const [chaserDrafts, setChaserDrafts] = useState<Record<string, ChaserDraft>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  async function draftChaser(item: any) {
    const key = item.id;
    setChaserDrafts((s) => ({ ...s, [key]: 'busy' }));
    try {
      const r = await api<{ id: string; webLink: string | null; subject: string; bodyHtml: string }>('/worklist/draft-chaser', {
        method: 'POST',
        body: JSON.stringify({ threadId: item.threadId ?? item.id }),
      });
      setChaserDrafts((s) => ({ ...s, [key]: r }));
    } catch (e: any) {
      setChaserDrafts((s) => {
        const { [key]: _drop, ...rest } = s;
        return rest;
      });
      setStatus(e?.message || 'Could not draft the chaser.');
    }
  }
  async function sendFromWeb(item: any, messageId: string) {
    setSendingId(item.id);
    try {
      await api('/worklist/send', { method: 'POST', body: JSON.stringify({ messageId, itemId: item.id }) });
      setMywork((s) => (s ? { ...s, items: s.items.filter((x) => x.id !== item.id) } : s));
      setChaserDrafts((s) => {
        const { [item.id]: _drop, ...rest } = s;
        return rest;
      });
    } catch (e: any) {
      setStatus(e?.message || 'Could not send — the draft may have changed. Try from Outlook Drafts.');
    } finally {
      setSendingId(null);
    }
  }
  async function myworkAction(item: any, action: 'snooze' | 'dismiss' | 'done') {
    setMyworkBusy(item.id);
    try {
      await api('/worklist', {
        method: 'POST',
        body: JSON.stringify({ kind: item.kind, id: item.kind === 'CHASE' ? item.threadId ?? item.id : item.id, action, days: 7 }),
      });
      setMywork((s) => (s ? { ...s, items: s.items.filter((x) => x.id !== item.id) } : s));
    } catch {
      loadMywork(mywork?.assignedTo);
    } finally {
      setMyworkBusy(null);
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
    api<{ role: string; email: string; displayName: string | null; tenantName?: string }>('/me')
      .then(setMe)
      .catch(() => {})
      .finally(() => setMeLoading(false));
    api('/billing/account').then(setBilling).catch(() => {});
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TAB_KEYS as string[]).includes(t)) setTab(t as TabKey);
    else setTab('mywork');
  }, []);
  // Never leave a non-admin parked on an admin-only tab.
  useEffect(() => {
    if (me && !isAdmin && ADMIN_ONLY.includes(tab)) setTab('mywork');
  }, [me, isAdmin, tab]);
  function go(t: TabKey) {
    setTab(t);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `/admin?tab=${t}`);
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
  // "/" focuses the board search from anywhere on the tab.
  const boardSearchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (tab !== 'board') return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '/' && !(t instanceof HTMLInputElement) && !(t instanceof HTMLTextAreaElement) && !(t instanceof HTMLSelectElement) && !t?.isContentEditable) {
        e.preventDefault();
        boardSearchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tab]);
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
      setStatus(e?.message || 'Could not create the matter.');
    } finally {
      setCreatingMatter(false);
    }
  }
  const [copiedRef, setCopiedRef] = useState(false);
  const [referrals, setReferrals] = useState<any>(null);
  const [mergeKeep, setMergeKeep] = useState<MatterHit | null>(null);
  const [mergeAway, setMergeAway] = useState<MatterHit | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [docTemplates, setDocTemplates] = useState<DocTemplate[]>([]);
  const [docUpload, setDocUpload] = useState({ name: '', description: '' });
  const [docUploading, setDocUploading] = useState(false);
  const docFileRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [policy, setPolicy] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [playbooks, setPlaybooks] = useState<any[]>([]);
  const [pb, setPb] = useState<{ name: string; description: string; steps: Array<{ type: string; config: any }> }>({ name: '', description: '', steps: [] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [t, setT] = useState({ name: '', category: 'enquiry_response', subjectTemplate: '', bodyTemplate: '', styleTag: 'NEUTRAL' });
  const [rule, setRule] = useState({
    name: '',
    intents: 'STATUS_UPDATE',
    minConfidence: 0.9,
    requireNoAttention: true,
    replyMode: 'NONE' as 'NONE' | 'DRAFT' | 'SEND',
    riskAccepted: false,
    riskAcknowledgement: '',
    enabled: false,
  });

  const load = useCallback(async () => {
    try {
      if (tab === 'billing') {
        setBilling(await api('/billing/account'));
        setReferrals(await api('/referrals'));
        api('/admin/import-analytics').then(setImportStats).catch(() => {});
      }
      if (tab === 'mywork') {
        loadMywork();
        if (isAdmin) api<{ users: any[] }>('/admin/users').then((r) => setUsers(r.users)).catch(() => {});
      }
      if (tab === 'board') {
        setBoardLoading(true);
        try {
          const b = await api<{ matters: any[]; doneTotal?: number }>('/admin/board');
          setBoard(b.matters);
          setDoneTotal(b.doneTotal ?? 0);
          // Members power the on-card "assign" dropdown (the board is editable in place).
          api<{ users: any[] }>('/admin/users').then((r) => setUsers(r.users)).catch(() => {});
        } finally {
          setBoardLoading(false);
        }
      }
      if (tab === 'templates') setTemplates((await api<{ templates: Template[] }>('/admin/templates')).templates);
      if (tab === 'docpacks') setDocTemplates((await api<{ templates: DocTemplate[] }>('/admin/doc-templates')).templates);
      if (tab === 'policy') setPolicy((await api<{ policy: any }>('/admin/policies')).policy);
      if (tab === 'audit') setAudit((await api<{ logs: any[] }>('/admin/audit?limit=100')).logs);
      if (tab === 'rules') setRules((await api<{ rules: any[] }>('/admin/rules')).rules);
      if (tab === 'team') setUsers((await api<{ users: any[] }>('/admin/users')).users);
      if (tab === 'workload') setWorkload((await api<{ workload: any[] }>('/admin/workload')).workload ?? []);
      if (tab === 'playbooks') {
        setPlaybooks((await api<{ playbooks: any[] }>('/admin/playbooks')).playbooks);
        setDocTemplates((await api<{ templates: DocTemplate[] }>('/admin/doc-templates')).templates);
      }
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

  async function createRule() {
    try {
      await api('/admin/rules', {
        method: 'POST',
        body: JSON.stringify({
          name: rule.name,
          intents: rule.intents.split(',').map((s) => s.trim()).filter(Boolean),
          minConfidence: Number(rule.minConfidence),
          requireNoAttention: rule.requireNoAttention,
          replyMode: rule.replyMode,
          riskAccepted: rule.riskAccepted,
          riskAcknowledgement: rule.riskAcknowledgement,
          enabled: rule.enabled,
        }),
      });
      setRule({ ...rule, name: '', riskAccepted: false, riskAcknowledgement: '', enabled: false });
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

  async function changePlanTo(plan: 'plus' | 'pro' | 'enterprise') {
    setBillingBusy(true);
    try {
      const res = await api<{ url?: string }>('/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
      if (res.url) { window.location.href = res.url; return; }
      await load(); // existing subscriber → in-place prorated swap; refresh
    } catch (e: any) {
      setStatus(e.message || 'Could not change your plan.');
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
    if (mergeKeep.id === mergeAway.id) { setStatus('Pick two different matters.'); return; }
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

  // ── Playbooks ──────────────────────────────────────────────────────────────
  const STEP_LABEL: Record<string, string> = {
    CREATE_MATTER: 'Create matter (from the email)',
    GENERATE_DOCS: 'Generate documents',
    CREATE_TASK: 'Create a task',
    DRAFT_REPLY: 'Draft a reply',
    ARCHIVE_MATTER: 'Archive matter (close it)',
    DELEGATE: 'Delegate (assign + forward)',
    NOTIFY: 'Notify someone',
  };
  function addStep(type: string) {
    const config = type === 'DRAFT_REPLY' ? { tone: 'NEUTRAL' } : type === 'CREATE_TASK' ? { detail: '', dueOffsetDays: '' } : type === 'GENERATE_DOCS' ? { templateIds: [] } : {};
    setPb((p) => ({ ...p, steps: [...p.steps, { type, config }] }));
  }
  function setStepConfig(i: number, config: any) {
    setPb((p) => ({ ...p, steps: p.steps.map((s, j) => (j === i ? { ...s, config } : s)) }));
  }
  function removeStep(i: number) {
    setPb((p) => ({ ...p, steps: p.steps.filter((_, j) => j !== i) }));
  }
  function moveStep(i: number, dir: -1 | 1) {
    setPb((p) => {
      const steps = [...p.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return p;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...p, steps };
    });
  }
  async function savePlaybook() {
    if (!pb.name.trim() || !pb.steps.length) { setStatus('Give the workflow a name and at least one step.'); return; }
    try {
      const payload = JSON.stringify({ name: pb.name.trim(), description: pb.description.trim(), steps: pb.steps });
      if (editingId) {
        await api(`/admin/playbooks/${editingId}`, { method: 'PATCH', body: payload });
      } else {
        await api('/admin/playbooks', { method: 'POST', body: payload });
      }
      setPb({ name: '', description: '', steps: [] });
      setEditingId(null);
      await load();
      setStatus(editingId ? 'Workflow updated.' : 'Workflow saved.');
    } catch (e) {
      setStatus((e as Error).message);
    }
  }
  function editPlaybook(p: any) {
    setEditingId(p.id);
    setPb({ name: p.name, description: p.description ?? '', steps: (p.steps ?? []).map((s: any) => ({ type: s.type, config: s.config ?? {} })) });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function cancelEdit() {
    setEditingId(null);
    setPb({ name: '', description: '', steps: [] });
  }
  async function deletePlaybook(id: string) {
    try {
      await api(`/admin/playbooks/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setStatus((e as Error).message);
    }
  }
  async function loadExampleWorkflows() {
    try {
      const r = await api<{ added: string[] }>('/admin/playbooks/examples', { method: 'POST' });
      await load();
      setStatus(r.added.length ? `Added: ${r.added.join(', ')}.` : 'Example workflows already present.');
    } catch (e) {
      setStatus((e as Error).message);
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
    padding: '7px 10px',
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
  const navGroupLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: '#9aa6b8', padding: '0 4px 6px', marginBottom: 6, borderBottom: '1px solid #eef1f5' };
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
              {[
                ['📥', 'Incoming email matched to the right matter and tagged'],
                ['✍️', 'Replies drafted into your Outlook Drafts — nothing sends itself'],
                ['🗂️', 'Every case tracked on the matter board, chases never forgotten'],
              ].map(([ic, txt]) => (
                <li key={txt} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: '#334155', marginBottom: 8 }}>
                  <span aria-hidden style={{ flexShrink: 0 }}>{ic}</span>
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
    <div style={{ background: '#f6f7fb', minHeight: '100vh', fontFamily: 'var(--font-manrope), ui-sans-serif, system-ui, sans-serif', color: '#0f172a' }}>
      {/* Shell-wide styling that inline styles can't express: hover states, motion, scrollbars. */}
      <style>{`
        @keyframes adm-spin{to{transform:rotate(360deg)}}
        .adm-nav{transition:background .12s ease,color .12s ease}
        .adm-nav:hover{background:#eef1f6}
        .adm-bcard{box-shadow:0 1px 2px rgba(16,24,40,0.05);transition:box-shadow .13s ease,transform .13s ease}
        .adm-bcard:hover{box-shadow:0 5px 14px rgba(16,24,40,0.11);transform:translateY(-1px)}
        ::-webkit-scrollbar{height:8px;width:8px}
        ::-webkit-scrollbar-thumb{background:#d7dce3;border-radius:999px}
        ::-webkit-scrollbar-track{background:transparent}
      `}</style>
      {/* Sticky brand bar */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e8eaf0', position: 'sticky', top: 0, zIndex: 5 }}>
        <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 20px' }}>
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#5A27E0" />
            <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </svg>
          <strong style={{ fontSize: 17 }}>CONVE<span style={{ color: '#5A27E0' }}>Yi</span></strong>
          {me && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              {billing?.plan && <span style={planBadge}>{PLAN_LABEL[billing.plan] ?? billing.plan}</span>}
              <span style={{ fontSize: 13, color: '#475569' }}>{me.displayName || me.email}</span>
              <span title={me.email} style={{ width: 30, height: 30, borderRadius: 999, background: '#ede9fe', color: '#5A27E0', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials}</span>
              <button
                onClick={() => { try { window.localStorage.removeItem(TOKEN_KEY); } catch {} window.location.href = '/api/v1/auth/logout'; }}
                title="Sign out"
                style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '4px 6px', fontFamily: 'inherit' }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ ...box, display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap', padding: '22px 20px 56px' }}>
        {/* Grouped left nav — a proper sidebar panel, sticky under the brand bar */}
        <nav style={{ width: 208, flexShrink: 0, position: 'sticky', top: 70, alignSelf: 'flex-start', background: '#fff', border: '1px solid #e8eaf0', borderRadius: 14, padding: '14px 10px', maxHeight: 'calc(100vh - 96px)', overflowY: 'auto', boxShadow: '0 1px 2px rgba(16,24,40,0.04)' }}>
          {NAV_GROUPS.map((grp) => {
            const items = grp.tabs.filter((k) => visibleTabs.includes(k));
            if (!items.length) return null;
            return (
              <div key={grp.label} style={{ marginBottom: 22 }}>
                <div style={navGroupLabel}>{grp.label}</div>
                {items.map((k) => (
                  <button key={k} className="adm-nav" style={navItem(tab === k)} onClick={() => go(k)}>
                    <span aria-hidden style={{ fontSize: 13, width: 18, textAlign: 'center', filter: tab === k ? 'none' : 'grayscale(0.4)', opacity: tab === k ? 1 : 0.75 }}>{TAB_ICON[k]}</span>
                    {TAB_META[k].label}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 300, maxWidth: tab === 'board' || tab === 'workload' || tab === 'audit' ? 'none' : 880 }}>
        <h1 style={{ fontSize: 20, margin: `0 0 ${TAB_META[tab].subtitle ? 4 : 18}px` }}>{TAB_META[tab].label}</h1>
        {TAB_META[tab].subtitle && <p style={{ color: '#64748b', margin: '0 0 18px', fontSize: 14 }}>{TAB_META[tab].subtitle}</p>}

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
                    <div style={{ fontSize: 26, fontWeight: 800, marginTop: 2 }}>{billing.plan ? (PLAN_LABEL[billing.plan] ?? billing.plan) : 'No plan yet'}</div>
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
                  {billing.plan !== 'pro' && billing.plan !== 'enterprise' && (
                    <button style={btnPrimary} disabled={billingBusy} onClick={() => changePlanTo('pro')}>{billingBusy ? 'Working…' : 'Upgrade to Pro'}</button>
                  )}
                  {billing.plan !== 'enterprise' && (
                    <button style={{ ...btnPrimary, background: '#0f172a' }} disabled={billingBusy} onClick={() => changePlanTo('enterprise')}>{billingBusy ? 'Working…' : 'Upgrade to Firm'}</button>
                  )}
                  <button style={btnGhost} disabled={billingBusy} onClick={manageSubscription}>{billing.hasSubscription ? 'Manage subscription' : 'Choose a plan'}</button>
                </div>
                {billing.hasSubscription && (
                  <p style={{ color: '#64748b', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
                    “Manage subscription” opens Stripe for your card, invoices, plan changes &amp; cancellation.
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
                  {billing.plan === 'enterprise'
                    ? 'Colleagues join by signing in with their Microsoft 365 account — in the CONVEYi add-in, or just at this web address. Your first 3 seats are included; extra seats are £59/month each.'
                    : 'Solo and Pro are single-seat. Firm opens up the matter board, workload and assignment, with 3 seats included — upgrade above.'}
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
                  ['Does CONVEYi ever send email on my behalf?', 'No. Everything it produces — replies, updates, notifications — is created as an Outlook draft for you to review and send. Auto-rules default to draft-only; only an explicitly enabled auto-SEND rule (which requires a signed risk acknowledgement) ever sends.'],
                  ['What does auto-triage do?', 'On each incoming email it matches the message to a case, tags it in Outlook, and pre-analyses it (thread summary + a drafted reply) so the email opens ready. It’s always on and never sends.'],
                  ['How are emails matched to a matter?', 'By hard signals first — a thread already linked to a case, or your case-ref token in the subject — then corroborating ones like the property postcode, party names and known participants. A match needs more than one signal to be confident.'],
                  ['How do document templates work?', 'Upload (or AI-generate) Word .docx templates in Automation → Doc packs using {{placeholders}} for matter data and, on premium plans, [[AI sections]]. On any matter, a conveyancer clicks Generate and the file is filled and saved to the case folder.'],
                  ['How is billing handled?', 'Plans and seats are shown here; the card, invoices, plan changes and cancellation are handled securely by Stripe via “Manage subscription”.'],
                  ['Where is our data stored?', 'Case data lives in your firm’s own Microsoft 365 (OneDrive/Excel) plus CONVEYi’s database for matching and analysis. AI drafting uses Claude; nothing is sent to third parties beyond what’s needed to draft and never auto-sent.'],
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

        {tab === 'board' && (
          <>
            <style>{`@keyframes adm-spin{to{transform:rotate(360deg)}}`}</style>
            {boardLoading && board.length === 0 ? (
              <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#64748b' }}>
                <span style={spinnerStyle} /> Loading matters…
              </div>
            ) : board.length === 0 ? (
              <div style={{ ...card, textAlign: 'center', color: '#94a3b8' }}>No live matters yet.</div>
            ) : (() => {
              const assigneeOpts = Array.from(new Set(board.map((m) => m.assignee).filter(Boolean))).sort();
              const hasUnassigned = board.some((m) => !m.assignee);
              const stageMs = (m: any) => new Date(m.stageEnteredAt || m.updatedAt).getTime();
              const q = boardQuery.trim().toLowerCase();
              const visible = board
                .filter(
                  (m) =>
                    (boardAssignee === '' || (boardAssignee === '__un' ? !m.assignee : m.assignee === boardAssignee)) &&
                    (boardFlag === '' || (m.statusFlag || 'ON_TRACK') === boardFlag) &&
                    (!q ||
                      String(m.matterRef || '').toLowerCase().includes(q) ||
                      String(m.propertyAddress || '').toLowerCase().includes(q) ||
                      String(m.assignee || '').toLowerCase().includes(q))
                )
                .sort((a, b) => {
                  if (boardSort === 'stage_age') return stageMs(a) - stageMs(b); // oldest in stage first (most dots)
                  if (boardSort === 'completion') {
                    const av = a.completionTargetDate ? new Date(a.completionTargetDate).getTime() : Infinity;
                    const bv = b.completionTargetDate ? new Date(b.completionTargetDate).getTime() : Infinity;
                    return av - bv; // soonest completion first
                  }
                  if (boardSort === 'ref') return String(a.matterRef || '').localeCompare(String(b.matterRef || ''));
                  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(); // most recently updated first
                });
              // Two piles: work in flight (stage columns) and Completed (done — capped
              // server-side so it never bloats). No backlog: conveyancing has no sprint-
              // grooming phase; a new instruction simply starts on the board.
              const active = visible.filter((m) => m.status !== 'CLOSED');
              const donePile = visible
                .filter((m) => m.status === 'CLOSED')
                .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
              // Dropping a completed card onto a stage reactivates it there.
              const dropOnStage = (stage: string) => {
                if (!draggingId) return;
                const dragged = board.find((x) => x.id === draggingId);
                if (dragged) {
                  if (dragged.status === 'CLOSED') patchMatter(draggingId, { stage, status: 'OPEN' });
                  else if ((dragged.stage || 'INSTRUCTION') !== stage) patchMatter(draggingId, { stage });
                }
                setDraggingId(null);
              };
              const initialsOf = (n: string) =>
                n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
              // Column chrome shared by stages and piles.
              const colHead = (label: string, dot: string, count: React.ReactNode, onToggle: () => void) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 6px 9px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, flexShrink: 0 }} />
                  <span onClick={onToggle} title={`${label} — click to collapse`} style={{ fontSize: 12, fontWeight: 800, color: '#334155', letterSpacing: 0.2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', textTransform: 'uppercase' }}>{label}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', background: '#e9ebf1', borderRadius: 999, padding: '0 7px', flexShrink: 0, marginLeft: 'auto' }}>{count}</span>
                </div>
              );
              const colBody: React.CSSProperties = { background: '#f0f1f5', borderRadius: 12, padding: 8, minHeight: 80, maxHeight: 'calc(100vh - 340px)', overflowY: 'auto', transition: 'background .12s' };
              const collapsedStrip = (key: string, label: string, dot: string, count: React.ReactNode, onDrop: (e: React.DragEvent) => void) => (
                <div
                  key={key}
                  onClick={() => toggleStage(key)}
                  onDragOver={(e) => { if (draggingId) e.preventDefault(); }}
                  onDrop={onDrop}
                  title={`${label} — ${count} (click to expand)`}
                  style={{ flex: '0 0 36px', alignSelf: 'stretch', minHeight: 140, background: draggingId ? '#eef2ff' : '#f0f1f5', border: draggingId ? '1px dashed #a5b4fc' : '1px solid transparent', borderRadius: 12, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '10px 0' }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: dot }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', background: '#fff', borderRadius: 999, padding: '1px 7px' }}>{count}</span>
                  <span style={{ writingMode: 'vertical-rl', fontSize: 10.5, fontWeight: 800, color: '#64748b', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</span>
                </div>
              );
              // The Completed pile — drop target, collapsible, compact cards.
              const pileColumn = (key: string, label: string, pile: any[], status: string, dot: string, countLabel?: string) => {
                const onDrop = (e: React.DragEvent) => {
                  e.preventDefault();
                  if (draggingId) {
                    const dragged = board.find((x) => x.id === draggingId);
                    if (dragged && dragged.status !== status) patchMatter(draggingId, { status });
                  }
                  setDraggingId(null);
                };
                if (collapsedStages.includes(key)) return collapsedStrip(key, label, dot, countLabel ?? pile.length, onDrop);
                return (
                  <div key={key} style={{ flex: '0 0 260px', minWidth: 0 }}>
                    {colHead(label, dot, countLabel ?? pile.length, () => toggleStage(key))}
                    <div
                      onDragOver={(e) => { if (draggingId) e.preventDefault(); }}
                      onDrop={onDrop}
                      style={{ ...colBody, ...(draggingId ? { background: '#eef2ff', outline: '1px dashed #a5b4fc' } : {}) }}
                    >
                      {pile.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#cbd5e1', textAlign: 'center', padding: '16px 0' }}>Drop a card here</div>
                      ) : (
                        pile.map((m) => (
                          <div
                            key={m.id}
                            draggable
                            onDragStart={() => setDraggingId(m.id)}
                            onDragEnd={() => setDraggingId(null)}
                            className="adm-bcard"
                            onClick={() => setOpenMatter(m)}
                            title="Open matter"
                            style={{ background: '#fff', border: '1px solid #e9ebf1', borderRadius: 10, padding: '9px 11px', marginBottom: 8, cursor: 'pointer', opacity: draggingId === m.id ? 0.4 : boardBusyId === m.id ? 0.6 : 1 }}
                          >
                            <strong style={{ display: 'block', fontSize: 13, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.matterRef || 'Matter'}</strong>
                            {m.propertyAddress && (
                              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.propertyAddress}</div>
                            )}
                            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                              ✓ completed {new Date(m.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                            </div>
                          </div>
                        ))
                      )}
                      {status === 'CLOSED' && doneTotal > pile.length && (
                        <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', padding: '4px 0 2px' }}>+ {doneTotal - pile.length} older</div>
                      )}
                    </div>
                  </div>
                );
              };
              // Pulse numbers over the whole live board (unfiltered) — the chips double as filters.
              const live = board.filter((m) => m.status !== 'CLOSED');
              const nAttention = live.filter((m) => m.statusFlag === 'NEEDS_ATTENTION').length;
              const nBlocked = live.filter((m) => m.statusFlag === 'BLOCKED').length;
              const nUnassigned = live.filter((m) => !m.assignee).length;
              const in7d = Date.now() + 7 * 86_400_000;
              const nDueSoon = live.filter((m) => {
                const t = m.completionTargetDate || m.exchangeTargetDate;
                return t && new Date(t).getTime() <= in7d;
              }).length;
              const statChip = (label: string, n: number, color: string, onClick?: () => void, active?: boolean) => (
                <button
                  key={label}
                  onClick={onClick}
                  disabled={!onClick}
                  style={{ background: active ? '#ede9fe' : '#fff', border: `1px solid ${active ? '#c4b5fd' : '#e8eaf0'}`, borderRadius: 12, padding: '9px 16px', textAlign: 'left', cursor: onClick ? 'pointer' : 'default', fontFamily: 'inherit', boxShadow: '0 1px 2px rgba(16,24,40,0.04)' }}
                >
                  <div style={{ fontSize: 19, fontWeight: 800, color, lineHeight: 1.1 }}>{n}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: '#8b93a3', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>{label}</div>
                </button>
              );
              return (
                <>
                  {/* Pulse strip — the board's vital signs; attention/blocked/unassigned chips filter on click */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                    {statChip('In flight', live.length, '#0f172a')}
                    {statChip('Needs attention', nAttention, nAttention ? '#b45309' : '#94a3b8', () => setBoardFlag(boardFlag === 'NEEDS_ATTENTION' ? '' : 'NEEDS_ATTENTION'), boardFlag === 'NEEDS_ATTENTION')}
                    {statChip('Blocked', nBlocked, nBlocked ? '#b91c1c' : '#94a3b8', () => setBoardFlag(boardFlag === 'BLOCKED' ? '' : 'BLOCKED'), boardFlag === 'BLOCKED')}
                    {statChip('Unassigned', nUnassigned, nUnassigned ? '#5A27E0' : '#94a3b8', () => setBoardAssignee(boardAssignee === '__un' ? '' : '__un'), boardAssignee === '__un')}
                    {statChip('Target in 7 days', nDueSoon, nDueSoon ? '#0e7490' : '#94a3b8')}
                    {statChip('Completed', doneTotal, '#16a34a')}
                  </div>

                  {/* Toolbar */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14, background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: '9px 10px', boxShadow: '0 1px 2px rgba(16,24,40,0.04)' }}>
                    <input
                      ref={boardSearchRef}
                      value={boardQuery}
                      onChange={(e) => setBoardQuery(e.target.value)}
                      placeholder="Search ref, address, owner…  ( / )"
                      style={{ ...filterSelect, width: 230, cursor: 'text', background: '#f6f7fb', border: '1px solid #eef0f4' }}
                    />
                    <select value={boardAssignee} onChange={(e) => setBoardAssignee(e.target.value)} style={filterSelect}>
                      <option value="">All assignees</option>
                      {assigneeOpts.map((a) => <option key={a} value={a}>{a}</option>)}
                      {hasUnassigned && <option value="__un">Unassigned</option>}
                    </select>
                    <select value={boardSort} onChange={(e) => setBoardSort(e.target.value as typeof boardSort)} style={filterSelect}>
                      <option value="stage_age">Sort: longest in stage</option>
                      <option value="completion">Sort: completion date</option>
                      <option value="updated">Sort: recently updated</option>
                      <option value="ref">Sort: matter ref</option>
                    </select>
                    <select value={boardFlag} onChange={(e) => setBoardFlag(e.target.value)} style={filterSelect}>
                      <option value="">All statuses</option>
                      <option value="ON_TRACK">On track</option>
                      <option value="NEEDS_ATTENTION">Needs attention</option>
                      <option value="BLOCKED">Blocked</option>
                    </select>
                    {(boardAssignee || boardFlag || boardQuery) && (
                      <button style={clearBtn} onClick={() => { setBoardAssignee(''); setBoardFlag(''); setBoardQuery(''); }}>Clear</button>
                    )}
                    {boardLoading && <span style={spinnerStyle} />}
                    <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 'auto' }}>{visible.length} matter{visible.length === 1 ? '' : 's'}</span>
                    {/* Customise what cards show — persisted per browser */}
                    <div style={{ position: 'relative' }}>
                      <button style={{ ...clearBtn, fontWeight: 700 }} onClick={() => setShowDisplayMenu((v) => !v)}>⚙ Display</button>
                      {showDisplayMenu && (
                        <>
                          <div onClick={() => setShowDisplayMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
                          <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20, background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, boxShadow: '0 10px 30px rgba(16,24,40,0.14)', padding: '10px 12px', width: 210 }}>
                            <div style={{ fontSize: 10.5, fontWeight: 800, color: '#8b93a3', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>Card fields</div>
                            {([['address', 'Property address'], ['owner', 'Owner'], ['dates', 'Dates & task chips'], ['tasks', 'Open-task count'], ['age', 'Days in stage'], ['quickEdit', 'Quick-edit dropdowns']] as const).map(([k, label]) => (
                              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', padding: '4px 0', cursor: 'pointer' }}>
                                <input type="checkbox" checked={Boolean(boardPrefs[k])} onChange={() => togglePref(k)} style={{ accentColor: '#5A27E0' }} />
                                {label}
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Kanban rail — fixed-width columns on a horizontal scroll, Completed pile at the end */}
                  <div style={{ display: 'flex', gap: 12, paddingBottom: 12, alignItems: 'flex-start', overflowX: 'auto' }}>
                    {STAGE_ORDER.map((stage) => {
                      const col = active.filter((m) => (m.stage || 'INSTRUCTION') === stage);
                      if (collapsedStages.includes(stage)) {
                        return collapsedStrip(stage, STAGE_LABEL[stage] ?? stage, STAGE_COLOR[stage] ?? '#94a3b8', col.length, (e) => {
                          e.preventDefault();
                          dropOnStage(stage);
                        });
                      }
                      return (
                        <div key={stage} style={{ flex: '0 0 290px', minWidth: 0 }}>
                          {colHead(STAGE_LABEL[stage] ?? stage, STAGE_COLOR[stage] ?? '#94a3b8', col.length, () => toggleStage(stage))}
                          <div
                            onDragOver={(e) => { if (draggingId) e.preventDefault(); }}
                            onDrop={(e) => {
                              e.preventDefault();
                              dropOnStage(stage);
                            }}
                            style={{ ...colBody, ...(draggingId ? { background: '#eef2ff', outline: '1px dashed #a5b4fc' } : {}) }}
                          >
                            {col.length === 0 && addingStage !== stage && (
                              <div style={{ fontSize: 12, color: '#cbd5e1', textAlign: 'center', padding: '14px 0 6px' }}>Drop a card here</div>
                            )}
                            {col.map((m) => {
                              const target = m.completionTargetDate || m.exchangeTargetDate;
                              const days = Math.max(0, Math.floor((Date.now() - new Date(m.stageEnteredAt || m.updatedAt).getTime()) / 86_400_000));
                              const ageFg = days <= 7 ? '#8b93a3' : days <= 21 ? '#b45309' : '#b91c1c';
                              const ageBg = days <= 7 ? '#f1f5f9' : days <= 21 ? '#fef3c7' : '#fee2e2';
                              const chip: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' };
                              return (
                                <div
                                  key={m.id}
                                  draggable
                                  onDragStart={() => setDraggingId(m.id)}
                                  onDragEnd={() => setDraggingId(null)}
                                  className="adm-bcard"
                                  style={{ background: '#fff', border: '1px solid #e9ebf1', borderLeft: `3px solid ${FLAG_DOT[m.statusFlag] ?? '#e9ebf1'}`, borderRadius: 10, padding: '10px 11px', marginBottom: 8, cursor: 'grab', opacity: draggingId === m.id ? 0.4 : boardBusyId === m.id ? 0.6 : 1 }}
                                >
                                  {/* Card face opens the full matter drawer */}
                                  <div onClick={() => setOpenMatter(m)} style={{ cursor: 'pointer' }} title="Open matter">
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <strong style={{ fontSize: 13.5, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, letterSpacing: -0.1 }}>{m.matterRef || 'Matter'}</strong>
                                      {boardPrefs.age && (
                                        <span title={`${days} day${days === 1 ? '' : 's'} in ${STAGE_LABEL[stage] ?? stage}`} style={{ ...chip, color: ageFg, background: ageBg, flexShrink: 0 }}>{days}d</span>
                                      )}
                                    </div>
                                    {boardPrefs.address && m.propertyAddress && (
                                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 3, lineHeight: 1.4, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>{m.propertyAddress}</div>
                                    )}
                                    {boardPrefs.dates && (target || Number(m.openTasks) > 0 || m.nextDue) && (
                                      <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                                        {target && (
                                          <span title={m.completionTargetDate ? 'Completion target' : 'Exchange target'} style={{ ...chip, color: '#0e7490', background: '#ecfeff' }}>
                                            🎯 {new Date(target).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                                          </span>
                                        )}
                                        {boardPrefs.tasks && Number(m.openTasks) > 0 && (
                                          <span title={`${m.openTasks} open task${Number(m.openTasks) === 1 ? '' : 's'}`} style={{ ...chip, color: '#475569', background: '#f1f5f9' }}>☑ {m.openTasks}</span>
                                        )}
                                        {boardPrefs.tasks && m.nextDue && (() => {
                                          const overdue = new Date(m.nextDue).getTime() < Date.now() - 86_400_000;
                                          return (
                                            <span title="Next task due" style={{ ...chip, color: overdue ? '#b91c1c' : '#475569', background: overdue ? '#fee2e2' : '#f1f5f9' }}>
                                              due {new Date(m.nextDue).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                                            </span>
                                          );
                                        })()}
                                      </div>
                                    )}
                                  </div>
                                  {/* Owner row — quick-edit dropdowns, or a read-only avatar chip */}
                                  {boardPrefs.owner && (
                                    boardPrefs.quickEdit ? (
                                      <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
                                        <select
                                          value={m.assignedTo || ''}
                                          title="Assign to"
                                          onChange={(e) => patchMatter(m.id, { assignedTo: e.target.value || null })}
                                          onDragStart={(e) => e.preventDefault()}
                                          style={{ flex: 1.6, minWidth: 0, fontSize: 11, padding: '3px 5px', border: '1px solid #eef0f4', borderRadius: 7, background: '#fafbfc', color: '#475569', cursor: 'pointer', fontFamily: 'inherit' }}
                                        >
                                          <option value="">Unassigned</option>
                                          {users.map((u: any) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
                                        </select>
                                        <select
                                          value={m.statusFlag || 'ON_TRACK'}
                                          title="Status"
                                          onChange={(e) => patchMatter(m.id, { statusFlag: e.target.value })}
                                          onDragStart={(e) => e.preventDefault()}
                                          style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '3px 5px', border: '1px solid #eef0f4', borderRadius: 7, background: '#fafbfc', color: FLAG_DOT[m.statusFlag] && m.statusFlag !== 'ON_TRACK' ? FLAG_DOT[m.statusFlag] : '#475569', cursor: 'pointer', fontFamily: 'inherit', fontWeight: m.statusFlag && m.statusFlag !== 'ON_TRACK' ? 700 : 400 }}
                                        >
                                          <option value="ON_TRACK">On track</option>
                                          <option value="NEEDS_ATTENTION">Attention</option>
                                          <option value="BLOCKED">Blocked</option>
                                        </select>
                                      </div>
                                    ) : (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                                        <span style={{ width: 20, height: 20, borderRadius: 999, background: m.assignee ? '#ede9fe' : '#f1f5f9', color: m.assignee ? '#5A27E0' : '#94a3b8', fontSize: 9.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                          {m.assignee ? initialsOf(m.assignee) : '—'}
                                        </span>
                                        <span style={{ fontSize: 11.5, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.assignee || 'Unassigned'}</span>
                                      </div>
                                    )
                                  )}
                                </div>
                              );
                            })}
                            {/* Trello-style quick add at the foot of every column */}
                            {addingStage === stage ? (
                              <div style={{ background: '#fff', border: '1px dashed #c7cdd8', borderRadius: 10, padding: 8 }}>
                                <input
                                  autoFocus
                                  disabled={creatingMatter}
                                  value={newMatterAddr}
                                  onChange={(e) => setNewMatterAddr(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') quickCreateMatter(stage);
                                    if (e.key === 'Escape') { setAddingStage(null); setNewMatterAddr(''); }
                                  }}
                                  placeholder="Property address…"
                                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '6px 8px', border: '1px solid #e2e8f0', borderRadius: 7, fontFamily: 'inherit' }}
                                />
                                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                  <button onClick={() => quickCreateMatter(stage)} disabled={creatingMatter || !newMatterAddr.trim()} style={{ ...btnPrimary, padding: '4px 12px', fontSize: 12, opacity: creatingMatter || !newMatterAddr.trim() ? 0.5 : 1 }}>
                                    {creatingMatter ? 'Creating…' : 'Add matter'}
                                  </button>
                                  <button onClick={() => { setAddingStage(null); setNewMatterAddr(''); }} style={{ ...clearBtn, padding: '4px 10px' }}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setAddingStage(stage); setNewMatterAddr(''); }}
                                style={{ width: '100%', border: 'none', background: 'transparent', color: '#8b93a3', fontSize: 12.5, fontWeight: 700, padding: '7px 0 4px', cursor: 'pointer', borderRadius: 8, fontFamily: 'inherit', textAlign: 'left', paddingLeft: 6 }}
                              >
                                ＋ Add matter
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {pileColumn('__DONE', 'Completed', donePile, 'CLOSED', '#22c55e', doneTotal ? String(doneTotal) : undefined)}
                  </div>
                </>
              );
            })()}
          </>
        )}

        {openMatter && (
          <MatterDrawer
            matter={openMatter}
            api={api}
            users={users}
            onPatch={patchMatter}
            onClose={() => setOpenMatter(null)}
          />
        )}

        {tab === 'mywork' && (() => {
          if (!mywork) {
            return (
              <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, color: '#64748b' }}>
                <span style={spinnerStyle} /> Loading your worklist…
              </div>
            );
          }
          const drafts = mywork.items.filter((i) => i.kind === 'DRAFT_READY');
          const chases = mywork.items.filter((i) => i.kind === 'CHASE');
          const tasks = mywork.items.filter((i) => i.kind === 'TASK');
          const row = (item: any, accent: string) => (
            <div key={item.id} style={{ borderTop: '1px solid #f1f5f9' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 0', opacity: myworkBusy === item.id ? 0.5 : 1 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: accent, marginTop: 6, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{item.title}</div>
                <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>
                  {[item.matterRef, item.propertyAddress, item.detail].filter(Boolean).join(' · ')}
                </div>
              </div>
              {Number(item.ageDays) > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: Number(item.ageDays) >= 7 ? '#b91c1c' : '#64748b', background: Number(item.ageDays) >= 7 ? '#fef2f2' : '#f1f5f9', borderRadius: 999, padding: '2px 8px', flexShrink: 0, marginTop: 2 }}>
                  {item.ageDays}d
                </span>
              )}
              {item.kind === 'CHASE' && !chaserDrafts[item.id] && (
                <button
                  onClick={() => draftChaser(item)}
                  style={{ ...clearBtn, background: '#5A27E0', color: '#fff', border: 'none', fontWeight: 700, flexShrink: 0 }}
                >
                  ✍️ Draft chaser
                </button>
              )}
              {item.kind === 'CHASE' && chaserDrafts[item.id] === 'busy' && (
                <span style={{ fontSize: 12, color: '#5A27E0', fontWeight: 700, flexShrink: 0 }}>Drafting…</span>
              )}
              {item.kind === 'DRAFT_READY' && item.graphMessageId && (
                <button
                  onClick={() => { if (window.confirm(`Send “${item.title}”? Review it first via Outlook Drafts if unsure.`)) sendFromWeb(item, item.graphMessageId); }}
                  disabled={sendingId === item.id}
                  style={{ ...clearBtn, background: '#16a34a', color: '#fff', border: 'none', fontWeight: 700, flexShrink: 0, opacity: sendingId === item.id ? 0.6 : 1 }}
                >
                  {sendingId === item.id ? 'Sending…' : 'Send ▸'}
                </button>
              )}
              {item.kind === 'DRAFT_READY' && (
                <a href="https://outlook.office.com/mail/drafts" target="_blank" rel="noopener noreferrer" style={{ ...clearBtn, textDecoration: 'none', flexShrink: 0 }}>
                  Open ↗
                </a>
              )}
              {item.kind === 'TASK' ? (
                <button style={{ ...clearBtn, flexShrink: 0 }} disabled={myworkBusy === item.id} onClick={() => myworkAction(item, 'done')} title="Mark this task done">✓ Done</button>
              ) : (
                <>
                  <button style={{ ...clearBtn, flexShrink: 0 }} disabled={myworkBusy === item.id} onClick={() => myworkAction(item, 'snooze')} title="Hide for 7 days">Snooze</button>
                  <button style={{ ...clearBtn, flexShrink: 0 }} disabled={myworkBusy === item.id} onClick={() => myworkAction(item, 'dismiss')} title="Remove from the list">Dismiss</button>
                </>
              )}
            </div>
            {/* Inline review-and-send: the drafted chaser, right here — no detour. */}
            {typeof chaserDrafts[item.id] === 'object' && (() => {
              const d = chaserDrafts[item.id] as Exclude<ChaserDraft, 'busy'>;
              return (
                <div style={{ margin: '0 0 12px', border: '1px solid #ddd2f7', background: '#faf8ff', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>{d.subject}</div>
                  <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.55, maxHeight: 220, overflowY: 'auto', background: '#fff', border: '1px solid #eef0f4', borderRadius: 8, padding: '8px 10px' }} dangerouslySetInnerHTML={{ __html: d.bodyHtml }} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => sendFromWeb(item, d.id)}
                      disabled={sendingId === item.id}
                      style={{ ...clearBtn, background: '#16a34a', color: '#fff', border: 'none', fontWeight: 700, opacity: sendingId === item.id ? 0.6 : 1 }}
                    >
                      {sendingId === item.id ? 'Sending…' : 'Send ▸'}
                    </button>
                    {d.webLink && (
                      <a href={d.webLink} target="_blank" rel="noopener noreferrer" style={{ ...clearBtn, textDecoration: 'none' }}>Edit in Outlook ↗</a>
                    )}
                    <button onClick={() => setChaserDrafts((s) => { const { [item.id]: _x, ...rest } = s; return rest; })} style={{ ...clearBtn, border: 'none', background: 'transparent' }}>Discard preview</button>
                    <span style={{ fontSize: 11.5, color: '#94a3b8' }}>Also saved in your Outlook Drafts.</span>
                  </div>
                </div>
              );
            })()}
            </div>
          );
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                {isAdmin && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#64748b' }}>Assigned to</span>
                    <select
                      value={mywork.assignedTo}
                      onChange={(e) => loadMywork(e.target.value)}
                      style={{ border: '1px solid #d0d5dd', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, fontWeight: 700, color: '#0f172a', background: '#fff', cursor: 'pointer' }}
                      title="Filter the worklist by who owns the matter"
                    >
                      <option value="">Anyone</option>
                      {users.map((u: any) => (
                        <option key={u.id} value={u.id}>{u.display_name || u.email}</option>
                      ))}
                    </select>
                  </label>
                )}
                <a href="https://outlook.office.com/mail/drafts" target="_blank" rel="noopener noreferrer" style={{ ...clearBtn, textDecoration: 'none', marginLeft: 'auto' }}>
                  Open Outlook Drafts ↗
                </a>
              </div>

              {mywork.items.length === 0 && (
                <div style={{ ...card, textAlign: 'center', padding: 40 }}>
                  <div style={{ fontSize: 30, marginBottom: 8 }}>🎉</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>All caught up</div>
                  <p style={{ fontSize: 13, color: '#64748b', margin: '6px 0 0' }}>No drafts waiting and nothing to chase. New work appears here as email comes in.</p>
                </div>
              )}

              {drafts.length > 0 && (
                <div style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: 14, color: '#0f172a' }}>Ready to send</strong>
                    <span style={{ fontSize: 11, fontWeight: 800, color: '#5A27E0', background: '#ede9fe', borderRadius: 999, padding: '1px 8px' }}>{drafts.length}</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>— replies already drafted, sitting in Outlook Drafts for review</span>
                  </div>
                  <div style={{ marginTop: 6 }}>{drafts.map((i) => row(i, '#5A27E0'))}</div>
                </div>
              )}

              {chases.length > 0 && (
                <div style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: 14, color: '#0f172a' }}>To chase</strong>
                    <span style={{ fontSize: 11, fontWeight: 800, color: '#b45309', background: '#fef3c7', borderRadius: 999, padding: '1px 8px' }}>{chases.length}</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>— you sent the last message and nobody has replied</span>
                  </div>
                  <div style={{ marginTop: 6 }}>{chases.map((i) => row(i, '#f59e0b'))}</div>
                </div>
              )}

              {tasks.length > 0 && (
                <div style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: 14, color: '#0f172a' }}>To do</strong>
                    <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', background: '#e2e8f0', borderRadius: 999, padding: '1px 8px' }}>{tasks.length}</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>— open tasks on your matters</span>
                  </div>
                  <div style={{ marginTop: 6 }}>{tasks.map((i) => row(i, '#64748b'))}</div>
                </div>
              )}
            </>
          );
        })()}

        {tab === 'workload' && (
          <div style={card}>
            <p style={{ fontSize: 13, color: '#475569', margin: '0 0 12px', lineHeight: 1.5 }}>
              Who’s carrying what right now. Assign matters from the board or a matter’s drawer; anything without an owner shows in its own row so nothing slips.
            </p>
            {workload.length === 0 ? (
              <p style={{ fontSize: 13, color: '#64748b' }}>No open matters yet.</p>
            ) : (
              <div style={{ overflowX: 'auto', border: '1px solid #e8eaf0', borderRadius: 10 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['Fee-earner', 'Open matters', 'Needs attention', 'Overdue chases', 'Drafts waiting'].map((h, i) => (
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

        {tab === 'templates' && (
          <>
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>New template</h3>
              <input style={input} placeholder="Name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
              <input style={input} placeholder="Category" value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })} />
              <input style={input} placeholder="Style tag (NEUTRAL/FIRM/CHASING)" value={t.styleTag} onChange={(e) => setT({ ...t, styleTag: e.target.value })} />
              <input style={input} placeholder="Subject template" value={t.subjectTemplate} onChange={(e) => setT({ ...t, subjectTemplate: e.target.value })} />
              <textarea style={{ ...input, minHeight: 100 }} placeholder="Body template" value={t.bodyTemplate} onChange={(e) => setT({ ...t, bodyTemplate: e.target.value })} />
              <button style={{ padding: '8px 16px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }} onClick={createTemplate}>
                Create
              </button>
            </div>
            {templates.map((tpl) => (
              <div key={tpl.id} style={card}>
                <strong>{tpl.name}</strong> <span style={{ color: '#64748b' }}>· {tpl.category} · {tpl.styleTag}</span>
                <p style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#334155' }}>{tpl.bodyTemplate}</p>
              </div>
            ))}
          </>
        )}

        {tab === 'docpacks' && (
          <>
            {/* Create with AI — the headline feature, up top */}
            <div style={{ ...card, background: 'linear-gradient(180deg,#faf5ff,#ffffff)', borderColor: '#d8b4fe', boxShadow: '0 2px 10px rgba(124,58,237,0.10)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }} aria-hidden>✨</span>
                <h2 style={{ margin: 0, fontSize: 18 }}>Create a template with AI</h2>
                <span style={{ fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 4, padding: '2px 6px', fontWeight: 700 }}>Beta</span>
              </div>
              <p style={{ fontSize: 13, color: '#475569', margin: '8px 0 14px' }}>
                Two ways: <strong>upload an existing Word document</strong> and we’ll turn it into a fillable
                template — keeping your wording and swapping the client/property/date details for matter
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
              <p style={{ fontSize: 13, color: '#334155', margin: '0 0 10px' }}>
                Upload your firm&apos;s Word (.docx) templates here. On any matter, a conveyancer opens the{' '}
                <strong>Files → Templates</strong> panel and clicks <strong>Generate</strong> — the template is
                filled with that matter&apos;s data and saved straight into the case&apos;s OneDrive folder.
              </p>
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>Placeholder syntax</p>
              <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                <tbody>
                  {[
                    ['{{matter_ref}}', 'Matter reference, e.g. CL-0042'],
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
                    ['{{assigned_to}}', 'Conveyancer handling the matter'],
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
                <strong>Per-matter Inbox subfolders.</strong> Give each matter its own Outlook Inbox subfolder and
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
            <h3 style={{ marginTop: 0 }}>Team members</h3>
            <p style={{ fontSize: 13, color: '#64748b' }}>
              The first person to sign in is the firm Admin; everyone else joins as a Conveyancer. Change roles here.
            </p>
            {users.map((u) => (
              <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e2e8f0', padding: '8px 0' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{u.display_name || u.email}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{u.email}</div>
                </div>
                <select value={u.role} onChange={(e) => setUserRole(u.id, e.target.value)} style={{ ...input, width: 'auto', marginBottom: 0 }}>
                  <option value="ADMIN">Admin</option>
                  <option value="CONVEYANCER">Conveyancer</option>
                  <option value="ASSISTANT">Assistant</option>
                  <option value="READ_ONLY">Read only</option>
                </select>
              </div>
            ))}
          </div>
        )}

        {tab === 'rules' && (
          <>
            <div style={{ ...card, background: '#fffbeb', borderColor: '#fde68a' }}>
              <strong>Premium automation.</strong> Rules only fire on <em>AUTO-band</em> (very high confidence, multi-signal)
              matches, and only when automation is enabled in Policy. Auto-<strong>SEND</strong> rules require you to accept
              responsibility every time you enable them.
            </div>
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>New rule</h3>
              <input style={input} placeholder="Rule name" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} />
              <input style={input} placeholder="Intents (comma separated)" value={rule.intents} onChange={(e) => setRule({ ...rule, intents: e.target.value })} />
              <label style={{ fontSize: 12, color: '#64748b' }}>Min confidence ({rule.minConfidence})</label>
              <input style={input} type="number" step="0.05" min="0" max="1" value={rule.minConfidence} onChange={(e) => setRule({ ...rule, minConfidence: Number(e.target.value) })} />
              <label style={{ fontSize: 12, color: '#64748b' }}>Reply mode</label>
              <select style={input} value={rule.replyMode} onChange={(e) => setRule({ ...rule, replyMode: e.target.value as any })}>
                <option value="NONE">None (categorise + tracker only)</option>
                <option value="DRAFT">Auto-draft (never sends)</option>
                <option value="SEND">Auto-SEND (sends automatically)</option>
              </select>
              <label style={{ display: 'flex', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={rule.requireNoAttention} onChange={(e) => setRule({ ...rule, requireNoAttention: e.target.checked })} />
                Only when the email needs no conveyancer attention
              </label>
              {rule.replyMode === 'SEND' && (
                <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', marginTop: 10 }}>
                  <strong>Risk acknowledgement required.</strong>
                  <p style={{ fontSize: 12 }}>
                    This rule will send emails to clients/counterparties automatically with no human review. You accept full
                    professional responsibility (SRA, GDPR) for messages it sends.
                  </p>
                  <textarea
                    style={{ ...input, minHeight: 60 }}
                    placeholder="Type your acknowledgement (e.g. 'I accept responsibility for auto-sent status acknowledgements on this rule')"
                    value={rule.riskAcknowledgement}
                    onChange={(e) => setRule({ ...rule, riskAcknowledgement: e.target.value })}
                  />
                  <label style={{ display: 'flex', gap: 6, fontSize: 13, fontWeight: 600 }}>
                    <input type="checkbox" checked={rule.riskAccepted} onChange={(e) => setRule({ ...rule, riskAccepted: e.target.checked })} />
                    I accept these risks and authorise auto-sending for this rule.
                  </label>
                </div>
              )}
              <label style={{ display: 'flex', gap: 6, fontSize: 13, marginTop: 8 }}>
                <input type="checkbox" checked={rule.enabled} onChange={(e) => setRule({ ...rule, enabled: e.target.checked })} />
                Enable now
              </label>
              <button
                style={{ padding: '8px 16px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', marginTop: 8 }}
                onClick={createRule}
                disabled={!rule.name || (rule.replyMode === 'SEND' && rule.enabled && (!rule.riskAccepted || !rule.riskAcknowledgement))}
              >
                Create rule
              </button>
            </div>
            {rules.map((r) => (
              <div key={r.id} style={card}>
                <strong>{r.name}</strong>{' '}
                <span style={{ color: '#64748b' }}>
                  · {r.reply_mode} · ≥{r.min_confidence} · {r.enabled ? 'enabled' : 'disabled'}
                  {r.reply_mode === 'SEND' && (r.risk_accepted ? ' · risk accepted' : ' · risk NOT accepted')}
                </span>
              </div>
            ))}
          </>
        )}

        {tab === 'playbooks' && (
          <>
            <div style={{ ...card, background: '#f0f9ff', borderColor: '#bae6fd' }}>
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Workflows</h3>
              <p style={{ fontSize: 13, color: '#334155', margin: 0 }}>
                A workflow is a named sequence of steps your team runs against an email in one click
                (e.g. <strong>Onboard client</strong>). Add steps in order; running it creates/drafts
                everything for review — nothing is sent. Workflows are suggested by the assistant.
              </p>
            </div>

            {/* Builder */}
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>{editingId ? 'Edit workflow' : 'New workflow'}</h3>
              <input style={input} placeholder="Name (e.g. Onboard client)" value={pb.name} onChange={(e) => setPb({ ...pb, name: e.target.value })} />
              <input style={input} placeholder="Description (helps the assistant suggest it)" value={pb.description} onChange={(e) => setPb({ ...pb, description: e.target.value })} />

              {pb.steps.map((s, i) => (
                <div key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 8, background: '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{i + 1}. {STEP_LABEL[s.type] ?? s.type}</strong>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button style={{ padding: '2px 7px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' }} onClick={() => moveStep(i, -1)}>↑</button>
                      <button style={{ padding: '2px 7px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' }} onClick={() => moveStep(i, 1)}>↓</button>
                      <button style={{ padding: '2px 7px', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 6, background: '#fff', cursor: 'pointer' }} onClick={() => removeStep(i)}>✕</button>
                    </div>
                  </div>
                  {s.type === 'DRAFT_REPLY' && (
                    <select style={{ ...input, marginTop: 8, marginBottom: 0 }} value={s.config.tone ?? 'NEUTRAL'} onChange={(e) => setStepConfig(i, { ...s.config, tone: e.target.value })}>
                      <option value="NEUTRAL">Neutral tone</option>
                      <option value="FIRM">Firm tone</option>
                      <option value="CHASING">Chasing tone</option>
                    </select>
                  )}
                  {s.type === 'CREATE_TASK' && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <input style={{ ...input, marginBottom: 0, flex: 2 }} placeholder="Task detail" value={s.config.detail ?? ''} onChange={(e) => setStepConfig(i, { ...s.config, detail: e.target.value })} />
                      <input style={{ ...input, marginBottom: 0, flex: 1 }} type="number" placeholder="Due in N days" value={s.config.dueOffsetDays ?? ''} onChange={(e) => setStepConfig(i, { ...s.config, dueOffsetDays: e.target.value })} />
                    </div>
                  )}
                  {s.type === 'GENERATE_DOCS' && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Templates to generate:</div>
                      {docTemplates.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>No templates yet — add some in Doc packs first.</div>}
                      {docTemplates.map((tpl) => {
                        const ids: string[] = s.config.templateIds ?? [];
                        const on = ids.includes(tpl.id);
                        return (
                          <label key={tpl.id} style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 2 }}>
                            <input type="checkbox" checked={on} onChange={(e) => setStepConfig(i, { ...s.config, templateIds: e.target.checked ? [...ids, tpl.id] : ids.filter((x) => x !== tpl.id) })} />
                            {tpl.name}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {s.type === 'CREATE_MATTER' && <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>Provisions a matter from the email (no setup needed).</div>}
                  {s.type === 'ARCHIVE_MATTER' && <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>Closes the matter so it drops off the live board (no setup needed).</div>}
                  {s.type === 'DELEGATE' && <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>Assigns the matter on the tracker and forwards the email. You pick the team member when you run it.</div>}
                  {s.type === 'NOTIFY' && <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>Drafts an update email. You choose the recipient (client or any address) when you run it.</div>}
                </div>
              ))}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
                {(['CREATE_MATTER', 'GENERATE_DOCS', 'CREATE_TASK', 'DRAFT_REPLY', 'ARCHIVE_MATTER', 'DELEGATE', 'NOTIFY'] as const).map((tp) => (
                  <button key={tp} style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 7, background: '#f8fafc', fontSize: 12, fontWeight: 600, cursor: 'pointer' }} onClick={() => addStep(tp)}>
                    + {STEP_LABEL[tp]}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ padding: '8px 16px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }} onClick={savePlaybook}>
                  {editingId ? 'Update workflow' : 'Save workflow'}
                </button>
                {editingId ? (
                  <button style={{ padding: '8px 16px', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }} onClick={cancelEdit}>
                    Cancel
                  </button>
                ) : (
                  <button style={{ padding: '8px 16px', background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }} onClick={loadExampleWorkflows}>
                    Load example workflows
                  </button>
                )}
              </div>
            </div>

            {/* Existing */}
            {playbooks.map((p) => (
              <div key={p.id} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <strong>{p.name}</strong>
                    {p.description && <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>{p.description}</div>}
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                      {(p.steps ?? []).map((s: any, i: number) => `${i + 1}. ${STEP_LABEL[s.type] ?? s.type}`).join('  ·  ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button style={{ padding: '4px 10px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }} onClick={() => editPlaybook(p)}>
                      Edit
                    </button>
                    <button style={{ padding: '4px 10px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }} onClick={() => deletePlaybook(p.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'actions' && (
          <>
            <div style={{ ...card, background: '#f0f9ff', borderColor: '#bae6fd' }}>
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Merge cases</h3>
              <p style={{ fontSize: 13, color: '#334155', margin: 0 }}>
                If the same case was created as two separate matters, merge the duplicate into the one
                you want to keep. All emails, documents, tasks, contacts and identifiers move across; the
                duplicate is archived (its OneDrive folder is left in place and noted on the survivor’s case log).
              </p>
            </div>
            <div style={card}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Keep this matter</label>
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

        {tab === 'audit' && (
          <div style={card}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th>When</th>
                  <th>Action</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td>{row.action_type}</td>
                    <td>{row.action_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
