'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

type TabKey = 'billing' | 'board' | 'templates' | 'docpacks' | 'playbooks' | 'rules' | 'team' | 'policy' | 'actions' | 'audit' | 'help';

// One entry per tab — the label and a subtitle that matches what the section does,
// so a deep link (e.g. ?tab=docpacks) lands somewhere coherent.
const TAB_META: Record<TabKey, { label: string; subtitle: string }> = {
  billing: { label: 'Billing & referrals', subtitle: 'Your plan, subscription, seats and referral credit. Card, invoices and cancellation are handled by Stripe.' },
  board: { label: 'Matter board', subtitle: 'Every live matter by stage — oversight at a glance, without living in the inbox. Read-only for now.' },
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
  { label: 'Account', tabs: ['billing'] },
  { label: 'Oversight', tabs: ['board'] },
  { label: 'Automation & templates', tabs: ['templates', 'docpacks', 'playbooks', 'rules'] },
  { label: 'Firm', tabs: ['team', 'policy'] },
  { label: 'Tools', tabs: ['actions', 'audit'] },
  { label: 'Help', tabs: ['help'] },
];
const TAB_KEYS = NAV_GROUPS.flatMap((g) => g.tabs);
// Tabs that need the ADMIN role. Billing and Help are per-user, so a non-admin who
// lands here from "click your name" still sees those.
const ADMIN_ONLY: TabKey[] = ['board', 'templates', 'docpacks', 'playbooks', 'rules', 'team', 'policy', 'actions', 'audit'];

// Conveyancing stage model — the board's columns, in workflow order.
const STAGE_ORDER = ['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION', 'POST_COMPLETION'] as const;
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

const PLAN_LABEL: Record<string, string> = { plus: 'Plus', pro: 'Pro', enterprise: 'Enterprise' };
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
  const isAdmin = me?.role === 'ADMIN';
  const visibleTabs = isAdmin ? TAB_KEYS : TAB_KEYS.filter((k) => !ADMIN_ONLY.includes(k));

  const [tab, setTab] = useState<TabKey>('billing');
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
      .catch(() => {});
    api('/billing/account').then(setBilling).catch(() => {});
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TAB_KEYS as string[]).includes(t)) setTab(t as TabKey);
    else setTab('billing');
  }, []);
  // Never leave a non-admin parked on an admin-only tab.
  useEffect(() => {
    if (me && !isAdmin && ADMIN_ONLY.includes(tab)) setTab('billing');
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
  const [board, setBoard] = useState<any[]>([]);
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
      }
      if (tab === 'board') setBoard((await api<{ matters: any[] }>('/admin/board')).matters);
      if (tab === 'templates') setTemplates((await api<{ templates: Template[] }>('/admin/templates')).templates);
      if (tab === 'docpacks') setDocTemplates((await api<{ templates: DocTemplate[] }>('/admin/doc-templates')).templates);
      if (tab === 'policy') setPolicy((await api<{ policy: any }>('/admin/policies')).policy);
      if (tab === 'audit') setAudit((await api<{ logs: any[] }>('/admin/audit?limit=100')).logs);
      if (tab === 'rules') setRules((await api<{ rules: any[] }>('/admin/rules')).rules);
      if (tab === 'team') setUsers((await api<{ users: any[] }>('/admin/users')).users);
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
  const navItem = (active: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '7px 10px',
    borderRadius: 8,
    border: 'none',
    background: active ? '#ede9fe' : 'transparent',
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

  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh' }}>
      {/* Sticky brand bar */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e8eaf0', position: 'sticky', top: 0, zIndex: 5 }}>
        <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 10, padding: '13px 20px' }}>
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#5A27E0" />
            <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </svg>
          <strong style={{ fontSize: 17 }}>CONVE<span style={{ color: '#5A27E0' }}>Yi</span></strong>
          <span style={{ color: '#94a3b8', fontWeight: 600, fontSize: 13 }}>Admin</span>
          {me && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {billing?.plan && <span style={planBadge}>{PLAN_LABEL[billing.plan] ?? billing.plan}</span>}
              <span style={{ fontSize: 13, color: '#475569' }}>{me.displayName || me.email}</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ ...box, display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap', padding: '22px 20px 56px' }}>
        {/* Grouped left nav */}
        <nav style={{ width: 200, flexShrink: 0 }}>
          {NAV_GROUPS.map((grp) => {
            const items = grp.tabs.filter((k) => visibleTabs.includes(k));
            if (!items.length) return null;
            return (
              <div key={grp.label} style={{ marginBottom: 22 }}>
                <div style={navGroupLabel}>{grp.label}</div>
                {items.map((k) => (
                  <button key={k} style={navItem(tab === k)} onClick={() => go(k)}>{TAB_META[k].label}</button>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 300, maxWidth: tab === 'board' || tab === 'audit' ? 'none' : 880 }}>
        <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>{TAB_META[tab].label}</h1>
        <p style={{ color: '#64748b', margin: '0 0 18px', fontSize: 14 }}>{TAB_META[tab].subtitle}</p>

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
                    <button style={{ ...btnPrimary, background: '#0f172a' }} disabled={billingBusy} onClick={() => changePlanTo('enterprise')}>{billingBusy ? 'Working…' : 'Upgrade to Enterprise'}</button>
                  )}
                  <button style={btnGhost} disabled={billingBusy} onClick={manageSubscription}>{billing.hasSubscription ? 'Manage subscription' : 'Choose a plan'}</button>
                </div>
                {billing.hasSubscription && (
                  <p style={{ color: '#64748b', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
                    “Manage subscription” opens Stripe for your card, invoices, plan changes &amp; cancellation.
                  </p>
                )}
              </div>

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
                    ? 'Colleagues join by opening the CONVEYi add-in and signing in with their Microsoft 365 account.'
                    : 'Plus and Pro are single-seat. Enterprise adds team seats — upgrade above.'}
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
                  Earn {money(billing.commissionPennies, billing.currency)}/month for every firm you refer, for as long as they stay subscribed.
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
            {board.length === 0 ? (
              <div style={{ ...card, textAlign: 'center', color: '#94a3b8' }}>No live matters yet.</div>
            ) : (
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
                {STAGE_ORDER.map((stage) => {
                  const col = board.filter((m) => (m.stage || 'INSTRUCTION') === stage);
                  return (
                    <div key={stage} style={{ flex: '0 0 230px', minWidth: 230 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 8px' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>{STAGE_LABEL[stage] ?? stage}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>{col.length}</span>
                      </div>
                      <div style={{ background: '#f1f5f9', borderRadius: 10, padding: 8, minHeight: 60 }}>
                        {col.length === 0 ? (
                          <div style={{ fontSize: 12, color: '#cbd5e1', textAlign: 'center', padding: '12px 0' }}>—</div>
                        ) : (
                          col.map((m) => {
                            const date = m.completionTargetDate || m.exchangeTargetDate;
                            return (
                              <div key={m.id} style={{ background: '#fff', border: '1px solid #e8eaf0', borderRadius: 8, padding: '8px 10px', marginBottom: 8, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ width: 8, height: 8, borderRadius: 999, background: FLAG_DOT[m.statusFlag] ?? '#cbd5e1', flexShrink: 0 }} title={(m.statusFlag || '').toLowerCase().replace(/_/g, ' ')} />
                                  <strong style={{ fontSize: 13, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.matterRef || 'Matter'}</strong>
                                </div>
                                {m.propertyAddress && (
                                  <div style={{ fontSize: 12, color: '#475569', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.propertyAddress}</div>
                                )}
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 6, fontSize: 11, color: '#64748b' }}>
                                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.assignee || 'Unassigned'}</span>
                                  {date && <span style={{ whiteSpace: 'nowrap', color: '#475569' }}>{new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
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
                <strong>Team plan only:</strong> use{' '}
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
