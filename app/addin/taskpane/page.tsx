'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { matterRefFrom, fallbackMatterRef } from '@/lib/ref-name';

// ── Minimal Office.js typings (we only touch the mailbox item) ───────────────
declare global {
  interface Window {
    Office?: {
      onReady: (cb: (info: { host: string }) => void) => void;
      MailboxEnums?: { RestVersion?: { v2_0?: unknown } };
      context?: {
        mailbox?: {
          item?: OfficeItem;
          // Office hands out EWS-format ids; Graph needs REST-format ones.
          convertToRestId?: (itemId: string, version: unknown) => string;
        };
      };
    };
  }
}
interface OfficeItem {
  itemId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: string; displayName?: string };
}

interface Me {
  email: string;
  displayName: string | null;
  role: string;
}
interface DraftPackage {
  subject: string;
  bodyHtml: string;
  why: string[];
  actions: Array<{ owner: string; task: string; due: string }>;
  referencedDocuments: Array<{ id: string; file_name: string; web_url: string | null }>;
}

interface ExtractedFacts {
  facts: Record<string, unknown>;
  risks: string[];
  outstanding: string[];
  timeline: Array<{ title: string; details: string }>;
}

interface AssistData {
  triageId: string;
  classification: { intent: string; needsAttention: boolean; urgency: string; reason: string };
  matchBand: string;
  matter: { id: string; matterRef: string; propertyAddress: string | null } | null;
  candidates: Array<{ matterId: string; matterRef: string; propertyAddress: string; score: number; band: string }>;
  ask: string;
  whatWeKnow: string[];
  outstanding: string[];
  draft: { subject: string; bodyHtml: string; why: string[]; actions: Array<{ owner: string; task: string; due: string }> } | null;
  highlighted: string[];
  /** False while the slow half (thread summary + draft) is still being prepared. */
  ready: boolean;
}

interface MatterTask {
  id: string;
  ref: string;
  type: string;
  detail: string;
  assignee: string | null;
  due: string | null;
  status: string;
}
interface Assignee {
  id: string;
  email: string;
  display_name: string | null;
}
interface FileItem {
  id: string;
  name: string;
  webUrl: string | null;
  size: number | null;
  lastModified: string | null;
  mimeType: string | null;
  processed: boolean;
}
interface MatterTemplate {
  id: string;
  name: string;
  description: string | null;
  has_llm_prompts: boolean;
}

interface ObJob {
  id: string;
  status: string;
  messages_scanned: number;
  threads_found: number;
  cases_proposed: number;
  cases_onboarded: number;
  error: string | null;
  lookback_months: number | null;
}
interface ObCase {
  id: string;
  proposed_matter_ref: string | null;
  property_address: string | null;
  buyer_names: string[];
  seller_names: string[];
  counterparty_solicitor: string | null;
  confidence: number | null;
  rationale: string | null;
  error: string | null;
  thread_count: number;
  message_count: number;
  status: string;
  matter_id: string | null;
}
const OB_ACTIVE = ['SCANNING', 'CLUSTERING', 'PROPOSING', 'PROVISIONING'];

const TONES = ['NEUTRAL', 'FIRM', 'CHASING'] as const;
type Tone = (typeof TONES)[number];
// run() busy labels for the reply flow — also used to drive the panel's spinner.
const REPLY_BUSY_CREATE = 'Writing the reply into Outlook';
const REPLY_BUSY_REGEN = 'Updating the reply in Outlook';
const REPLY_BUSY_SEND = 'Sending the reply';

const STAGES: Array<[string, string]> = [
  ['INSTRUCTION', '1 · Instruction'],
  ['CONTRACT_PACK', '2 · Contract pack'],
  ['SEARCHES_ENQUIRIES', '3 · Searches & enquiries'],
  ['REVIEW_SIGNING', '4 · Review & signing'],
  ['EXCHANGE', '5 · Exchange'],
  ['COMPLETION', '6 · Completion'],
  ['POST_COMPLETION', '7 · Post-completion'],
];

// Which side of the transaction we act for — frames the stage model and the
// drafting AI (so it doesn't assume we're always the buyer).
const TRACKS: Array<[string, string]> = [
  ['PURCHASE', 'Purchase (acting for buyer)'],
  ['SALE', 'Sale (acting for seller)'],
  ['REMORTGAGE', 'Remortgage (acting for borrower)'],
];
const STATUS_FLAGS: Array<[string, string]> = [
  ['ON_TRACK', 'On track'],
  ['NEEDS_ATTENTION', 'Needs attention'],
  ['BLOCKED', 'Blocked'],
];

const TOKEN_KEY = 'cl_token';

// A 401/403 from ANY call means the session lapsed mid-use. Rather than let the
// individual caller surface a dead-end "unauthorized" toast, we drop the whole
// taskpane back to the Connect screen. The component registers this on mount.
let onUnauthorized: (() => void) | null = null;

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  // Bearer token (set after the sign-in dialog) covers desktop Outlook, where the
  // session cookie isn't shared with the taskpane. Cookie still works on the web.
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const text = await res.text();
  let json: any = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // A non-JSON body means the request didn't reach our handler cleanly — almost always a
      // serverless timeout (504) or a gateway/framework error page. Surface a real message
      // (plus a snippet of the body) instead of a raw "Unexpected token <" JSON parse crash.
      const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
      const err = new Error(
        res.status === 504 || res.status === 408 || res.status === 524
          ? `Timed out (HTTP ${res.status}).`
          : `Non-JSON response (HTTP ${res.status || '?'})${snippet ? `: ${snippet}` : ''}`
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
  }
  if (!res.ok) {
    // Auth lapsed → bounce to the Connect screen (see onUnauthorized). Clear the stale
    // bearer token so we don't keep re-sending a dead one on the reconnect.
    if (res.status === 401 || res.status === 403) {
      if (typeof window !== 'undefined') window.localStorage.removeItem(TOKEN_KEY);
      onUnauthorized?.();
    }
    const err = new Error(json.error || `HTTP ${res.status}`) as Error & { status?: number; action?: string };
    err.status = res.status;
    err.action = json.action;
    throw err;
  }
  return json as T;
}

// The canonical taskpane worklist entry (see /api/v1/worklist): "ready to send" drafts and
// chases, shown on the no-email landing regardless of whether an email is open.
type WorklistEntry = {
  id: string;
  kind: 'CHASE' | 'DRAFT_READY' | 'TASK';
  matterRef: string;
  propertyAddress: string | null;
  title: string;
  detail: string | null;
  ageDays: number;
  threadId?: string | null;
  graphMessageId?: string | null; // the ready draft to send (DRAFT_READY only)
  keyDate?: string | null; // matter's nearest exchange/completion target
  urgent?: boolean; // key date OR task due within a week — top of the queue
  due?: string | null; // TASK's own due date (YYYY-MM-DD)
};

// Remember across opens that this user was signed in, so a cold taskpane shows a
// brief "Connecting…" instead of flashing "Not connected" while /me is in flight.
// Set on a successful /me, cleared only on a genuine sign-out (401/403).
const SIGNED_IN_COOKIE = 'cl_signed_in';
function setSignedInCookie(on: boolean) {
  if (typeof document === 'undefined') return;
  document.cookie = on
    ? `${SIGNED_IN_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`
    : `${SIGNED_IN_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
function hasSignInHint(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    new RegExp(`(?:^|; )${SIGNED_IN_COOKIE}=1`).test(document.cookie) ||
    !!window.localStorage.getItem(TOKEN_KEY)
  );
}

export default function Taskpane() {
  const [me, setMe] = useState<Me | null>(null);
  const [plan, setPlan] = useState<{ plan: string | null; status: string; entitled: boolean; trialing: boolean } | null>(null);
  // Matter reconciliation grid ("is my file right?").
  const [recon, setRecon] = useState<{ rows: any[]; issues: string[]; documents: string[]; skipped: string[] } | null>(null);
  const [reconBusy, setReconBusy] = useState(false);
  const [aiConnected, setAiConnected] = useState<boolean | null>(null);
  const [autoTriage, setAutoTriage] = useState<{ enabled: boolean; expiresAt: string | null; needsReconnect?: boolean } | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState<string>('');

  // Auto-dismiss the status toast. Otherwise a transient message (an error like
  // "Link or create a matter first." or a success confirmation) lingers until
  // the next action happens to clear it. While busy we leave it — the toast is
  // then showing live progress, not a settled message.
  useEffect(() => {
    if (!status || busy) return;
    const t = setTimeout(() => setStatus(''), 6000);
    return () => clearTimeout(t);
  }, [status, busy]);

  // Outlook thread context
  const [messageId, setMessageId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [subject, setSubject] = useState('');

  // Matter
  const [matterId, setMatterId] = useState('');
  const [matterInfo, setMatterInfo] = useState<any>(null);
  const [showNewMatter, setShowNewMatter] = useState(false);
  // A stable codename used as the matter ref when we can't derive one from the
  // names/address — generated once so the placeholder doesn't flicker on edits.
  const [fallbackRef] = useState(() => fallbackMatterRef());
  const [sender, setSender] = useState<{ name: string; email: string } | null>(null);
  const [form, setForm] = useState<{
    matterRef: string;
    propertyAddress: string;
    buyerNames: string[];
    sellerNames: string[];
    counterparties: string[];
    exchangeTargetDate: string;
    completionTargetDate: string;
  }>({
    matterRef: '',
    propertyAddress: '',
    buyerNames: [],
    sellerNames: [],
    counterparties: [],
    exchangeTargetDate: '',
    completionTargetDate: '',
  });

  // Triage / suggested match
  const [triage, setTriage] = useState<any>(null);
  const [riskOk, setRiskOk] = useState(false);

  // AI outputs
  const [summary, setSummary] = useState<{ happened: string[]; outstanding: string[] } | null>(null);
  const [facts, setFacts] = useState<ExtractedFacts | null>(null);
  // Reply tone — NEUTRAL by default; the user can switch it and regenerate.
  const [tone, setTone] = useState<Tone>('NEUTRAL');
  // Free-text steer for the reply redraft, and whether a reply draft now exists in
  // Outlook for this email (so the panel shows "Regenerate" + a written-to-Outlook hint).
  const [guidance, setGuidance] = useState('');
  const [replyReady, setReplyReady] = useState(false);
  const [replySent, setReplySent] = useState(false); // this email's reply has been sent
  const [draftId, setDraftId] = useState<string | null>(null); // the Outlook draft to send
  // Set when a reply draft attempt errors, so the panel stops spinning and offers a retry.
  const [replyFailed, setReplyFailed] = useState(false);

  // The taskpane renders by *situation*, not by feature tabs: open an email → it
  // auto-analyses → we show what we found (matter? what's being asked?) and the
  // handful of moves that make sense. `chosenAction` tracks which of the four
  // canonical moves the user picked so its sub-panel expands; `linkOpen` toggles
  // the (normally collapsed) link-to-a-different/new-matter drawer.
  const [chosenAction, setChosenAction] = useState<'reply' | 'action' | 'ignore' | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // When a matter is linked, the drawer shows just the matter + "Change matter".
  // Setting this reveals the candidate/create chooser so they can pick another.
  const [changing, setChanging] = useState(false);
  // Free-text search over all the firm's matters — for linking to one the
  // auto-matcher didn't surface as a candidate.
  const [matterSearch, setMatterSearch] = useState('');
  const [matterResults, setMatterResults] = useState<Array<{ id: string; matterRef: string; propertyAddress: string }>>([]);
  const [ignored, setIgnored] = useState(false);
  // Setup (historical import + AI settings) isn't a tab — it's the initial state
  // for a firm that hasn't imported yet, and re-openable via the header gear.
  const [showSetup, setShowSetup] = useState(false);

  // Three tabs, sharing the matter pill at the top as a fixed anchor:
  //   email     → what this email is about + what we're doing about it
  //   house     → the transaction/matter record (details, stage, tasks) — editable
  //   paperclip → files on the matter + the email-derived transaction knowledge
  const [tab, setTab] = useState<'email' | 'house' | 'paperclip'>('email');
  // Home/worklist view: the pane only opens on a selected email, so the "what needs me"
  // queue was unreachable while any email was open. This toggle surfaces it on demand.
  const [homeView, setHomeView] = useState(false);

  // Assistant ("here's the situation") + the matter task board ("Jira in Excel").
  const [assist, setAssist] = useState<AssistData | null>(null);
  // Tracks which message the assist poller is following; changing it cancels any
  // in-flight poll so a fast email-switch never lands stale results.
  // True when /me failed for a reason *other* than being signed out (a 5xx or a
  // network error). We're still "not connected", but telling the user to connect
  // their account won't help — the server is the problem, so offer a retry.
  const [connError, setConnError] = useState(false);
  // True until the first /me check resolves. Starts true only when we have a
  // prior-sign-in hint (cookie / desktop token) so a returning user sees
  // "Connecting…" instead of "Not connected", but a first-timer goes straight to
  // the Connect button. Set false in an effect to keep server/client render in step.
  const [booting, setBooting] = useState(false);
  const assistPollRef = useRef<string>('');
  // True when the initial analysis of the open email failed — lets the hero show
  // a recoverable error + retry instead of an endless "Reading…" spinner.
  const [assistError, setAssistError] = useState(false);
  const [tasks, setTasks] = useState<MatterTask[]>([]);
  const [worklist, setWorklist] = useState<WorklistEntry[] | null>(null);
  const [wlBusy, setWlBusy] = useState<string>('');
  // Worklist sort: 'smart' keeps the server's urgency order; 'due' by nearest deadline; 'matter' groups by case.
  const [wlSort, setWlSort] = useState<'smart' | 'due' | 'matter'>('smart');
  // Worklist filter: `assignee` is '' (anyone / whole firm) or a user id. Only shown to team admins.
  const [wlMeta, setWlMeta] = useState<{ team: boolean; isAdmin: boolean; assignee: string }>({ team: false, isAdmin: false, assignee: '' });
  const [teamMembers, setTeamMembers] = useState<Array<{ id: string; display_name: string | null; email: string; role: string }>>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [showHistory, setShowHistory] = useState(false); // status card: audit-log panel
  // Referral popup (the gift icon in the header).
  const [referral, setReferral] = useState<{ referralLink: string; referralCode: string; commissionPennies: number } | null>(null);
  const [showReferral, setShowReferral] = useState(false);
  const [quotaModal, setQuotaModal] = useState<{ used: number; cap: number; hoursSaved: number } | null>(null);
  const [refCopied, setRefCopied] = useState(false);
  // Cache the master board's URL so the button can open it synchronously (no
  // popup block, no blank tab) and sync in the background.
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);

  // Documents & sharing
  const [docs, setDocs] = useState<any[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [templates, setTemplates] = useState<MatterTemplate[]>([]);
  const [templatesPremium, setTemplatesPremium] = useState(false);
  const [genTemplateId, setGenTemplateId] = useState<string | null>(null);
  // Loading vs loaded so the panels show a spinner while fetching, not an empty
  // state. `loaded` flips true after the first fetch settles for the current matter.
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);
  // Playbooks (named multi-step actions)
  const [playbooks, setPlaybooks] = useState<Array<{ id: string; name: string; description: string | null; steps: any[] }>>([]);
  const [runningPb, setRunningPb] = useState<string | null>(null);
  const [pbResults, setPbResults] = useState<{ name: string; results: Array<{ type: string; ok: boolean; detail: string }> } | null>(null);
  const [pbInputs, setPbInputs] = useState<{ p: { id: string; name: string; steps?: any[] }; needsDelegate: boolean; needsNotify: boolean; delegateToUserId: string; notifyEmail: string; notifyName: string } | null>(null);
  const [pbSuggestion, setPbSuggestion] = useState<{ playbookId: string; reason: string } | null>(null);
  const suggestedFor = useRef<string>('');
  // The message we've already auto-drafted a reply for, so the auto-draft fires once.
  const autoRepliedFor = useRef<string>('');
  const [quick, setQuick] = useState<{ type: 'DELEGATE' | 'NOTIFY'; delegateToUserId: string; notifyEmail: string; notifyName: string; notifyCustom: boolean } | null>(null);
  const [expandedPb, setExpandedPb] = useState<string | null>(null);

  // Onboarding (bulk-import existing cases from the mailbox backlog)
  const [obJob, setObJob] = useState<ObJob | null>(null);
  const [obCases, setObCases] = useState<ObCase[]>([]);
  const [obSel, setObSel] = useState<Record<string, boolean>>({});
  const [obRefEdit, setObRefEdit] = useState<Record<string, string>>({});
  const [obLookback, setObLookback] = useState<'3' | 'unlimited'>('3');
  const [obSearch, setObSearch] = useState('');
  // Per-matter Inbox subfolders — opt-in; nudge the admin once at first import.
  const [subfolderPref, setSubfolderPref] = useState<{ enabled: boolean; prompted: boolean } | null>(null);
  const [obUpsell, setObUpsell] = useState(false); // monthly backlog-scan cap hit (non-pro)
  const obDriving = useRef(false);
  // First-run: until the firm has scanned its backlog (or chosen to skip), lead
  // with the import. obFetched gates it so the hero doesn't flash before we know.
  const [obFetched, setObFetched] = useState(false);
  const [obSkipped, setObSkipped] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('cl_onboarding_skipped') === '1'
  );
  function skipOnboarding() {
    if (typeof window !== 'undefined') window.localStorage.setItem('cl_onboarding_skipped', '1');
    setObSkipped(true);
  }

  const officeReady = useRef(false);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
      setConnError(false);
      setSignedInCookie(true);
    } catch (e) {
      // 401/403 → genuinely signed out. Anything else (5xx, or a network error
      // with no status) → the server is unreachable, not an auth problem.
      const status = (e as { status?: number }).status;
      const signedOut = status === 401 || status === 403;
      setMe(null);
      setConnError(!signedOut);
      if (signedOut) setSignedInCookie(false); // stale hint — don't keep promising "Connecting…"
    } finally {
      setBooting(false);
    }
    try {
      const k = await api<{ connected: boolean }>('/me/ai-key');
      setAiConnected(k.connected);
    } catch {
      setAiConnected(null);
    }
    try {
      // Self-heal on open: re-arm the inbox subscription if it lapsed or is
      // expiring, so on-receipt triage survives a missed renewal cron. Cheap
      // (DB-only) when auto-triage is off or the subscription is healthy.
      setAutoTriage(await api<{ enabled: boolean; expiresAt: string | null; needsReconnect?: boolean }>('/graph/subscriptions/ensure', { method: 'POST' }));
    } catch {
      try {
        setAutoTriage(await api<{ enabled: boolean; expiresAt: string | null }>('/graph/subscriptions'));
      } catch {
        setAutoTriage(null);
      }
    }
    try {
      const b = await api<{ plan: string | null; status: string; entitled: boolean; trialing: boolean }>('/billing/account');
      setPlan({ plan: b.plan, status: b.status, entitled: b.entitled, trialing: b.trialing });
    } catch {
      setPlan(null);
    }
    try {
      setPlaybooks((await api<{ playbooks: any[] }>('/playbooks')).playbooks ?? []);
    } catch {
      setPlaybooks([]);
    }
    try {
      // Doesn't need an email open — the "what needs me today" list (my matters by default).
      const r = await api<{ items: WorklistEntry[]; team: boolean; isAdmin: boolean; assignedTo: string }>('/worklist');
      setWorklist(r.items ?? []);
      setWlMeta({ team: !!r.team, isAdmin: !!r.isAdmin, assignee: r.assignedTo ?? '' });
    } catch {
      setWorklist([]);
    }
    try {
      setTeamMembers((await api<{ members: any[] }>('/team/members')).members ?? []);
    } catch {
      setTeamMembers([]);
    }
  }, []);

  // Register the global unauthorized handler: any 401/403 mid-session drops the whole
  // taskpane to the Connect screen (me=null) instead of a dead-end toast, so the user
  // can just sign back in.
  useEffect(() => {
    onUnauthorized = () => {
      setMe(null);
      setSignedInCookie(false);
      setBooting(false);
    };
    return () => {
      onUnauthorized = null;
    };
  }, []);

  // Re-pull the worklist on its own (used when returning to the no-email landing, on a light
  // poll, and when switching My/Team scope). Captures team/role so the toggle knows itself.
  const reloadWorklist = useCallback(async (assignee?: string) => {
    try {
      const r = await api<{ items: WorklistEntry[]; team: boolean; isAdmin: boolean; assignedTo: string }>(
        `/worklist${assignee !== undefined ? `?assignedTo=${encodeURIComponent(assignee || 'any')}` : ''}`
      );
      setWorklist(r.items ?? []);
      setWlMeta({ team: !!r.team, isAdmin: !!r.isAdmin, assignee: r.assignedTo ?? '' });
    } catch {
      /* keep whatever we had */
    }
  }, []);

  // Snooze (a week) or dismiss a worklist entry — a chase (by thread) or a ready-to-send draft.
  async function worklistAction(item: WorklistEntry, action: 'snooze' | 'dismiss' | 'done') {
    setWlBusy(item.id);
    try {
      await api('/worklist', {
        method: 'POST',
        body: JSON.stringify({ kind: item.kind, id: item.kind === 'CHASE' ? item.threadId ?? item.id : item.id, action, days: 7 }),
      });
      setWorklist((w) => (w ?? []).filter((x) => x.id !== item.id));
    } catch {
      /* best-effort */
    } finally {
      setWlBusy('');
    }
  }

  // The "did-it-for-you, hit confirm" actions, right in the worklist:
  //  - a ready draft is already written → one-click Send.
  //  - a chase → draft the chaser (into Outlook Drafts), then it becomes Send.
  // Per-item drafted-chaser state so the button flips to Send once it's written.
  const [wlChaser, setWlChaser] = useState<Record<string, string | 'busy'>>({}); // itemId → draft messageId
  async function sendWorklistDraft(item: WorklistEntry, messageId: string) {
    setWlBusy(item.id);
    try {
      await api('/worklist/send', { method: 'POST', body: JSON.stringify({ messageId, itemId: item.kind === 'DRAFT_READY' ? item.id : undefined }) });
      setWorklist((w) => (w ?? []).filter((x) => x.id !== item.id));
      setStatus('Sent.');
    } catch (e: any) {
      setStatus(e?.message || 'Couldn’t send — open the draft in Outlook to send it there.');
    } finally {
      setWlBusy('');
    }
  }
  async function draftWorklistChaser(item: WorklistEntry) {
    setWlChaser((s) => ({ ...s, [item.id]: 'busy' }));
    try {
      const r = await api<{ id: string }>('/worklist/draft-chaser', { method: 'POST', body: JSON.stringify({ threadId: item.threadId ?? item.id }) });
      if (r.id) setWlChaser((s) => ({ ...s, [item.id]: r.id }));
      else throw new Error('no draft');
    } catch (e: any) {
      setWlChaser((s) => { const { [item.id]: _drop, ...rest } = s; return rest; });
      setStatus(e?.message || 'Couldn’t draft the chaser.');
    }
  }

  // Keep the worklist fresh while it's on screen (no-email landing OR the homeView queue):
  // refetch on entering it and every 90s, so newly-arrived drafts/chases appear.
  useEffect(() => {
    if (!me || (messageId && !homeView)) return;
    reloadWorklist(wlMeta.assignee);
    const t = setInterval(() => reloadWorklist(wlMeta.assignee), 90_000);
    return () => clearInterval(t);
  }, [me, messageId, homeView, reloadWorklist, wlMeta.assignee]);

  // Cold open with a prior-sign-in hint → optimistically show "Connecting…" so we
  // don't flash "Not connected" during the first /me round-trip. Runs post-mount
  // (not in the initial state) to keep the server and client render identical.
  useEffect(() => {
    if (hasSignInHint()) setBooting(true);
  }, []);

  // Billing lives on a full page (redirects need width). Hand the session token
  // over in the URL fragment so desktop Outlook's separate storage jar can auth.
  // Open the admin/account area. The session token rides in the URL fragment so
  // desktop Outlook (separate cookie jar) can authenticate the browser tab.
  function openAdmin(tab = 'billing') {
    const t = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
    const base = `/admin?tab=${tab}`;
    window.open(t ? `${base}#token=${encodeURIComponent(t)}` : base, '_blank', 'noopener');
  }

  // Referral popup — fetch the firm's link lazily the first time the gift is opened.
  async function openReferral() {
    setShowReferral(true);
    setRefCopied(false);
    if (referral) return;
    try {
      const r = await api<{ referralLink: string; referralCode: string; commissionPennies: number }>('/referrals');
      setReferral({ referralLink: r.referralLink, referralCode: r.referralCode, commissionPennies: r.commissionPennies });
    } catch {
      /* leave null — the popup shows a gentle fallback */
    }
  }

  async function copyReferral() {
    if (!referral) return;
    const text = referral.referralLink;
    let ok = false;
    // Async Clipboard API first — but it's often blocked/absent inside the Office
    // add-in iframe (needs clipboard-write permission + secure context).
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    // Legacy fallback — a hidden textarea + execCommand('copy'). Works in Outlook's
    // embedded webview where the async API is unavailable.
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setRefCopied(true);
      setTimeout(() => setRefCopied(false), 2000);
    } else {
      setStatus('Couldn’t copy automatically — your code is ' + referral.referralCode + '.');
    }
  }


  // ── Onboarding ───────────────────────────────────────────────────────────────
  const refreshOnboarding = useCallback(async (): Promise<ObJob | null> => {
    try {
      const r = await api<{ job: ObJob | null; cases: ObCase[] }>('/onboarding');
      setObJob(r.job);
      setObCases(r.cases ?? []);
      if (r.job?.status === 'AWAITING_REVIEW') {
        // Pre-tick confident candidates so the common case is one click.
        setObSel((prev) => {
          const next = { ...prev };
          for (const c of r.cases ?? []) if (!(c.id in next)) next[c.id] = (c.confidence ?? 0) >= 0.6;
          return next;
        });
      }
      return r.job;
    } catch {
      return null;
    } finally {
      setObFetched(true);
    }
  }, []);

  // Loop the bounded /process endpoint until the job needs the user (review) or ends.
  const driveOnboarding = useCallback(async () => {
    if (obDriving.current) return;
    obDriving.current = true;
    let transientRetries = 0;
    try {
      for (;;) {
        try {
          const r = await api<{ status: string; job: ObJob | null; done: boolean }>('/onboarding/process', { method: 'POST' });
          transientRetries = 0; // a good slice resets the budget
          if (r.job) setObJob(r.job);
          if (r.done) {
            await refreshOnboarding();
            break;
          }
          await new Promise((res) => setTimeout(res, 500));
        } catch (e) {
          // A single slice timing out / a transient 5xx shouldn't abort the whole import —
          // each slice is resumable, so back off and retry a few times before surfacing.
          // Show the RAW error + status on every attempt so failures are diagnosable.
          const status = (e as { status?: number }).status ?? 0;
          const raw = (e as Error).message || 'Unknown error';
          const transient = status === 0 || status === 408 || status === 429 || status >= 500;
          if (transient && transientRetries < 4) {
            transientRetries += 1;
            setStatus(`⚠️ ${raw} [HTTP ${status || 'network'}] — retrying ${transientRetries}/4…`);
            await new Promise((res) => setTimeout(res, 1500 * transientRetries));
            continue;
          }
          setStatus(`Onboarding stopped — ${raw} [HTTP ${status || 'network'}]`);
          return;
        }
      }
    } catch (e) {
      setStatus(`Onboarding stopped — ${(e as Error).message || 'Unknown error'}`);
    } finally {
      obDriving.current = false;
    }
  }, [refreshOnboarding]);

  // Load the subfolder preference once we know the user is an admin (only admins can
  // set it, and only they see the nudge).
  useEffect(() => {
    if (me?.role !== 'ADMIN') return;
    api<{ enabled: boolean; prompted: boolean }>('/settings/mail-subfolders').then(setSubfolderPref).catch(() => {});
  }, [me]);

  async function chooseSubfolders(enabled: boolean) {
    try {
      await api('/settings/mail-subfolders', { method: 'POST', body: JSON.stringify({ enabled }) });
    } catch {
      /* best-effort — the choice is a nudge, not a blocker */
    }
    setSubfolderPref({ enabled, prompted: true });
  }

  async function startOnboarding() {
    setObUpsell(false);
    const started = await run('Starting scan', async () => {
      const lookbackMonths = obLookback === 'unlimited' ? null : 3;
      try {
        const r = await api<{ job: ObJob }>('/onboarding', { method: 'POST', body: JSON.stringify({ lookbackMonths }) });
        setObJob(r.job);
        setObCases([]);
        setObSel({});
        setObRefEdit({});
        setStatus('Scanning your mailbox…');
        return true;
      } catch (e) {
        // Monthly backlog-scan cap → show the message (and an upsell when not on Pro).
        if ((e as { status?: number }).status === 429) {
          if ((e as { action?: string }).action === 'upgrade') setObUpsell(true);
          setStatus((e as Error).message);
          return false;
        }
        throw e;
      }
    });
    if (started) driveOnboarding(); // the setup view stays open while the scan runs
  }

  async function confirmOnboarding() {
    const ok = await run('Onboarding selected cases', async () => {
      const selections = obCases
        .filter((c) => c.status === 'PROPOSED')
        .map((c) => ({
          caseId: c.id,
          approved: !!obSel[c.id],
          edits: obRefEdit[c.id]?.trim() ? { matterRef: obRefEdit[c.id].trim() } : undefined,
        }));
      await api('/onboarding/confirm', { method: 'POST', body: JSON.stringify({ selections }) });
      setStatus('Provisioning matters…');
      await refreshOnboarding();
      return true;
    });
    if (ok) driveOnboarding();
  }

  async function cancelOnboarding() {
    await run('Cancelling', async () => {
      await api('/onboarding', { method: 'DELETE' });
      setObJob(null);
      setObCases([]);
      setObSel({});
      setStatus('Onboarding cancelled.');
    });
  }

  // Resume an in-progress job whenever the taskpane (re)loads while signed in.
  useEffect(() => {
    if (!me) return;
    (async () => {
      const job = await refreshOnboarding();
      if (job && OB_ACTIVE.includes(job.status)) driveOnboarding();
    })();
  }, [me, refreshOnboarding, driveOnboarding]);

  useEffect(() => {
    refreshMe();
    // Wait for Office.js then pull the current message context.
    const tryOffice = () => {
      if (window.Office && !officeReady.current) {
        officeReady.current = true;
        const Office = window.Office as any;
        // Read the open message; Graph needs a REST id. Classic Outlook (Win/Mac)
        // hands back an EWS id that must be converted; OWA / new Outlook already
        // give a REST id, and converting THAT yields an "id malformed" 400 from
        // Graph. EWS ids are standard base64 (contain + / =); REST ids are base64url
        // (never do), so only convert when the id actually looks like EWS.
        const loadItem = () => {
          const mailbox = Office?.context?.mailbox;
          const item = mailbox?.item;
          if (!item) {
            // Pinned pane with nothing selected → drop back to the worklist landing rather
            // than leaving the last email's analysis stuck on screen.
            setMessageId('');
            setConversationId('');
            setSubject('');
            setSender(null);
            setAssist(null);
            setMatterId('');
            setMatterInfo(null);
            setTab('email');
            return;
          }
          let id = item.itemId as string | undefined;
          if (id && /[+/=]/.test(id) && typeof mailbox.convertToRestId === 'function') {
            try {
              id = mailbox.convertToRestId(id, Office?.MailboxEnums?.RestVersion?.v2_0);
            } catch {
              /* fall back to the raw id */
            }
          }
          setMessageId(id ?? '');
          setConversationId(item.conversationId ?? '');
          setSubject(item.subject ?? '');
          if (item.from?.emailAddress) {
            setSender({ name: item.from.displayName || item.from.emailAddress, email: item.from.emailAddress });
          }
          // Switching emails (incl. on a pinned task pane) = a clean slate: clear the
          // previous email's analysis AND every matter-scoped panel, so nothing from
          // the old case lingers. runAssist (keyed on messageId) then repopulates for
          // the newly selected email.
          setAssist(null);
          setTriage(null);
          setChosenAction(null);
          setPbSuggestion(null);
          setQuick(null);
          setPbResults(null);
          setExpandedPb(null);
          setIgnored(false);
          setLinkOpen(false);
          setReplyReady(false);
          setReplySent(false);
          setDraftId(null);
          setReplyFailed(false);
          setGuidance('');
          setTone('NEUTRAL');
          setMatterId('');
          setMatterInfo(null);
          setSummary(null);
          setFacts(null);
          setTasks([]);
          setDocs([]);
          setChanging(false);
          setShowNewMatter(false);
          setMatterSearch('');
          setMatterResults([]);
          setRiskOk(false);
          setTab('email');
        };
        Office.onReady(() => {
          loadItem();
          // Re-read when the user selects a different message (pinned task pane).
          try {
            Office?.context?.mailbox?.addHandlerAsync?.(Office?.EventType?.ItemChanged ?? 'olkItemSelectedChanged', loadItem);
          } catch {
            /* event not available on this host — the pane just won't auto-refresh */
          }
        });
      }
    };
    tryOffice();
    const t = setInterval(tryOffice, 400);
    return () => clearInterval(t);
  }, [refreshMe]);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setStatus('');
    try {
      const r = await fn();
      return r;
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const requireThread = () => {
    if (!conversationId) throw new Error('Open an email so CONVEYi can read the thread.');
  };
  const requireMatter = () => {
    if (!matterId) throw new Error('Link or create a matter first.');
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  // Sign-in must run in an Office dialog window — Microsoft's login refuses to be
  // iframed, so a redirect inside the taskpane fails with "refused to connect".
  // Clear the session both sides and drop to the Connect screen — the user-facing escape
  // hatch from a bad auth state (wrong account, stale consent). No dead ends.
  async function signOut() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* clear locally regardless */ }
    window.localStorage.removeItem(TOKEN_KEY);
    setSignedInCookie(false);
    setMe(null);
    setBooting(false);
    setStatus('Signed out.');
  }

  function connect(opts: { consent?: boolean } = {}) {
    const Office = (window as any).Office;
    const origin = window.location.origin;
    const path = opts.consent ? '/api/v1/auth/login?consent=1' : '/api/v1/auth/login';
    if (Office?.context?.ui?.displayDialogAsync) {
      Office.context.ui.displayDialogAsync(
        `${origin}${path}`,
        { height: 60, width: 30, displayInIframe: false },
        (result: any) => {
          if (result.status !== 'succeeded') {
            setStatus('Could not open the sign-in window. Allow pop-ups and try again.');
            return;
          }
          const dialog = result.value;
          dialog.addEventHandler(Office.EventType.DialogMessageReceived, async (arg: any) => {
            try {
              const data = JSON.parse(arg.message);
              if (data.token) window.localStorage.setItem(TOKEN_KEY, data.token);
            } catch {
              /* ignore malformed message */
            }
            dialog.close();
            await refreshMe();
            setStatus('Connected to Outlook.');
          });
          dialog.addEventHandler(Office.EventType.DialogEventReceived, () => refreshMe());
        }
      );
    } else {
      // Not in Office (e.g. testing in a plain browser tab) — top-level redirect.
      window.location.href = path;
    }
  }

  function cleanSubject(s: string) {
    return s.replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim();
  }

  // Pull a clean property address out of the subject: keep everything up to and
  // including a UK postcode if present; else the house-number clause; else the
  // de-prefixed subject (trimmed of a trailing "— draft contract" style suffix).
  function addressFromSubject(s: string): string {
    const clean = cleanSubject(s);
    const pc = clean.match(/^(.*?\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
    if (pc) return pc[1].trim();
    const num = clean.match(/\b\d+\s+[A-Za-z].*/);
    if (num) return num[0].split(/\s[–—|:-]\s/)[0].trim().slice(0, 80);
    return clean;
  }

  // The sender of an incoming email is almost always the other side — format them
  // as one "Name <email>" contact (or just the email when there's no real name).
  function senderContact(): string | null {
    if (!sender?.email) return null;
    const name = sender.name?.trim();
    return name && name.toLowerCase() !== sender.email.toLowerCase() ? `${name} <${sender.email}>` : sender.email;
  }

  // A human, memorable default ref: party surname + postcode/street token, e.g.
  // "HARTLEY-SW1A" or "SMITH-14OAK". Falls back to a random codename (e.g.
  // "amber-cedar-harbor") when we know nothing yet — never a bare number.
  // Recomputed live so the placeholder shows what will actually be used.
  function suggestedRef(): string {
    return (
      matterRefFrom({ buyerNames: form.buyerNames, sellerNames: form.sellerNames, propertyAddress: form.propertyAddress }) ||
      fallbackRef
    );
  }

  // Open the New-matter form, pre-filling what we can read from the open email:
  // the property address from the subject, and the counterparty from the sender.
  function openNewMatter() {
    if (showNewMatter) {
      setShowNewMatter(false);
      return;
    }
    const contact = senderContact();
    setForm((f) => ({
      ...f,
      propertyAddress: f.propertyAddress || addressFromSubject(subject),
      counterparties: f.counterparties.length ? f.counterparties : contact ? [contact] : [],
    }));
    setShowNewMatter(true);
  }

  async function createMatter() {
    await run('Creating matter', async () => {
      const body = {
        matterRef: form.matterRef.trim() || suggestedRef(),
        propertyAddress: form.propertyAddress,
        buyerNames: form.buyerNames,
        sellerNames: form.sellerNames,
        // First contact → solicitor, second → agent (the two backend columns).
        counterpartySolicitor: form.counterparties[0] || undefined,
        counterpartyAgent: form.counterparties[1] || undefined,
        exchangeTargetDate: form.exchangeTargetDate || undefined,
        completionTargetDate: form.completionTargetDate || undefined,
      };
      const created = await api<{ id: string; folderWebUrl: string | null; trackerWebUrl: string | null }>('/matters', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMatterId(created.id);
      setShowNewMatter(false);
      // Link the current thread automatically when one is open.
      if (conversationId) {
        await api(`/matters/${created.id}/link-thread`, {
          method: 'POST',
          body: JSON.stringify({ graphThreadId: conversationId, graphConversationId: conversationId, messageId: messageId || undefined, subject }),
        });
      }
      setStatus('Matter created — OneDrive folder + Tracker.xlsx provisioned.');
      await loadMatter(created.id);
    });
  }

  async function loadMatter(id = matterId) {
    await run('Loading matter', async () => {
      if (!id) throw new Error('No matter id');
      setMatterInfo(await api(`/matters/${id}`));
    });
  }

  // Update a matter field (stage / status) and refresh the panel.
  async function updateMatterField(patch: Record<string, unknown>) {
    if (!matterId) return;
    await run('Updating matter', async () => {
      await api(`/matters/${matterId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await loadMatter();
      return true;
    });
  }

  // Open the firm-wide master Excel — syncs Excel edits in, builds it if missing,
  // and opens it. If it's already open in Excel (locked) we just open it.
  // Look up the board's URL up front (no sync) so the button can open instantly.
  const loadBoardUrl = useCallback(async () => {
    try {
      const r = await api<{ webUrl: string | null }>('/matters/board');
      setBoardUrl(r.webUrl);
    } catch {
      /* not built yet — buildBoard will create it */
    }
  }, []);
  useEffect(() => {
    if (me) loadBoardUrl();
  }, [me, loadBoardUrl]);

  async function buildBoard() {
    // If we already know the file's URL, open it now (synchronous → no popup block,
    // no blank tab) and sync in the background; the open sheet updates live as the
    // rows upsert. Otherwise build it first (spinner), then open.
    if (boardUrl) window.open(boardUrl, '_blank');
    setBoardLoading(true);
    try {
      const r = await api<{ webUrl: string | null; matters: number; needsClose: boolean }>('/matters/board', { method: 'POST' });
      if (r.needsClose) {
        setStatus('Close the tracker in Excel, then click again — upgrading it to the live-updating version.');
        return;
      }
      if (r.webUrl) setBoardUrl(r.webUrl);
      if (r.webUrl && !boardUrl) window.open(r.webUrl, '_blank'); // first build: open once we have it
      setStatus(`Team tracker synced — ${r.matters} open matter(s).`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBoardLoading(false);
    }
  }

  async function useCandidate(c: any) {
    await run('Linking match', async () => {
      await api('/triage/apply', {
        method: 'POST',
        body: JSON.stringify({
          // Candidates can arrive from the auto-analyse (assist) or a manual
          // "search again" (triage) — either carries a triageId to apply against.
          triageId: assist?.triageId ?? triage?.triageId,
          matterId: c.matterId,
          messageId,
          conversationId,
          band: c.band,
          riskAccepted: c.band === 'AUTO' ? true : riskOk,
        }),
      });
      setMatterId(c.matterId);
      setTriage(null);
      setLinkOpen(false);
      setShowNewMatter(false);
      await loadMatter(c.matterId);
      setStatus(`Linked to ${c.matterRef}.`);
    });
    // Re-read the email now we know the matter, so the situation + actions reflect
    // the linked file's context rather than the no-matter analysis.
    runAssist(c.matterId);
  }

  // Link this email's thread to a matter the user picked from search (rather than
  // an AI candidate). link-thread is the direct association; no triage to apply.
  async function linkExistingMatter(m: { id: string; matterRef: string; propertyAddress: string }) {
    await run('Linking matter', async () => {
      if (!conversationId) throw new Error('Open an email to link it to a matter.');
      await api(`/matters/${m.id}/link-thread`, {
        method: 'POST',
        body: JSON.stringify({ graphThreadId: conversationId, graphConversationId: conversationId, messageId: messageId || undefined, subject }),
      });
      setMatterId(m.id);
      setChanging(false);
      setLinkOpen(false);
      await loadMatter(m.id);
      setStatus(`Linked to ${m.matterRef}.`);
    });
    runAssist(m.id);
  }

  async function summarise() {
    const r = await run('Summarising', async () => {
      requireThread();
      return api<{ happened: string[]; outstanding: string[] }>(`/threads/${encodeURIComponent(conversationId)}/summarise`, {
        method: 'POST',
        body: JSON.stringify({ matterId: matterId || undefined, conversationId }),
      });
    });
    if (r) setSummary(r);
  }

  async function loadDocs() {
    await run('Loading documents', async () => {
      requireMatter();
      const r = await api<{ documents: any[] }>(`/matters/${matterId}/documents`);
      setDocs(r.documents);
    });
  }

  // Live contents of the matter's OneDrive folder (incl. files dropped in directly,
  // Cross-document reconciliation: "check this file is right" across the matter's docs.
  async function runReconcile() {
    if (!matterId) return;
    setReconBusy(true);
    try {
      const r = await api<{ rows: any[]; issues: string[]; documents: string[]; skipped: string[] }>(
        `/matters/${matterId}/reconcile`,
        { method: 'POST' }
      );
      setRecon(r);
      setStatus('');
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setReconBusy(false);
    }
  }

  // not just app-saved ones) — quiet load so opening the Files tab isn't a spinner.
  const loadFiles = useCallback(async (mid = matterId) => {
    if (!mid) return;
    setFilesLoading(true);
    try {
      const r = await api<{ files: FileItem[] }>(`/matters/${mid}/files`);
      setFiles(r.files ?? []);
    } catch {
      /* folder may not be provisioned yet — leave the list empty */
    } finally {
      setFilesLoading(false);
      setFilesLoaded(true);
    }
  }, [matterId]);

  // Upload a file straight into the matter's OneDrive folder, then run it through
  // the same log-and-maybe-notify pipeline (the upload is the "file changed" event).
  const fileInputRef = useRef<HTMLInputElement>(null);
  async function uploadFile(file: File) {
    const contentBase64 = await new Promise<string>((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => rej(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
    const r = await run(`Uploading ${file.name}`, async () => {
      requireMatter();
      return api<{ drafted: boolean; draftSubject: string | null; reason: string | null }>(
        `/matters/${matterId}/files/upload`,
        { method: 'POST', body: JSON.stringify({ fileName: file.name, contentBase64, mimeType: file.type || undefined }) }
      );
    });
    if (!r) return;
    setStatus(
      r.drafted
        ? `Uploaded — tracker updated and a draft created in Outlook: “${r.draftSubject}”.`
        : `Uploaded and logged to the tracker.${r.reason ? ' ' + r.reason : ''}`
    );
    loadFiles();
  }

  // Attach a case file to a reply on the current thread — reuses an existing draft
  // reply if there is one, else creates a reply to the most recent email. Never sends.
  async function attachToReply(f: FileItem) {
    if (!matterId || !conversationId) return;
    setAttachingId(f.id);
    try {
      const r = await api<{ reused: boolean; fileName: string }>(`/matters/${matterId}/files/attach-to-reply`, {
        method: 'POST',
        body: JSON.stringify({ fileId: f.id, fileName: f.name, mimeType: f.mimeType || undefined, conversationId }),
      });
      setStatus(
        r.reused
          ? `Attached “${f.name}” to your existing draft reply.`
          : `Attached “${f.name}” to a new draft reply in Outlook.`
      );
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setAttachingId(null);
    }
  }

  // A workflow with a Delegate/Notify step needs a target chosen at run time. If so,
  // open the inputs form; otherwise run straight away.
  function runPlaybookFor(p: { id: string; name: string; steps?: any[] }) {
    const steps = p.steps ?? [];
    const needsDelegate = steps.some((s: any) => s.type === 'DELEGATE');
    const needsNotify = steps.some((s: any) => s.type === 'NOTIFY');
    if (needsDelegate || needsNotify) {
      const client = (matterInfo?.contacts ?? []).find((c: any) => c.role === 'CLIENT');
      setPbInputs({
        p,
        needsDelegate,
        needsNotify,
        delegateToUserId: assignees[0]?.id ?? '',
        notifyEmail: client?.email ?? '',
        notifyName: client?.name ?? '',
      });
      return;
    }
    doRunPlaybook(p, {});
  }

  // Run-all-then-review: nothing sends.
  async function doRunPlaybook(p: { id: string; name: string }, inputs: Record<string, string | undefined>) {
    setRunningPb(p.id);
    setPbResults(null);
    setPbInputs(null);
    try {
      const r = await api<{ matterId: string | null; results: Array<{ type: string; ok: boolean; detail: string }> }>(
        `/playbooks/${p.id}/run`,
        {
          method: 'POST',
          body: JSON.stringify({
            messageId: messageId || undefined,
            conversationId: conversationId || undefined,
            subject: subject || undefined,
            matterId: matterId || undefined,
            inputs,
          }),
        }
      );
      setPbResults({ name: p.name, results: r.results });
      if (r.matterId && r.matterId !== matterId) {
        setMatterId(r.matterId);
        await loadMatter(r.matterId);
      }
      loadFiles();
      loadTasks();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setRunningPb(null);
    }
  }

  function confirmRunInputs() {
    if (!pbInputs) return;
    const a = assignees.find((x) => x.id === pbInputs.delegateToUserId);
    doRunPlaybook(pbInputs.p, {
      delegateToUserId: pbInputs.needsDelegate ? pbInputs.delegateToUserId || undefined : undefined,
      delegateToEmail: pbInputs.needsDelegate ? a?.email : undefined,
      delegateToName: pbInputs.needsDelegate ? a?.display_name || a?.email : undefined,
      notifyEmail: pbInputs.needsNotify ? pbInputs.notifyEmail.trim() || undefined : undefined,
      notifyName: pbInputs.needsNotify ? pbInputs.notifyName.trim() || undefined : undefined,
    });
  }

  // One-off Delegate / Notify actions (single workflow step, no saved workflow).
  function openQuick(type: 'DELEGATE' | 'NOTIFY') {
    const client = (matterInfo?.contacts ?? []).find((c: any) => c.role === 'CLIENT');
    setPbResults(null);
    setQuick({ type, delegateToUserId: assignees[0]?.id ?? '', notifyEmail: client?.email ?? '', notifyName: client?.name ?? '', notifyCustom: false });
  }
  async function runQuick() {
    if (!quick) return;
    setRunningPb('quick');
    const a = assignees.find((x) => x.id === quick.delegateToUserId);
    const inputs =
      quick.type === 'DELEGATE'
        ? { delegateToUserId: quick.delegateToUserId, delegateToEmail: a?.email, delegateToName: a?.display_name || a?.email }
        : { notifyEmail: quick.notifyEmail.trim(), notifyName: quick.notifyName.trim() || undefined };
    setQuick(null);
    try {
      const r = await api<{ results: Array<{ type: string; ok: boolean; detail: string }> }>('/playbooks/run-step', {
        method: 'POST',
        body: JSON.stringify({
          step: { type: quick.type, config: {} },
          messageId: messageId || undefined,
          conversationId: conversationId || undefined,
          subject: subject || undefined,
          matterId: matterId || undefined,
          inputs,
        }),
      });
      setPbResults({ name: quick.type === 'DELEGATE' ? 'Delegate' : 'Notify', results: r.results });
      loadTasks();
      loadMatter();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setRunningPb(null);
    }
  }

  const loadTemplates = useCallback(async (mid = matterId) => {
    if (!mid) return;
    setTemplatesLoading(true);
    try {
      const r = await api<{ templates: MatterTemplate[]; isPremium: boolean }>(`/matters/${mid}/doc-pack`);
      setTemplates(r.templates ?? []);
      setTemplatesPremium(!!r.isPremium);
    } catch {
      /* no templates configured yet — leave the list empty */
    } finally {
      setTemplatesLoading(false);
      setTemplatesLoaded(true);
    }
  }, [matterId]);

  // Fill a template with this matter's data and save it into the OneDrive folder,
  // so it shows up under Case files. If the name clashes, confirm before overwriting.
  async function generateTemplate(tpl: MatterTemplate, overwrite = false) {
    if (!matterId) return;
    setGenTemplateId(tpl.id);
    try {
      // Raw fetch (not api()) so we can read the 409 conflict body — but we must
      // still send the bearer token, since desktop Outlook doesn't share the cookie.
      const token = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
      const res = await fetch(`/api/v1/matters/${matterId}/doc-pack`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ templateId: tpl.id, overwrite }),
      });
      if (res.status === 409) {
        const j = (await res.json().catch(() => ({}))) as { fileName?: string };
        const name = j.fileName ?? `${tpl.name}.docx`;
        if (window.confirm(`“${name}” already exists in Case files. Overwrite it with a freshly generated copy?`)) {
          setGenTemplateId(null);
          return generateTemplate(tpl, true);
        }
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus((j as any).error || `Couldn’t generate “${tpl.name}” (HTTP ${res.status}).`);
        return;
      }
      setStatus(
        (j as any).capped
          ? `Generated “${(j as any).file?.name ?? tpl.name}” — but you’ve hit your Pro monthly AI limit, so the AI sections were left blank. Upgrade to Firm for uncapped AI.`
          : `Generated “${(j as any).file?.name ?? tpl.name}” — saved to Case files.`
      );
      await loadFiles();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setGenTemplateId(null);
    }
  }

  // ── Assistant + tasks ────────────────────────────────────────────────────
  // `matterOverride` lets a just-linked matter be read immediately, before the
  // matterId state update has flushed (the auto-run uses the current state).
  async function runAssist(matterOverride?: string) {
    const mid = matterOverride ?? matterId;
    const pollKey = messageId;
    assistPollRef.current = pollKey; // cancels any in-flight poll for a prior email
    setAssistError(false);
    // Watchdog every /assist call: a request stalled in the Office webview would
    // otherwise leave the "Reading the email…" toast hanging forever. Abort after
    // 30s so the toast clears and the panel can show a retry.
    const call = async (): Promise<AssistData> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      try {
        return await api<AssistData>('/assist', {
          method: 'POST',
          signal: ctrl.signal,
          // Omit tone so the response matches the precomputed cache; tone-specific
          // redrafts go through the dedicated draft-reply path.
          body: JSON.stringify({ messageId, conversationId, matterId: mid || undefined }),
        });
      } finally {
        clearTimeout(t);
      }
    };

    // The first call returns fast — either the cached full result or just the
    // fast half — so the spinner clears quickly and the situation shows at once.
    const first = await run('Reading the email', async () => {
      requireThread();
      if (!messageId) throw new Error('Open an email first.');
      return call();
    });
    if (!first) {
      // Only surface the error when the email is still the one we tried to read —
      // a fast switch to another message shouldn't flash a stale failure.
      if (assistPollRef.current === pollKey) setAssistError(true);
      return;
    }
    // Hit the monthly email cap → show the time-saving + upgrade nudge, don't analyse.
    if ((first as any).overQuota) {
      if (assistPollRef.current === pollKey) {
        setQuotaModal({ used: (first as any).emailsUsed ?? 0, cap: (first as any).emailsCap ?? 0, hoursSaved: (first as any).hoursSavedThisMonth ?? 0 });
        setAssistError(true);
      }
      return;
    }
    setAssist(first);
    if (first.matter && !mid) {
      setMatterId(first.matter.id);
      loadMatter(first.matter.id);
    }

    // Slow half (summary + draft) not ready yet → poll quietly until it lands,
    // updating the panel in place. No blocking spinner; placeholders fill in.
    let current = first;
    let tries = 0;
    while (!current.ready && assistPollRef.current === pollKey && tries < 40) {
      await new Promise((res) => setTimeout(res, 1500));
      if (assistPollRef.current !== pollKey) return; // a newer email took over
      tries++;
      try {
        const next = await call();
        if (assistPollRef.current !== pollKey) return;
        setAssist(next);
        current = next;
      } catch {
        /* transient — keep polling */
      }
    }
  }

  // Clicking Reply creates an actual draft reply in Outlook (never sent): use the
  // precomputed draft if ready, otherwise generate one (which also reviews any
  // attachments against the case), then write it straight to Outlook's drafts.
  // Writes the reply straight into the Outlook draft — no in-pane preview. The first
  // call reuses the cached assist draft (instant); `regen` forces a fresh draft with
  // the current tone + guidance, which create-draft folds into the SAME Outlook draft.
  async function openReply(opts: { regen?: boolean; auto?: boolean } = {}) {
    setReplyFailed(false);
    // Watchdog: drafting goes through the LLM + Graph, so bound it. If it stalls,
    // abort the request so the spinner releases and the panel offers a retry rather
    // than spinning forever.
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), 40000);
    const done = await run(opts.regen ? REPLY_BUSY_REGEN : REPLY_BUSY_CREATE, async () => {
      requireThread();
      if (!messageId) throw new Error('Open an email first.');
      let subject = opts.regen ? undefined : assist?.draft?.subject;
      let bodyHtml = opts.regen ? undefined : assist?.draft?.bodyHtml;
      if (!bodyHtml) {
        const g = await api<DraftPackage>(`/threads/${encodeURIComponent(conversationId)}/draft-reply`, {
          method: 'POST',
          signal: ctrl.signal,
          body: JSON.stringify({ matterId: matterId || undefined, messageId, conversationId, tone, guidance: guidance.trim() || undefined }),
        });
        subject = g.subject;
        bodyHtml = g.bodyHtml;
      }
      const r = await api<{ draftId: string; webLink?: string | null; subject: string; bodyHtml: string; reused?: boolean }>(
        `/threads/${encodeURIComponent(conversationId)}/create-draft`,
        {
          method: 'POST',
          signal: ctrl.signal,
          // Auto draft-on-open: if a draft already exists, leave it as-is (don't
          // overwrite the user's edits, and don't claim we generated anything).
          body: JSON.stringify({ matterId: matterId || undefined, messageId, subject, bodyHtml, skipIfExists: opts.auto || undefined }),
        }
      );
      setReplyReady(true);
      setDraftId(r.draftId ?? null);
      // The auto draft-on-open is a background action — the green panel state says it
      // all, so stay quiet (and never toast when an existing draft was left untouched).
      if (!opts.auto && !r.reused) {
        setStatus(opts.regen ? 'Reply draft updated.' : 'Reply drafted.');
      }
      // NB: we deliberately do NOT file (move) the email here. The reply is only a
      // draft, and auto-drafting fires on open — filing here moved the source email
      // out of the inbox, so it appeared to vanish. Filing stays a deliberate action.
      return true;
    });
    clearTimeout(watchdog);
    if (!done) setReplyFailed(true);
  }

  // Send the reviewed draft straight from the pane. Human-in-the-loop: the user clicked
  // Send. The server refuses anything that isn't a draft, so it can only fire once.
  async function sendReply() {
    // No window.confirm here: Outlook add-in webviews don't reliably support it (it can
    // return undefined and silently block the send). The explicit Send click is the intent.
    if (!draftId) { setStatus('No draft to send yet — draft the reply first.'); return; }
    await run(REPLY_BUSY_SEND, async () => {
      await api('/worklist/send', { method: 'POST', body: JSON.stringify({ messageId: draftId }) });
      setStatus('Reply sent.');
      setReplySent(true); // show a "sent" confirmation, don't fall back to the drafter
      setReplyReady(false);
      setDraftId(null);
      return true;
    });
  }

  const loadTasks = useCallback(async (mid = matterId) => {
    if (!mid) return;
    try {
      const r = await api<{ tasks: MatterTask[]; assignees: Assignee[] }>(`/matters/${mid}/tasks`);
      setTasks(r.tasks ?? []);
      setAssignees(r.assignees ?? []);
    } catch {
      /* board is best-effort; a tracker read hiccup shouldn't break the pane */
    }
  }, [matterId]);

  useEffect(() => {
    if (matterId) loadTasks(matterId);
  }, [matterId, loadTasks]);

  const [newTask, setNewTask] = useState('');
  const [taskBusy, setTaskBusy] = useState('');
  async function setTaskStatus(taskId: string, status: 'OPEN' | 'DONE') {
    if (!matterId) return;
    setTaskBusy(taskId);
    try {
      await api(`/matters/${matterId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await loadTasks(matterId);
    } catch { /* best-effort */ } finally { setTaskBusy(''); }
  }
  async function addTask() {
    const detail = newTask.trim();
    if (!detail || !matterId) return;
    setTaskBusy('new');
    try {
      await api(`/matters/${matterId}/tasks`, { method: 'POST', body: JSON.stringify({ detail }) });
      setNewTask('');
      await loadTasks(matterId);
    } catch { /* best-effort */ } finally { setTaskBusy(''); }
  }

  // Delegate to a colleague: assign it on the Excel tracker AND draft a forward of
  // the email to them with instructions (draft only, never sent). Both effects are
  // best-effort independent so a Graph hiccup on the forward still books the task.
  // The setup state: shown automatically until the firm has imported (or skipped),
  // while a scan is running/awaiting review, or whenever re-opened via the gear.
  const onboardingBusy = !!obJob && (OB_ACTIVE.includes(obJob.status) || obJob.status === 'AWAITING_REVIEW');
  const setupView = !!me && (showSetup || onboardingBusy || (obFetched && !obJob && !obSkipped));

  // ── What did we find? ──────────────────────────────────────────────────────
  // The hero is a single status the moment an email opens: do we know whose
  // matter this is? `band` comes from the matcher (AUTO = nailed it, STRONG/WEAK
  // = a guess to confirm, NONE = nothing). A linked matter always counts as found.
  const hasMatter = !!matterId;
  // A manual "search again" (triage) is the freshest signal when present; the
  // auto-analysis (assist) is the default the moment an email opens.
  const band: string | null = triage?.band ?? assist?.matchBand ?? null;
  const candidates: any[] = (triage?.candidates ?? assist?.candidates ?? []) as any[];
  const topCandidate = candidates[0];
  // The currently-linked matter's ref/address, for the drawer's confirm view.
  const linkedCandidate = candidates.find((c: any) => c.matterId === matterId);
  const linkedRef = matterInfo?.matter?.matter_ref ?? linkedCandidate?.matterRef ?? assist?.matter?.matterRef ?? null;
  const linkedAddr = matterInfo?.matter?.property_address ?? linkedCandidate?.propertyAddress ?? assist?.matter?.propertyAddress ?? null;
  const analysed = !!assist || !!triage;
  const matchKind: 'found' | 'partial' | 'none' | 'pending' =
    hasMatter || band === 'AUTO' ? 'found' : band === 'STRONG' || band === 'WEAK' ? 'partial' : analysed ? 'none' : 'pending';
  // The hero is always expandable; the drawer is purely user-controlled. We
  // auto-open it once per email when there's no matter (the only state with
  // nothing else to act on) — but the user can still collapse it.
  const drawerOpen = linkOpen;
  const autoOpenedFor = useRef('');
  useEffect(() => {
    if (matchKind === 'none' && autoOpenedFor.current !== messageId) {
      autoOpenedFor.current = messageId;
      setLinkOpen(true);
    }
  }, [matchKind, messageId]);
  // Back to the compact confirm view whenever the linked matter or email changes.
  useEffect(() => {
    setChanging(false);
    setMatterSearch('');
    setMatterResults([]);
  }, [matterId, messageId]);

  // While the chooser is open, search the firm's matters (debounced). An empty
  // query returns recent matters, so the list is useful the moment it opens.
  const choosing = drawerOpen && (changing || !matterId);
  useEffect(() => {
    if (!choosing) return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ matters: Array<{ id: string; matterRef: string; propertyAddress: string }> }>(
          `/matters?q=${encodeURIComponent(matterSearch.trim())}`
        );
        setMatterResults(r.matters ?? []);
      } catch {
        setMatterResults([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [choosing, matterSearch]);

  // Once we know the matter, an incoming email only ever resolves one of four
  // ways. We surface all four and pre-light the one the classifier implies:
  // a pure FYI → Ignore; anything that wants a response → Reply; otherwise it's
  // work to do (Action) or to hand off (Delegate).
  const cls = assist?.classification;
  const recommended: 'reply' | 'action' | 'ignore' = !cls
    ? 'reply'
    : cls.needsAttention === false
    ? 'ignore'
    : assist?.draft
    ? 'reply'
    : (assist?.outstanding?.length ?? 0) > 0
    ? 'action'
    : 'action';
  // The panel that's expanded: the user's explicit pick, else the recommendation.
  const effectiveAction = chosenAction ?? recommended;

  // When the Action panel is shown, ask the assistant which workflow fits this
  // email (once per email). Lazy so we only spend the call when it's relevant.
  useEffect(() => {
    if (effectiveAction !== 'action' || !messageId || !conversationId || playbooks.length === 0) return;
    if (suggestedFor.current === messageId) return;
    suggestedFor.current = messageId;
    setPbSuggestion(null);
    api<{ playbookId: string | null; reason: string }>('/playbooks/suggest', {
      method: 'POST',
      body: JSON.stringify({ messageId, conversationId, subject: subject || undefined }),
    })
      .then((r) => { if (r.playbookId) setPbSuggestion({ playbookId: r.playbookId, reason: r.reason }); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAction, messageId, conversationId, playbooks.length]);

  // When Reply is the recommended move, auto-draft it into the Outlook message as
  // soon as analysis is ready — once per email. openReply uses the cached draft when
  // present, otherwise generates one; the panel shows a spinner the whole time.
  useEffect(() => {
    if (recommended !== 'reply' || !assist?.ready || !messageId || !conversationId) return;
    // `busy` is in the deps so that if another action (e.g. loadMatter) is mid-flight
    // when analysis lands, this re-runs and fires once that clears — otherwise the
    // panel hangs on "Preparing the reply…" forever.
    if (autoRepliedFor.current === messageId || replyReady || replySent || busy) return;
    autoRepliedFor.current = messageId;
    openReply({ auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommended, assist?.ready, messageId, conversationId, replyReady, busy]);

  // Log the move the user picked — analytics only, never blocks the UI. This is
  // the only footprint some moves leave (esp. Ignore, and Delegate before a task
  // exists), so the label-vs-action picture in v_email_journey stays complete.
  function recordAction(action: 'reply' | 'action' | 'ignore') {
    if (!messageId) return;
    api('/triage/action', {
      method: 'POST',
      body: JSON.stringify({ messageId, conversationId: conversationId || undefined, matterId: matterId || undefined, action }),
    }).catch(() => {});
  }

  // The inbox is an in-tray: once the user has actioned an email (replied,
  // updated, delegated, marked handled) we file it into its matter's Outlook
  // subfolder to clear it. Fire-and-forget; no-ops without a matter/folder.
  function fileCurrentEmail() {
    if (!matterId || !messageId) return;
    api(`/matters/${matterId}/file-email`, { method: 'POST', body: JSON.stringify({ messageId }) }).catch(() => {});
  }

  // Draft a fresh outbound update to a specific party on the matter (not a reply
  // to the sender) and create it as an Outlook draft addressed to them.
  // "Ignore" needs no other backend — the email's been read, there's just nothing
  // to do — but we still record the decision (above) so it isn't invisible.
  function markIgnore() {
    setIgnored(true);
    setChosenAction('ignore');
    recordAction('ignore');
    fileCurrentEmail();
    setStatus('Marked as handled — no reply needed.');
  }

  // Auto-analyse the moment a message is opened (once per message). This is what
  // makes the hero meaningful on arrival and lets the assistant "read the email
  // in context and decide" without the user pressing anything.
  const autoAnalysed = useRef<string>('');
  useEffect(() => {
    if (!me || setupView || !messageId || !conversationId) return;
    if (autoAnalysed.current === messageId) return;
    autoAnalysed.current = messageId;
    runAssist();
    // runAssist is stable enough for this purpose; keying on the message id is
    // what actually gates re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, setupView, messageId, conversationId]);

  // House & Files only make sense with a linked matter — fall back to Email when
  // there isn't one so those tabs never show an empty pane.
  useEffect(() => {
    if (!matterId && tab !== 'email') setTab('email');
  }, [matterId, tab]);

  // Preload the matter's case files & templates as soon as an email is matched to
  // a matter — not when the Files tab is opened — so the tab is ready instantly.
  // Runs asynchronously in the background; the panels show a spinner until done.
  useEffect(() => {
    if (!matterId) {
      setFilesLoaded(false);
      setTemplatesLoaded(false);
      setFiles([]);
      setTemplates([]);
      return;
    }
    setFilesLoaded(false);
    setTemplatesLoaded(false);
    setRecon(null);
    loadFiles(matterId);
    loadTemplates(matterId);
  }, [matterId, loadFiles, loadTemplates]);

  // ── UI ───────────────────────────────────────────────────────────────────
  // Boxed out: signed in, but the subscription/trial has lapsed. A full-pane
  // paywall covers everything; the server also 402s the cost routes as a backstop.
  const reconTh: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#64748b', fontWeight: 700, fontSize: 11, borderBottom: '1px solid #e2e8f0' };
  const reconTd: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top', color: '#334155' };
  const boxedOut = !!(me && plan && plan.entitled === false);
  const boxedMsg =
    plan?.status === 'past_due'
      ? 'Your last payment failed. Update your card to keep using CONVEYi.'
      : 'Your trial has ended. Subscribe to keep using CONVEYi — your matters and data are safe.';

  return (
    <div style={S.page}>
      <style>{`@keyframes cl-spin{to{transform:rotate(360deg)}}`}</style>
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {me && (
            <button
              style={{ ...S.iconBtn, color: homeView && !setupView ? '#5A27E0' : '#64748b', background: homeView && !setupView ? '#EDE7FB' : 'transparent' }}
              onClick={() => { if (showSetup) { setShowSetup(false); setHomeView(true); } else setHomeView((h) => !h); }}
              title={homeView ? 'Back to this email' : 'What needs me — the worklist'}
              aria-label={homeView ? 'Back to this email' : 'Open worklist'}
            >
              {homeView && messageId ? (
                // an email is open behind us — offer a clear way back
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                  <circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" />
                </svg>
              )}
            </button>
          )}
          {me && (
            <button
              style={{ ...S.iconBtn, color: showSetup ? '#5A27E0' : '#64748b', background: showSetup ? '#EDE7FB' : 'transparent' }}
              onClick={() => setShowSetup((s) => !s)}
              title="Setup & settings"
              aria-label="Setup & settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          {me && (
            <button
              style={{ ...S.iconBtn, color: '#64748b' }}
              onClick={openReferral}
              title="Refer a firm, earn credit"
              aria-label="Refer a firm, earn credit"
            >
              <Icon name="gift" size={18} />
            </button>
          )}
        </div>
        {me ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {plan && (
              <span style={S.planBadge}>
                {plan.plan === 'enterprise'
                  ? 'Firm'
                  : plan.plan === 'pro'
                  ? 'Pro'
                  : plan.plan === 'plus'
                  ? 'Solo'
                  : plan.status === 'trialing'
                  ? 'Trial'
                  : 'Free'}
              </span>
            )}
            <button style={{ ...S.iconBtn, color: '#64748b' }} onClick={() => openAdmin('billing')} title={`${me.displayName || me.email} — account & billing`} aria-label="Account & billing">
              <Icon name="user" size={18} />
            </button>
            <button style={{ ...S.iconBtn, color: '#64748b' }} onClick={signOut} title={`Sign out (${me.email})`} aria-label="Sign out">
              <Icon name="logout" size={18} />
            </button>
          </div>
        ) : (
          <span style={S.user}>{booting ? 'Connecting…' : connError ? 'Can’t reach server' : 'Not connected'}</span>
        )}
      </header>

      {boxedOut && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(255,255,255,0.97)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ maxWidth: 320, textAlign: 'center' }}>
            <div style={{ fontSize: 34, marginBottom: 8 }} aria-hidden>🔒</div>
            <h2 style={{ fontSize: 18, margin: '0 0 6px', color: '#0f172a' }}>
              {plan?.status === 'past_due' ? 'Payment needed' : 'Trial ended'}
            </h2>
            <p style={{ fontSize: 13, color: '#475569', margin: '0 0 16px', lineHeight: 1.5 }}>{boxedMsg}</p>
            <button
              style={{ ...S.primary, marginTop: 0 }}
              onClick={() => openAdmin('billing')}
            >
              {plan?.status === 'past_due' ? 'Update payment' : 'Choose a plan'}
            </button>
            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
              Opens your billing page in the browser. Nothing in your mailbox or cases is touched.
            </p>
          </div>
        </div>
      )}

      {!me && (
        <Card>
          {booting ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={S.spinner} />
              <span style={S.user}>Connecting to Outlook…</span>
            </div>
          ) : connError ? (
            <>
              <p style={S.muted}>Can’t reach CaseLightning right now — this is usually temporary.</p>
              <button style={S.secondary} onClick={refreshMe}>Retry</button>
            </>
          ) : (
            <>
              <button style={S.primary} onClick={() => connect()}>
                Connect Outlook
              </button>
              {/* Escape hatch: if a scope was added or consent went stale, a normal connect
                  can silently fail — this forces the Microsoft consent screen. */}
              <button
                onClick={() => connect({ consent: true })}
                style={{ display: 'block', margin: '10px auto 0', background: 'none', border: 'none', color: '#5A27E0', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Trouble connecting? Reconnect with fresh permissions
              </button>
            </>
          )}
        </Card>
      )}

      {/* First run: bring the firm's existing cases in before anything else. */}
      {me && !setupView && (
        <>
          {/* ── Hero: one compact status pill — a coloured dot (green = certain,
                amber = unsure, red = none/error), the matter name, and an expand
                arrow. Always tappable to open the link/create drawer. ── */}
          {!homeView && (() => {
            const ref = matterInfo?.matter?.matter_ref ?? assist?.matter?.matterRef ?? topCandidate?.matterRef ?? null;
            const meta: Record<typeof matchKind, { icon: string; dot: string; name: string; style: React.CSSProperties }> = {
              found: { icon: '✓', dot: '#16a34a', name: ref || 'Matter found', style: S.heroFound },
              partial: { icon: '!', dot: '#f59e0b', name: ref || 'Unconfirmed match', style: S.heroPartial },
              none: { icon: '!', dot: '#dc2626', name: 'No matter found', style: S.heroNone },
              pending: assistError
                ? { icon: '!', dot: '#dc2626', name: 'Couldn’t read this email', style: S.heroNone }
                : { icon: '', dot: '#94a3b8', name: messageId ? 'Reading this email…' : 'Open an email', style: S.heroPending },
            };
            const m = meta[matchKind];
            const showSpinner = matchKind === 'pending' && !assistError;
            return (
              <button
                style={{ ...S.hero, ...m.style, ...(drawerOpen ? S.heroOpen : null) }}
                onClick={() => setLinkOpen((o) => !o)}
                title="Show matter options"
                aria-expanded={drawerOpen}
              >
                <span style={{ ...S.statusDot, background: m.dot }}>
                  {showSpinner ? <span style={S.spinnerLight} /> : m.icon}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 13, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.name}
                </span>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ flex: 'none', opacity: 0.8, transform: drawerOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            );
          })()}

          {/* Analysis failed — give the spinner an exit instead of spinning forever. */}
          {!homeView && messageId && assistError && (
            <Card>
              <p style={S.muted}>We couldn’t finish reading this email. It may have been a temporary hiccup.</p>
              <button style={S.secondary} onClick={() => runAssist()}>Try again</button>
            </Card>
          )}

          {/* The worklist — shown when no email is open, or on demand via the header
              worklist button (homeView) even while an email is selected. */}
          {(homeView || !messageId) && !assistError && (
            <>
              {/* Canonical worklist — the "what needs me today" list, no email required.
                  Two buckets: drafts CONVEYi prepared (replies + doc-received acks) that are
                  ready to send, and matters that have gone quiet and need chasing. */}
              {/* Admins can always filter the queue by fee earner — "Anyone" is the whole
                  firm. Gate on me.role (reliable, from /me) rather than wlMeta.isAdmin, which
                  is only set when /worklist itself succeeds — so the control shows even if the
                  list call hiccups. Regardless of plan/tasks/headcount. */}
              {me?.role === 'ADMIN' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#7A7388', flex: 'none' }}>Assigned to</span>
                  <select
                    value={wlMeta.assignee}
                    onChange={(e) => reloadWorklist(e.target.value)}
                    style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, padding: '6px 8px', borderRadius: 8, border: '1px solid #D9D2EC', background: '#fff', color: '#1C1530', cursor: 'pointer' }}
                    title="Filter the worklist by who owns the matter"
                  >
                    <option value="">Anyone</option>
                    {teamMembers.map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name || m.email}</option>
                    ))}
                  </select>
                </div>
              )}
              {(() => {
                const base = worklist ?? [];
                // 'smart' keeps the server's urgency ranking. 'due' floats nearest deadlines
                // (task due or exchange/completion) to the top. 'matter' groups by case.
                const deadlineMs = (w: WorklistEntry) => {
                  const d = w.due ? new Date(w.due).getTime() : w.keyDate ? new Date(w.keyDate).getTime() : NaN;
                  return Number.isNaN(d) ? Infinity : d;
                };
                const items =
                  wlSort === 'smart'
                    ? base
                    : [...base].sort((a, b) =>
                        wlSort === 'due'
                          ? deadlineMs(a) - deadlineMs(b)
                          : (a.matterRef || '').localeCompare(b.matterRef || '') || a.ageDays - b.ageDays
                      );
                const row = (w: WorklistEntry) => (
                  <div
                    key={w.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + (w.urgent ? '#fecaca' : '#ECE7F8'), borderRadius: 10, background: w.urgent ? '#fff7f7' : '#FBFAFF' }}
                  >
                    <span
                      style={{ flex: 'none', minWidth: 34, textAlign: 'center', fontSize: 11, fontWeight: 700, color: w.ageDays >= 10 ? '#dc2626' : w.ageDays >= 5 ? '#d97706' : '#64748b' }}
                      title={`${w.ageDays} days`}
                    >
                      {w.ageDays}d
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, ...(w.kind === 'CHASE' ? { color: '#b45309', background: '#fef3c7' } : w.kind === 'TASK' ? { color: '#475569', background: '#e2e8f0' } : { color: '#5A27E0', background: '#ede9fe' }), borderRadius: 999, padding: '0 6px', flex: 'none' }}>
                          {w.kind === 'CHASE' ? 'Chase' : w.kind === 'TASK' ? 'To do' : 'Send'}
                        </span>
                        {w.urgent && w.keyDate && (
                          <span title="Exchange/completion target" style={{ fontSize: 10, fontWeight: 700, color: '#b91c1c', background: '#fee2e2', borderRadius: 999, padding: '0 6px', flex: 'none', whiteSpace: 'nowrap' }}>
                            🎯 {new Date(w.keyDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </span>
                        )}
                        {w.kind === 'TASK' && w.due && (
                          <span title="Task due" style={{ fontSize: 10, fontWeight: 700, ...(w.urgent ? { color: '#b91c1c', background: '#fee2e2' } : { color: '#475569', background: '#e2e8f0' }), borderRadius: 999, padding: '0 6px', flex: 'none', whiteSpace: 'nowrap' }}>
                            📅 {new Date(w.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </span>
                        )}
                        <strong style={{ fontSize: 12.5, color: '#1C1530', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {w.matterRef}{w.propertyAddress ? ` · ${w.propertyAddress}` : ''}
                        </strong>
                      </span>
                      <span style={{ display: 'block', fontSize: 11.5, color: '#7A7388', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                        {w.detail || w.title}
                      </span>
                    </span>
                    {(() => {
                      const primary: React.CSSProperties = { flex: 'none', fontSize: 11, fontWeight: 700, padding: '5px 10px', border: 'none', borderRadius: 8, background: '#5A27E0', color: '#fff', cursor: 'pointer' };
                      const ghost: React.CSSProperties = { flex: 'none', fontSize: 11, fontWeight: 600, padding: '5px 8px', border: '1px solid #D9D2EC', borderRadius: 8, background: '#fff', color: '#7A7388', cursor: 'pointer' };
                      const busy = wlBusy === w.id;
                      // TASK: a matter to-do → tick it off (mirrors out to Excel / To Do).
                      if (w.kind === 'TASK') {
                        return (
                          <button style={{ ...ghost, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => worklistAction(w, 'done')} title="Mark this task done">
                            {busy ? '…' : '✓ Done'}
                          </button>
                        );
                      }
                      // DRAFT_READY: it's already written → Send in one click.
                      if (w.kind === 'DRAFT_READY') {
                        return (
                          <>
                            {w.graphMessageId && (
                              <button style={{ ...primary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => sendWorklistDraft(w, w.graphMessageId!)} title="Send this reviewed draft now">
                                {busy ? '…' : 'Send'}
                              </button>
                            )}
                            <button style={ghost} disabled={busy} onClick={() => worklistAction(w, 'dismiss')} title="Mark done (handled another way)">Done</button>
                          </>
                        );
                      }
                      // CHASE: draft the chaser for you, then it becomes Send.
                      const drafted = wlChaser[w.id];
                      if (typeof drafted === 'string') {
                        return (
                          <>
                            <button style={{ ...primary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => sendWorklistDraft(w, drafted)} title="Send the chaser now">{busy ? '…' : 'Send'}</button>
                            <button style={ghost} disabled={busy} onClick={() => worklistAction(w, 'snooze')} title="Hide for a week">Snooze</button>
                          </>
                        );
                      }
                      return (
                        <>
                          <button style={{ ...primary, opacity: drafted === 'busy' ? 0.6 : 1 }} disabled={drafted === 'busy'} onClick={() => draftWorklistChaser(w)} title="Draft a chase-up for you">
                            {drafted === 'busy' ? '…' : 'Draft chaser'}
                          </button>
                          <button style={ghost} disabled={busy} onClick={() => worklistAction(w, 'snooze')} title="Hide for a week (e.g. already chased by phone)">Snooze</button>
                        </>
                      );
                    })()}
                  </div>
                );
                if (items.length === 0) {
                  const who = wlMeta.assignee ? teamMembers.find((m) => m.id === wlMeta.assignee) : null;
                  const whoName = who ? who.display_name || who.email : null;
                  return (
                    <Card>
                      <Label>What needs you</Label>
                      <p style={{ ...S.muted, margin: '6px 0 0' }}>
                        {worklist === null
                          ? 'Loading your worklist…'
                          : whoName
                          ? `Nothing needs ${whoName} right now. Switch “Assigned to” to Anyone (or another person) to see the rest.`
                          : 'All caught up across the firm — no chases or ready-to-send drafts right now. New ones appear here automatically.'}
                      </p>
                    </Card>
                  );
                }
                return (
                  <>
                    <Card>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <Label>What needs you ({items.length})</Label>
                        <select
                          value={wlSort}
                          onChange={(e) => setWlSort(e.target.value as typeof wlSort)}
                          title="Sort the worklist"
                          style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, padding: '3px 6px', borderRadius: 7, border: '1px solid #D9D2EC', background: '#fff', color: '#5A27E0', cursor: 'pointer' }}
                        >
                          <option value="smart">Smart order</option>
                          <option value="due">By due date</option>
                          <option value="matter">By matter</option>
                        </select>
                      </div>
                      <p style={{ ...S.muted, margin: '0 0 8px' }}>
                        Chases, ready-to-send drafts and open tasks — everything on your plate.
                        {wlSort === 'smart' ? ' In priority order: soonest deadline first, then overdue chases.' : ''}
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{items.slice(0, 80).map(row)}</div>
                    </Card>
                    <p style={{ ...S.muted, fontSize: 11, margin: '-2px 2px 4px' }}>
                      📌 Tip: pin CONVEYi (the pin at the top of this pane) to keep this open as you work.
                    </p>
                  </>
                );
              })()}
              {!homeView && (
                <Card>
                  <button style={S.secondary} onClick={() => setShowSetup(true)}>Setup &amp; import existing cases</button>
                </Card>
              )}
            </>
          )}

          {/* Matter drawer — two states only: confirm the linked matter, or choose
              a different one (pick a candidate / create new). */}
          {!homeView && drawerOpen && (
            <div
              style={{
                ...S.matterDrawer,
                borderColor:
                  matchKind === 'found' ? '#86efac' : matchKind === 'partial' ? '#fde68a' : matchKind === 'none' ? '#fecaca' : '#e2e8f0',
              }}
            >
              {matterId && !changing ? (
                // Linked: show the matter, one way to change it.
                <>
                  <Label>Linked Matter</Label>
                  <div style={S.candidate}>
                    <strong style={{ fontSize: 13 }}>{linkedRef || 'This matter'}</strong>
                    {linkedAddr && <div style={{ fontSize: 12, color: '#475569' }}>{linkedAddr}</div>}
                  </div>
                  <button style={S.secondary} onClick={() => setChanging(true)}>Change matter</button>
                </>
              ) : (
                // Chooser: candidates to pick from, or create a new matter.
                <>
                  {/* While creating a new matter, collapse the RAG candidate
                      selection to a simple "New matter" header until the form
                      below is submitted (createMatter clears showNewMatter). */}
                  {showNewMatter ? (
                    <div style={{ ...S.candidate, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div>
                        <strong style={{ fontSize: 13 }}>New matter</strong>
                        <div style={{ fontSize: 12, color: '#64748b' }}>Complete the form below to create it.</div>
                      </div>
                      <button style={S.secondary} onClick={openNewMatter}>Cancel</button>
                    </div>
                  ) : (
                  <>
                  {candidates.length > 0 ? (
                    <>
                      <Label>Likely Matters</Label>
                      {candidates.map((c: any) => {
                        const pct = Math.round((c.score ?? 0) * 100);
                        const auto = c.band === 'AUTO';
                        const isLinked = c.matterId === matterId;
                        return (
                          <div key={c.matterId} style={S.candidate}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                              <strong style={{ fontSize: 13 }}>{c.matterRef}</strong>
                              <span style={{ ...S.confidence, background: auto ? '#dcfce7' : pct >= 60 ? '#fef9c3' : '#fee2e2' }}>
                                {pct}% match
                              </span>
                            </div>
                            <div style={{ fontSize: 12, color: '#475569' }}>{c.propertyAddress}</div>
                            <ul style={{ ...S.ul, fontSize: 11, color: '#64748b' }}>
                              {(c.signals ?? []).map((s: any, i: number) => <li key={i}>{s.detail}</li>)}
                            </ul>
                            {!auto && !isLinked && (
                              <label style={{ display: 'flex', gap: 6, fontSize: 11, color: '#b91c1c', margin: '4px 0' }}>
                                <input type="checkbox" checked={riskOk} onChange={(e) => setRiskOk(e.target.checked)} />
                                Use anyway — low-confidence match
                              </label>
                            )}
                            {isLinked ? (
                              <span style={{ fontSize: 11, fontWeight: 700, color: '#166534' }}>✓ Linked</span>
                            ) : (
                              <button style={S.secondary} onClick={() => useCandidate(c)} disabled={!auto && !riskOk}>
                                Use this
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </>
                  ) : (
                    <p style={{ ...S.muted, marginBottom: 8 }}>No suggested matter for this email.</p>
                  )}

                  <div style={S.rowWrap}>
                    <button style={!matterId ? S.primary : S.secondary} onClick={openNewMatter}>
                      + New matter
                    </button>
                    {matterId && (
                      <button style={S.secondary} onClick={() => setChanging(false)}>Keep current</button>
                    )}
                  </div>

                  {/* Link to any existing matter, including ones the matcher missed. */}
                  {(() => {
                    const others = matterResults.filter(
                      (m) => m.id !== matterId && !candidates.some((c: any) => c.matterId === m.id)
                    );
                    return (
                      <>
                        <SubLabel>Link a Different Matter</SubLabel>
                        <input
                          style={S.input}
                          placeholder="Search by reference or address…"
                          value={matterSearch}
                          onChange={(e) => setMatterSearch(e.target.value)}
                        />
                        {/* Cap the list at ~4 rows tall; the rest scrolls. Search narrows it. */}
                        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                          {others.map((m) => (
                            <div key={m.id} style={S.candidate}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                <div style={{ minWidth: 0 }}>
                                  <strong style={{ fontSize: 13 }}>{m.matterRef}</strong>
                                  {m.propertyAddress && (
                                    <div style={{ fontSize: 12, color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                      {m.propertyAddress}
                                    </div>
                                  )}
                                </div>
                                <button style={S.secondary} onClick={() => linkExistingMatter(m)} disabled={!conversationId}>
                                  Link
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                        {matterSearch.trim() && others.length === 0 && (
                          <p style={S.muted}>No matters match “{matterSearch.trim()}”.</p>
                        )}
                      </>
                    );
                  })()}
                  </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Tab bar + everything below is the per-email view — hidden in homeView so the
              worklist stands alone. The matter pill above is the fixed "which matter" anchor;
              these switch what we show for it. House/Files need a linked matter. */}
          {!homeView && (
          <>
          <div style={S.tabBar}>
            {([
              ['email', 'mail', 'Email'],
              ['house', 'home', 'House'],
              ['paperclip', 'clip', 'Files'],
            ] as const).map(([key, icon, lbl]) => {
              const active = tab === key;
              const locked = key !== 'email' && !hasMatter;
              return (
                <button
                  key={key}
                  style={{ ...S.tabBtn, ...(active ? S.tabBtnActive : {}), ...(locked ? S.tabBtnLocked : {}) }}
                  onClick={() => { if (!locked) setTab(key); }}
                  disabled={locked}
                  title={locked ? 'Link a matter first' : lbl}
                  aria-label={lbl}
                  aria-selected={active}
                >
                  <Icon name={icon} size={18} />
                </button>
              );
            })}
          </div>

          {/* ── EMAIL TAB — what this email is about + what we're doing about it ── */}
          {/* The situation + the four moves — only once we have a matter to act on. */}
          {tab === 'email' && hasMatter && assist && (
            <Card>
              <Label>Summary</Label>
              <p style={{ fontSize: 13, lineHeight: 1.5, color: '#0f172a', margin: '0 0 10px' }}>{assist.ask}</p>

              {/* The moves, as tabs. The recommended one is pre-lit; pick either to expand it. */}
              <div style={S.tabBar}>
                {([
                  ['reply', 'reply', 'Reply'],
                  ['action', 'check', 'Action'],
                ] as const).map(([key, icon, lbl]) => {
                  const active = effectiveAction === key;
                  const isRec = recommended === key;
                  return (
                    <button
                      key={key}
                      style={{ ...S.tabBtn, ...(active ? S.tabBtnActive : {}), position: 'relative' }}
                      aria-selected={active}
                      onClick={() => {
                        recordAction(key);
                        setChosenAction(key);
                        if (key === 'reply') openReply();
                      }}
                    >
                      <Icon name={icon} size={16} />
                      <span>{lbl}</span>
                      {isRec && <span style={{ ...S.recDot, top: 3, right: 6 }} title="Suggested" />}
                    </button>
                  );
                })}
              </div>

              {/* Reply — the draft lives in Outlook, never previewed here. This panel
                  is the control surface: status, tone, guidance and regenerate. */}
              {effectiveAction === 'reply' && (() => {
                const replying = busy === REPLY_BUSY_CREATE || busy === REPLY_BUSY_REGEN;
                // Once sent, the reply is done — a confirmation, not the drafter again.
                if (replySent) {
                  return (
                    <div style={S.actionPanel}>
                      <p style={{ margin: 0, fontSize: 13, color: '#166534', fontWeight: 700 }}>✓ Sent</p>
                      <p style={{ ...S.muted, margin: '4px 0 0' }}>You’re now waiting on a reply — I’ll surface this as a chase if it goes quiet. No need to nudge them yourself.</p>
                    </div>
                  );
                }
                return (
                  <div style={S.actionPanel}>
                    {replyReady && !replying ? (
                      <p style={{ margin: 0, fontSize: 12, color: '#166534', fontWeight: 600 }}>✓ Reply drafted — review below, then Send.</p>
                    ) : replying ? (
                      <p style={{ ...S.muted, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={S.spinner} /> Writing the draft into Outlook…
                      </p>
                    ) : replyFailed ? (
                      <p style={{ margin: 0, fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>Couldn’t draft the reply — try again below.</p>
                    ) : (recommended === 'reply' || (!assist.ready && !assist.draft)) ? (
                      <p style={{ ...S.muted, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={S.spinner} /> Preparing the reply…
                      </p>
                    ) : null}

                    <div style={{ marginTop: 10 }}>
                      <span style={S.updateLabel}>Add guidance</span>
                      <textarea
                        value={guidance}
                        onChange={(e) => setGuidance(e.target.value)}
                        placeholder="e.g. push for completion by Friday; mention the survey is attached"
                        style={{ ...S.input, marginTop: 4, marginBottom: 0, minHeight: 52, resize: 'vertical', fontFamily: 'inherit' }}
                      />
                    </div>

                    {replyReady ? (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button
                          style={{ ...S.secondary, flex: 1, marginTop: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onClick={() => openReply({ regen: true })}
                          disabled={!!busy}
                        >
                          {busy === REPLY_BUSY_REGEN ? <span style={S.spinner} /> : 'Regenerate'}
                        </button>
                        <button
                          style={{ ...S.primary, flex: 1, marginTop: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                          onClick={sendReply}
                          disabled={!!busy}
                        >
                          {busy === REPLY_BUSY_SEND ? <span style={S.spinnerLight} /> : 'Send'}
                        </button>
                      </div>
                    ) : (
                      <button
                        style={{ ...S.primary, marginTop: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                        onClick={() => openReply({ regen: !!guidance.trim() })}
                        disabled={replying}
                      >
                        {replying ? <span style={S.spinnerLight} /> : 'Draft reply'}
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Action — send a fresh update to a party on the matter. Data-driven
                  from the address book (one chip per real contact), so it stays
                  compact rather than a fixed grid of role buttons. */}
              {effectiveAction === 'action' && (
                <div style={S.actionPanel}>
                  {/* One-off actions */}
                  <span style={S.updateLabel}>Quick actions</span>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button style={S.quickAct} onClick={() => openQuick('DELEGATE')} disabled={!!runningPb}>
                      <Icon name="user" size={14} /> Delegate
                    </button>
                    <button style={S.quickAct} onClick={() => openQuick('NOTIFY')} disabled={!!runningPb}>
                      <Icon name="mail" size={14} /> Notify
                    </button>
                  </div>
                  {quick && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
                      {quick.type === 'DELEGATE' ? (
                        <label style={{ display: 'block', marginBottom: 6 }}>
                          <span style={S.fieldLabel}>Delegate To</span>
                          <select style={{ ...S.input, marginBottom: 0 }} value={quick.delegateToUserId} onChange={(e) => setQuick({ ...quick, delegateToUserId: e.target.value })}>
                            <option value="">Choose a team member…</option>
                            {assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
                          </select>
                        </label>
                      ) : (
                        <>
                          <label style={{ display: 'block', marginBottom: 6 }}>
                            <span style={S.fieldLabel}>Notify</span>
                            <select
                              style={{ ...S.input, marginBottom: 0 }}
                              value={quick.notifyCustom ? '__custom__' : quick.notifyEmail}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === '__custom__') { setQuick({ ...quick, notifyCustom: true, notifyEmail: '', notifyName: '' }); return; }
                                const c = (matterInfo?.contacts ?? []).find((x: any) => x.email === v);
                                setQuick({ ...quick, notifyCustom: false, notifyEmail: v, notifyName: c?.name ?? '' });
                              }}
                            >
                              <option value="">Choose a contact…</option>
                              {(matterInfo?.contacts ?? []).filter((c: any) => c.email && c.role !== 'OUR_FIRM').map((c: any) => (
                                <option key={c.id} value={c.email}>{c.name || c.email}{c.role && c.role !== 'UNKNOWN' ? ` (${humanize(c.role)})` : ''}</option>
                              ))}
                              <option value="__custom__">Custom email…</option>
                            </select>
                          </label>
                          {quick.notifyCustom && (
                            <input style={{ ...S.input, marginBottom: 6 }} placeholder="name@example.com" value={quick.notifyEmail} onChange={(e) => setQuick({ ...quick, notifyEmail: e.target.value })} />
                          )}
                        </>
                      )}
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button style={{ ...S.primary, marginTop: 0, flex: 1, width: 'auto', padding: '8px 0' }} onClick={runQuick} disabled={quick.type === 'DELEGATE' ? !quick.delegateToUserId : !quick.notifyEmail.trim()}>Run</button>
                        <button style={{ ...S.secondary, flex: 1 }} onClick={() => setQuick(null)}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* Workflows — named multi-step actions */}
                  {(playbooks.length > 0 || me?.role === 'ADMIN') && (
                    <div style={{ marginTop: 12 }}>
                      <span style={S.updateLabel}>Workflows</span>
                      {playbooks.length === 0 && (
                        <p style={{ ...S.muted, margin: '4px 0 0' }}>No workflows yet.</p>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                        {[...playbooks]
                          .sort((a, b) => (b.id === pbSuggestion?.playbookId ? 1 : 0) - (a.id === pbSuggestion?.playbookId ? 1 : 0))
                          .map((p) => {
                            const suggested = p.id === pbSuggestion?.playbookId;
                            const open = expandedPb === p.id;
                            return (
                              <div key={p.id} style={{ border: '1px solid', borderColor: suggested ? '#5A27E0' : '#cbd5e1', borderRadius: 7, overflow: 'hidden' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 5px 5px 9px', background: suggested ? '#f5f3ff' : '#fff' }}>
                                  <button
                                    style={{ flex: 1, minWidth: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', color: '#0f172a', padding: '3px 0' }}
                                    onClick={() => setExpandedPb(open ? null : p.id)}
                                    title="Show details"
                                  >
                                    <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                                    {suggested && <span style={{ fontSize: 9, color: '#5A27E0', fontWeight: 800, flex: 'none' }}>SUGGESTED</span>}
                                  </button>
                                  <button
                                    style={{ flex: 'none', minWidth: 58, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 14px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: runningPb && runningPb !== p.id ? 0.5 : 1 }}
                                    onClick={() => runPlaybookFor(p)}
                                    disabled={!!runningPb}
                                  >
                                    {runningPb === p.id ? <span style={S.spinnerLight} /> : 'Run'}
                                  </button>
                                </div>
                                {open && p.description && (
                                  <div style={{ padding: '8px 9px', borderTop: '1px solid #f1f5f9' }}>
                                    <p style={{ fontSize: 12, color: '#475569', margin: 0, lineHeight: 1.4 }}>{p.description}</p>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                      {pbInputs && (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
                          <SubLabel>Run “{pbInputs.p.name}”</SubLabel>
                          {pbInputs.needsDelegate && (
                            <label style={{ display: 'block', marginBottom: 6 }}>
                              <span style={S.fieldLabel}>Delegate To</span>
                              <select style={{ ...S.input, marginBottom: 0 }} value={pbInputs.delegateToUserId} onChange={(e) => setPbInputs({ ...pbInputs, delegateToUserId: e.target.value })}>
                                <option value="">Choose a team member…</option>
                                {assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
                              </select>
                            </label>
                          )}
                          {pbInputs.needsNotify && (
                            <label style={{ display: 'block', marginBottom: 6 }}>
                              <span style={S.fieldLabel}>Notify (Email)</span>
                              <input style={{ ...S.input, marginBottom: 0 }} placeholder="client@example.com" value={pbInputs.notifyEmail} onChange={(e) => setPbInputs({ ...pbInputs, notifyEmail: e.target.value })} />
                            </label>
                          )}
                          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                            <button
                              style={{ ...S.primary, marginTop: 0, flex: 1, width: 'auto', padding: '8px 0' }}
                              onClick={confirmRunInputs}
                              disabled={(pbInputs.needsDelegate && !pbInputs.delegateToUserId) || (pbInputs.needsNotify && !pbInputs.notifyEmail.trim())}
                            >
                              Run
                            </button>
                            <button style={{ ...S.secondary, flex: 1 }} onClick={() => setPbInputs(null)}>Cancel</button>
                          </div>
                        </div>
                      )}
                      {me?.role === 'ADMIN' && (
                        <button onClick={() => openAdmin('playbooks')} style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: '#5A27E0', fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                          Manage workflows →
                        </button>
                      )}
                    </div>
                  )}

                  {/* Shared results — quick action or workflow */}
                  {pbResults && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
                      <SubLabel>{pbResults.name} — done</SubLabel>
                      <ul style={{ ...S.ul, fontSize: 12 }}>
                        {pbResults.results.map((r, i) => (
                          <li key={i} style={{ color: r.ok ? '#166534' : '#b91c1c' }}>{r.ok ? '✓' : '✕'} {r.detail}</li>
                        ))}
                      </ul>
                      <p style={{ ...S.muted, margin: 0 }}>Drafts are in Outlook — review before sending. Nothing was sent.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Ignore — read, nothing to do */}
              {effectiveAction === 'ignore' && (
                <div style={S.actionPanel}>
                  {ignored ? (
                    <p style={{ ...S.muted, margin: 0, color: '#166534' }}>✓ Marked as handled — no reply needed.</p>
                  ) : (
                    <button style={S.secondary} onClick={markIgnore}>Mark as no action needed</button>
                  )}
                </div>
              )}
            </Card>
          )}

          {tab === 'email' && showNewMatter && (
            <Card>
              <Label>New Matter</Label>
              <Field label="Your reference (optional)" value={form.matterRef} onChange={(v) => setForm({ ...form, matterRef: v })} placeholder={`auto: ${suggestedRef()}`} />
              <Field label="Property address" value={form.propertyAddress} onChange={(v) => setForm({ ...form, propertyAddress: v })} placeholder="14 Oak Street, London SW1A 1AA" />
              <TagInput label="Buyers" values={form.buyerNames} onChange={(v) => setForm({ ...form, buyerNames: v })} placeholder="type a name, press Enter" />
              <TagInput label="Sellers" values={form.sellerNames} onChange={(v) => setForm({ ...form, sellerNames: v })} placeholder="type a name, press Enter" />
              <TagInput label="Other side (solicitor, agent…)" values={form.counterparties} onChange={(v) => setForm({ ...form, counterparties: v })} placeholder="prefilled from sender — Enter to add, × to remove" />
              <div style={S.rowWrap}>
                <Field label="Exchange target" type="date" value={form.exchangeTargetDate} onChange={(v) => setForm({ ...form, exchangeTargetDate: v })} />
                <Field label="Completion target" type="date" value={form.completionTargetDate} onChange={(v) => setForm({ ...form, completionTargetDate: v })} />
              </div>
              <button style={S.primary} onClick={createMatter} disabled={!form.propertyAddress}>
                Create + provision OneDrive
              </button>
            </Card>
          )}


          {tab === 'email' && summary && (
            <Card>
              <Label>Summary</Label>
              <SubLabel>Happened</SubLabel>
              <ul style={S.ul}>{summary.happened.map((h, i) => <li key={i}>{h}</li>)}</ul>
              <SubLabel>Outstanding</SubLabel>
              <ul style={S.ul}>{summary.outstanding.map((o, i) => <li key={i}>{o}</li>)}</ul>
            </Card>
          )}

          {tab === 'email' && facts && (
            <Card>
              <Label>Extracted Facts{!matterId && ' — not saved (link a matter to persist)'}</Label>
              {Object.entries(facts.facts).map(([k, v]) => (
                <div key={k} style={S.kv}>
                  <span>{humanize(k)}</span>
                  <span>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                </div>
              ))}
              {facts.outstanding.length > 0 && (
                <>
                  <SubLabel>Outstanding</SubLabel>
                  <ul style={S.ul}>{facts.outstanding.map((o, i) => <li key={i}>{o}</li>)}</ul>
                </>
              )}
              {facts.risks.length > 0 && (
                <>
                  <SubLabel>Risks</SubLabel>
                  <ul style={S.ul}>{facts.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </>
              )}
            </Card>
          )}

          {/* ── Status — pulled from the matter's tracker, + links to the boards ── */}
          {tab === 'email' && matterId && (() => {
            const rawFlag = matterInfo?.matter?.status_flag || 'ON_TRACK';
            const flag = humanize(rawFlag);
            const fc =
              rawFlag === 'BLOCKED'
                ? { bg: '#fee2e2', fg: '#991b1b', dot: '#dc2626' }
                : rawFlag === 'NEEDS_ATTENTION'
                ? { bg: '#fef9c3', fg: '#854d0e', dot: '#f59e0b' }
                : { bg: '#dcfce7', fg: '#166534', dot: '#16a34a' };
            const curStage = matterInfo?.matter?.stage || 'INSTRUCTION';
            const curAssigned = matterInfo?.matter?.assigned_to || '';
            const savedNotes = (matterInfo?.matter?.notes as string | undefined) ?? '';
            const timeline: Array<{ title?: string; details?: string; event_type?: string; event_at?: string; created_at?: string }> =
              (matterInfo?.timeline as any) ?? [];
            const ctrl: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 9px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', color: '#0f172a', marginBottom: 7, fontFamily: 'inherit', cursor: 'pointer' };
            return (
              <Card>
                {/* Header row: status badge + refresh, with history + Tracker pinned right. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: fc.bg, color: fc.fg, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: fc.dot, flex: 'none' }} />
                    {flag}
                  </span>
                  <button
                    style={S.ghostIcon}
                    onClick={() => { loadMatter(); loadTasks(); }}
                    disabled={!!busy}
                    title="Refresh status"
                    aria-label="Refresh status"
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      style={{ ...S.ghostIcon, ...(showHistory ? { background: '#ede9fe', color: '#5A27E0' } : {}) }}
                      onClick={() => setShowHistory((v) => !v)}
                      title="Case history"
                      aria-label="Case history"
                    >
                      <Icon name="history" size={14} />
                    </button>
                    <button style={S.boardBtn} onClick={buildBoard} disabled={boardLoading} title="Open the team tracker in a new tab">
                      {boardLoading ? 'Syncing…' : 'Tracker'} <Icon name="external" size={11} />
                    </button>
                  </div>
                </div>

                {showHistory ? (
                  /* Case audit log — emails matched, stage moves, reassignments, edits. */
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {timeline.length === 0 ? (
                      <p style={{ ...S.muted, margin: '2px 0' }}>No history yet — activity shows here as email arrives and the matter changes.</p>
                    ) : (
                      timeline.map((e, i) => {
                        const when = e.event_at || e.created_at;
                        return (
                          <div key={i} style={{ display: 'flex', gap: 8, padding: '7px 0', borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: '#c4b5fd', marginTop: 5, flex: 'none' }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, color: '#0f172a' }}>{e.title || (e.event_type || '').toLowerCase().replace(/_/g, ' ')}</div>
                              {e.details && <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 1 }}>{e.details}</div>}
                              {when && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{new Date(when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <>
                    {/* Stage + assignee side by side — unlabeled, edit in place */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select value={curStage} onChange={(e) => updateMatterField({ stage: e.target.value })} disabled={!!busy} style={{ ...ctrl, flex: 1, minWidth: 0, width: 'auto' }} title="Stage">
                        {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <select value={curAssigned} onChange={(e) => updateMatterField({ assignedTo: e.target.value || null })} disabled={!!busy} style={{ ...ctrl, flex: 1, minWidth: 0, width: 'auto' }} title="Assigned to">
                        <option value="">Unassigned</option>
                        {assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
                      </select>
                    </div>
                    {/* Free-text case notes — unlabeled box, saves on blur */}
                    <textarea
                      key={matterId}
                      defaultValue={savedNotes}
                      placeholder="Notes on this matter…"
                      onBlur={(e) => { if (e.target.value !== savedNotes) updateMatterField({ notes: e.target.value }); }}
                      style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 9px', border: '1px solid #e2e8f0', borderRadius: 8, minHeight: 60, resize: 'vertical', fontFamily: 'inherit', color: '#0f172a', lineHeight: 1.45 }}
                    />
                  </>
                )}
              </Card>
            );
          })()}

          {/* ── HOUSE TAB — the property/transaction record (editable, validated) ── */}
          {tab === 'house' && matterInfo?.matter && (
            <>
              <HousePanel
                key={matterInfo.matter.id}
                matter={matterInfo.matter}
                facts={matterInfo.summary?.facts ?? {}}
                onPatch={updateMatterField}
                history={Array.isArray(matterInfo.figureHistory) ? matterInfo.figureHistory : []}
                members={teamMembers}
              />
              <ContactsPanel key={`contacts-${matterInfo.matter.id}`} matterId={matterInfo.matter.id} initial={matterInfo.contacts ?? []} />

              {/* Tasks — the matter's to-do list (incl. items seeded on import). The state was
                  being loaded but never rendered; this is the actual task view. */}
              <Card>
                <Label>Tasks{tasks.filter((t) => t.status !== 'DONE').length ? ` · ${tasks.filter((t) => t.status !== 'DONE').length} open` : ''}</Label>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <input
                    style={{ ...S.input, marginTop: 0 }}
                    placeholder="Add a task…"
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void addTask(); }}
                  />
                  <button style={{ ...S.secondary, width: 'auto', marginTop: 0, padding: '6px 12px' }} disabled={taskBusy === 'new' || !newTask.trim()} onClick={() => void addTask()}>
                    {taskBusy === 'new' ? '…' : 'Add'}
                  </button>
                </div>
                {tasks.length === 0 ? (
                  <p style={{ ...S.muted, margin: 0 }}>No tasks yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {[...tasks].sort((a, b) => (a.status === 'DONE' ? 1 : 0) - (b.status === 'DONE' ? 1 : 0)).map((t) => {
                      const done = t.status === 'DONE';
                      return (
                        <label key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 9px', border: '1px solid #ECE7F8', borderRadius: 9, background: done ? '#F7F6FB' : '#FBFAFF', cursor: 'pointer', opacity: taskBusy === t.id ? 0.5 : 1 }}>
                          <input
                            type="checkbox"
                            checked={done}
                            disabled={taskBusy === t.id}
                            onChange={(e) => void setTaskStatus(t.id, e.target.checked ? 'DONE' : 'OPEN')}
                            style={{ marginTop: 2 }}
                          />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 12.5, color: done ? '#94a3b8' : '#1C1530', textDecoration: done ? 'line-through' : 'none' }}>{t.detail}</span>
                            <span style={{ display: 'block', fontSize: 10.5, color: '#94a3b8', marginTop: 1 }}>
                              {t.ref}{t.status !== 'OPEN' && t.status !== 'DONE' ? ` · ${t.status.toLowerCase()}` : ''}{t.assignee ? ` · ${t.assignee}` : ''}{t.due ? ` · due ${t.due}` : ''}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </Card>

              {/* Figure history — who changed each figure, when, why, and the email/doc
                  it came from. Every price/date/party edit is auditable. */}
              {Array.isArray(matterInfo.figureHistory) && matterInfo.figureHistory.length > 0 && (
                <Card>
                  <Label>Figure History</Label>
                  <p style={{ ...S.muted, margin: '0 0 8px' }}>
                    Who changed each figure, when and why — and the email or document it came from.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {matterInfo.figureHistory.slice(0, 50).map((h: any) => (
                      <div key={h.id} style={{ padding: '8px 10px', border: '1px solid #ECE7F8', borderRadius: 10, background: '#FBFAFF' }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1C1530' }}>
                          {h.label}:{' '}
                          <span style={{ color: '#94a3b8', fontWeight: 500, textDecoration: h.old_value ? 'line-through' : 'none' }}>
                            {h.old_value || '—'}
                          </span>{' '}
                          → <span style={{ color: '#5A27E0' }}>{h.new_value || '—'}</span>
                        </div>
                        <div style={{ fontSize: 11.5, color: '#7A7388', marginTop: 2 }}>
                          {h.actor || (h.source === 'MANUAL' ? 'Someone' : 'CONVEYi')} ·{' '}
                          {new Date(h.created_at).toLocaleString()} ·{' '}
                          {h.source === 'MANUAL'
                            ? 'edited by hand'
                            : h.source === 'AI_EMAIL'
                            ? 'read from an email'
                            : h.source === 'AI_DOC'
                            ? 'read from a document'
                            : h.source === 'IMPORT'
                            ? 'from import'
                            : String(h.source).toLowerCase()}
                        </div>
                        {h.reason && h.source === 'MANUAL' && (
                          <div style={{ fontSize: 11.5, color: '#4A4358', marginTop: 2, fontStyle: 'italic' }}>{h.reason}</div>
                        )}
                        {h.ref_kind && (
                          <div style={{ marginTop: 4 }}>
                            {h.ref_url ? (
                              <a
                                href={h.ref_url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ display: 'inline-block', fontSize: 11, color: '#5A27E0', textDecoration: 'none', border: '1px solid #D9D2EC', borderRadius: 8, padding: '2px 8px' }}
                              >
                                {h.ref_kind === 'EMAIL' ? '✉' : '📎'} {h.ref_label || (h.ref_kind === 'EMAIL' ? 'Source email' : 'Source document')}
                              </a>
                            ) : (
                              <span
                                style={{ display: 'inline-block', fontSize: 11, color: '#5A27E0', border: '1px solid #D9D2EC', borderRadius: 8, padding: '2px 8px' }}
                                title={h.ref_kind === 'EMAIL' ? 'The email this came from' : 'The document this came from'}
                              >
                                {h.ref_kind === 'EMAIL' ? '✉' : '📎'} {h.ref_label || (h.ref_kind === 'EMAIL' ? 'Source email' : 'Source document')}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}

          {/* ── FILES TAB — Case files (live OneDrive folder) + Templates ── */}
          {tab === 'paperclip' && matterId && (
            <>
              {/* Reconciliation results — the cross-check is triggered from the Case Files
                  header (the purple icon); this card only appears once it has run. */}
              {recon && (
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
                  <Label>Check the File</Label>
                  <button
                    style={{ ...S.secondary, width: 'auto', marginTop: 0, padding: '5px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={runReconcile}
                    disabled={reconBusy}
                  >
                    {reconBusy ? <span style={S.spinner} /> : null}
                    {reconBusy ? 'Checking…' : 'Re-check'}
                  </button>
                </div>
                {recon && (
                  <>
                    {/* Issues first — the "what needs you" headline. */}
                    {recon.issues.length > 0 ? (
                      <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#9a3412', marginBottom: 4 }}>
                          {recon.issues.length} thing{recon.issues.length === 1 ? '' : 's'} to resolve
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {recon.issues.map((it, i) => (
                            <li key={i} style={{ fontSize: 12, color: '#7c2d12', lineHeight: 1.45 }}>{it}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p style={{ fontSize: 12, color: '#166534', fontWeight: 600, margin: '0 0 10px' }}>✓ No discrepancies found across the file.</p>
                    )}

                    {/* The grid: one row per fact, matter value + each document, mismatches lit. */}
                    {recon.rows.length > 0 && (
                      <div style={{ overflowX: 'auto', border: '1px solid #e8eaf0', borderRadius: 10, boxShadow: '0 1px 2px rgba(16,24,40,0.04)' }}>
                        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                          <thead>
                            <tr style={{ background: '#f8fafc' }}>
                              <th style={reconTh}>Fact</th>
                              <th style={reconTh}>Matter</th>
                              <th style={reconTh}>Documents</th>
                            </tr>
                          </thead>
                          <tbody>
                            {recon.rows.map((row: any, i: number) => {
                              const bad = row.status === 'MISMATCH';
                              const miss = row.status === 'MISSING';
                              return (
                                <tr key={i} style={{ borderTop: '1px solid #eef2f7', background: bad ? '#fef2f2' : miss ? '#fffbeb' : '#fff' }}>
                                  <td style={{ ...reconTd, fontWeight: 600, whiteSpace: 'nowrap' }}>
                                    {bad ? '⚠ ' : miss ? '• ' : ''}{row.field}
                                  </td>
                                  <td style={reconTd}>{row.matterValue || '—'}</td>
                                  <td style={reconTd}>
                                    {(row.cells ?? []).length === 0 ? (
                                      <span style={{ color: '#94a3b8' }}>—</span>
                                    ) : (
                                      (row.cells ?? []).map((c: any, j: number) => (
                                        <div key={j} style={{ marginBottom: 2 }}>
                                          <span style={{ color: '#0f172a' }}>{c.value}</span>{' '}
                                          <span style={{ color: '#64748b' }} title={c.quote || ''}>· {c.doc}</span>
                                        </div>
                                      ))
                                    )}
                                    {row.note && <div style={{ color: bad ? '#b91c1c' : '#64748b', fontStyle: 'italic', marginTop: 2 }}>{row.note}</div>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {recon.skipped.length > 0 && (
                      <p style={{ ...S.muted, margin: '8px 0 0', fontSize: 11 }}>
                        Not yet read (excluded): {recon.skipped.join(', ')}.
                      </p>
                    )}
                  </>
                )}
              </Card>
              )}

              {/* Case files — the live contents of the matter's OneDrive folder. */}
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Label>Case Files</Label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {matterInfo?.matter?.folder_web_url && (
                      <a style={S.iconAction} href={matterInfo.matter.folder_web_url} target="_blank" rel="noreferrer" title="Open folder in OneDrive" aria-label="Open folder in OneDrive">
                        <Icon name="clip" size={15} />
                      </a>
                    )}
                    <button style={S.iconAction} onClick={() => fileInputRef.current?.click()} title="Upload a file" aria-label="Upload a file">
                      <Icon name="upload" size={15} />
                    </button>
                    <button style={S.iconAction} onClick={() => loadFiles()} title="Refresh" aria-label="Refresh">
                      <Icon name="refresh" size={15} />
                    </button>
                    {/* Cross-check — rightmost. Greyed with a why until there's a real document beyond the Tracker. */}
                    {(() => {
                      const docs = files.filter((f) => !(f.id === matterInfo?.matter?.tracker_item_id || /^Tracker\.xlsx$/i.test(f.name))).length;
                      const canX = filesLoaded && docs > 0 && !reconBusy;
                      return (
                        <button
                          style={{ ...S.iconAction, background: canX ? '#5A27E0' : '#fff', color: canX ? '#fff' : '#cbd5e1', borderColor: canX ? '#5A27E0' : '#e2e8f0', cursor: canX ? 'pointer' : 'not-allowed' }}
                          onClick={() => canX && runReconcile()}
                          aria-disabled={!canX}
                          title={reconBusy ? 'Cross-checking…' : !filesLoaded ? 'Loading case files…' : docs === 0 ? 'Add case documents to cross check' : 'Cross Check Documents'}
                          aria-label="Cross-check documents"
                        >
                          {reconBusy ? <span style={S.spinner} /> : <Icon name="fileCheck" size={15} />}
                        </button>
                      );
                    })()}
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }}
                />
                {filesLoading || !filesLoaded ? (
                  <LoadingRow label="Loading case files…" />
                ) : files.length > 0 ? (
                  <div style={S.fileList}>
                    {files.map((f) => {
                      const when = f.lastModified ? new Date(f.lastModified).toLocaleDateString('en-GB') : '';
                      const size = fmtSize(f.size);
                      // The matter's own case log (Tracker.xlsx) isn't an attachable document.
                      const isTracker = f.id === matterInfo?.matter?.tracker_item_id || /^Tracker\.xlsx$/i.test(f.name);
                      const attaching = attachingId === f.id;
                      return (
                        <div key={f.id} style={S.fileRow} title={f.name}>
                          <a
                            style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}
                            href={f.webUrl || undefined}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span style={S.fileIcon}><Icon name="file" size={15} /></span>
                            <span style={S.fileName}>{f.name}</span>
                            {size && <span style={S.fileMeta}>{size}</span>}
                            {when && <span style={S.fileMeta}>{when}</span>}
                          </a>
                          {!isTracker && (
                            <button
                              style={{ ...S.ghostIcon, flex: 'none', color: attaching ? '#5A27E0' : '#94a3b8', opacity: conversationId ? 1 : 0.4 }}
                              onClick={() => attachToReply(f)}
                              disabled={!conversationId || !!attachingId}
                              title={attaching ? 'Attaching…' : conversationId ? 'Attach to a reply' : 'Open an email to attach this to a reply'}
                              aria-label="Attach to a reply"
                            >
                              {attaching ? <span style={S.spinner} /> : <Icon name="clip" size={14} />}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p style={S.muted}>This folder is empty — upload a file, generate a template below, or drop one into OneDrive.</p>
                )}
              </Card>

              {/* Templates — fill a firm template with this matter's data. */}
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Label>Templates</Label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <a
                      style={S.iconAction}
                      href="/conveyi/doc-packs"
                      target="_blank"
                      rel="noreferrer"
                      title="How document templates work"
                      aria-label="How document templates work"
                    >
                      <Icon name="info" size={15} />
                    </a>
                    <button style={S.iconAction} onClick={() => loadTemplates()} title="Refresh templates" aria-label="Refresh templates">
                      <Icon name="refresh" size={15} />
                    </button>
                  </div>
                </div>
                {templatesLoading || !templatesLoaded ? (
                  <LoadingRow label="Loading templates…" />
                ) : templates.length > 0 ? (
                  <div style={S.fileList}>
                    {templates.map((tpl) => {
                      const busy = genTemplateId === tpl.id;
                      const aiLocked = tpl.has_llm_prompts && !templatesPremium;
                      return (
                        <div key={tpl.id} style={{ ...S.fileRow, cursor: 'default' }} title={tpl.description || tpl.name}>
                          <span style={S.fileIcon}><Icon name="file" size={15} /></span>
                          <span style={S.fileName}>
                            {tpl.name}
                            {tpl.has_llm_prompts && (
                              <span
                                style={{ marginLeft: 6, fontSize: 10, color: aiLocked ? '#94a3b8' : '#6d28d9', fontWeight: 700 }}
                                title={aiLocked ? 'Contains AI-written sections — Pro plan and up. They’ll be left blank on your plan.' : 'Contains AI-written sections'}
                              >
                                AI{aiLocked ? ' · Pro' : ''}
                              </span>
                            )}
                          </span>
                          <button
                            style={{ ...S.pillBtn, opacity: busy ? 0.6 : 1 }}
                            onClick={() => generateTemplate(tpl)}
                            disabled={busy || !!genTemplateId}
                            title="Fill this template with the matter's data and save it to Case files"
                          >
                            {busy ? 'Generating…' : 'Generate'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p style={S.muted}>
                    No templates yet.{me?.role === 'ADMIN' ? ' Add your firm’s .docx templates from Manage templates.' : ' Ask your firm admin to add some.'}
                  </p>
                )}
                {me?.role === 'ADMIN' && (
                  <button
                    onClick={() => openAdmin('docpacks')}
                    style={{ display: 'inline-block', marginTop: 10, fontSize: 12, color: '#5A27E0', fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Manage templates →
                  </button>
                )}
              </Card>
            </>
          )}
          </>
          )}

        </>
      )}

      {me && setupView && (
        <>
          {!onboardingBusy && (showSetup || !obJob) && (
            <button
              style={{ ...S.secondary, marginBottom: 10 }}
              onClick={() => (showSetup ? setShowSetup(false) : skipOnboarding())}
            >
              {showSetup ? '← Back to inbox' : 'Skip for now'}
            </button>
          )}
          {/* Onboard existing cases (bulk-import the mailbox backlog) */}
          <Card>
            <Label>Onboard Existing Cases</Label>

            {(!obJob || ['COMPLETED', 'CANCELLED', 'FAILED'].includes(obJob.status)) && (
              <>
                <p style={S.muted}>Find live cases in your mailbox and import them as matters — you pick which to keep.</p>
                <SubLabel>How Far Back</SubLabel>
                <select style={S.input} value={obLookback} onChange={(e) => setObLookback(e.target.value as '3' | 'unlimited')}>
                  <option value="3">Last 3 months</option>
                  <option value="unlimited">All history (premium)</option>
                </select>

                {/* One-time nudge: per-matter Inbox subfolders are opt-in. */}
                {subfolderPref && !subfolderPref.prompted && me?.role === 'ADMIN' && (
                  <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 12px', margin: '4px 0 10px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#075985', marginBottom: 4 }}>Tidy matched mail into matter folders?</div>
                    <p style={{ fontSize: 12, color: '#334155', margin: '0 0 8px', lineHeight: 1.45 }}>
                      CONVEYi can give each matter its own Inbox subfolder and move matched emails into it as you
                      action them. Off by default — change it any time in <strong>Admin → Policy</strong>.
                    </p>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={{ ...S.primary, marginTop: 0, flex: 1, width: 'auto', padding: '7px 0' }} onClick={() => chooseSubfolders(true)}>Enable</button>
                      <button style={{ ...S.secondary, flex: 1 }} onClick={() => chooseSubfolders(false)}>Not now</button>
                    </div>
                  </div>
                )}

                <button style={S.primary} onClick={startOnboarding}>
                  Scan my inbox
                </button>
                {obUpsell && (
                  <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, padding: '10px 12px', marginTop: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#6d28d9', marginBottom: 4 }}>You’ve used this month’s backlog scan</div>
                    <p style={{ fontSize: 12, color: '#475569', margin: '0 0 8px', lineHeight: 1.45 }}>
                      Re-scanning the whole mailbox is heavy, so it’s limited per month. Pro firms get more scans a month
                      (and all-history lookback).
                    </p>
                    <button style={{ ...S.primary, marginTop: 0, background: '#7c3aed' }} onClick={() => openAdmin('billing')}>
                      Upgrade to Pro
                    </button>
                  </div>
                )}
                {obJob?.status === 'COMPLETED' && (
                  <p style={{ ...S.muted, marginTop: 8 }}>Last run onboarded {obJob.cases_onboarded} case(s).</p>
                )}
                {obJob?.status === 'FAILED' && (
                  <p style={{ ...S.muted, color: '#b91c1c', marginTop: 8 }}>Last run failed: {obJob.error}</p>
                )}
              </>
            )}

            {obJob && OB_ACTIVE.includes(obJob.status) && (
              <>
                <p style={S.muted}>
                  {obJob.status === 'SCANNING' && `Scanning mailbox — ${obJob.messages_scanned} emails read…`}
                  {obJob.status === 'CLUSTERING' && `Grouping ${obJob.messages_scanned} emails into cases…`}
                  {obJob.status === 'PROPOSING' && `Identifying cases — ${obJob.cases_proposed} found so far…`}
                  {obJob.status === 'PROVISIONING' && `Provisioning matters — ${obJob.cases_onboarded} done…`}
                </p>
                <button style={S.secondary} onClick={cancelOnboarding}>
                  Cancel
                </button>
              </>
            )}

            {obJob?.status === 'AWAITING_REVIEW' && (
              <>
                <p style={S.muted}>
                  Found {obCases.filter((c) => c.status === 'PROPOSED').length} candidate case(s) across {obJob.messages_scanned}{' '}
                  emails. Tick the ones to onboard.
                </p>
                {(() => {
                  const proposed = obCases.filter((c) => c.status === 'PROPOSED');
                  const q = obSearch.trim().toLowerCase();
                  const shown = q
                    ? proposed.filter((c) => {
                        const hay = `${c.property_address || ''} ${[...(c.buyer_names || []), ...(c.seller_names || [])].join(' ')}`.toLowerCase();
                        return hay.includes(q);
                      })
                    : proposed;
                  return (
                    <>
                      {proposed.length > 6 && (
                        <input
                          style={{ ...S.input, marginBottom: 6 }}
                          placeholder="Search address or party…"
                          value={obSearch}
                          onChange={(e) => setObSearch(e.target.value)}
                        />
                      )}
                      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                        {shown.map((c) => {
                          const pct = Math.round((c.confidence ?? 0) * 100);
                          const parties = [...(c.buyer_names || []), ...(c.seller_names || [])].filter(Boolean).join(', ');
                          return (
                            <div key={c.id} style={S.candidate}>
                              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input
                                  type="checkbox"
                                  checked={!!obSel[c.id]}
                                  onChange={(e) => setObSel((s) => ({ ...s, [c.id]: e.target.checked }))}
                                />
                                <strong style={{ fontSize: 13 }}>{c.property_address || 'Unknown property'}</strong>
                              </label>
                              {parties && <div style={{ fontSize: 12, color: '#475569' }}>{parties}</div>}
                              <div style={{ fontSize: 11, color: '#64748b', margin: '2px 0' }}>
                                {pct}% · {c.message_count} email(s) · {c.thread_count} thread(s)
                              </div>
                              {c.rationale && <div style={{ fontSize: 11, color: '#64748b' }}>{c.rationale}</div>}
                              <input
                                style={{ ...S.input, marginTop: 4 }}
                                placeholder={`Matter ref (default: ${c.proposed_matter_ref || 'auto'})`}
                                value={obRefEdit[c.id] ?? ''}
                                onChange={(e) => setObRefEdit((r) => ({ ...r, [c.id]: e.target.value }))}
                              />
                            </div>
                          );
                        })}
                        {shown.length === 0 && <p style={S.muted}>No candidates match “{obSearch.trim()}”.</p>}
                      </div>
                    </>
                  );
                })()}
                {/* DIAGNOSTIC: why clusters were NOT proposed — surfaces AI failures vs
                    genuinely-not-a-case vs low confidence, so 0 candidates is explainable. */}
                {(() => {
                  const rejected = obCases.filter((c) => c.status === 'REJECTED' || c.status === 'FAILED');
                  if (!rejected.length) return null;
                  const aiFails = rejected.filter((c) => /AI proposal failed|timed out|Groq|error/i.test(c.rationale || '')).length;
                  return (
                    <details style={{ marginTop: 8, fontSize: 12 }}>
                      <summary style={{ cursor: 'pointer', color: '#64748b', fontWeight: 600 }}>
                        {rejected.length} not recognised{aiFails ? ` · ${aiFails} AI error(s)` : ''} — why?
                      </summary>
                      <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6 }}>
                        {rejected.slice(0, 40).map((c) => (
                          <div key={c.id} style={{ padding: '5px 0', borderTop: '1px solid #eee' }}>
                            <div style={{ color: '#475569' }}>
                              {(c.property_address || [...(c.buyer_names || []), ...(c.seller_names || [])].join(', ') || 'cluster')} · {c.message_count} email(s)
                              {c.confidence != null ? ` · ${Math.round((c.confidence ?? 0) * 100)}%` : ''}
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: 11 }}>{c.rationale || '(no rationale recorded)'}</div>
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })()}
                <button style={S.primary} onClick={confirmOnboarding}>
                  Onboard selected
                </button>
                <button style={{ ...S.secondary, marginTop: 6 }} onClick={cancelOnboarding}>
                  Discard
                </button>
              </>
            )}

            {obJob?.status === 'COMPLETED' && obCases.some((c) => c.status === 'ONBOARDED') && (() => {
              const onboarded = obCases.filter((c) => c.status === 'ONBOARDED');
              const q = obSearch.trim().toLowerCase();
              const shown = q ? onboarded.filter((c) => (c.property_address || '').toLowerCase().includes(q)) : onboarded;
              return (
                <>
                  <SubLabel>Onboarded · {onboarded.length}</SubLabel>
                  {onboarded.length > 8 && (
                    <input
                      style={{ ...S.input, marginBottom: 6 }}
                      placeholder="Search address…"
                      value={obSearch}
                      onChange={(e) => setObSearch(e.target.value)}
                    />
                  )}
                  <div style={S.scrollList}>
                    {shown.map((c) => (
                      <div key={c.id} style={S.scrollRow} title={c.error || c.property_address || ''}>
                        <div>{c.property_address || 'Unknown property'}</div>
                        {/* DIAGNOSTIC: what enrichment did per matter (tasks seeded / outstanding / msgs)
                            or why it failed — so "no tasks" is explainable at a glance. */}
                        {c.error && (
                          <div style={{ fontSize: 10.5, color: /fail|no messages/i.test(c.error) ? '#b91c1c' : '#94a3b8' }}>{c.error}</div>
                        )}
                      </div>
                    ))}
                    {shown.length === 0 && <div style={{ ...S.scrollRow, color: '#94a3b8', borderBottom: 'none' }}>No matches.</div>}
                  </div>
                </>
              );
            })()}
          </Card>

          {/* AI engine + auto-triage */}
          <Card>
            <Label>AI Engine</Label>
            <p style={S.muted}>
              {aiConnected === null ? 'Status unknown.' : aiConnected ? 'Per-user key connected.' : 'Using the firm’s central Claude key.'}
            </p>
            <SubLabel>Auto-Triage</SubLabel>
            <p style={S.muted}>
              Always on — incoming mail is auto-matched to a case, tagged, and pre-analysed so each email
              opens ready. It never sends a reply.
            </p>
            {autoTriage?.needsReconnect && (
              <p style={{ ...S.muted, color: '#b45309' }}>
                Outlook stopped letting us watch your inbox — reconnect your account to resume auto-triage.
              </p>
            )}
          </Card>
        </>
      )}

      {(busy || status) && (
        <div style={{ ...S.toast, ...(busy ? S.toastBusy : {}) }}>{busy ? `${busy}…` : status}</div>
      )}

      {/* Monthly email-cap reached — time saved so far + upgrade. */}
      {quotaModal && (
        <div style={S.modalOverlay} onClick={() => setQuotaModal(null)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()}>
            <button style={{ ...S.iconAction, width: 26, height: 26, position: 'absolute', top: 12, right: 12 }} onClick={() => setQuotaModal(null)} title="Close" aria-label="Close">✕</button>
            <div style={{ textAlign: 'center', padding: '4px 0 2px' }}>
              <div style={{ fontSize: 30, lineHeight: 1 }}>🚀</div>
              <h2 style={{ fontSize: 18, margin: '10px 0 4px', color: '#0f172a' }}>You’ve hit this month’s limit</h2>
              <p style={{ fontSize: 13, color: '#475569', margin: '0 0 12px', lineHeight: 1.5 }}>
                You’ve processed {quotaModal.used.toLocaleString()} of {quotaModal.cap.toLocaleString()} emails this month
                {quotaModal.hoursSaved > 0 && (
                  <> — and CONVEYi’s drafting has saved you an estimated <strong>~{quotaModal.hoursSaved.toLocaleString()} hours</strong> of writing</>
                )}.
              </p>
              <p style={{ fontSize: 13, color: '#475569', margin: '0 0 16px', lineHeight: 1.5 }}>
                Upgrade for <strong>unlimited</strong> emails — new mail keeps being triaged, matched and drafted with no monthly cap.
              </p>
              <button style={{ ...S.primary, marginTop: 0 }} onClick={() => { setQuotaModal(null); openAdmin('billing'); }}>
                Upgrade for unlimited
              </button>
              <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 10 }}>
                Already-opened emails still work. Your limit resets on the 1st.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Referral popup — gift icon in the header. */}
      {showReferral && (
        <div style={S.modalOverlay} onClick={() => setShowReferral(false)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()}>
            <button style={{ ...S.iconAction, width: 26, height: 26, position: 'absolute', top: 12, right: 12 }} onClick={() => setShowReferral(false)} title="Close" aria-label="Close">✕</button>
            <div style={{ textAlign: 'center', padding: '4px 0 2px' }}>
              <div style={{ fontSize: 30, lineHeight: 1 }}>🎉</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#5A27E0', marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>up to</div>
              <div style={{ fontSize: 40, fontWeight: 800, color: '#5A27E0', letterSpacing: -1, marginTop: 2, lineHeight: 1 }}>
                £{referral ? (referral.commissionPennies / 100).toFixed(0) : '50'}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginTop: 6, lineHeight: 1.3 }}>
                every month<br />for every referral you make
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 6, lineHeight: 1.3 }}>
                a quarter of what they pay, up to £{referral ? (referral.commissionPennies / 100).toFixed(0) : '50'}
              </div>
            </div>

            {referral ? (
              <>
                <button
                  style={S.copyBox}
                  onClick={copyReferral}
                  title="Click to copy your referral link"
                  aria-label="Copy referral link"
                >
                  <span style={S.copyBoxText}>{refCopied ? 'Link copied to clipboard!' : referral.referralLink}</span>
                  <span style={{ color: refCopied ? '#16a34a' : '#5A27E0', flex: 'none' }}>
                    <Icon name={refCopied ? 'check' : 'copy'} size={16} />
                  </span>
                </button>
                <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0', textAlign: 'center' }}>
                  Your code: <strong style={{ color: '#64748b' }}>{referral.referralCode}</strong>
                </p>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 0' }}>
                <span style={S.spinner} />
                <span style={{ fontSize: 12, color: '#64748b' }}>Fetching your link…</span>
              </div>
            )}

            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <a
                href="/conveyi/referral-terms"
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: '#5A27E0', fontWeight: 600, textDecoration: 'none' }}
              >
                See how referral payments work →
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────
// Visually dim a button when its action isn't ready yet — but keep it clickable
// so the handler's guard can explain what's missing (vs. a silently-dead
// `disabled` button, whose inline dark style hides the disabled state entirely).
function btn(base: React.CSSProperties, dim: boolean): React.CSSProperties {
  return dim ? { ...base, opacity: 0.5 } : base;
}

// Turn an UPPER_SNAKE enum or snake_case key into human text for display:
// "IN_PROGRESS" → "In progress", "completion_date" → "Completion date". The raw
// value stays the source of truth — this only ever touches what the user reads.
// Bytes → a short human size for the file-explorer rows.
function fmtSize(n: number | null): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

// Small inline SVG icons, stroke-based to match the header gear — keeps the
// taskpane emoji-free and crisp at any zoom. Inherits colour from the parent.
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    reply: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 5 5v4" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 8 9 6 9-6" /></>,
    home: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
    file: <><path d="M14 3v5h5" /><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /></>,
    upload: <><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></>,
    refresh: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>,
    history: <><path d="M3 3v6h6" /><path d="M3.5 9a9 9 0 1 0 2.1-3.4L3 9" /><path d="M12 8v5l4 2" /></>,
    fileCheck: <><path d="M14 3v5h5" /><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 14 2 2 4-4" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
    external: <><path d="M14 3h7v7" /><path d="M21 3l-9 9" /><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
    clip: <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.9-2.9l7.6-7.6" />,
    check: <path d="M20 6 9 17l-5-5" />,
    user: <><circle cx="12" cy="8" r="4" /><path d="M5 21a7 7 0 0 1 14 0" /></>,
    minus: <path d="M5 12h14" />,
    chart: <><path d="M4 4v16h16" /><path d="M8 17v-5" /><path d="M13 17V8" /><path d="M18 17v-3" /></>,
    sparkle: <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />,
    alert: <><path d="M10.3 4 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 4a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
    gift: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" /><path d="M12 8v14" /><path d="M12 8H7.5a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8z" /><path d="M12 8h4.5a2.5 2.5 0 0 0 0-5C13 3 12 8 12 8z" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {paths[name]}
    </svg>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section style={S.card}>{children}</section>;
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px' }}>
      <span style={S.spinner} />
      <span style={{ fontSize: 12, color: '#64748b' }}>{label}</span>
    </div>
  );
}

// The House tab's property record: controlled fields with validation and an
// explicit Save / Discard (no silent save-on-blur). Keyed by matter id by the
// caller so it re-initialises when the matter changes. Buyers/sellers are
// read-only (the matter PATCH doesn't accept them); stage/status are enum selects
// that apply immediately. Purchase price is validated as a money value.
const MONEY_RE = /^£?\s*\d{1,3}(,\d{3})*(\.\d{1,2})?$|^£?\s*\d+(\.\d{1,2})?$/;
function HousePanel({
  matter,
  facts,
  onPatch,
  history,
  members,
}: {
  matter: any;
  facts: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => Promise<unknown>;
  history: any[];
  members: Array<{ id: string; display_name: string | null; email: string; role: string }>;
}) {
  const dateStr = (s: unknown) => (s ? String(s).slice(0, 10) : '');
  const priceKey = Object.keys(facts).find((k) => /price|consideration|value|offer/i.test(k));
  const initial = {
    track: matter.track || 'PURCHASE',
    propertyAddress: matter.property_address ?? '',
    purchasePrice: matter.purchase_price ?? (priceKey ? String(facts[priceKey]) : ''),
    counterpartySolicitor: matter.counterparty_solicitor ?? '',
    counterpartyAgent: matter.counterparty_agent ?? '',
    lender: matter.lender ?? '',
    chainPosition: matter.chain_position ?? '',
    exchangeTargetDate: dateStr(matter.exchange_target_date),
    completionTargetDate: dateStr(matter.completion_target_date),
  };
  type Draft = typeof initial;
  const [draft, setDraft] = useState<Draft>(initial);
  const [baseline, setBaseline] = useState<Draft>(initial);
  const set = (k: keyof Draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const [openField, setOpenField] = useState<keyof Draft | null>(null);
  // Map each editable field to the DB field name used in the figure-change audit, so a
  // field's label can reveal its own history.
  const DB_FIELD: Partial<Record<keyof Draft, string>> = {
    propertyAddress: 'property_address',
    purchasePrice: 'purchase_price',
    counterpartySolicitor: 'counterparty_solicitor',
    counterpartyAgent: 'counterparty_agent',
    lender: 'lender',
    chainPosition: 'chain_position',
    exchangeTargetDate: 'exchange_target_date',
    completionTargetDate: 'completion_target_date',
    track: 'track',
  };

  const priceValid = !draft.purchasePrice.trim() || MONEY_RE.test(draft.purchasePrice.trim());
  const keys = Object.keys(draft) as (keyof Draft)[];
  const dirty = keys.some((k) => draft[k] !== baseline[k]);
  const canSave = dirty && priceValid;
  const join = (a?: string[]) => (a && a.length ? a.join(', ') : '');

  const save = async () => {
    const patch: Record<string, unknown> = {};
    keys.forEach((k) => { if (draft[k] !== baseline[k]) patch[k] = draft[k].trim(); });
    if (!Object.keys(patch).length) return;
    await onPatch(patch);
    setBaseline(draft);
  };

  const field = (label: string, k: keyof Draft, type = 'text', valid = true) => {
    const dbf = DB_FIELD[k];
    const rows = dbf ? history.filter((h: any) => h.field === dbf) : [];
    const open = openField === k;
    return (
      <div style={{ marginBottom: 6 }}>
        <span
          style={{ ...S.fieldLabel, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: rows.length ? 'pointer' : 'default' }}
          onClick={rows.length ? () => setOpenField(open ? null : k) : undefined}
          title={rows.length ? 'Show change history' : undefined}
        >
          {label}
          {rows.length > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#5A27E0', background: '#EDE7FB', borderRadius: 8, padding: '1px 6px' }}>
              {rows.length} {open ? '⌃' : '⌄'}
            </span>
          )}
        </span>
        <input
          style={{ ...S.input, marginBottom: 0, ...(valid ? {} : { borderColor: '#dc2626' }) }}
          type={type}
          value={draft[k]}
          onChange={(e) => set(k, e.target.value)}
        />
        {!valid && <span style={{ fontSize: 11, color: '#dc2626' }}>Enter a valid amount, e.g. £210,000</span>}
        {open && rows.length > 0 && (
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {rows.map((h: any) => (
              <div key={h.id} style={{ fontSize: 11, color: '#4A4358', background: '#FBFAFF', border: '1px solid #ECE7F8', borderRadius: 8, padding: '5px 8px' }}>
                <div>
                  <span style={{ color: '#94a3b8', textDecoration: h.old_value ? 'line-through' : 'none' }}>{h.old_value || '—'}</span>
                  {' → '}
                  <span style={{ color: '#5A27E0', fontWeight: 700 }}>{h.new_value || '—'}</span>
                </div>
                <div style={{ color: '#7A7388', marginTop: 1 }}>
                  {h.actor || 'CONVEYi'} · {new Date(h.created_at).toLocaleDateString()} ·{' '}
                  {h.source === 'MANUAL' ? 'by hand' : h.source === 'AI_EMAIL' ? 'from email' : h.source === 'AI_DOC' ? 'from a document' : String(h.source).toLowerCase()}
                  {h.ref_label ? ` · ${h.ref_kind === 'EMAIL' ? '✉' : '📎'} ${h.ref_label}` : ''}
                </div>
                {h.reason && h.source === 'MANUAL' && <div style={{ fontStyle: 'italic', color: '#7A7388', marginTop: 1 }}>{h.reason}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <section style={S.card}>
      <Label>{matter.matter_ref}</Label>
      <label style={{ display: 'block', marginBottom: 6 }}>
        <span style={S.fieldLabel}>Acting For</span>
        <select style={{ ...S.input, marginBottom: 0 }} value={draft.track} onChange={(e) => set('track', e.target.value)}>
          {TRACKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {members.length > 1 && (
        <label style={{ display: 'block', marginBottom: 6 }}>
          <span style={S.fieldLabel}>Assigned to</span>
          <select
            style={{ ...S.input, marginBottom: 0 }}
            value={matter.assigned_to || ''}
            onChange={(e) => onPatch({ assignedTo: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.display_name || m.email}</option>
            ))}
          </select>
        </label>
      )}
      {field('Property Address', 'propertyAddress')}
      {field('Purchase Price', 'purchasePrice', 'text', priceValid)}
      {join(matter.buyer_names) && <div style={S.kv}><span>Buyer(s)</span><span style={{ textAlign: 'right' }}>{join(matter.buyer_names)}</span></div>}
      {join(matter.seller_names) && <div style={S.kv}><span>Seller(s)</span><span style={{ textAlign: 'right' }}>{join(matter.seller_names)}</span></div>}
      {field('Other Side (Solicitor)', 'counterpartySolicitor')}
      {field('Estate Agent', 'counterpartyAgent')}
      {field('Lender', 'lender')}
      {field('Chain Position', 'chainPosition')}
      <div style={{ display: 'flex', gap: 6 }}>
        {field('Exchange Target', 'exchangeTargetDate', 'date')}
        {field('Completion Target', 'completionTargetDate', 'date')}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <label style={{ flex: 1 }}>
          <span style={S.fieldLabel}>Stage</span>
          <select style={{ ...S.input, marginBottom: 0 }} value={matter.stage || 'INSTRUCTION'} onChange={(e) => onPatch({ stage: e.target.value })}>
            {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          <span style={S.fieldLabel}>Status</span>
          <select style={{ ...S.input, marginBottom: 0 }} value={matter.status_flag || 'ON_TRACK'} onChange={(e) => onPatch({ statusFlag: e.target.value })}>
            {STATUS_FLAGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      {dirty && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
          <button style={{ ...S.primary, marginTop: 0, flex: 1, opacity: canSave ? 1 : 0.5 }} onClick={save} disabled={!canSave}>
            Save changes
          </button>
          <button style={S.secondary} onClick={() => setDraft(baseline)}>Discard</button>
        </div>
      )}
    </section>
  );
}

const CONTACT_ROLES: [string, string][] = [
  ['CLIENT', 'Client'],
  ['OTHER_SIDE', 'Other side'],
  ['AGENT', 'Estate agent'],
  ['LENDER', 'Lender'],
  ['OUR_FIRM', 'Our firm'],
  ['OTHER', 'Other'],
  ['UNKNOWN', '—'],
];

// The matter's address book: every party we've seen on its email traffic, each
// taggable with a role so actions like "email the client" can target the right
// person rather than only ever replying to the sender. Two-way: role edits and
// manual adds persist; new addresses appear as emails are matched to the case.
function ContactsPanel({ matterId, initial }: { matterId: string; initial: any[] }) {
  const [contacts, setContacts] = useState<any[]>(initial);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  useEffect(() => setContacts(initial), [initial]);

  const setRole = async (c: any, role: string) => {
    setContacts((cs) => cs.map((x) => (x.id === c.id ? { ...x, role } : x)));
    await api(`/matters/${matterId}/contacts`, { method: 'POST', body: JSON.stringify({ email: c.email, role }) }).catch(() => {});
  };
  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!e.includes('@')) return;
    await api(`/matters/${matterId}/contacts`, {
      method: 'POST',
      body: JSON.stringify({ email: e, name: name.trim() || undefined }),
    }).catch(() => {});
    const r = await api<{ contacts: any[] }>(`/matters/${matterId}/contacts`).catch(() => ({ contacts }));
    setContacts(r.contacts);
    setEmail('');
    setName('');
  };
  const remove = async (c: any) => {
    setContacts((cs) => cs.filter((x) => x.id !== c.id));
    await api(`/matters/${matterId}/contacts?id=${c.id}`, { method: 'DELETE' }).catch(() => {});
  };

  return (
    <section style={S.card}>
      <Label>People</Label>
      {contacts.length === 0 && (
        <p style={{ ...S.muted, margin: '4px 0 8px' }}>No contacts yet — they’ll appear as emails are matched to this case.</p>
      )}
      {contacts.map((c) => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.email}</div>
            {c.name && <div style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email}</div>}
          </div>
          <select
            style={{ ...S.input, marginBottom: 0, width: 116, flex: '0 0 auto' }}
            value={c.role || 'UNKNOWN'}
            onChange={(e) => setRole(c, e.target.value)}
          >
            {CONTACT_ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button style={{ ...S.iconAction, width: 30, height: 30 }} onClick={() => remove(c)} title="Remove contact" aria-label="Remove contact">✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
        <input style={{ ...S.input, marginBottom: 0, flex: 1 }} placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={{ ...S.input, marginBottom: 0, width: 90 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button style={S.secondary} onClick={add}>Add</button>
      </div>
    </section>
  );
}

// A collapsible card: the secondary surfaces (Tasks, Documents, Review) fold away
// so the situation + four moves own the top of the pane instead of being buried
// under an everything-at-once stack. `count` hints there's content when closed.
function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={S.card}>
      <button style={S.sectionHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={{ ...S.label, marginBottom: 0 }}>
          {title}
          {count ? <span style={S.sectionCount}>{count}</span> : null}
        </span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{open ? '▲' : '▾'}</span>
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </section>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return <div style={S.label}>{children}</div>;
}
function SubLabel({ children }: { children: React.ReactNode }) {
  return <div style={S.subLabel}>{children}</div>;
}
function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label style={{ display: 'block', flex: 1, minWidth: 120 }}>
      <span style={S.fieldLabel}>{label}</span>
      <input style={S.input} type={type ?? 'text'} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// Chip input: type a value and press Enter (or comma) to add it; multiple allowed.
function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = [...values];
    for (const p of raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      if (!next.includes(p)) next.push(p);
    }
    if (next.length !== values.length) onChange(next);
    setDraft('');
  };
  return (
    <label style={{ display: 'block', marginBottom: 6 }}>
      <span style={S.fieldLabel}>{label}</span>
      <div style={S.tagBox}>
        {values.map((v, i) => (
          <span key={i} style={S.tag}>
            {v}
            <button type="button" style={S.tagX} onClick={() => onChange(values.filter((_, j) => j !== i))} aria-label={`Remove ${v}`}>
              ×
            </button>
          </span>
        ))}
        <input
          style={S.tagInput}
          value={draft}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
        />
      </div>
    </label>
  );
}

// ── Inline styles (self-contained so the taskpane renders the same regardless
//    of the dark marketing theme on <body>) ──────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 480, margin: '0 auto', padding: 12, paddingBottom: 60 },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 4px 12px',
    borderBottom: '1px solid #e2e8f0',
    marginBottom: 12,
  },
  bolt: { color: '#5A27E0', fontSize: 18 },
  user: { fontSize: 12, color: '#64748b' },
  account: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
  },
  planBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#5A27E0',
    background: '#EDE7FB',
    borderRadius: 999,
    padding: '2px 7px',
  },
  iconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    padding: 0,
  },
  subjectLine: { fontSize: 12, fontWeight: 600, color: '#475569', margin: '0 2px 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  hero: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    textAlign: 'left',
    padding: '7px 11px',
    border: '1px solid',
    borderRadius: 999,
    cursor: 'pointer',
    marginBottom: 10,
  },
  statusDot: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    borderRadius: 999,
    color: '#fff',
    fontSize: 12,
    fontWeight: 800,
    lineHeight: 1,
    flex: 'none',
  },
  spinnerLight: {
    width: 11,
    height: 11,
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.45)',
    borderTopColor: '#fff',
    display: 'inline-block',
    animation: 'cl-spin 0.7s linear infinite',
  },
  heroFound: { background: '#dcfce7', borderColor: '#86efac', color: '#166534' },
  heroPartial: { background: '#fef9c3', borderColor: '#fde68a', color: '#854d0e' },
  heroNone: { background: '#fee2e2', borderColor: '#fecaca', color: '#991b1b' },
  heroPending: { background: '#f1f5f9', borderColor: '#e2e8f0', color: '#475569' },
  // When the drawer is open the pill becomes the header of a single connected
  // container: square off the bottom and drop the gap so the drawer joins onto it.
  heroOpen: { borderRadius: '14px 14px 0 0', marginBottom: 0 },
  // The drawer, rendered as the body of that container — flat top, no top border
  // (the pill's bottom edge is the divider), same coloured outline as the pill.
  matterDrawer: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderTopWidth: 0,
    borderRadius: '0 0 14px 14px',
    marginTop: 0,
    marginBottom: 10,
    padding: 12,
    background: '#f8fafc',
  },
  tabBar: { display: 'flex', gap: 2, marginBottom: 12, borderBottom: '1px solid #e2e8f0' },
  tabBtn: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 6px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', marginBottom: -1, fontSize: 12, fontWeight: 600, color: '#64748b', cursor: 'pointer' },
  tabBtnActive: { color: '#5A27E0', borderBottomColor: '#5A27E0' },
  tabBtnLocked: { opacity: 0.4, cursor: 'not-allowed' },
  fileList: { border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff', marginTop: 4 },
  fileRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderBottom: '1px solid #f1f5f9', textDecoration: 'none', color: '#0f172a', cursor: 'pointer' },
  fileExt: { flex: 'none', width: 38, textAlign: 'center', fontSize: 9, fontWeight: 700, letterSpacing: 0.3, color: '#5A27E0', background: '#EDE7FB', borderRadius: 4, padding: '3px 0' },
  fileName: { flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  fileMeta: { flex: 'none', fontSize: 11, color: '#94a3b8' },
  fileBtn: { flex: 'none', padding: '3px 9px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  fileDone: { flex: 'none', fontSize: 10, fontWeight: 700, color: '#166534', background: '#dcfce7', borderRadius: 999, padding: '2px 7px' },
  iconAction: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, border: '1px solid #cbd5e1', borderRadius: 7, background: '#fff', color: '#475569', cursor: 'pointer', textDecoration: 'none' },
  fileIcon: { flex: 'none', display: 'inline-flex', color: '#94a3b8' },
  actionRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 4 },
  actionBtn: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '8px 4px',
    background: '#fff',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    fontSize: 11,
    fontWeight: 600,
    color: '#334155',
    cursor: 'pointer',
  },
  actionBtnActive: { background: '#5A27E0', borderColor: '#5A27E0', color: '#fff' },
  recDot: { position: 'absolute', top: 5, right: 5, width: 6, height: 6, borderRadius: 999, background: '#22c55e' },
  actionPanel: { marginTop: 8, padding: 10, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 },
  updateLabel: { display: 'block', fontSize: 11, color: '#64748b', marginBottom: 6 },
  updateChip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 999, fontSize: 12, color: '#5A27E0', cursor: 'pointer', fontWeight: 600 },
  updateChipRole: { fontSize: 10, fontWeight: 500, color: '#7c6fb0', background: '#fff', border: '1px solid #e9e4ff', borderRadius: 999, padding: '1px 6px' },
  previewBody: { marginTop: 8, padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: '#0f172a', maxHeight: 240, overflow: 'auto' },
  spinner: {
    width: 12,
    height: 12,
    borderRadius: '50%',
    border: '2px solid #cbd5e1',
    borderTopColor: '#5A27E0',
    display: 'inline-block',
    animation: 'cl-spin 0.7s linear infinite',
  },
  assistIcon: {
    width: 20,
    height: 20,
    borderRadius: 6,
    background: '#5A27E0',
    color: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    flex: 'none',
  },
  card: {
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    background: '#f8fafc',
  },
  label: { fontWeight: 700, fontSize: 13, marginBottom: 8, color: '#0f172a' },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
  },
  sectionCount: {
    display: 'inline-block',
    marginLeft: 7,
    fontSize: 11,
    fontWeight: 700,
    color: '#5A27E0',
    background: '#EDE7FB',
    borderRadius: 999,
    padding: '1px 7px',
  },
  subLabel: { fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b', margin: '10px 0 4px' },
  fieldLabel: { display: 'block', fontSize: 11, color: '#64748b', marginBottom: 2 },
  linkedMatter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    background: '#f1edfd',
    border: '1px solid #ddd6fe',
    borderRadius: 8,
    padding: '7px 10px',
    fontSize: 13,
    fontWeight: 600,
    color: '#4A1FBE',
    marginBottom: 8,
  },
  tagBox: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    alignItems: 'center',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    padding: 4,
    minHeight: 38,
    background: '#fff',
    marginBottom: 6,
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    background: '#ede9fb',
    color: '#4A1FBE',
    borderRadius: 999,
    padding: '2px 4px 2px 9px',
    fontSize: 12,
    fontWeight: 600,
  },
  tagX: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: '#7c6bb0', padding: '0 3px' },
  tagInput: { flex: 1, minWidth: 90, border: 'none', outline: 'none', padding: '4px 6px', fontSize: 13, background: 'transparent' },
  muted: { fontSize: 12, color: '#64748b', margin: '0 0 10px' },
  threadSubject: { fontSize: 13, fontWeight: 600, marginBottom: 10, color: '#0f172a' },
  rowWrap: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  input: {
    width: '100%',
    padding: '7px 9px',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 6,
  },
  textarea: {
    width: '100%',
    padding: '8px 9px',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15,23,42,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    zIndex: 50,
  },
  modalCard: {
    position: 'relative',
    width: '100%',
    maxWidth: 360,
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 14,
    padding: 18,
    boxShadow: '0 20px 50px -20px rgba(15,23,42,0.5)',
  },
  copyBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    marginTop: 14,
    padding: '10px 12px',
    background: '#f5f3ff',
    border: '1px solid #ddd6fe',
    borderRadius: 9,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  copyBoxText: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    color: '#5b21b6',
    fontWeight: 600,
  },
  scrollList: {
    maxHeight: 240,
    overflowY: 'auto',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    background: '#fff',
  },
  scrollRow: {
    padding: '7px 10px',
    borderBottom: '1px solid #f1f5f9',
    fontSize: 12,
    color: '#334155',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  primary: {
    width: '100%',
    padding: '9px 12px',
    background: '#5A27E0',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    marginTop: 4,
  },
  secondary: {
    padding: '7px 10px',
    background: '#fff',
    color: '#0f172a',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
  },
  action: {
    padding: '10px',
    background: '#0f172a',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  tone: { padding: '5px 10px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  toneActive: { padding: '5px 10px', background: '#5A27E0', border: '1px solid #5A27E0', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 700 },
  ul: { margin: '0 0 4px', paddingLeft: 18, fontSize: 13, lineHeight: 1.5 },
  chip: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#e2e8f0', color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.3 },
  candidate: { border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, marginBottom: 6, background: '#fff' },
  confidence: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, color: '#0f172a' },
  kv: { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: '#334155', gap: 12 },
  trk: { width: '100%', borderCollapse: 'collapse', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff' },
  trkH: { textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b', padding: '6px 8px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc' },
  trkC: { fontSize: 12, color: '#0f172a', padding: '6px 8px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' },
  pillBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer', textDecoration: 'none' },
  // Light, tidy board links (Team tracker / Case log) — equal width when stacked.
  boardBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '5px 12px', background: '#f5f3ff', color: '#5A27E0', border: '1px solid #ddd6fe', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap' },
  // Quick-action buttons (Delegate / Notify) — white on purple.
  quickAct: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 10px', background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  // Borderless icon button (e.g. the status refresh) — no boxy outline.
  ghostIcon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', borderRadius: 6 },
  kvRow: { display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', alignItems: 'baseline' },
  kvKey: { flex: 'none', width: 74, color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap' },
  kvVal: { flex: 1, minWidth: 0, color: '#0f172a', lineHeight: 1.45, wordBreak: 'break-word' },
  link: { display: 'block', fontSize: 12, color: '#5A27E0', margin: '6px 0', textDecoration: 'none', fontWeight: 600 },
  toast: {
    position: 'fixed',
    left: 12,
    right: 12,
    bottom: 28,
    maxWidth: 456,
    margin: '0 auto',
    background: '#0f172a',
    color: '#fff',
    padding: '10px 12px',
    borderRadius: 8,
    fontSize: 12,
    boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
  },
  toastBusy: { background: '#5A27E0' },
};
