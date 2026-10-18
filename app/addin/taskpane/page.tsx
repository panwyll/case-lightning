'use client';
/**
 * CONVEYi in Outlook: file the open email to its case, as the web app's Email page does, and nothing more. The email is
 * read here only to show which case it belongs to; once it is filed CONVEYi reads it in the background (the Tasks list
 * shows the result), and drafting, documents and the case itself are in CONVEYi (Open In CONVEYi).
 *
 * Sign-in runs in an Office dialog (Microsoft's login refuses to be framed); the token it hands back is sent as a Bearer
 * on every call, because desktop Outlook does not share the session cookie with the pane.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CasePicker, PICKER_CSS, type Item, type MatterHit } from '@/app/shared/email/CasePicker';
import { CheckCircle, Home, Loader } from '@/app/shared/icons';
import { paths } from '@/lib/paths';

// ── Minimal Office.js typings (only the mailbox item) ───────────────
declare global {
  interface Window {
    Office?: {
      onReady: (cb: (info: { host: string }) => void) => void;
      MailboxEnums?: { RestVersion?: { v2_0?: unknown } };
      context?: {
        mailbox?: {
          item?: { itemId?: string; conversationId?: string; subject?: string; from?: { emailAddress?: string; displayName?: string } };
          // Office hands out EWS-format ids; Graph needs REST-format ones.
          convertToRestId?: (itemId: string, version: unknown) => string;
        };
      };
    };
  }
}

const TOKEN_KEY = 'cl_token';
const SIGNED_IN_COOKIE = 'cl_signed_in';
let onUnauthorized: (() => void) | null = null;

async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch {
    throw Object.assign(new Error(res.status === 504 || res.status === 408 ? `Timed out (HTTP ${res.status}).` : `Unexpected response (HTTP ${res.status || '?'}).`), { status: res.status });
  }
  if (!res.ok) {
    // Signed out mid-use: back to Connect, with the dead token cleared.
    if (res.status === 401 || res.status === 403) { window.localStorage.removeItem(TOKEN_KEY); onUnauthorized?.(); }
    throw Object.assign(new Error(String(json.error ?? `HTTP ${res.status}`)), { status: res.status });
  }
  return json as T;
}

function setSignedInCookie(on: boolean) {
  document.cookie = on ? `${SIGNED_IN_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax` : `${SIGNED_IN_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
const hasSignInHint = () => typeof document !== 'undefined' && (new RegExp(`(?:^|; )${SIGNED_IN_COOKIE}=1`).test(document.cookie) || !!window.localStorage.getItem(TOKEN_KEY));

type Me = { email: string; displayName: string | null };
type Open = { messageId: string; conversationId: string; subject: string; from: { name: string; email: string } | null };
type ForMessage = { filed: { matterId: string; matterRef: string; propertyAddress: string | null } | null; item: Item | null };
type Pending = { messageId: string; state: 'processing' | 'task' | 'no_action' };

const CSS = `
.tp{font:13.5px/1.45 -apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a;padding:14px 14px 18px;background:#fff;min-height:100vh;box-sizing:border-box}
.tp h1{font-size:15px;font-weight:800;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.tp h1 .who{margin-left:auto;font-size:12px;font-weight:600;color:#64748b}
.tp-subj{font-size:14px;font-weight:800;margin:0 0 2px;overflow-wrap:anywhere}
.tp-from{font-size:12.5px;color:#64748b;margin-bottom:6px}
.tp-card{border:1px solid #e6e8ee;border-radius:12px;padding:12px;margin-top:10px}
.tp-card b{display:block}
.tp-ok{display:flex;gap:8px;align-items:flex-start;color:#166534}
.tp-proc{display:flex;gap:8px;align-items:center;color:#5A27E0;font-weight:700}
.tp-spin{animation:tp-spin 1s linear infinite}
@keyframes tp-spin{to{transform:rotate(360deg)}}
.tp-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid #5A27E0;background:#5A27E0;color:#fff;border-radius:9px;padding:8px 13px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none}
.tp-btn.ghost{background:#fff;color:#5A27E0}
.tp-err{color:#b91c1c;font-size:12.5px;margin-top:8px}
.tp-none{color:#64748b;margin-top:8px}
.tp-foot{display:flex;gap:10px;align-items:center;margin-top:18px;padding-top:12px;border-top:1px solid #f1f5f9;font-size:12.5px}
.tp-foot a,.tp-foot button{color:#5A27E0;font-weight:700;text-decoration:none;background:none;border:0;padding:0;font:inherit;cursor:pointer}
.tp-foot .r{margin-left:auto}
.tp .ef-case{grid-template-columns:auto 1fr}
.tp .ef-case .side{grid-row:auto;grid-column:2}
`;

export default function Taskpane() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [connError, setConnError] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [found, setFound] = useState<ForMessage | null>(null);
  const [filedNow, setFiledNow] = useState<{ matterId: string; state: Pending['state'] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notCase, setNotCase] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint] = useState(hasSignInHint);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
      setConnError(false);
      setSignedInCookie(true);
      // Self-heal: re-arm on-receipt triage if its subscription lapsed (cheap when healthy).
      void api('/graph/subscriptions/ensure', { method: 'POST' }).catch(() => {});
    } catch (e) {
      const status = (e as { status?: number }).status;
      setMe(null);
      setConnError(!(status === 401 || status === 403));
      if (status === 401 || status === 403) setSignedInCookie(false);
    } finally {
      setBooting(false);
    }
  }, []);

  // The open email, and again whenever another is selected (a pinned pane).
  useEffect(() => {
    onUnauthorized = () => { setMe(null); setSignedInCookie(false); };
    void refreshMe();
    let done = false;
    const tryOffice = () => {
      const Office = window.Office;
      if (done || !Office?.onReady) return;
      done = true;
      const load = () => {
        const mailbox = Office.context?.mailbox;
        const item = mailbox?.item;
        setFound(null); setFiledNow(null); setErr(null); setNotCase(false);
        if (!item) { setOpen(null); return; }
        let id = item.itemId;
        // Only an EWS-format id is converted: OWA and new Outlook already give REST ids.
        if (id && /[+/=]/.test(id) && typeof mailbox?.convertToRestId === 'function') {
          try { id = mailbox.convertToRestId(id, Office.MailboxEnums?.RestVersion?.v2_0); } catch { /* the raw id */ }
        }
        setOpen({ messageId: id ?? '', conversationId: item.conversationId ?? '', subject: item.subject ?? '', from: item.from?.emailAddress ? { name: item.from.displayName || item.from.emailAddress, email: item.from.emailAddress } : null });
      };
      Office.onReady(() => {
        load();
        try {
          const o = window.Office as unknown as { context?: { mailbox?: { addHandlerAsync?: (t: unknown, h: () => void) => void } }; EventType?: { ItemChanged?: unknown } };
          o.context?.mailbox?.addHandlerAsync?.(o.EventType?.ItemChanged ?? 'olkItemSelectedChanged', load);
        } catch { /* this host does not say when the selection changes */ }
      });
    };
    tryOffice();
    const t = setInterval(tryOffice, 400);
    return () => { clearInterval(t); onUnauthorized = null; };
  }, [refreshMe]);

  // Which case it belongs to: filed already, or its suggestions.
  useEffect(() => {
    if (!me || !open?.messageId) return;
    let live = true;
    api<ForMessage>(`/mail/for-message?messageId=${encodeURIComponent(open.messageId)}`)
      .then((r) => { if (live) setFound(r); })
      .catch((e: unknown) => { if (live) setErr(e instanceof Error ? e.message : 'Could not read this email.'); });
    return () => { live = false; };
  }, [me, open?.messageId]);

  // After filing: processing, then the task it made or no action needed (the Tasks list's Pending).
  const watch = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (watch.current) clearTimeout(watch.current); }, []);
  const follow = (messageId: string, matterId: string, tries = 0) => {
    watch.current = setTimeout(async () => {
      const r = await api<{ items: Pending[] }>('/mail/pending').catch(() => ({ items: [] as Pending[] }));
      const p = r.items.find((x) => x.messageId === messageId);
      if (p && p.state !== 'processing') { setFiledNow({ matterId, state: p.state }); return; }
      if (tries < 40) follow(messageId, matterId, tries + 1);
    }, 3000);
  };

  const file = async (matterId: string) => {
    if (!open) return;
    setBusy(true); setErr(null);
    try {
      await api(`/matters/${matterId}/link-thread`, { method: 'POST', body: JSON.stringify({ graphThreadId: open.conversationId || open.messageId, graphConversationId: open.conversationId || undefined, messageId: open.messageId, subject: open.subject, participants: [open.from?.email].filter(Boolean) }) });
      setFiledNow({ matterId, state: 'processing' });
      follow(open.messageId, matterId);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not file this email.'); }
    setBusy(false);
  };
  const notACase = async () => {
    if (!open) return;
    setBusy(true); setErr(null);
    try {
      await api('/mail/not-a-case', { method: 'POST', body: JSON.stringify({ conversationId: open.conversationId || open.messageId, subject: open.subject, reason: null }) });
      setFiledNow(null);
      setNotCase(true);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not set this aside.'); }
    setBusy(false);
  };
  function connect() {
    const Office = window.Office as unknown as { context?: { ui?: { displayDialogAsync?: (url: string, o: unknown, cb: (r: { status: string; value: { addEventHandler: (t: unknown, h: (a: { message?: string }) => void) => void; close: () => void } }) => void) => void } }; EventType?: { DialogMessageReceived?: unknown; DialogEventReceived?: unknown } } | undefined;
    if (Office?.context?.ui?.displayDialogAsync) {
      Office.context.ui.displayDialogAsync(`${origin}/api/v1/auth/login`, { height: 60, width: 30, displayInIframe: false }, (result) => {
        if (result.status !== 'succeeded') { setErr('Could not open the sign-in window. Allow pop-ups and try again.'); return; }
        const dialog = result.value;
        dialog.addEventHandler(Office.EventType?.DialogMessageReceived, async (arg) => {
          try { const data = JSON.parse(arg.message ?? '{}'); if (data.token) window.localStorage.setItem(TOKEN_KEY, data.token); } catch { /* not ours */ }
          dialog.close();
          await refreshMe();
        });
        dialog.addEventHandler(Office.EventType?.DialogEventReceived, () => void refreshMe());
      });
    } else {
      window.location.href = '/api/v1/auth/login';
    }
  }
  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.localStorage.removeItem(TOKEN_KEY);
    setSignedInCookie(false);
    setMe(null);
  }

  const searchCases = async (q: string) => ((await api<{ matters: MatterHit[] }>(`/matters?q=${encodeURIComponent(q)}`)).matters ?? []).slice(0, 6);
  const caseLink = (matterId: string) => `${origin}${paths.matter(matterId)}`;

  return (
    <div className="tp">
      <style>{PICKER_CSS + CSS}</style>
      <h1>CONVEYi{me && <span className="who">{me.displayName ?? me.email}</span>}</h1>

      {booting && hint && <div className="tp-none">Connecting…</div>}
      {!booting && !me && (
        <div className="tp-card">
          <b>{connError ? 'CONVEYi Could Not Be Reached' : 'Sign In To File Email'}</b>
          <div style={{ marginTop: 10 }}><button className="tp-btn" onClick={connect}>{connError ? 'Try Again' : 'Sign In With Microsoft'}</button></div>
        </div>
      )}

      {me && !open?.messageId && <div className="tp-none">Select an email to file it to its case.</div>}

      {me && open?.messageId && (
        <>
          <p className="tp-subj">{open.subject || '(no subject)'}</p>
          {open.from && <div className="tp-from">{open.from.name}</div>}

          {filedNow ? (
            <div className="tp-card">
              {filedNow.state === 'processing'
                ? <div className="tp-proc"><Loader size={16} className="tp-spin" />Filed: Reading It</div>
                : <div className="tp-ok"><CheckCircle size={16} /><span><b>{filedNow.state === 'task' ? 'Filed: A Task Is Waiting' : 'Filed: No Action Required'}</b></span></div>}
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {filedNow.state === 'task' && <a className="tp-btn" href={`${origin}${paths.tasks}`} target="_blank" rel="noopener noreferrer">Open Tasks</a>}
                <a className="tp-btn ghost" href={caseLink(filedNow.matterId)} target="_blank" rel="noopener noreferrer"><Home size={16} />Open Case</a>
              </div>
            </div>
          ) : notCase ? (
            <div className="tp-card"><div className="tp-ok"><CheckCircle size={16} /><b>Set Aside: Not A Case</b></div></div>
          ) : found?.filed ? (
            <div className="tp-card">
              <div className="tp-ok"><CheckCircle size={16} /><span><b>Filed To {found.filed.matterRef}</b>{found.filed.propertyAddress}</span></div>
              <div style={{ marginTop: 10 }}><a className="tp-btn ghost" href={caseLink(found.filed.matterId)} target="_blank" rel="noopener noreferrer"><Home size={16} />Open Case</a></div>
            </div>
          ) : found?.item ? (
            <CasePicker item={found.item} busy={busy} onFile={(id) => void file(id)} onNotACase={() => void notACase()} searchCases={searchCases} showOutlook={false} />
          ) : found ? (
            <div className="tp-none">This email is not one CONVEYi files (sent by you to colleagues, or automated mail).</div>
          ) : !err && <div className="tp-none">Finding its case…</div>}
          {err && <div className="tp-err">{err}</div>}
        </>
      )}

      {me && (
        <div className="tp-foot">
          <a href={`${origin}${paths.tasks}`} target="_blank" rel="noopener noreferrer">Open CONVEYi</a>
          <button className="r" onClick={() => void signOut()}>Sign Out</button>
        </div>
      )}
    </div>
  );
}
