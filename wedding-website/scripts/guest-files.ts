import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GuestSchema, type Guest } from '../lib/guest-schema';

export const GUEST_DIR = path.join(process.cwd(), 'content', 'guests');
export const INDEX_FILE = path.join(GUEST_DIR, 'index.ts');

/** Every guest JSON file on disk, ignoring the leading-underscore template. */
export function guestFileNames(): string[] {
  return readdirSync(GUEST_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export type Problem = { file: string; message: string };

export function validateAll(): { guests: Guest[]; problems: Problem[] } {
  const guests: Guest[] = [];
  const problems: Problem[] = [];

  for (const name of guestFileNames()) {
    const file = path.join(GUEST_DIR, `${name}.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push({ file: `${name}.json`, message: `not valid JSON — ${(error as Error).message}` });
      continue;
    }

    const parsed = GuestSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({ file: `${name}.json`, message: `${issue.path.join('.') || '(root)'}: ${issue.message}` });
      }
      continue;
    }
    if (parsed.data.slug !== name) {
      problems.push({ file: `${name}.json`, message: `slug is "${parsed.data.slug}" but the file is "${name}.json"` });
      continue;
    }
    guests.push(parsed.data);
  }

  return { guests, problems };
}

function identifier(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function renderIndex(names: string[]): string {
  const imports = names.map((n) => `import ${identifier(n)} from './${n}.json';`).join('\n');
  const entries = names.map((n) => `  '${n}': ${identifier(n)},`).join('\n');
  return `// AUTO-GENERATED. Run \`npm run guests:check -- --fix\` after adding or removing a
// guest file, or use \`npm run guests:new\` which regenerates this for you.
// Files beginning with an underscore are ignored.
${imports}

export const guestFiles: Record<string, unknown> = {
${entries}
};
`;
}

export function writeIndex(names: string[]): void {
  writeFileSync(INDEX_FILE, renderIndex(names), 'utf8');
}

export function indexIsCurrent(names: string[]): boolean {
  try {
    return readFileSync(INDEX_FILE, 'utf8') === renderIndex(names);
  } catch {
    return false;
  }
}
