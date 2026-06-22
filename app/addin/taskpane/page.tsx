'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { randomMatterRef } from '@/lib/ref-name';

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
  thread_count: number;
  message_count: number;
  status: string;
  matter_id: string | null;
}
const OB_ACTIVE = ['SCANNING', 'CLUSTERING', 'PROPOSING', 'PROVISIONING'];

const TONES = ['NEUTRAL', 'FIRM', 'CHASING'] as const;
type Tone = (typeof TONES)[number];

const STAGES: Array<[string, string]> = [
  ['INSTRUCTION', '1 · Instruction'],
  ['CONTRACT_PACK', '2 · Contract pack'],
  ['SEARCHES_ENQUIRIES', '3 · Searches & enquiries'],
  ['REVIEW_SIGNING', '4 · Review & signing'],
  ['EXCHANGE', '5 · Exchange'],
  ['COMPLETION', '6 · Completion'],
];
const STATUS_FLAGS: Array<[string, string]> = [
  ['ON_TRACK', 'On track'],
  ['NEEDS_ATTENTION', 'Needs attention'],
  ['BLOCKED', 'Blocked'],
];

const TOKEN_KEY = 'cl_token';

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
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json as T;
}

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
  const [plan, setPlan] = useState<{ plan: string | null; status: string } | null>(null);
  const [aiConnected, setAiConnected] = useState<boolean | null>(null);
  const [autoTriage, setAutoTriage] = useState<{ enabled: boolean; expiresAt: string | null } | null>(null);
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
  const [fallbackRef] = useState(() => randomMatterRef());
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
  const [tone, setTone] = useState<Tone>('NEUTRAL');

  // The taskpane renders by *situation*, not by feature tabs: open an email → it
  // auto-analyses → we show what we found (matter? what's being asked?) and the
  // handful of moves that make sense. `chosenAction` tracks which of the four
  // canonical moves the user picked so its sub-panel expands; `linkOpen` toggles
  // the (normally collapsed) link-to-a-different/new-matter drawer.
  const [chosenAction, setChosenAction] = useState<'reply' | 'action' | 'delegate' | 'ignore' | null>(null);
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
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [newTaskDetail, setNewTaskDetail] = useState('');
  // Cache the master board's URL so the button can open it synchronously (no
  // popup block, no blank tab) and sync in the background.
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [draft, setDraft] = useState<DraftPackage | null>(null);
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');

  // Documents & sharing
  const [docs, setDocs] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [attachmentIntent, setAttachmentIntent] = useState('');

  // Document review
  const [attachments, setAttachments] = useState<any[]>([]);
  const [docReview, setDocReview] = useState<any>(null);
  const [teamId, setTeamId] = useState('');
  const [channelId, setChannelId] = useState('');

  // Onboarding (bulk-import existing cases from the mailbox backlog)
  const [obJob, setObJob] = useState<ObJob | null>(null);
  const [obCases, setObCases] = useState<ObCase[]>([]);
  const [obSel, setObSel] = useState<Record<string, boolean>>({});
  const [obRefEdit, setObRefEdit] = useState<Record<string, string>>({});
  const [obLookback, setObLookback] = useState<'3' | 'unlimited'>('3');
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
      setAutoTriage(await api<{ enabled: boolean; expiresAt: string | null }>('/graph/subscriptions'));
    } catch {
      setAutoTriage(null);
    }
    try {
      const b = await api<{ plan: string | null; status: string }>('/billing/account');
      setPlan({ plan: b.plan, status: b.status });
    } catch {
      setPlan(null);
    }
  }, []);

  // Cold open with a prior-sign-in hint → optimistically show "Connecting…" so we
  // don't flash "Not connected" during the first /me round-trip. Runs post-mount
  // (not in the initial state) to keep the server and client render identical.
  useEffect(() => {
    if (hasSignInHint()) setBooting(true);
  }, []);

  // Billing lives on a full page (redirects need width). Hand the session token
  // over in the URL fragment so desktop Outlook's separate storage jar can auth.
  function openAccount() {
    const t = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
    window.open(t ? `/account#token=${encodeURIComponent(t)}` : '/account', '_blank', 'noopener');
  }

  async function toggleAutoTriage() {
    await run(autoTriage?.enabled ? 'Disabling auto-triage' : 'Enabling auto-triage', async () => {
      await api('/graph/subscriptions', { method: autoTriage?.enabled ? 'DELETE' : 'POST' });
      setAutoTriage(await api('/graph/subscriptions'));
      setStatus(autoTriage?.enabled ? 'Auto-triage off.' : 'Auto-triage on — new inbox mail will be tagged & matched.');
    });
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
    try {
      for (;;) {
        const r = await api<{ status: string; job: ObJob | null; done: boolean }>('/onboarding/process', { method: 'POST' });
        if (r.job) setObJob(r.job);
        if (r.done) {
          await refreshOnboarding();
          break;
        }
        await new Promise((res) => setTimeout(res, 500));
      }
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      obDriving.current = false;
    }
  }, [refreshOnboarding]);

  async function startOnboarding() {
    const started = await run('Starting scan', async () => {
      const lookbackMonths = obLookback === 'unlimited' ? null : 3;
      const r = await api<{ job: ObJob }>('/onboarding', { method: 'POST', body: JSON.stringify({ lookbackMonths }) });
      setObJob(r.job);
      setObCases([]);
      setObSel({});
      setObRefEdit({});
      setStatus('Scanning your mailbox…');
      return true;
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
        // Read the open message; convert Office's EWS id to the REST id Graph needs.
        const loadItem = () => {
          const mailbox = Office?.context?.mailbox;
          const item = mailbox?.item;
          if (!item) return;
          let id = item.itemId as string | undefined;
          if (id && typeof mailbox.convertToRestId === 'function') {
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
          // Clear last email's assistant result + per-email UI so nothing lingers.
          setAssist(null);
          setTriage(null);
          setChosenAction(null);
          setIgnored(false);
          setLinkOpen(false);
          setDraft(null);
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
  function connect() {
    const Office = (window as any).Office;
    const origin = window.location.origin;
    if (Office?.context?.ui?.displayDialogAsync) {
      Office.context.ui.displayDialogAsync(
        `${origin}/api/v1/auth/login`,
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
      window.location.href = '/api/v1/auth/login';
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
    const surname = (form.buyerNames[0] || form.sellerNames[0] || '').trim().split(/\s+/).pop() || '';
    const who = surname.replace(/[^A-Za-z-]/g, '').toUpperCase();
    const addr = form.propertyAddress.toUpperCase();
    const pc = addr.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/);
    const street = addr.match(/\b(\d+)\s+([A-Z]+)/);
    const where = pc ? pc[1] : street ? `${street[1]}${street[2]}` : '';
    const parts = [who, where].filter(Boolean);
    return parts.length ? parts.join('-') : fallbackRef;
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
          body: JSON.stringify({ graphThreadId: conversationId, graphConversationId: conversationId, subject }),
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
        body: JSON.stringify({ graphThreadId: conversationId, graphConversationId: conversationId, subject }),
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

  async function extractFacts() {
    const r = await run('Extracting facts', async () => {
      requireThread();
      return api<ExtractedFacts>(`/threads/${encodeURIComponent(conversationId)}/extract-facts`, {
        method: 'POST',
        body: JSON.stringify({ matterId: matterId || undefined, conversationId }),
      });
    });
    if (!r) return;
    setFacts(r);
    if (matterId) {
      setStatus('Facts extracted; matter summary + Excel tracker updated.');
      await loadMatter();
    } else {
      setStatus('Facts extracted. Link or create a matter to save them.');
    }
  }

  async function saveToMatter() {
    await run('Saving to OneDrive', async () => {
      requireMatter();
      requireThread();
      if (!messageId) throw new Error('No message selected.');
      const r = await api<{ savedDocs: any[] }>(`/threads/${encodeURIComponent(conversationId)}/save-to-matter`, {
        method: 'POST',
        body: JSON.stringify({ matterId, messageId, includeAttachments: true }),
      });
      setStatus(`Saved ${r.savedDocs.length} file(s) to the matter's OneDrive folder.`);
    });
  }

  async function generateDraft() {
    // A matter is optional, but a draft written without one has no matter facts
    // or saved documents to draw on — confirm before proceeding.
    if (
      !matterId &&
      !window.confirm(
        'No matter is linked. Draft a reply anyway?\n\nThe draft will be based only on this email thread — it won’t use matter facts or saved documents.'
      )
    ) {
      return;
    }
    const r = await run('Drafting reply', async () => {
      requireThread();
      if (!messageId) throw new Error('No message selected.');
      return api<DraftPackage>(`/threads/${encodeURIComponent(conversationId)}/draft-reply`, {
        method: 'POST',
        body: JSON.stringify({ matterId: matterId || undefined, messageId, conversationId, tone }),
      });
    });
    if (r) {
      setDraft(r);
      setDraftSubject(r.subject);
      setDraftBody(r.bodyHtml);
    }
  }

  async function createOutlookDraft() {
    await run('Creating Outlook draft', async () => {
      requireThread();
      const r = await api<{ draftId: string }>(`/threads/${encodeURIComponent(conversationId)}/create-draft`, {
        method: 'POST',
        body: JSON.stringify({ matterId: matterId || undefined, messageId, subject: draftSubject || undefined, bodyHtml: draftBody }),
      });
      setStatus(`Draft created in Outlook (never sent). Draft id: ${r.draftId}`);
    });
  }

  async function loadDocs() {
    await run('Loading documents', async () => {
      requireMatter();
      const r = await api<{ documents: any[] }>(`/matters/${matterId}/documents`);
      setDocs(r.documents);
    });
  }

  async function suggestAttachments() {
    const r = await run('Suggesting attachments', async () => {
      requireMatter();
      return api<{ suggestions: any[] }>(`/matters/${matterId}/documents/suggest-attachments`, {
        method: 'POST',
        body: JSON.stringify({ intent: attachmentIntent || 'respond to the current thread' }),
      });
    });
    if (r) setSuggestions(r.suggestions);
  }

  async function postToTeams() {
    await run('Posting to Teams', async () => {
      requireMatter();
      if (!teamId || !channelId) throw new Error('Team ID and Channel ID are required.');
      await api(`/matters/${matterId}/teams/post-summary`, {
        method: 'POST',
        body: JSON.stringify({ teamId, channelId }),
      });
      setStatus('Posted matter summary to Teams.');
    });
  }

  async function listAttachments() {
    const r = await run('Loading attachments', async () => {
      if (!messageId) throw new Error('Open an email with an attachment first.');
      return api<{ attachments: any[] }>(
        `/threads/${encodeURIComponent(conversationId || messageId)}/attachments?messageId=${encodeURIComponent(messageId)}`
      );
    });
    if (r) {
      setAttachments(r.attachments);
      setDocReview(null);
      if (!r.attachments.length) setStatus('No attachments on this email.');
    }
  }

  async function reviewAttachment(att: any) {
    const r = await run(`Reviewing ${att.name}`, async () => {
      requireMatter();
      if (!messageId) throw new Error('No message selected.');
      return api<{ review: any; reviewId: string }>(`/matters/${matterId}/documents/review`, {
        method: 'POST',
        body: JSON.stringify({ messageId, attachmentId: att.id }),
      });
    });
    if (r) setDocReview(r.review);
  }

  function useReviewDraft() {
    if (!docReview?.draftReply) return;
    const dr = docReview.draftReply;
    setDraft({ subject: dr.subject, bodyHtml: dr.bodyHtml, why: [], actions: [], referencedDocuments: [] });
    setDraftSubject(dr.subject);
    setDraftBody(dr.bodyHtml);
    setStatus('Draft loaded in the draft workspace below — review, then create the Outlook draft.');
  }

  // ── Assistant + tasks ────────────────────────────────────────────────────
  // `matterOverride` lets a just-linked matter be read immediately, before the
  // matterId state update has flushed (the auto-run uses the current state).
  async function runAssist(matterOverride?: string) {
    const mid = matterOverride ?? matterId;
    const pollKey = messageId;
    assistPollRef.current = pollKey; // cancels any in-flight poll for a prior email
    setAssistError(false);
    const call = () =>
      api<AssistData>('/assist', {
        method: 'POST',
        // Omit tone so the response matches the precomputed cache; tone-specific
        // redrafts go through the dedicated draft-reply path.
        body: JSON.stringify({ messageId, conversationId, matterId: mid || undefined }),
      });

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

  function openAssistDraft() {
    if (!assist?.draft) return;
    setDraft({ subject: assist.draft.subject, bodyHtml: assist.draft.bodyHtml, why: assist.draft.why, actions: assist.draft.actions, referencedDocuments: [] });
    setDraftSubject(assist.draft.subject);
    setDraftBody(assist.draft.bodyHtml);
    setStatus('Draft ready below — review it, then create the Outlook draft.');
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

  async function addTask() {
    if (!matterId || !newTaskDetail.trim()) return;
    await run('Adding task', async () => {
      await api(`/matters/${matterId}/tasks`, { method: 'POST', body: JSON.stringify({ detail: newTaskDetail.trim() }) });
      setNewTaskDetail('');
      await loadTasks();
      return true;
    });
  }

  async function patchTask(taskId: string, patch: Record<string, unknown>) {
    await run('Updating task', async () => {
      const r = await api<{ task: MatterTask }>(`/matters/${matterId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setTasks((ts) => ts.map((t) => (t.id === taskId ? r.task : t)));
      return true;
    });
  }

  async function assignBlocker(detail: string, assigneeUserId: string) {
    if (!matterId) {
      setStatus('Link a matter first to assign work.');
      return;
    }
    const a = assignees.find((x) => x.id === assigneeUserId);
    await run('Assigning', async () => {
      await api(`/matters/${matterId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ type: 'ENQUIRY', detail, assignee: a ? a.display_name || a.email : null, assigneeUserId, source: 'ASSISTANT', status: 'OPEN' }),
      });
      await loadTasks();
      setStatus('Assigned and written to the Excel tracker.');
      return true;
    });
  }

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
  const recommended: 'reply' | 'action' | 'delegate' | 'ignore' = !cls
    ? 'reply'
    : cls.needsAttention === false
    ? 'ignore'
    : assist?.draft
    ? 'reply'
    : (assist?.outstanding?.length ?? 0) > 0
    ? 'delegate'
    : 'action';
  // The panel that's expanded: the user's explicit pick, else the recommendation.
  const effectiveAction = chosenAction ?? recommended;

  // Log the move the user picked — analytics only, never blocks the UI. This is
  // the only footprint some moves leave (esp. Ignore, and Delegate before a task
  // exists), so the label-vs-action picture in v_email_journey stays complete.
  function recordAction(action: 'reply' | 'action' | 'delegate' | 'ignore') {
    if (!messageId) return;
    api('/triage/action', {
      method: 'POST',
      body: JSON.stringify({ messageId, conversationId: conversationId || undefined, matterId: matterId || undefined, action }),
    }).catch(() => {});
  }

  // "Ignore" needs no other backend — the email's been read, there's just nothing
  // to do — but we still record the decision (above) so it isn't invisible.
  function markIgnore() {
    setIgnored(true);
    setChosenAction('ignore');
    recordAction('ignore');
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

  // Auto-load the OneDrive file list when the Files tab opens, so the literal
  // files show without a click. Best-effort; keyed only on tab + matter.
  useEffect(() => {
    if (tab === 'paperclip' && matterId) loadDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, matterId]);

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <style>{`@keyframes cl-spin{to{transform:rotate(360deg)}}`}</style>
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {me && (
            <button
              style={{ ...S.iconBtn, color: showSetup ? '#5A27E0' : '#94a3b8', background: showSetup ? '#EDE7FB' : 'transparent' }}
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
        </div>
        {me ? (
          <button style={S.account} onClick={openAccount} title="Manage account & billing">
            {plan && (
              <span style={S.planBadge}>
                {plan.plan === 'team'
                  ? 'Team'
                  : plan.plan === 'standard'
                  ? 'Standard'
                  : plan.status === 'trialing'
                  ? 'Trial'
                  : 'Free'}
              </span>
            )}
            <span style={S.user}>{me.displayName || me.email}</span>
            <span style={{ color: '#94a3b8' }}>›</span>
          </button>
        ) : (
          <span style={S.user}>{booting ? 'Connecting…' : connError ? 'Can’t reach server' : 'Not connected'}</span>
        )}
      </header>

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
            <button style={S.primary} onClick={connect}>
              Connect Outlook
            </button>
          )}
        </Card>
      )}

      {/* First run: bring the firm's existing cases in before anything else. */}
      {me && !setupView && (
        <>
          {/* ── Hero: one compact status pill — a coloured dot (green = certain,
                amber = unsure, red = none/error), the matter name, and an expand
                arrow. Always tappable to open the link/create drawer. ── */}
          {(() => {
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
                style={{ ...S.hero, ...m.style }}
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
                <span style={{ fontSize: 12, opacity: 0.6, flex: 'none' }}>{drawerOpen ? '▲' : '▾'}</span>
              </button>
            );
          })()}

          {/* Analysis failed — give the spinner an exit instead of spinning forever. */}
          {messageId && assistError && (
            <Card>
              <p style={S.muted}>We couldn’t finish reading this email. It may have been a temporary hiccup.</p>
              <button style={S.secondary} onClick={() => runAssist()}>Try again</button>
            </Card>
          )}

          {/* No email open — don't leave the pane blank; say what to do and where
              the firm-wide tools are. */}
          {!messageId && !assistError && (
            <Card>
              <button style={S.secondary} onClick={() => setShowSetup(true)}>Setup &amp; import existing cases</button>
            </Card>
          )}

          {/* Matter drawer — two states only: confirm the linked matter, or choose
              a different one (pick a candidate / create new). */}
          {drawerOpen && (
            <Card>
              {matterId && !changing ? (
                // Linked: show the matter, one way to change it.
                <>
                  <Label>Linked matter</Label>
                  <div style={S.candidate}>
                    <strong style={{ fontSize: 13 }}>{linkedRef || 'This matter'}</strong>
                    {linkedAddr && <div style={{ fontSize: 12, color: '#475569' }}>{linkedAddr}</div>}
                  </div>
                  <button style={S.secondary} onClick={() => setChanging(true)}>Change matter</button>
                </>
              ) : (
                // Chooser: candidates to pick from, or create a new matter.
                <>
                  {candidates.length > 0 ? (
                    <>
                      <Label>Likely matters</Label>
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

                  {/* Link to any existing matter, including ones the matcher missed. */}
                  {(() => {
                    const others = matterResults.filter(
                      (m) => m.id !== matterId && !candidates.some((c: any) => c.matterId === m.id)
                    );
                    return (
                      <>
                        <SubLabel>Link a different matter</SubLabel>
                        <input
                          style={S.input}
                          placeholder="Search by reference or address…"
                          value={matterSearch}
                          onChange={(e) => setMatterSearch(e.target.value)}
                        />
                        {others.slice(0, 8).map((m) => (
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
                        {matterSearch.trim() && others.length === 0 && (
                          <p style={S.muted}>No matters match “{matterSearch.trim()}”.</p>
                        )}
                      </>
                    );
                  })()}

                  <div style={{ ...S.rowWrap, marginTop: 8 }}>
                    <button style={!matterId && !showNewMatter ? S.primary : S.secondary} onClick={openNewMatter}>
                      {showNewMatter ? 'Cancel new matter' : '+ New matter'}
                    </button>
                    {matterId && (
                      <button style={S.secondary} onClick={() => setChanging(false)}>Keep current</button>
                    )}
                  </div>
                </>
              )}
            </Card>
          )}

          {/* Tab bar — the matter pill above is the fixed "which matter" anchor;
              these switch what we show for it. House/Files need a linked matter. */}
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
              <div style={S.rowWrap}>
                <span style={S.chip}>{humanize(assist.classification.intent)}</span>
                <span style={{ ...S.chip, background: assist.classification.needsAttention ? '#fee2e2' : '#dcfce7' }}>
                  {assist.classification.needsAttention ? 'Needs you' : 'FYI'}
                </span>
                <span style={S.chip}>{humanize(assist.classification.urgency)}</span>
              </div>
              <p style={{ fontSize: 13, lineHeight: 1.5, color: '#0f172a', margin: '8px 0 10px' }}>{assist.ask}</p>

              {assist.whatWeKnow.length > 0 ? (
                <>
                  <SubLabel>What we know</SubLabel>
                  <ul style={S.ul}>{assist.whatWeKnow.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </>
              ) : !assist.ready ? (
                <>
                  <SubLabel>What we know</SubLabel>
                  <p style={S.muted}>Reading the thread…</p>
                </>
              ) : null}

              {/* The four moves. The recommended one is pre-lit; pick any to expand it. */}
              <SubLabel>What do you want to do?</SubLabel>
              <div style={S.actionRow}>
                {([
                  ['reply', 'reply', 'Reply'],
                  ['action', 'check', 'Action'],
                  ['delegate', 'user', 'Delegate'],
                  ['ignore', 'minus', 'Ignore'],
                ] as const).map(([key, icon, lbl]) => {
                  const active = effectiveAction === key;
                  const isRec = recommended === key;
                  return (
                    <button
                      key={key}
                      style={{ ...S.actionBtn, ...(active ? S.actionBtnActive : {}) }}
                      onClick={() => {
                        if (key === 'ignore') { markIgnore(); return; }
                        recordAction(key);
                        setChosenAction(key);
                      }}
                    >
                      <Icon name={icon} size={18} />
                      <span>{lbl}</span>
                      {isRec && <span style={S.recDot} title="Suggested" />}
                    </button>
                  );
                })}
              </div>

              {/* Reply */}
              {effectiveAction === 'reply' && (
                <div style={S.actionPanel}>
                  {assist.draft ? (
                    <button style={S.primary} onClick={openAssistDraft}>Open draft for review</button>
                  ) : !assist.ready ? (
                    <p style={S.muted}>Preparing a draft…</p>
                  ) : (
                    <button style={S.primary} onClick={generateDraft}>Draft a reply</button>
                  )}
                </div>
              )}

              {/* Action — do something on the matter yourself */}
              {effectiveAction === 'action' && (
                <div style={S.actionPanel}>
                  <div style={S.rowWrap}>
                    <button style={S.secondary} onClick={extractFacts}>Extract facts → tracker</button>
                    <button style={S.secondary} onClick={saveToMatter}>Save email to matter</button>
                  </div>
                </div>
              )}

              {/* Delegate — hand the open items (or the whole email) to a colleague */}
              {effectiveAction === 'delegate' && (
                <div style={S.actionPanel}>
                  {assist.outstanding.length > 0 ? (
                    <>
                      {assist.outstanding.map((o, i) => (
                        <div key={i} style={S.candidate}>
                          <div style={{ fontSize: 12, color: '#0f172a', marginBottom: 4 }}>{o}</div>
                          <select
                            style={{ ...S.input, marginBottom: 0 }}
                            defaultValue=""
                            onChange={(e) => { if (e.target.value) assignBlocker(o, e.target.value); }}
                          >
                            <option value="">Assign to…</option>
                            {assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
                          </select>
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      <select
                        style={{ ...S.input, marginBottom: 0 }}
                        defaultValue=""
                        onChange={(e) => { if (e.target.value) assignBlocker(`Handle email: ${cleanSubject(subject) || 'this thread'}`, e.target.value); }}
                      >
                        <option value="">Delegate to…</option>
                        {assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
                      </select>
                    </>
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
              <Label>New matter</Label>
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
              <Label>Extracted facts{!matterId && ' — not saved (link a matter to persist)'}</Label>
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

          {/* Draft workspace */}
          {tab === 'email' && draft && (
            <Card>
              <Label>Draft reply — never auto-sent</Label>
              <div style={S.rowWrap}>
                {TONES.map((t) => (
                  <button key={t} style={t === tone ? S.toneActive : S.tone} onClick={() => setTone(t)}>
                    {humanize(t)}
                  </button>
                ))}
                <button style={S.secondary} onClick={generateDraft}>Regenerate</button>
              </div>
              <SubLabel>Subject</SubLabel>
              <input style={S.input} value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} />
              <SubLabel>Body</SubLabel>
              <textarea style={S.textarea} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={8} />
              {draft.why.length > 0 && (
                <>
                  <SubLabel>Why this draft</SubLabel>
                  <ul style={S.ul}>{draft.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </>
              )}
              {draft.actions.length > 0 && (
                <>
                  <SubLabel>Next actions</SubLabel>
                  <ul style={S.ul}>{draft.actions.map((a, i) => <li key={i}>{a.owner}: {a.task} ({a.due})</li>)}</ul>
                </>
              )}
              <button style={S.primary} onClick={createOutlookDraft}>Create Outlook draft</button>
            </Card>
          )}

          {/* ── Task management lives on the EMAIL tab (the work surface) ── */}
          {tab === 'email' && (
            <button
              style={{ ...S.secondary, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10, opacity: boardLoading ? 0.7 : 1 }}
              onClick={buildBoard}
              disabled={boardLoading}
            >
              {boardLoading ? <span style={S.spinner} /> : <Icon name="chart" size={15} />}
              {boardLoading ? 'Syncing…' : 'Team tracker'}
            </button>
          )}

          {/* Task board — lives in the matter's Excel tracker, two-way synced. */}
          {tab === 'email' && matterId && (
            <Section title="Tasks" count={tasks.length}>
              <p style={S.muted}>Two-way synced with the matter’s Excel tracker.</p>
              {tasks.length === 0 && <p style={S.muted}>No tasks yet.</p>}
              {tasks.map((t) => {
                const assigneeId = assignees.find((a) => (a.display_name || a.email) === t.assignee)?.id || '';
                const statusBg = t.status === 'DONE' ? '#dcfce7' : t.status === 'IN_PROGRESS' ? '#fef9c3' : t.status === 'NOTED' ? '#e2e8f0' : '#fee2e2';
                return (
                  <div key={t.id} style={S.candidate}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: '#64748b' }}>{t.ref} · {humanize(t.type)}</span>
                      <select
                        style={{ ...S.chip, background: statusBg, border: 'none', cursor: 'pointer', textTransform: 'none' }}
                        value={t.status}
                        onChange={(e) => patchTask(t.id, { status: e.target.value })}
                      >
                        {['OPEN', 'IN_PROGRESS', 'DONE', 'NOTED'].map((s) => (
                          <option key={s} value={s}>{humanize(s)}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ fontSize: 13, color: '#0f172a', margin: '5px 0' }}>{t.detail}</div>
                    <div style={S.rowWrap}>
                      <select
                        style={{ ...S.input, marginBottom: 0, flex: 1 }}
                        value={assigneeId}
                        onChange={(e) => {
                          const a = assignees.find((x) => x.id === e.target.value);
                          patchTask(t.id, { assignee: a ? a.display_name || a.email : null, assigneeUserId: a ? a.id : null });
                        }}
                      >
                        <option value="">Unassigned</option>
                        {assignees.map((a) => (
                          <option key={a.id} value={a.id}>{a.display_name || a.email}</option>
                        ))}
                      </select>
                      <input
                        type="date"
                        style={{ ...S.input, marginBottom: 0, width: 132 }}
                        value={t.due ? String(t.due).slice(0, 10) : ''}
                        onChange={(e) => patchTask(t.id, { due: e.target.value })}
                      />
                    </div>
                  </div>
                );
              })}
              <div style={{ ...S.rowWrap, marginTop: 4 }}>
                <input
                  style={{ ...S.input, marginBottom: 0, flex: 1 }}
                  placeholder="Add a task…"
                  value={newTaskDetail}
                  onChange={(e) => setNewTaskDetail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addTask();
                  }}
                />
                <button style={S.secondary} onClick={addTask}>Add</button>
              </div>
            </Section>
          )}

          {/* ── HOUSE TAB — the property/transaction record (details only) ── */}
          {tab === 'house' && matterInfo?.matter && (() => {
            const m = matterInfo.matter;
            const facts: Record<string, unknown> = matterInfo.summary?.facts ?? {};
            // No price column historically — prefill from the first price-like fact.
            const priceKey = Object.keys(facts).find((k) => /price|consideration|value|offer/i.test(k));
            const join = (a?: string[]) => (a && a.length ? a.join(', ') : '');
            const row = (label: string, val: unknown) =>
              val ? <div style={S.kv}><span>{label}</span><span style={{ textAlign: 'right' }}>{String(val)}</span></div> : null;
            // Editable, two-way: edits PATCH the matter on blur (only when changed
            // from the stored baseline), then the panel reloads. Uncontrolled +
            // keyed per matter so switching matters resets the inputs.
            const edit = (label: string, field: string, display: string, baseline: string, type = 'text') => (
              <label key={`${m.id}:${field}`} style={{ display: 'block', marginBottom: 6 }}>
                <span style={S.fieldLabel}>{label}</span>
                <input
                  style={{ ...S.input, marginBottom: 0 }}
                  type={type}
                  defaultValue={display}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== baseline) updateMatterField({ [field]: v }); }}
                />
              </label>
            );
            const date = (s: unknown) => (s ? String(s).slice(0, 10) : '');
            const extra = Object.entries(facts).filter(([k]) => k !== priceKey);
            return (
              <Card>
                <Label>{m.matter_ref}</Label>
                {edit('Property address', 'propertyAddress', m.property_address ?? '', m.property_address ?? '')}
                {edit('Purchase price', 'purchasePrice', m.purchase_price ?? (priceKey ? String(facts[priceKey]) : ''), m.purchase_price ?? '')}
                {row('Buyer(s)', join(m.buyer_names))}
                {row('Seller(s)', join(m.seller_names))}
                {edit('Other side (solicitor)', 'counterpartySolicitor', m.counterparty_solicitor ?? '', m.counterparty_solicitor ?? '')}
                {edit('Estate agent', 'counterpartyAgent', m.counterparty_agent ?? '', m.counterparty_agent ?? '')}
                {edit('Lender', 'lender', m.lender ?? '', m.lender ?? '')}
                {edit('Chain position', 'chainPosition', m.chain_position ?? '', m.chain_position ?? '')}
                <div style={{ display: 'flex', gap: 6 }}>
                  {edit('Exchange target', 'exchangeTargetDate', date(m.exchange_target_date), date(m.exchange_target_date), 'date')}
                  {edit('Completion target', 'completionTargetDate', date(m.completion_target_date), date(m.completion_target_date), 'date')}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <label style={{ flex: 1 }}>
                    <span style={S.fieldLabel}>Stage</span>
                    <select
                      style={{ ...S.input, marginBottom: 0 }}
                      value={m.stage || 'INSTRUCTION'}
                      onChange={(e) => updateMatterField({ stage: e.target.value })}
                    >
                      {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                  <label style={{ flex: 1 }}>
                    <span style={S.fieldLabel}>Status</span>
                    <select
                      style={{ ...S.input, marginBottom: 0 }}
                      value={m.status_flag || 'ON_TRACK'}
                      onChange={(e) => updateMatterField({ statusFlag: e.target.value })}
                    >
                      {STATUS_FLAGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                </div>
                {extra.length > 0 && (
                  <>
                    <SubLabel>Other extracted facts</SubLabel>
                    {extra.map(([k, v]) => (
                      <div key={k} style={S.kv}>
                        <span>{humanize(k)}</span>
                        <span style={{ textAlign: 'right' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                      </div>
                    ))}
                  </>
                )}
              </Card>
            );
          })()}

          {/* ── FILES TAB — the literal files in the matter's OneDrive folder ── */}
          {tab === 'paperclip' && matterId && (
            <Card>
              <Label>Files</Label>
              <p style={S.muted}>The documents saved to this matter&apos;s OneDrive folder.</p>
              <div style={S.rowWrap}>
                {matterInfo?.matter?.folder_web_url && (
                  <a
                    style={{ ...S.secondary, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
                    href={matterInfo.matter.folder_web_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="clip" size={14} /> Open folder
                  </a>
                )}
                {matterInfo?.matter?.tracker_web_url && (
                  <a
                    style={{ ...S.secondary, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
                    href={matterInfo.matter.tracker_web_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="chart" size={14} /> Tracker.xlsx
                  </a>
                )}
                <button style={S.secondary} onClick={loadDocs}>Refresh</button>
              </div>
              {docs.length > 0 ? (
                <div style={S.fileList}>
                  {[...docs]
                    .sort((a, b) => String(a.file_name || '').localeCompare(String(b.file_name || '')))
                    .map((d) => {
                      const ext = (String(d.file_name || '').split('.').pop() || '').toUpperCase().slice(0, 4) || 'FILE';
                      const when = d.created_at ? new Date(d.created_at).toLocaleDateString('en-GB') : '';
                      return (
                        <a
                          key={d.id}
                          style={S.fileRow}
                          href={d.web_url || undefined}
                          target="_blank"
                          rel="noreferrer"
                          title={d.file_name}
                        >
                          <span style={S.fileExt}>{ext}</span>
                          <span style={S.fileName}>{d.file_name}</span>
                          {when && <span style={S.fileMeta}>{when}</span>}
                        </a>
                      );
                    })}
                </div>
              ) : (
                <p style={S.muted}>No files saved to this matter yet — save an email&apos;s attachments from the Email tab.</p>
              )}
            </Card>
          )}

          {/* Find attachments & share — reply/collaboration helpers (Email tab). */}
          {tab === 'email' && matterId && (
            <Section title="Find attachments & share">
              <button style={S.secondary} onClick={suggestAttachments}>Suggest attachments for a reply</button>
              <input
                style={{ ...S.input, marginTop: 6 }}
                placeholder="What's the reply about? (improves suggestions)"
                value={attachmentIntent}
                onChange={(e) => setAttachmentIntent(e.target.value)}
              />
              {suggestions.length > 0 && (
                <>
                  <SubLabel>Suggested attachments</SubLabel>
                  <ul style={S.ul}>
                    {suggestions.map((s) => (
                      <li key={s.id}>
                        {s.web_url ? <a style={S.link} href={s.web_url} target="_blank" rel="noreferrer">{s.file_name}</a> : s.file_name}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <SubLabel>Post matter summary to Teams</SubLabel>
              <div style={S.rowWrap}>
                <Field label="Team ID" value={teamId} onChange={setTeamId} />
                <Field label="Channel ID" value={channelId} onChange={setChannelId} />
              </div>
              <button style={S.secondary} onClick={postToTeams} disabled={!teamId || !channelId}>
                Post to Teams
              </button>
            </Section>
          )}

          {/* Review a document */}
          {tab === 'email' && matterId && (
            <Section title="Review a document" count={attachments.length || undefined}>
              <button style={S.secondary} onClick={listAttachments} disabled={!messageId}>
                List attachments on this email
              </button>
              {attachments.map((a) => (
                <div key={a.id} style={S.candidate}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.name}
                      {a.size ? ` · ${Math.round(a.size / 1024)} KB` : ''}
                    </span>
                    <button style={S.secondary} onClick={() => reviewAttachment(a)}>
                      Review
                    </button>
                  </div>
                </div>
              ))}

              {docReview && (
                <div style={{ marginTop: 8 }}>
                  <SubLabel>{docReview.documentType}</SubLabel>
                  <p style={S.muted}>{docReview.summary}</p>

                  {(docReview.consistencyChecks ?? []).length > 0 && (
                    <>
                      <SubLabel>Details vs matter</SubLabel>
                      {docReview.consistencyChecks.map((c: any, i: number) => {
                        const bg =
                          c.status === 'MATCH' ? '#dcfce7' : c.status === 'MISMATCH' ? '#fee2e2' : c.status === 'MISSING' ? '#fef9c3' : '#e2e8f0';
                        return (
                          <div key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: 6, marginBottom: 4, background: '#fff' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                              <strong style={{ fontSize: 12 }}>{c.field}</strong>
                              <span style={{ ...S.chip, background: bg }}>{c.status}</span>
                            </div>
                            <div style={{ fontSize: 11, color: '#475569' }}>
                              matter: {c.expected || '—'} · doc: {c.found || '—'}
                            </div>
                            {c.note && <div style={{ fontSize: 11, color: '#64748b' }}>{c.note}</div>}
                          </div>
                        );
                      })}
                    </>
                  )}

                  {(docReview.risks ?? []).length > 0 && (
                    <>
                      <SubLabel>Risks</SubLabel>
                      <ul style={S.ul}>
                        {docReview.risks.map((r: any, i: number) => (
                          <li key={i}>
                            <strong style={{ color: r.severity === 'HIGH' ? '#b91c1c' : r.severity === 'MEDIUM' ? '#b45309' : '#475569' }}>
                              {r.severity}:
                            </strong>{' '}
                            {r.issue}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {(docReview.keyDetails ?? []).length > 0 && (
                    <>
                      <SubLabel>Key details</SubLabel>
                      <ul style={S.ul}>
                        {docReview.keyDetails.map((k: any, i: number) => (
                          <li key={i}>
                            <strong>{k.label}:</strong> {k.value}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {(docReview.nextSteps ?? []).length > 0 && (
                    <>
                      <SubLabel>Suggested next steps</SubLabel>
                      <ul style={S.ul}>
                        {docReview.nextSteps.map((s: string, i: number) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </>
                  )}

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 7,
                      marginTop: 8,
                      padding: '8px 10px',
                      background: '#fffbeb',
                      border: '1px solid #fde68a',
                      borderRadius: 6,
                      fontSize: 11,
                      color: '#92400e',
                    }}
                  >
                    <Icon name="alert" size={14} />
                    <span>AI-generated review — it can miss or misread things. Always verify against the source document before relying on it.</span>
                  </div>

                  {docReview.draftReply && (
                    <button style={{ ...S.primary, marginTop: 8 }} onClick={useReviewDraft}>
                      Use as draft reply
                    </button>
                  )}
                </div>
              )}
            </Section>
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
            <Label>Onboard existing cases</Label>

            {(!obJob || ['COMPLETED', 'CANCELLED', 'FAILED'].includes(obJob.status)) && (
              <>
                <p style={S.muted}>Find live cases in your mailbox and import them as matters — you pick which to keep.</p>
                <SubLabel>How far back</SubLabel>
                <select style={S.input} value={obLookback} onChange={(e) => setObLookback(e.target.value as '3' | 'unlimited')}>
                  <option value="3">Last 3 months</option>
                  <option value="unlimited">All history (premium)</option>
                </select>
                <button style={S.primary} onClick={startOnboarding}>
                  Scan my inbox
                </button>
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
                {obCases
                  .filter((c) => c.status === 'PROPOSED')
                  .map((c) => {
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
                <button style={S.primary} onClick={confirmOnboarding}>
                  Onboard selected
                </button>
                <button style={{ ...S.secondary, marginTop: 6 }} onClick={cancelOnboarding}>
                  Discard
                </button>
              </>
            )}

            {obJob?.status === 'COMPLETED' && obCases.some((c) => c.status === 'ONBOARDED') && (
              <>
                <SubLabel>Onboarded</SubLabel>
                <ul style={S.ul}>
                  {obCases
                    .filter((c) => c.status === 'ONBOARDED')
                    .map((c) => (
                      <li key={c.id}>{c.property_address}</li>
                    ))}
                </ul>
              </>
            )}
          </Card>

          {/* AI engine + auto-triage */}
          <Card>
            <Label>AI engine</Label>
            <p style={S.muted}>
              {aiConnected === null ? 'Status unknown.' : aiConnected ? 'Per-user key connected.' : 'Using the firm’s central Claude key.'}
            </p>
            <SubLabel>Auto-triage</SubLabel>
            <p style={S.muted}>
              {autoTriage?.enabled
                ? 'On — new inbox mail is auto-matched, tagged, and run through your firm’s auto-rules.'
                : 'Off — turn on to triage & tag incoming mail automatically (requires the deployed app).'}
            </p>
            <button style={autoTriage?.enabled ? S.secondary : S.primary} onClick={toggleAutoTriage}>
              {autoTriage?.enabled ? 'Turn off auto-triage' : 'Turn on auto-triage'}
            </button>
          </Card>
        </>
      )}

      {(busy || status) && (
        <div style={{ ...S.toast, ...(busy ? S.toastBusy : {}) }}>{busy ? `${busy}…` : status}</div>
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
function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}

// Small inline SVG icons, stroke-based to match the header gear — keeps the
// taskpane emoji-free and crisp at any zoom. Inherits colour from the parent.
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    reply: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 5 5v4" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 8 9 6 9-6" /></>,
    home: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
    clip: <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.9-2.9l7.6-7.6" />,
    check: <path d="M20 6 9 17l-5-5" />,
    user: <><circle cx="12" cy="8" r="4" /><path d="M5 21a7 7 0 0 1 14 0" /></>,
    minus: <path d="M5 12h14" />,
    chart: <><path d="M4 4v16h16" /><path d="M8 17v-5" /><path d="M13 17V8" /><path d="M18 17v-3" /></>,
    sparkle: <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />,
    alert: <><path d="M10.3 4 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 4a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
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
  tabBar: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginBottom: 12, background: '#f1f5f9', padding: 4, borderRadius: 10 },
  tabBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 6px', background: 'transparent', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, color: '#475569', cursor: 'pointer' },
  tabBtnActive: { background: '#fff', color: '#5A27E0', boxShadow: '0 1px 2px rgba(0,0,0,0.06)' },
  tabBtnLocked: { opacity: 0.4, cursor: 'not-allowed' },
  fileList: { border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff', marginTop: 4 },
  fileRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderBottom: '1px solid #f1f5f9', textDecoration: 'none', color: '#0f172a', cursor: 'pointer' },
  fileExt: { flex: 'none', width: 38, textAlign: 'center', fontSize: 9, fontWeight: 700, letterSpacing: 0.3, color: '#5A27E0', background: '#EDE7FB', borderRadius: 4, padding: '3px 0' },
  fileName: { flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  fileMeta: { flex: 'none', fontSize: 11, color: '#94a3b8' },
  actionRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 4 },
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
