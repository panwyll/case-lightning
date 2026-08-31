import { loadEnv } from './env';
import { guestCode, personalLink, siteUrl } from '../lib/auth';
import { validateAll } from './guest-files';

/**
 * Prints every guest's personal link. lib/auth reads its secrets lazily, so
 * loading .env before the first call is enough for these to match production.
 */
async function main() {
  loadEnv();

  if (!process.env.GUEST_LINK_SECRET) {
    console.warn(
      'GUEST_LINK_SECRET is not set, so these are development codes and will NOT\n' +
        'work against production. Set it in .env.local (and in your host) first.\n',
    );
  }

  const { guests, problems } = validateAll();
  if (problems.length > 0) {
    console.error('Fix the guest files first: npm run guests:check');
    process.exit(1);
  }

  console.log(`Personal links against ${siteUrl()}\n`);

  for (const guest of guests) {
    const code = guest.accessCode ?? (await guestCode(guest.slug));
    const flag = guest.status === 'live' ? '' : `  [${guest.status}]`;
    console.log(`${guest.displayName}${flag}`);
    console.log(`  code  ${code}`);
    console.log(`  link  ${personalLink(guest.slug, code)}`);
    console.log('');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
