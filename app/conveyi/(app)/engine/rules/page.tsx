'use client';
import { BackLink } from '@/app/shared/BackLink';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { paths } from '@/lib/paths';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { LevelButtons, TRUST_CSS, TrustLevels, setLevel } from '@/app/shared/engine/TrustLevels';
import type { TrustLevel } from '@/app/shared/engine/types';

/**
 * The firm's rules on one page: who signs what off, how long the engine waits before it
 * chases and escalates, every message it can send and what triggers it, and the document
 * rules with their thresholds. This is the page a firm signs off at onboarding.
 */
interface Timer { waitKey: string; label: string; to: string; chaseAfter: number; chaseEvery: number | null; escalateAfter: number; reEscalateAfter: number; overridden: boolean }
interface Message { id: string; kind: 'acknowledgement' | 'update' | 'chase' | 'request'; when: string; to: string; subject: string; template: string; levelKey: string; level: TrustLevel }
interface DocRule { id: string; document: string; rule: string; value: string }
interface CaseRule { id: string; group: string; when: string; then: string; holds?: string; tells?: string; source: string }
interface Rules { policies?: { protectOutgoingFiles: boolean; archiveHandledEmail?: boolean; clientReminderHours?: number }; timers: Timer[]; messages: Message[]; documentRules: DocRule[]; caseRules: CaseRule[]; signoffs: Record<string, { at: string; by: string | null }> }

const SECTIONS = [['signoffs', 'Sign-Offs'], ['timers', 'Timers'], ['messages', 'Messages'], ['documents', 'Document Rules']] as const;
const KIND_LABEL: Record<Message['kind'], string> = { acknowledgement: 'Acknowledgement', update: 'Client update', chase: 'Chase', request: 'Request' };

const CSS = `
.ru-nav{display:flex;gap:4px;position:sticky;top:${56}px;z-index:5;background:#f6f7fb;padding:8px 0 10px;margin-bottom:6px}
.ru-nav a{padding:6px 12px;border-radius:999px;font-size:13px;font-weight:700;color:#334155;text-decoration:none;border:1px solid transparent}
.ru-nav a:hover{background:#eef1f6}
.ru-nav a.on{background:#ede9fe;color:#4c1d95;border-color:#ddd6fe}
.ru-sec{margin:22px 0 0;scroll-margin-top:110px}
.ru-h{font-size:13px;font-weight:800;color:#0f172a;margin:0 0 6px;line-height:1.3}
.ru-t{width:100%;border-collapse:collapse;font-size:13px}
.ru-t th{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;text-align:left;padding:8px 12px;border-bottom:1px solid #e8eaf0;white-space:nowrap}
.ru-t td{padding:9px 12px;border-top:1px solid #f1f5f9;vertical-align:middle}
.ru-t td.n{width:84px}
.ru-t td.n input{width:64px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;font-family:inherit;text-align:right;font-variant-numeric:tabular-nums}
.ru-t td.n input.changed{border-color:#5A27E0;background:#faf8ff}
.ru-t tr.over td:first-child::after{content:'Changed';margin-left:8px;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#4c1d95;background:#ede9fe;border-radius:999px;padding:1px 7px;vertical-align:1px}
.ru-kind{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:2px 8px;background:#f1f5f9;color:#475569;white-space:nowrap}
.ru-kind.chase{background:#fef3c7;color:#78350f}
.ru-kind.update{background:#e0e7ff;color:#3730a3}
.ru-kind.acknowledgement{background:#dcfce7;color:#14532d}
.ru-kind.request{background:#ede9fe;color:#4c1d95}
.ru-sub{color:#64748b;font-size:12.5px}
.ru-val{font-weight:800;color:#0f172a;white-space:nowrap;font-variant-numeric:tabular-nums}
.ru-t tr.grp td{background:#ede9fe;color:#3b1d8f;font-weight:800;border-top:1px solid #ddd6fe;font-size:12px;letter-spacing:.03em}
.ru-sign{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.ru-sign .eg-btn{padding:4px 10px;font-size:12px;margin:0}
.ru-signed{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#14532d;font-weight:700}
.ru-signed i{width:16px;height:16px;border-radius:99px;background:#16a34a;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:10px}
.ru-signed small{font-weight:500;color:#64748b}
.ru-holds{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#7f1d1d;background:#fee2e2;border-radius:999px;padding:2px 8px;white-space:nowrap}
.ru-tells{font-size:12px;color:#3730a3;white-space:nowrap;vertical-align:top}
.ru-progress{font-size:12.5px;color:#64748b;margin:-4px 0 10px;font-variant-numeric:tabular-nums}
`;

export default function RulesPage() {
  const [r, setR] = useState<Rules | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Partial<Timer>>>({});
  const [section, setSection] = useState<string>(typeof window !== 'undefined' && window.location.hash ? window.location.hash.slice(1) : 'signoffs');
  const setProtect = async (value: boolean) => {
    setBusy('policy');
    try { await api('/admin/engine-rules', { method: 'PATCH', body: JSON.stringify({ key: 'protectOutgoingFiles', value }) }); await load(); }
    finally { setBusy(null); }
  };
  const [remind, setRemind] = useState<string>('');
  const saveRemind = async () => {
    const hours = Number(remind);
    if (!Number.isInteger(hours) || hours < 1) return;
    setBusy('remind');
    try { await api('/admin/engine-rules', { method: 'PATCH', body: JSON.stringify({ key: 'clientReminderHours', value: hours }) }); setRemind(''); await load(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save it.'); }
    finally { setBusy(null); }
  };
  const setArchive = async (value: boolean) => {
    setBusy('archive');
    try { await api('/admin/engine-rules', { method: 'PATCH', body: JSON.stringify({ key: 'archiveHandledEmail', value }) }); await load(); }
    finally { setBusy(null); }
  };
  const load = useCallback(async () => {
    try {
      setR(await api<Rules>('/admin/engine-rules'));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the rules (admins only).');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onScroll = () => {
      const tops = SECTIONS.map(([id]) => [id, document.getElementById(id)?.getBoundingClientRect().top ?? Infinity] as const);
      const current = tops.filter(([, t]) => t < 140).pop()?.[0] ?? 'signoffs';
      setSection(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const timerValue = (t: Timer, k: keyof Timer) => (edits[t.waitKey]?.[k] ?? t[k]) as number | null;
  const saveTimer = async (t: Timer) => {
    setBusy(t.waitKey);
    try {
      await api('/admin/engine-rules', { method: 'PUT', body: JSON.stringify({ waitKey: t.waitKey, chaseAfter: timerValue(t, 'chaseAfter'), chaseEvery: timerValue(t, 'chaseEvery'), escalateAfter: timerValue(t, 'escalateAfter'), reEscalateAfter: timerValue(t, 'reEscalateAfter') }) });
      setEdits((e) => { const n = { ...e }; delete n[t.waitKey]; return n; });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not save the timer.');
    } finally {
      setBusy(null);
    }
  };
  const pickLevel = async (m: Message, lv: TrustLevel) => {
    setBusy(m.id);
    try {
      await setLevel(m.levelKey, lv);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not change the level.');
    } finally {
      setBusy(null);
    }
  };
  const num = (t: Timer, k: 'chaseAfter' | 'chaseEvery' | 'escalateAfter' | 'reEscalateAfter') => {
    const v = timerValue(t, k);
    const changed = edits[t.waitKey]?.[k] !== undefined && edits[t.waitKey]?.[k] !== t[k];
    return (
      <td className="n">
        <input type="number" min={k === 'chaseEvery' ? 1 : 0} max={365} value={v ?? ''} placeholder={k === 'chaseEvery' ? 'once' : ''} className={changed ? 'changed' : ''} onChange={(e) => setEdits((ed) => ({ ...ed, [t.waitKey]: { ...ed[t.waitKey], [k]: e.target.value === '' ? (k === 'chaseEvery' ? null : 0) : Number(e.target.value) } }))} />
      </td>
    );
  };

  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + TRUST_CSS + CSS}</style>
      <div className="eg-top">
        <h1 className="eg-h1" style={{ display: 'flex', alignItems: 'center' }}><BackLink href="/conveyi/integrations" label="Back to Tools" />Rules</h1>
      </div>
      <nav className="ru-nav" aria-label="Sections">
        {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className={section === id ? 'on' : ''} onClick={() => setSection(id)}>{label}</a>)}
      </nav>
      {err && <div className="eg-err">{err}</div>}

      <section id="signoffs" className="ru-sec">
        <h2 className="ru-h">Sign-Offs</h2>
        <TrustLevels onChanged={() => void load()} />
      </section>

      <section id="timers" className="ru-sec">
        <h2 className="ru-h">Timers</h2>
        <div className="eg-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="ru-t">
            <thead>
              <tr>
                <th>Waiting for</th>
                <th>Chase</th>
                <th title="First chase after this many working days">First chase after</th>
                <th title="Then every this many working days; blank = chase once">Then every</th>
                <th title="Raise it to a person after this many working days">Escalate after</th>
                <th title="If still waiting after an escalation is dealt with, escalate again after this many more">Re-escalate after</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(r?.timers ?? []).map((t) => (
                <tr key={t.waitKey} className={t.overridden ? 'over' : ''}>
                  <td>{t.label}</td>
                  <td className="ru-sub">{t.to}</td>
                  {num(t, 'chaseAfter')}{num(t, 'chaseEvery')}{num(t, 'escalateAfter')}{num(t, 'reEscalateAfter')}
                  <td style={{ textAlign: 'right' }}>{edits[t.waitKey] && <button className="eg-btn primary" disabled={busy === t.waitKey} onClick={() => void saveTimer(t)}>Save</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ru-sub" style={{ marginTop: 6 }}>Working days, England and Wales.</div>
        <div className="eg-card" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13.5, flex: 1, minWidth: 240 }}>Remind Clients of What They Owe in Updates</b>
          <span className="ru-sub">No sooner than every</span>
          <input type="number" min={1} max={336} value={remind !== '' ? remind : String(r?.policies?.clientReminderHours ?? 24)} onChange={(e) => setRemind(e.target.value)} style={{ width: 64, border: '1px solid #cbd5e1', borderRadius: 6, padding: '5px 8px', font: 'inherit', fontSize: 13 }} aria-label="Hours" />
          <span className="ru-sub">hours</span>
          {remind !== '' && Number(remind) !== (r?.policies?.clientReminderHours ?? 24) && <button className="eg-btn primary" disabled={busy === 'remind'} onClick={() => void saveRemind()}>Save</button>}
        </div>
      </section>

      <section id="messages" className="ru-sec">
        <h2 className="ru-h">Messages</h2>
        <div className="eg-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="ru-t">
            <thead>
              <tr>
                <th>Kind</th>
                <th>When</th>
                <th>To</th>
                <th>Subject</th>
                <th>Level</th>
              </tr>
            </thead>
            <tbody>
              {(r?.messages ?? []).map((m) => (
                <tr key={m.id}>
                  <td><span className={`ru-kind ${m.kind}`}>{KIND_LABEL[m.kind]}</span></td>
                  <td>{m.when}</td>
                  <td className="ru-sub">{m.to}</td>
                  <td className="ru-sub" title={m.template}>{m.subject}</td>
                  <td><LevelButtons current={m.level} busy={busy === m.id} scope={`${KIND_LABEL[m.kind].toLowerCase()}: ${m.when.toLowerCase()}`} onPick={(lv) => void pickLevel(m, lv)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ru-sub" style={{ marginTop: 6 }}>Wording is under <a href={`${paths.admin}?tab=templates`}>Email Templates</a>.</div>
        <div className="eg-card" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13.5 }}>Protect Outgoing Files</b>
          <span className="ru-sub" style={{ flex: 1, minWidth: 240 }}>Files go inside a password-protected zip; the password goes separately (WhatsApp where the client has opted in, otherwise its own message). Both are on the case log.</span>
          <button className="eg-btn" disabled={busy === 'policy'} onClick={() => void setProtect(!(r?.policies?.protectOutgoingFiles ?? false))} style={r?.policies?.protectOutgoingFiles ? { background: '#5A27E0', color: '#fff', borderColor: '#5A27E0' } : undefined}>{r?.policies?.protectOutgoingFiles ? 'On' : 'Off'}</button>
        </div>
        <div className="eg-card" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13.5, flex: 1 }}>File Email into Case Folders in Outlook</b>
          <button className="eg-btn" disabled={busy === 'archive'} onClick={() => void setArchive(!(r?.policies?.archiveHandledEmail ?? true))} style={(r?.policies?.archiveHandledEmail ?? true) ? { background: '#5A27E0', color: '#fff', borderColor: '#5A27E0' } : undefined}>{(r?.policies?.archiveHandledEmail ?? true) ? 'On' : 'Off'}</button>
        </div>
      </section>

      <section id="documents" className="ru-sec">
        <h2 className="ru-h">Document Rules</h2>
        <div className="eg-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="ru-t">
            <thead>
              <tr>
                <th>Document</th>
                <th>Rule</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {(r?.documentRules ?? []).map((d) => (
                <tr key={d.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{d.document}</td>
                  <td>{d.rule}</td>
                  <td className="ru-val">{d.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
