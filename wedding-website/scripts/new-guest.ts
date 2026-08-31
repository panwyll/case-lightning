import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { GUEST_DIR, guestFileNames, writeIndex } from './guest-files';

/**
 * Creates a guest page from the template and regenerates the index.
 *
 *   npm run guests:new                          (prompts)
 *   npm run guests:new -- "The Shahs"           (slug derived)
 *   npm run guests:new -- "The Shahs" the-shahs
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ask(): Promise<{ displayName: string; slug: string }> {
  const [argName, argSlug] = process.argv.slice(2);

  if (argName) {
    return { displayName: argName.trim(), slug: (argSlug || slugify(argName)).trim() };
  }

  if (!stdin.isTTY) {
    console.error('Usage: npm run guests:new -- "Display Name" [slug]');
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const displayName = (await rl.question('Display name (e.g. "Dave", "The Shahs"): ')).trim();
    if (!displayName) {
      console.error('A display name is required.');
      process.exit(1);
    }
    const suggested = slugify(displayName);
    const answer = (await rl.question(`URL slug [${suggested}]: `)).trim();
    return { displayName, slug: answer || suggested };
  } finally {
    rl.close();
  }
}

async function main() {
  const { displayName, slug } = await ask();

  if (!displayName) {
    console.error('A display name is required.');
    process.exit(1);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    console.error(`"${slug}" is not a valid slug — lowercase letters, numbers and hyphens only.`);
    process.exit(1);
  }
  if (guestFileNames().includes(slug)) {
    console.error(`content/guests/${slug}.json already exists.`);
    process.exit(1);
  }

  const target = path.join(GUEST_DIR, `${slug}.json`);
  copyFileSync(path.join(GUEST_DIR, '_template.json'), target);

  const draft = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
  draft.slug = slug;
  draft.displayName = displayName;
  draft.hero = {
    kicker: 'A page that exists only for you',
    headline: `${displayName}, you are invited`,
    blurb: '',
  };
  writeFileSync(target, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');

  writeIndex(guestFileNames());

  console.log(`\nCreated content/guests/${slug}.json (status: draft).`);
  console.log('Next:');
  console.log('  1. Edit it — party, menu, sections.');
  console.log(`  2. npm run dev, then preview it at /admin/g/${slug}`);
  console.log('  3. Set "status": "live", then npm run guests:links for their link.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
