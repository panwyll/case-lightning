import { config } from '@/lib/server/config';
import { paths } from '@/lib/paths';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approve CONVEYi — IT Admin' };

/**
 * The page a firm's IT admin is sent to when Microsoft 365 blocks staff from approving
 * apps themselves. One button: Microsoft's admin-consent screen for the whole firm. The
 * permission list is read from the scopes CONVEYi actually asks for, so it cannot drift.
 */
const WHAT: Record<string, string> = {
  'User.Read': 'Sign in and read the person’s name and email',
  'Mail.ReadWrite': 'File case email and prepare drafts in the person’s own mailbox',
  'Mail.Send': 'Send case email the person or the firm has approved',
  'MailboxSettings.ReadWrite': 'Colour-code case email with Outlook categories',
  'Files.ReadWrite': 'Save case documents to the person’s OneDrive',
  'Team.ReadBasic.All': 'List the person’s Teams to post case updates to',
  'ChannelMessage.Send': 'Post case updates to a Teams channel the firm chooses',
  'Tasks.ReadWrite': 'Put the person’s case tasks in Microsoft To Do',
  offline_access: 'Keep working between sign-ins (chasers, filing)',
};

const CSS = `
.ia{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:32px 16px;background:#faf9f7;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.ia-card{width:100%;max-width:480px}
.ia-brand{font-size:22px;font-weight:800;letter-spacing:-0.02em}
.ia-brand span{color:#5A27E0}
.ia-h1{font-size:26px;font-weight:800;margin:20px 0 16px;letter-spacing:-0.02em}
.ia-box{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.ia-h2{font-size:13px;font-weight:800;margin:0 0 10px}
.ia-list{list-style:none;margin:0;padding:0}
.ia-list li{display:flex;gap:12px;padding:8px 0;border-top:1px solid #f1f5f9;font-size:13.5px;line-height:1.45}
.ia-list li:first-child{border-top:0}
.ia-list code{flex:none;width:176px;font-size:12px;color:#5A27E0;font-weight:700;padding-top:1px;overflow-wrap:anywhere}
.ia-list span{color:#334155}
.ia-note{font-size:13px;color:#475569;line-height:1.5;margin:14px 0 0}
.ia-btn{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:16px;padding:12px 16px;border-radius:10px;background:#5A27E0;color:#fff;font-size:14.5px;font-weight:700;text-decoration:none}
.ia-foot{margin-top:18px;font-size:12.5px;color:#94a3b8;text-align:center}
.ia-foot a{color:#64748b}
@media (max-width:520px){.ia-list li{flex-direction:column;gap:2px}.ia-list code{width:auto}}
`;

export default function ItAdminPage() {
  const scopes = Array.from(new Set([...config.graphScopes, 'offline_access'])).filter((s) => s && !['openid', 'profile', 'email'].includes(s));
  return (
    <main className="ia">
      <style>{CSS}</style>
      <div className="ia-card">
        <div className="ia-brand">CONVE<span>Yi</span></div>
        <h1 className="ia-h1">Approve CONVEYi For Your Firm</h1>
        <div className="ia-box">
          <h2 className="ia-h2">Microsoft Graph Permissions (Delegated)</h2>
          <ul className="ia-list">
            {scopes.map((s) => (
              <li key={s}>
                <code>{s}</code>
                <span>{WHAT[s] ?? 'Used by CONVEYi on the signed-in person’s behalf'}</span>
              </li>
            ))}
          </ul>
          <p className="ia-note">Delegated only: CONVEYi acts in the mailbox and OneDrive of each person who signs in, never anyone else’s. Needs a Global, Application or Cloud Application Administrator.</p>
          <a className="ia-btn" href="/api/v1/auth/login?admin=1">
            <svg width="17" height="17" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg>
            Approve With Microsoft
          </a>
        </div>
        <p className="ia-foot">
          Questions? <a href={paths.support}>Support</a> · <a href={paths.signIn}>Sign In</a>
        </p>
      </div>
    </main>
  );
}
