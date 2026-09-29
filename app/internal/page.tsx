'use client';
/**
 * The owner's console. Not linked from the site; gated by INTERNAL_DASHBOARD_KEY (entered once,
 * kept in this browser). Pages: Overview, Firms, Billing, Usage, Errors, Acquisition.
 */
import { useCallback, useEffect, useState } from 'react';
import { Acquisition, css as ACQ_CSS } from './Acquisition';
import { Billing, CONSOLE_CSS, Errors, Firms, Overview, Usage } from './pages';

const KEY_STORE = 'cl_internal_key';
const PAGES = [['overview', 'Overview'], ['firms', 'Firms'], ['billing', 'Billing'], ['usage', 'Usage'], ['errors', 'Errors'], ['acquisition', 'Acquisition']] as const;

export default function InternalConsole() {
  const [key, setKey] = useState('');
  const [input, setInput] = useState('');
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState('overview');
  const [params, setParams] = useState<Record<string, string>>({});

  // The page and its filters live in the URL, so a view can be bookmarked and Back works.
  const readUrl = useCallback(() => {
    const sp = new URLSearchParams(window.location.search);
    setPage(sp.get('page') ?? 'overview');
    const p: Record<string, string> = {};
    sp.forEach((v, k) => { if (k !== 'page') p[k] = v; });
    setParams(p);
  }, []);
  useEffect(() => {
    try { const saved = localStorage.getItem(KEY_STORE); if (saved) setKey(saved); } catch { /* storage blocked */ }
    readUrl(); setReady(true);
    window.addEventListener('popstate', readUrl);
    return () => window.removeEventListener('popstate', readUrl);
  }, [readUrl]);
  const go = useCallback((p: string, extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ page: p, ...extra }).toString();
    window.history.pushState(null, '', `/internal?${qs}`);
    setPage(p); setParams(extra); window.scrollTo(0, 0);
  }, []);
  const lock = useCallback(() => { try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ } setKey(''); }, []);

  if (!ready) return null;
  if (!key) {
    return (
      <main className="gate">
        <style>{ACQ_CSS}</style>
        <div className="gate-box">
          <h1>Console</h1>
          <input type="password" value={input} autoFocus onChange={(e) => setInput(e.target.value)} placeholder="Dashboard key" onKeyDown={(e) => { if (e.key === 'Enter' && input) { try { localStorage.setItem(KEY_STORE, input); } catch { /* ignore */ } setKey(input); } }} />
          <button onClick={() => { if (input) { try { localStorage.setItem(KEY_STORE, input); } catch { /* ignore */ } setKey(input); } }}>Unlock</button>
        </div>
      </main>
    );
  }
  return (
    <div className="shell">
      <style>{ACQ_CSS + CONSOLE_CSS}</style>
      <nav className="side">
        <div className="brand">Case Lightning</div>
        {PAGES.map(([id, label]) => <button key={id} className={page === id ? 'on' : undefined} onClick={() => go(id)}>{label}</button>)}
        <div className="foot"><button onClick={lock}>Lock</button></div>
      </nav>
      <main className="main">
        {page === 'overview' && <Overview k={key} onBadKey={lock} go={go} />}
        {page === 'firms' && <Firms k={key} onBadKey={lock} go={go} id={params.id ?? null} />}
        {page === 'billing' && <Billing k={key} onBadKey={lock} go={go} />}
        {page === 'usage' && <Usage k={key} onBadKey={lock} go={go} />}
        {page === 'errors' && <Errors key={`${params.firm ?? ''}-${params.days ?? ''}`} k={key} onBadKey={lock} go={go} firm={params.firm ?? null} initialDays={params.days ?? null} />}
        {page === 'acquisition' && <div className="dash"><Acquisition k={key} onBadKey={lock} /></div>}
      </main>
    </div>
  );
}
