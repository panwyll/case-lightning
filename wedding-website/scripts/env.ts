import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env loader so the scripts see the same secrets `next dev` does,
 * without pulling in a dependency. First file to define a key wins, matching
 * Next.js's own precedence.
 */
export function loadEnv(root = process.cwd()): void {
  for (const name of ['.env.local', '.env']) {
    let raw: string;
    try {
      raw = readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
}
