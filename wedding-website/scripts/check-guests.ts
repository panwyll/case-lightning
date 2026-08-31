import { guestFileNames, indexIsCurrent, validateAll, writeIndex } from './guest-files';

/**
 * Validates every guest file and keeps content/guests/index.ts in step.
 * Run it before you deploy; `-- --fix` regenerates the index for you.
 */
const fix = process.argv.includes('--fix');
const names = guestFileNames();
const { guests, problems } = validateAll();

let failed = false;

if (problems.length > 0) {
  failed = true;
  console.error('Problems in guest content:\n');
  for (const problem of problems) {
    console.error(`  content/guests/${problem.file}\n    ${problem.message}`);
  }
  console.error('');
}

if (!indexIsCurrent(names)) {
  if (fix) {
    writeIndex(names);
    console.log('Rewrote content/guests/index.ts');
  } else {
    failed = true;
    console.error(
      'content/guests/index.ts is out of date.\n' +
        '  Run: npm run guests:check -- --fix\n',
    );
  }
}

if (failed) process.exit(1);

const live = guests.filter((g) => g.status === 'live');
const seats = live.reduce((n, g) => n + g.party.length, 0);
console.log(
  `${guests.length} guest page(s): ${live.length} live, ` +
    `${guests.filter((g) => g.status === 'draft').length} draft, ` +
    `${guests.filter((g) => g.status === 'closed').length} closed.`,
);
console.log(`${seats} seat(s) offered across live pages.`);
