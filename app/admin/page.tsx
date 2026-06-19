'use client';

import { useCallback, useEffect, useState } from 'react';

interface Template {
  id: string;
  name: string;
  category: string;
  subjectTemplate?: string;
  bodyTemplate: string;
  styleTag: string;
  isActive: boolean;
}

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

export default function AdminPage() {
  const [tab, setTab] = useState<'templates' | 'team' | 'policy' | 'rules' | 'referrals' | 'audit'>('templates');
  const [users, setUsers] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [policy, setPolicy] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [referrals, setReferrals] = useState<any>(null);
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
      if (tab === 'templates') setTemplates((await api<{ templates: Template[] }>('/admin/templates')).templates);
      if (tab === 'policy') setPolicy((await api<{ policy: any }>('/admin/policies')).policy);
      if (tab === 'audit') setAudit((await api<{ logs: any[] }>('/admin/audit?limit=100')).logs);
      if (tab === 'rules') setRules((await api<{ rules: any[] }>('/admin/rules')).rules);
      if (tab === 'referrals') setReferrals(await api('/referrals'));
      if (tab === 'team') setUsers((await api<{ users: any[] }>('/admin/users')).users);
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
          folderNamingPattern: policy.folder_naming_pattern ?? '{matter_ref}_{address_slug}',
          allowedExternalDomains: policy.allowed_external_domains ?? [],
        }),
      });
      setStatus('Policy saved.');
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  const box: React.CSSProperties = { maxWidth: 880, margin: '0 auto', padding: 24, color: '#0f172a' };
  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: '8px 14px',
    border: 'none',
    borderBottom: active ? '2px solid #ff2d78' : '2px solid transparent',
    background: 'transparent',
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    color: '#0f172a',
  });
  const input: React.CSSProperties = { width: '100%', padding: 8, border: '1px solid #cbd5e1', borderRadius: 6, marginBottom: 8 };
  const card: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, marginBottom: 12, background: '#f8fafc' };

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <div style={box}>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>CaseLightning Admin</h1>
        <p style={{ color: '#64748b', marginTop: 0 }}>Firm playbook templates, policy and audit. Admin role required.</p>
        <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid #e2e8f0', marginBottom: 16 }}>
          <button style={tabBtn(tab === 'templates')} onClick={() => setTab('templates')}>Templates</button>
          <button style={tabBtn(tab === 'team')} onClick={() => setTab('team')}>Team</button>
          <button style={tabBtn(tab === 'policy')} onClick={() => setTab('policy')}>Policy</button>
          <button style={tabBtn(tab === 'rules')} onClick={() => setTab('rules')}>Auto-rules</button>
          <button style={tabBtn(tab === 'referrals')} onClick={() => setTab('referrals')}>Referrals</button>
          <button style={tabBtn(tab === 'audit')} onClick={() => setTab('audit')}>Audit</button>
        </div>

        {status && <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca' }}>{status}</div>}

        {tab === 'templates' && (
          <>
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>New template</h3>
              <input style={input} placeholder="Name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
              <input style={input} placeholder="Category" value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })} />
              <input style={input} placeholder="Style tag (NEUTRAL/FIRM/CHASING)" value={t.styleTag} onChange={(e) => setT({ ...t, styleTag: e.target.value })} />
              <input style={input} placeholder="Subject template" value={t.subjectTemplate} onChange={(e) => setT({ ...t, subjectTemplate: e.target.value })} />
              <textarea style={{ ...input, minHeight: 100 }} placeholder="Body template" value={t.bodyTemplate} onChange={(e) => setT({ ...t, bodyTemplate: e.target.value })} />
              <button style={{ padding: '8px 16px', background: '#ff2d78', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }} onClick={createTemplate}>
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
            <button style={{ padding: '8px 16px', background: '#ff2d78', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }} onClick={savePolicy}>
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
                style={{ padding: '8px 16px', background: '#ff2d78', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', marginTop: 8 }}
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

        {tab === 'referrals' && referrals && (
          <>
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>Your referral link</h3>
              <p style={{ fontSize: 13, color: '#475569' }}>
                Earn <strong>£{(referrals.commissionPennies / 100).toFixed(0)}/month</strong> in account credit for every
                firm you refer — recurring, paid the month after each pays, for as long as they stay subscribed.
              </p>
              <input style={input} readOnly value={referrals.referralLink} onClick={(e) => (e.target as HTMLInputElement).select()} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={{ padding: '8px 16px', background: '#ff2d78', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}
                  onClick={() => navigator.clipboard?.writeText(referrals.referralLink)}
                >
                  Copy link
                </button>
                <span style={{ alignSelf: 'center', color: '#64748b', fontSize: 13 }}>Code: <strong>{referrals.referralCode}</strong></span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div style={card}>
                <div style={{ fontSize: 12, color: '#64748b' }}>Credit balance</div>
                <div style={{ fontSize: 24, fontWeight: 800 }}>£{(referrals.creditBalancePennies / 100).toFixed(2)}</div>
              </div>
              <div style={card}>
                <div style={{ fontSize: 12, color: '#64748b' }}>Active referrals</div>
                <div style={{ fontSize: 24, fontWeight: 800 }}>{referrals.referrals.active} / {referrals.referrals.total}</div>
              </div>
              <div style={card}>
                <div style={{ fontSize: 12, color: '#64748b' }}>Earned to date</div>
                <div style={{ fontSize: 24, fontWeight: 800 }}>£{(referrals.commissions.appliedPennies / 100).toFixed(2)}</div>
              </div>
            </div>
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>Referred firms</h3>
              {referrals.referrals.list.length === 0 && <p style={{ color: '#64748b' }}>No referrals yet — share your link above.</p>}
              {referrals.referrals.list.map((r: any, i: number) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #e2e8f0', padding: '6px 0', fontSize: 13 }}>
                  <span>{r.plan ?? '—'} · joined {new Date(r.created_at).toLocaleDateString()}</span>
                  <span style={{ color: r.status === 'active' ? '#16a34a' : '#94a3b8' }}>{r.status}</span>
                </div>
              ))}
              {referrals.commissions.clawedBackPennies > 0 && (
                <p style={{ fontSize: 12, color: '#b91c1c' }}>£{(referrals.commissions.clawedBackPennies / 100).toFixed(2)} clawed back (refunds/cancellations).</p>
              )}
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
  );
}
