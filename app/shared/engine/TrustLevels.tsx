'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { TRUST_LEVELS, type TrustLevel } from './types';

/**
 * Sign-offs: for every action the engine can take, and each of its subjects, whether it
 * proposes (a person approves first), assists (goes, then a person confirms what the
 * rules cleared) or runs on its own. With the tally that earns a promotion.
 */
interface Row { key: string; label: string; level: TrustLevel; overridden: boolean; proposed: number; approved: number; rejected: number; failed: number; pending: number }
interface Group { action: string; label: string; level: TrustLevel; proposed: number; approved: number; rejected: number; failed: number; pending: number; rows: Row[] }
interface Board { levels: Record<string, TrustLevel>; groups: Group[] }

export const LEVEL_LABEL: Record<TrustLevel, string> = { propose: 'Propose', assist: 'Assist', auto: 'Auto' };
export const LEVEL_HELP: Record<TrustLevel, string> = {
  propose: 'The engine puts the intended action in Tasks and does nothing until someone approves it.',
  assist: 'Acknowledgements, chases and search orders are sent without asking. Client updates are still proposed. Documents the rules clear are cleared, then put to a person to confirm.',
  auto: 'Proceeds without asking. Flagged documents and payments still come to a person.',
};

export const TRUST_CSS = `
.tl-t{width:100%;border-collapse:collapse;font-size:13px}
.tl-t th{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;text-align:right;padding:8px 12px;border-bottom:1px solid #e8eaf0}
.tl-t th:first-child,.tl-t td:first-child{text-align:left}
.tl-t td{padding:9px 12px;border-top:1px solid #f1f5f9;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tl-t tr.g td{font-weight:800;background:#ede9fe;color:#3b1d8f;border-top:1px solid #ddd6fe}
.tl-t tr.s td:first-child{padding-left:28px;color:#334155}
.tl-t td.lv{text-align:left}
.tl-t td.lv .eg-btn,.lv-btns .eg-btn{display:inline-flex;align-items:center;justify-content:center;width:76px;height:28px;padding:0;font-size:12px;margin:0 4px 0 0;box-sizing:border-box}
.tl-t td.z{color:#cbd5e1}
`;

/** The three buttons, shared with the Messages section. */
export function LevelButtons({ current, busy, scope, onPick }: { current: TrustLevel; busy: boolean; scope: string; onPick: (lv: TrustLevel) => void }) {
  return (
    <span className="lv-btns">
      {TRUST_LEVELS.map((lv) => (
        <button key={lv} className={`eg-btn${current === lv ? (lv === 'propose' ? ' on' : lv === 'assist' ? ' accent' : ' primary') : ''}`} disabled={busy || current === lv} title={`${LEVEL_HELP[lv]} Applies to ${scope}.`} onClick={() => onPick(lv)}>
          {LEVEL_LABEL[lv]}
        </button>
      ))}
    </span>
  );
}

export async function setLevel(key: string, level: TrustLevel): Promise<void> {
  await api('/admin/engine/subflows', { method: 'PUT', body: JSON.stringify({ action: key, level }) });
}

export function TrustLevels({ onChanged }: { onChanged?: () => void }) {
  const [b, setB] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setB(await api<Board>('/engine/shadow'));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the sign-offs (admins only).');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const set = async (key: string, level: TrustLevel) => {
    setBusy(key);
    try {
      await setLevel(key, level);
      await load();
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not change the level.');
    } finally {
      setBusy(null);
    }
  };
  const n = (v: number) => <td className={v ? '' : 'z'}>{v}</td>;
  return (
    <>
      {err && <div className="eg-err">{err}</div>}
      {b && (
        <div className="eg-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tl-t">
            <thead>
              <tr>
                <th>Action</th>
                <th style={{ textAlign: 'left' }}>Level</th>
                <th title="Proposals a person approved">Approved</th>
                <th title="Proposals a person declined, with a reason">Declined</th>
                <th title="Approved, but the send or order did not go through">Failed</th>
                <th title="Proposals waiting in Tasks">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {b.groups.map((g) => (
                <Fragment key={g.action}>
                  <tr className="g">
                    <td>{g.label}</td>
                    <td className="lv"><LevelButtons current={g.level} busy={busy === g.action} scope={`every ${g.label.toLowerCase()} row below`} onPick={(lv) => void set(g.action, lv)} /></td>
                    {n(g.approved)}{n(g.rejected)}{n(g.failed)}{n(g.pending)}
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.key} className="s">
                      <td>{r.label}</td>
                      <td className="lv"><LevelButtons current={r.level} busy={busy === r.key} scope={`${g.label.toLowerCase()}: ${r.label.toLowerCase()} only`} onPick={(lv) => void set(r.key, lv)} /></td>
                      {n(r.approved)}{n(r.rejected)}{n(r.failed)}{n(r.pending)}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
