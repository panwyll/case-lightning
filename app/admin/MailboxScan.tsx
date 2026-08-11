'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Backlog scan, on the web.
 *
 * This is the moment a new firm first sees CONVEYi do something real: it reads their
 * recent mail, works out which threads are the same transaction, and hands back a list
 * of their actual live matters to approve. It previously existed ONLY in the Outlook
 * task pane, which meant the payoff was gated behind installing an add-in — and rendered
 * in a 320px strip. On the web it's the first thing a firm does after signing in.
 *
 * The protocol is the task pane's (app/addin/taskpane/page.tsx), deliberately unchanged:
 *   POST /onboarding            → create the job
 *   POST /onboarding/process    → run one bounded slice; loop until done
 *   GET  /onboarding            → job + proposed cases once AWAITING_REVIEW
 *   POST /onboarding/confirm    → provision the approved ones
 *   DELETE /onboarding          → cancel
 * Each /process call is a resumable slice, so a closed tab or a timed-out slice loses at
 * most one slice of work rather than the run.
 */

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('cl_token') : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status, action: json.action });
  return json as T;
}

interface Job {
  id: string;
  status: string;
  messages_scanned: number;
  threads_found: number;
  cases_proposed: number;
  cases_onboarded: number;
  error: string | null;
  lookback_months: number | null;
}
interface Case {
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
}

const ACTIVE = ['SCANNING', 'CLUSTERING', 'PROPOSING', 'PROVISIONING'];
const PURPLE = '#5A27E0';

const PROGRESS_COPY: Record<string, string> = {
  SCANNING: 'Reading your recent mail…',
  CLUSTERING: 'Grouping emails into transactions…',
  PROPOSING: 'Working out the property, parties and stage…',
  PROVISIONING: 'Creating your matters…',
};

export default function MailboxScan({ onImported }: { onImported?: (count: number) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [refEdit, setRefEdit] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [upsell, setUpsell] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const driving = useRef(false);

  const refresh = useCallback(async (): Promise<Job | null> => {
    try {
      const r = await api<{ job: Job | null; cases: Case[] }>('/onboarding');
      setJob(r.job);
      setCases(r.cases ?? []);
      if (r.job?.status === 'AWAITING_REVIEW') {
        // Pre-tick the confident ones so the common case is a single click.
        setSel((prev) => {
          const next = { ...prev };
          for (const c of r.cases ?? []) if (!(c.id in next)) next[c.id] = (c.confidence ?? 0) >= 0.6;
          return next;
        });
      }
      return r.job;
    } catch {
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  // Loop the bounded /process endpoint until the job needs the user or ends. Transient
  // failures back off and retry rather than abandoning a half-finished import.
  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    let retries = 0;
    try {
      for (;;) {
        try {
          const r = await api<{ job: Job | null; done: boolean }>('/onboarding/process', { method: 'POST' });
          retries = 0;
          if (r.job) setJob(r.job);
          if (r.done) {
            await refresh();
            break;
          }
          await new Promise((res) => setTimeout(res, 500));
        } catch (e) {
          const status = (e as { status?: number }).status ?? 0;
          const transient = status === 0 || status === 408 || status === 429 || status >= 500;
          if (transient && retries < 4) {
            retries += 1;
            await new Promise((res) => setTimeout(res, 1500 * retries));
            continue;
          }
          setErr((e as Error).message || 'The scan stopped unexpectedly.');
          return;
        }
      }
    } finally {
      driving.current = false;
    }
  }, [refresh]);

  // Resume an in-flight job on mount — someone who closed the tab mid-scan comes back
  // to a running import, not a dead one.
  useEffect(() => {
    void (async () => {
      const j = await refresh();
      if (j && ACTIVE.includes(j.status)) void drive();
    })();
  }, [refresh, drive]);

  async function start() {
    setErr(null);
    setUpsell(false);
    setBusy(true);
    try {
      const r = await api<{ job: Job }>('/onboarding', { method: 'POST', body: JSON.stringify({ lookbackMonths: 3 }) });
      setJob(r.job);
      setCases([]);
      setSel({});
      setRefEdit({});
      void drive();
    } catch (e) {
      if ((e as { status?: number }).status === 429 && (e as { action?: string }).action === 'upgrade') setUpsell(true);
      setErr((e as Error).message || 'Could not start the scan.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setErr(null);
    setBusy(true);
    try {
      const selections = cases
        .filter((c) => c.status === 'PROPOSED')
        .map((c) => ({
          caseId: c.id,
          approved: !!sel[c.id],
          edits: refEdit[c.id]?.trim() ? { matterRef: refEdit[c.id].trim() } : undefined,
        }));
      await api('/onboarding/confirm', { method: 'POST', body: JSON.stringify({ selections }) });
      await refresh();
      void drive();
    } catch (e) {
      setErr((e as Error).message || 'Could not import those matters.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api('/onboarding', { method: 'DELETE' });
      setJob(null);
      setCases([]);
    } catch {
      /* cancelling is best-effort */
    } finally {
      setBusy(false);
    }
  }

  const status = job?.status;
  const proposed = cases.filter((c) => c.status === 'PROPOSED');
  const onboarded = cases.filter((c) => c.status === 'ONBOARDED');
  const chosen = proposed.filter((c) => sel[c.id]).length;

  // Tell the parent once per completed job. The ref matters: callers pass an inline
  // arrow, so `onImported` has a new identity every render — without the guard this
  // effect would re-fire on each render, and since the callback reloads the checklist
  // (which re-renders us) that is an unbounded request loop, not a stray extra call.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'COMPLETED' || !job || !onboarded.length) return;
    if (reported.current === job.id) return;
    reported.current = job.id;
    onImported?.(onboarded.length);
  }, [status, job, onboarded.length, onImported]);

  if (!loaded) return <div style={{ ...card, color: '#94a3b8', fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {err && (
        <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', fontSize: 13 }}>
          {err}
          {upsell && (
            <>
              {' '}
              <a href="/admin?tab=billing" style={{ color: PURPLE, fontWeight: 700 }}>See plans →</a>
            </>
          )}
        </div>
      )}

      {/* Idle — the pitch and the button. */}
      {(!job || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status ?? '')) && (
        <div style={card}>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a' }}>
            {onboarded.length ? 'Scan your mailbox again' : 'Find your live matters'}
          </div>
          <div style={{ fontSize: 13.5, color: '#475569', marginTop: 4, lineHeight: 1.5 }}>
            CONVEYi reads your recent mail and works out which threads belong to the same
            transaction — the property, the parties and the other side’s solicitor. You review what
            it found and choose which to keep. Nothing is sent, and nothing leaves your mailbox.
          </div>
          {status === 'FAILED' && job?.error && (
            <div style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 8 }}>Last scan failed: {job.error}</div>
          )}
          <button onClick={start} disabled={busy} style={{ ...primary, marginTop: 12 }}>
            {busy ? 'Starting…' : onboarded.length ? 'Scan again' : 'Scan my mailbox'}
          </button>
        </div>
      )}

      {/* Running. */}
      {status && ACTIVE.includes(status) && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Spinner />
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
              {PROGRESS_COPY[status] ?? 'Working…'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
            <Stat label="Emails read" value={job?.messages_scanned ?? 0} />
            <Stat label="Threads" value={job?.threads_found ?? 0} />
            <Stat label="Matters found" value={job?.cases_proposed ?? 0} />
          </div>
          <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 12 }}>
            This can take a few minutes on a busy mailbox. You can leave this page — the scan picks
            up where it left off. <button onClick={cancel} disabled={busy} style={link}>Cancel</button>
          </div>
        </div>
      )}

      {/* Review — the payoff. */}
      {status === 'AWAITING_REVIEW' && (
        <div style={card}>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a' }}>
            {proposed.length === 0
              ? 'No matters found in that window'
              : `We found ${proposed.length} live ${proposed.length === 1 ? 'matter' : 'matters'}`}
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 3 }}>
            {proposed.length === 0
              ? 'Nothing in your recent mail looked like an active conveyance. If your matters are older than the scanned window, subscribing lifts the limit on how far back we look.'
              : 'Untick anything that isn’t a real case. You can edit a reference before importing.'}
          </div>

          {proposed.length > 0 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {proposed.map((c) => (
                  <label
                    key={c.id}
                    style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10, borderRadius: 10,
                      border: `1px solid ${sel[c.id] ? '#ddd0fb' : '#eef2f7'}`,
                      background: sel[c.id] ? '#faf7ff' : '#fff', cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!sel[c.id]}
                      onChange={(e) => setSel((p) => ({ ...p, [c.id]: e.target.checked }))}
                      style={{ marginTop: 3, accentColor: PURPLE }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                        {c.property_address || 'Address not identified'}
                      </div>
                      <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>
                        {[
                          c.buyer_names?.length ? `Buyer: ${c.buyer_names.join(', ')}` : null,
                          c.seller_names?.length ? `Seller: ${c.seller_names.join(', ')}` : null,
                          c.counterparty_solicitor ? `Other side: ${c.counterparty_solicitor}` : null,
                        ].filter(Boolean).join(' · ') || 'Parties not identified'}
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
                        {c.message_count} email{c.message_count === 1 ? '' : 's'} across {c.thread_count} thread
                        {c.thread_count === 1 ? '' : 's'}
                        {c.confidence != null && ` · ${Math.round(c.confidence * 100)}% confident`}
                      </div>
                      <input
                        value={refEdit[c.id] ?? c.proposed_matter_ref ?? ''}
                        onChange={(e) => setRefEdit((p) => ({ ...p, [c.id]: e.target.value }))}
                        onClick={(e) => e.preventDefault()}
                        placeholder="Matter reference"
                        style={{ ...input, marginTop: 7, width: 220 }}
                      />
                    </div>
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={confirm} disabled={busy || chosen === 0} style={{ ...primary, opacity: chosen === 0 ? 0.5 : 1 }}>
                  {busy ? 'Importing…' : `Import ${chosen} matter${chosen === 1 ? '' : 's'}`}
                </button>
                <button onClick={() => setSel(Object.fromEntries(proposed.map((c) => [c.id, true])))} style={link}>
                  Select all
                </button>
                <button onClick={() => setSel({})} style={link}>Clear</button>
                <button onClick={cancel} disabled={busy} style={{ ...link, marginLeft: 'auto' }}>Discard this scan</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Done. */}
      {status === 'COMPLETED' && onboarded.length > 0 && (
        <div style={{ ...card, background: '#f6fdf9', border: '1px solid #bbf7d0' }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#065f46' }}>
            {onboarded.length} matter{onboarded.length === 1 ? '' : 's'} imported from your mailbox
          </div>
          <div style={{ fontSize: 13, color: '#047857', marginTop: 3 }}>
            Every email in those threads is now filed against the right case, with the property,
            parties and key dates already pulled out.
          </div>
          <a href="/admin?tab=board" style={{ ...primaryLink, marginTop: 12 }}>See your case board →</a>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11.5, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>{label}</div>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <span
        style={{
          width: 16, height: 16, borderRadius: '50%', flex: 'none',
          border: `2px solid ${PURPLE}33`, borderTopColor: PURPLE,
          animation: 'clspin .7s linear infinite', display: 'inline-block',
        }}
      />
      <style>{'@keyframes clspin{to{transform:rotate(360deg)}}'}</style>
    </>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 14 };
const input: React.CSSProperties = { boxSizing: 'border-box', fontSize: 13, padding: '6px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
const primary: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '9px 16px', borderRadius: 8, border: 'none', background: PURPLE, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' };
const primaryLink: React.CSSProperties = { ...primary, display: 'inline-block', textDecoration: 'none' };
const link: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, background: 'none', border: 'none', color: PURPLE, cursor: 'pointer', padding: 0, fontFamily: 'inherit' };
