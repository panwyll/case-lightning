'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { randomMatterRef } from '@/lib/ref-name';

// ── Minimal Office.js typings (we only touch the mailbox item) ───────────────
declare global {
  interface Window {
    Office?: {
      onReady: (cb: (info: { host: string }) => void) => void;
      context?: { mailbox?: { item?: OfficeItem } };
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
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
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

  // Which top-level view is showing. The taskpane is organised by what the user
  // is doing (triage this email → manage the matter → set things up) rather than
  // by feature, so the narrow pane stays focused instead of an endless scroll.
  const [tab, setTab] = useState<'email' | 'matter' | 'setup'>('email');

  // Assistant ("here's the situation") + the matter task board ("Jira in Excel").
  const [assist, setAssist] = useState<AssistData | null>(null);
  const [tasks, setTasks] = useState<MatterTask[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [newTaskDetail, setNewTaskDetail] = useState('');
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

  const officeReady = useRef(false);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch {
      setMe(null);
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
    if (started) driveOnboarding();
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
        window.Office.onReady(() => {
          const item = window.Office?.context?.mailbox?.item;
          if (item?.itemId) setMessageId(item.itemId);
          if (item?.conversationId) setConversationId(item.conversationId);
          if (item?.subject) setSubject(item.subject);
          if (item?.from?.emailAddress) {
            setSender({ name: item.from.displayName || item.from.emailAddress, email: item.from.emailAddress });
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

  async function linkThread() {
    await run('Linking thread', async () => {
      requireMatter();
      requireThread();
      await api(`/matters/${matterId}/link-thread`, {
        method: 'POST',
        body: JSON.stringify({ graphThreadId: conversationId, graphConversationId: conversationId, subject }),
      });
      setStatus('Thread linked to matter.');
    });
  }

  async function loadMatter(id = matterId) {
    await run('Loading matter', async () => {
      if (!id) throw new Error('No matter id');
      setMatterInfo(await api(`/matters/${id}`));
    });
  }

  async function findMatter() {
    const r = await run('Finding matter', async () => {
      if (!messageId) throw new Error('Open an email first.');
      return api('/triage', { method: 'POST', body: JSON.stringify({ messageId, conversationId }) });
    });
    if (r) {
      setTriage(r);
      setRiskOk(false);
    }
  }

  async function useCandidate(c: any) {
    await run('Linking match', async () => {
      await api('/triage/apply', {
        method: 'POST',
        body: JSON.stringify({
          triageId: triage?.triageId,
          matterId: c.matterId,
          messageId,
          conversationId,
          band: c.band,
          riskAccepted: c.band === 'AUTO' ? true : riskOk,
        }),
      });
      setMatterId(c.matterId);
      setTriage(null);
      await loadMatter(c.matterId);
      setStatus(`Linked to ${c.matterRef}.`);
    });
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
  async function runAssist() {
    const r = await run('Reading the email', async () => {
      requireThread();
      if (!messageId) throw new Error('Open an email first.');
      return api<AssistData>('/assist', {
        method: 'POST',
        body: JSON.stringify({ messageId, conversationId, matterId: matterId || undefined, tone }),
      });
    });
    if (r) {
      setAssist(r);
      if (r.matter && !matterId) {
        setMatterId(r.matter.id);
        loadMatter(r.matter.id);
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

  // The single most likely next step for the open email — shown as the hero
  // action so the user isn't faced with a flat grid of equal-weight verbs.
  // Mirrors Jira's "next transition": read-only updates → Summarise; anything
  // that needs a response → Draft reply.
  const emailActions: Array<{ key: string; label: string; onClick: () => void; needsMatter?: boolean }> = [
    { key: 'draft', label: 'Draft reply', onClick: generateDraft },
    { key: 'summarise', label: 'Summarise', onClick: summarise },
    { key: 'facts', label: 'Extract facts', onClick: extractFacts },
    { key: 'save', label: 'Save to matter', onClick: saveToMatter, needsMatter: true },
  ];
  const noReplyNeeded = triage?.classification?.needsAttention === false;
  const primaryKey = noReplyNeeded ? 'summarise' : 'draft';
  const primaryAction = emailActions.find((a) => a.key === primaryKey)!;
  const otherActions = emailActions.filter((a) => a.key !== primaryKey);

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#5A27E0" />
            <path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </svg>
          <strong style={{ fontSize: 15 }}>
            CONVE<span style={{ color: '#5A27E0' }}>Yi</span>
          </strong>
        </div>
        {me ? (
          <button style={S.account} onClick={openAccount} title="Manage account & billing">
            <span style={S.planBadge}>
              {plan?.plan === 'team'
                ? 'Team'
                : plan?.plan === 'standard'
                ? 'Standard'
                : plan?.status === 'trialing'
                ? 'Trial'
                : 'Free'}
            </span>
            <span style={S.user}>{me.displayName || me.email}</span>
            <span style={{ color: '#94a3b8' }}>›</span>
          </button>
        ) : (
          <span style={S.user}>Not connected</span>
        )}
      </header>

      {!me && (
        <Card>
          <p style={S.muted}>Connect your Microsoft 365 account to read the current thread and manage cases.</p>
          <button style={S.primary} onClick={connect}>
            Connect Outlook
          </button>
        </Card>
      )}

      {me && (
        <>
          {/* Thread context */}
          <Card>
            <Label>Current thread</Label>
            <div style={S.threadSubject}>{subject || '— open an email —'}</div>
            {matterInfo?.matter ? (
              <div style={S.linkedMatter}>
                <span>📁 {matterInfo.matter.matter_ref}</span>
                <button style={S.tagX} onClick={() => { setMatterId(''); setMatterInfo(null); }} title="Unlink">×</button>
              </div>
            ) : (
              <p style={S.muted}>No matter linked yet. Find a match, or create one.</p>
            )}
            <div style={S.rowWrap}>
              <button style={S.secondary} onClick={findMatter} disabled={!messageId}>
                Find matter
              </button>
              <button style={S.secondary} onClick={openNewMatter}>
                {showNewMatter ? 'Cancel' : 'New matter'}
              </button>
              <button style={S.secondary} onClick={linkThread} disabled={!matterId || !conversationId}>
                Link thread
              </button>
              <button style={S.secondary} onClick={() => loadMatter()} disabled={!matterId}>
                Refresh
              </button>
            </div>
          </Card>

          {/* Top-level navigation — keeps the narrow pane focused on one job at a time. */}
          <div style={S.tabBar} role="tablist">
            {([
              ['email', 'This email'],
              ['matter', 'Matter'],
              ['setup', 'Setup'],
            ] as const).map(([key, lbl]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                style={tab === key ? { ...S.tab, ...S.tabActive } : S.tab}
                onClick={() => setTab(key)}
              >
                {lbl}
              </button>
            ))}
          </div>

          {tab === 'email' && (
          <>
          {/* Assistant — the situation + the recommended move, in one pass. */}
          <Card>
            {!assist ? (
              <>
                <Label>AI assistant</Label>
                <p style={S.muted}>Let CaseLightning read this email, pull what we already know, and prepare the reply.</p>
                <button style={S.primary} onClick={runAssist} disabled={!messageId}>
                  Analyse this email
                </button>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                  <span style={S.assistIcon}>✦</span>
                  <span style={S.label}>Here&apos;s the situation</span>
                </div>
                <div style={S.rowWrap}>
                  <span style={S.chip}>{assist.classification.intent.replace(/_/g, ' ')}</span>
                  <span style={{ ...S.chip, background: assist.classification.needsAttention ? '#fee2e2' : '#dcfce7' }}>
                    {assist.classification.needsAttention ? 'Needs you' : 'FYI'}
                  </span>
                  <span style={S.chip}>{assist.classification.urgency}</span>
                </div>
                <p style={{ fontSize: 13, lineHeight: 1.5, color: '#0f172a', margin: '8px 0 10px' }}>{assist.ask}</p>
                {assist.matter && (
                  <div style={S.linkedMatter}><span>📁 {assist.matter.matterRef}</span></div>
                )}

                {assist.whatWeKnow.length > 0 && (
                  <>
                    <SubLabel>What we know</SubLabel>
                    <ul style={S.ul}>{assist.whatWeKnow.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </>
                )}

                {assist.outstanding.length > 0 && (
                  <>
                    <SubLabel>Blockers — assign to clear</SubLabel>
                    {assist.outstanding.map((o, i) => (
                      <div key={i} style={S.candidate}>
                        <div style={{ fontSize: 12, color: '#0f172a', marginBottom: 4 }}>{o}</div>
                        <select
                          style={{ ...S.input, marginBottom: 0 }}
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) assignBlocker(o, e.target.value);
                          }}
                        >
                          <option value="">{matterId ? 'Assign to…' : 'Link a matter to assign'}</option>
                          {assignees.map((a) => (
                            <option key={a.id} value={a.id}>{a.display_name || a.email}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </>
                )}

                {assist.draft ? (
                  <button style={S.primary} onClick={openAssistDraft}>Open draft for review</button>
                ) : (
                  <p style={{ ...S.muted, marginTop: 8 }}>No reply needed — looks like an update to note.</p>
                )}
                <button style={{ ...S.secondary, marginTop: 6 }} onClick={runAssist}>Re-analyse</button>
              </>
            )}
          </Card>

          {triage && (
            <Card>
              <Label>Suggested match</Label>
              <div style={S.rowWrap}>
                <span style={S.chip}>{triage.classification?.intent}</span>
                <span style={{ ...S.chip, background: triage.classification?.needsAttention ? '#fee2e2' : '#dcfce7' }}>
                  {triage.classification?.needsAttention ? 'Needs attention' : 'No action needed'}
                </span>
                <span style={S.chip}>{triage.classification?.urgency}</span>
              </div>
              <p style={S.muted}>{triage.classification?.reason}</p>

              {(triage.candidates ?? []).length === 0 && (
                <p style={S.muted}>No candidate matters found from the thread. Create or link one manually.</p>
              )}

              {(triage.candidates ?? []).map((c: any) => {
                const pct = Math.round((c.score ?? 0) * 100);
                const auto = c.band === 'AUTO';
                return (
                  <div key={c.matterId} style={S.candidate}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: 13 }}>{c.matterRef}</strong>
                      <span style={{ ...S.confidence, background: auto ? '#dcfce7' : pct >= 60 ? '#fef9c3' : '#fee2e2' }}>
                        {pct}% · {c.band}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: '#475569' }}>{c.propertyAddress}</div>
                    <ul style={{ ...S.ul, fontSize: 11, color: '#64748b' }}>
                      {(c.signals ?? []).map((s: any, i: number) => (
                        <li key={i}>{s.detail}</li>
                      ))}
                    </ul>
                    {!auto && (
                      <label style={{ display: 'flex', gap: 6, fontSize: 11, color: '#b91c1c', margin: '4px 0' }}>
                        <input type="checkbox" checked={riskOk} onChange={(e) => setRiskOk(e.target.checked)} />
                        Below the high-confidence bar — I accept this is a subpar match.
                      </label>
                    )}
                    <button style={S.secondary} onClick={() => useCandidate(c)} disabled={!auto && !riskOk}>
                      Use this matter
                    </button>
                  </div>
                );
              })}
            </Card>
          )}

          {showNewMatter && (
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

          {/* Act on this email — one recommended step up top, the rest below. */}
          <Card>
            <Label>{noReplyNeeded ? 'Recommended: summarise' : 'Recommended: draft a reply'}</Label>
            {!conversationId ? (
              <p style={S.muted}>Open an email to summarise it, extract facts, or draft a reply. Saving to a matter needs one linked.</p>
            ) : (
              <>
                <button style={S.primary} onClick={primaryAction.onClick}>{primaryAction.label}</button>
                <div style={{ ...S.grid, marginTop: 8 }}>
                  {otherActions.map((a) => (
                    <button
                      key={a.key}
                      style={btn(S.secondary, !!a.needsMatter && !matterId)}
                      onClick={a.onClick}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Card>

          {summary && (
            <Card>
              <Label>Summary</Label>
              <SubLabel>Happened</SubLabel>
              <ul style={S.ul}>{summary.happened.map((h, i) => <li key={i}>{h}</li>)}</ul>
              <SubLabel>Outstanding</SubLabel>
              <ul style={S.ul}>{summary.outstanding.map((o, i) => <li key={i}>{o}</li>)}</ul>
            </Card>
          )}

          {facts && (
            <Card>
              <Label>Extracted facts{!matterId && ' — not saved (link a matter to persist)'}</Label>
              {Object.entries(facts.facts).map(([k, v]) => (
                <div key={k} style={S.kv}>
                  <span>{k}</span>
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
          {draft && (
            <Card>
              <Label>Draft reply — never auto-sent</Label>
              <div style={S.rowWrap}>
                {TONES.map((t) => (
                  <button key={t} style={t === tone ? S.toneActive : S.tone} onClick={() => setTone(t)}>
                    {t}
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
          </>
          )}

          {tab === 'matter' && (
          <>
          {!matterId && (
            <Card>
              <p style={S.muted}>No matter linked. Open an email in the <strong>This email</strong> tab and link or create a matter, then manage it here.</p>
            </Card>
          )}

          {/* Task board — lives in the matter's Excel tracker, two-way synced. */}
          {matterId && (
            <Card>
              <Label>Tasks</Label>
              <p style={S.muted}>Synced with this matter&apos;s Tracker.xlsx — change them here or in Excel, both stay in step.</p>
              {tasks.length === 0 && <p style={S.muted}>No tasks yet. Add one below, or the assistant will when you assign a blocker.</p>}
              {tasks.map((t) => {
                const assigneeId = assignees.find((a) => (a.display_name || a.email) === t.assignee)?.id || '';
                const statusBg = t.status === 'DONE' ? '#dcfce7' : t.status === 'IN_PROGRESS' ? '#fef9c3' : t.status === 'NOTED' ? '#e2e8f0' : '#fee2e2';
                return (
                  <div key={t.id} style={S.candidate}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: '#64748b' }}>{t.ref} · {t.type}</span>
                      <select
                        style={{ ...S.chip, background: statusBg, border: 'none', cursor: 'pointer' }}
                        value={t.status}
                        onChange={(e) => patchTask(t.id, { status: e.target.value })}
                      >
                        {['OPEN', 'IN_PROGRESS', 'DONE', 'NOTED'].map((s) => (
                          <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
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
            </Card>
          )}

          {/* Matter panel */}
          {matterInfo?.matter && (
            <Card>
              <Label>Matter {matterInfo.matter.matter_ref}</Label>
              <div style={S.kv}><span>Property</span><span>{matterInfo.matter.property_address}</span></div>
              {matterInfo.matter.folder_web_url && (
                <a style={S.link} href={matterInfo.matter.folder_web_url} target="_blank" rel="noreferrer">Open OneDrive folder →</a>
              )}
              {matterInfo.matter.tracker_web_url && (
                <a style={S.link} href={matterInfo.matter.tracker_web_url} target="_blank" rel="noreferrer">Open Excel tracker →</a>
              )}
              {(matterInfo.summary?.outstanding_items?.length ?? 0) > 0 && (
                <>
                  <SubLabel>Outstanding</SubLabel>
                  <ul style={S.ul}>{matterInfo.summary.outstanding_items.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul>
                </>
              )}
            </Card>
          )}

          {/* Documents & sharing */}
          {matterId && (
            <Card>
              <Label>Documents &amp; sharing</Label>
              <div style={S.rowWrap}>
                <button style={S.secondary} onClick={loadDocs}>List documents</button>
                <button style={S.secondary} onClick={suggestAttachments}>Suggest attachments</button>
              </div>
              <input
                style={S.input}
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
              {docs.length > 0 && (
                <>
                  <SubLabel>All documents</SubLabel>
                  <ul style={S.ul}>
                    {docs.map((d) => (
                      <li key={d.id}>
                        {d.web_url ? <a style={S.link} href={d.web_url} target="_blank" rel="noreferrer">{d.file_name}</a> : d.file_name}
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
            </Card>
          )}

          {/* Review a document */}
          {matterId && (
            <Card>
              <Label>Review a document</Label>
              <p style={S.muted}>
                Read an incoming attachment and check it against this matter — key details, mismatches, risks and a draft
                reply.
              </p>
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
                      marginTop: 8,
                      padding: '8px 10px',
                      background: '#fffbeb',
                      border: '1px solid #fde68a',
                      borderRadius: 6,
                      fontSize: 11,
                      color: '#92400e',
                    }}
                  >
                    ⚠ AI-generated review — it can miss or misread things. Always verify against the source document before relying on it.
                  </div>

                  {docReview.draftReply && (
                    <button style={{ ...S.primary, marginTop: 8 }} onClick={useReviewDraft}>
                      Use as draft reply
                    </button>
                  )}
                </div>
              )}
            </Card>
          )}

          </>
          )}

          {tab === 'setup' && (
          <>
          {/* Onboard existing cases (bulk-import the mailbox backlog) */}
          <Card>
            <Label>Onboard existing cases</Label>

            {(!obJob || ['COMPLETED', 'CANCELLED', 'FAILED'].includes(obJob.status)) && (
              <>
                <p style={S.muted}>
                  Scan your mailbox to find cases already in flight and import them as matters — OneDrive folder, Excel
                  tracker and AI summary included. You review and pick which to keep before anything is created.
                </p>
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
        </>
      )}

      {(busy || status) && (
        <div style={{ ...S.toast, ...(busy ? S.toastBusy : {}) }}>{busy ? `${busy}…` : status}</div>
      )}
      <footer style={S.footer}>Draft-only · matter-isolated · every action audited</footer>
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

function Card({ children }: { children: React.ReactNode }) {
  return <section style={S.card}>{children}</section>;
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
  tabBar: { display: 'flex', gap: 4, marginBottom: 12, background: '#f1f5f9', borderRadius: 9, padding: 3 },
  tab: {
    flex: 1,
    padding: '7px 8px',
    border: 'none',
    background: 'transparent',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    color: '#64748b',
    cursor: 'pointer',
  },
  tabActive: { background: '#fff', color: '#0f172a', boxShadow: '0 1px 2px rgba(0,0,0,0.10)' },
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
  footer: { position: 'fixed', left: 0, right: 0, bottom: 0, textAlign: 'center', fontSize: 10, color: '#94a3b8', padding: 6, background: '#fff', borderTop: '1px solid #e2e8f0' },
};
