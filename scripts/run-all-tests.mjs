/**
 * Runs every `test:*` npm script (the verify-* DOM harnesses) and prints a
 * single summary.
 *
 * Why this exists: the repo has ~100 verify scripts but no aggregate entry
 * point, so "did I break another card?" could only be answered by remembering
 * which scripts to run. Refactors need one gate.
 *
 * Usage:
 *   node scripts/run-all-tests.mjs                 # everything
 *   node scripts/run-all-tests.mjs dataview task   # only names containing any keyword
 *   node scripts/run-all-tests.mjs --bail          # stop at the first failure
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const bail = argv.includes('--bail');
const keywords = argv.filter(a => !a.startsWith('--')).map(a => a.toLowerCase());

const all = Object.keys(pkg.scripts)
	.filter(name => name.startsWith('test:'))
	.sort();

const selected = keywords.length === 0
	? all
	: all.filter(name => keywords.some(k => name.toLowerCase().includes(k)));

if (selected.length === 0) {
	console.error(`No test:* script matched: ${keywords.join(', ')}`);
	process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];

function runOne(name) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(npm, ['run', name], {
			cwd: root,
			shell: process.platform === 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk.toString(); });
		child.stderr.on('data', (chunk) => { output += chunk.toString(); });
		child.on('close', (code) => {
			resolve({ name, code: code ?? 1, ms: Date.now() - started, output });
		});
	});
}

const startedAll = Date.now();
for (const name of selected) {
	process.stdout.write(`  ${name} ... `);
	const result = await runOne(name);
	results.push(result);
	if (result.code === 0) {
		console.log(`ok (${result.ms}ms)`);
	} else {
		console.log(`FAILED (${result.ms}ms)`);
		const tail = result.output.trim().split('\n').slice(-25).join('\n');
		console.log(tail.split('\n').map(l => `      ${l}`).join('\n'));
		if (bail) break;
	}
}

const failed = results.filter(r => r.code !== 0);
const passed = results.length - failed.length;
const totalMs = Date.now() - startedAll;

console.log('\n' + '-'.repeat(60));
console.log(`${passed}/${results.length} passed in ${(totalMs / 1000).toFixed(1)}s`);
if (failed.length > 0) {
	console.log(`failed: ${failed.map(r => r.name).join(', ')}`);
	process.exit(1);
}
if (results.length < selected.length) {
	console.log(`not run: ${selected.slice(results.length).join(', ')}`);
}
