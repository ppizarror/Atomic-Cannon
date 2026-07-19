/**
 * Test runner — executes every `tests/*.test.ts` in its own tsx process and
 * aggregates the results. Run: pnpm test
 */
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.test.ts')).sort();

let failed = 0;
for (const f of files) {
    console.log(`\n\x1b[1m▶ ${f}\x1b[0m`);
    const r = spawnSync('npx', ['--yes', 'tsx', join(dir, f)], {stdio: 'inherit'});
    if (r.status !== 0) failed++;
}

console.log(`\n${'='.repeat(40)}`);
console.log(`${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
