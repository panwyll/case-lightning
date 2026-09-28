import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { fail } from '@/lib/server/http';
import { getFirmProfile } from '@/lib/server/firm';
import { proposalsMarkdown, reviewedPlaybook } from '@/lib/server/playbook-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The proposed changes as a Markdown file, to hand to a developer. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [firm, rules] = await Promise.all([getFirmProfile(user.tenantId), reviewedPlaybook(user.tenantId)]);
    const md = proposalsMarkdown(firm.name || 'the firm', rules);
    return new Response(md, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="playbook-changes-${new Date().toISOString().slice(0, 10)}.md"` } });
  } catch (error) {
    return fail(error);
  }
}
