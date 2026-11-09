/**
 * Verifies the shared task-toggle write base (src/task-toggle.ts) — the ONE
 * persistence path every note-backed task surface (dataview rows, calendar
 * section/widget, day agendas) goes through:
 *
 * 1. A single write flips the note, reports wrote:true, and updates the
 *    target's line/originalLine in place (in-place surfaces keep toggling the
 *    SAME object across writes).
 * 2. Serialization: two overlapping writes (two cards showing the same note,
 *    or two quick clicks) must BOTH land — the old unqueued path read the file
 *    twice concurrently and the later write restored the earlier state.
 * 3. A throwing vault write resolves (never rejects) with outcome.error, shows
 *    the failure Notice once, and does not poison the queue.
 * 4. An unlocatable line (skeleton no longer in the note) reports wrote:false
 *    with NO error and NO Notice.
 * 5. The scan-cache invalidation is wired (source contract).
 *
 * Run: `npm run test:task-toggle-contract`
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';

/** tsc sees the real Notice typing; the runtime alias points at the stub,
 *  which records every message on noticeMessages(). */
const noticeMessages = (): string[] => (Notice as unknown as { messages: string[] }).messages;
import { writeTaskToggle, type TaskToggleTarget } from '../src/task-toggle';
import { t } from '../src/i18n';

async function main(): Promise<void> {

/** Fake vault whose process() is a DELAYED read-modify-write — the delay
 *  widens the interleaving window so a missing queue loses updates. */
function makeApp(files: Record<string, string>, opts: { delayMs?: number; failPath?: string } = {}): { app: App; read: (p: string) => string } {
	const store = new Map(Object.entries(files));
	const mkFile = (path: string): TFile => ({ path, stat: { mtime: 1 } } as unknown as TFile);
	const app = {
		vault: {
			process: async (file: TFile, cb: (data: string) => string): Promise<string> => {
				const before = store.get(file.path) ?? '';
				if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
				if (opts.failPath === file.path) throw new Error('disk on fire');
				const next = cb(before);
				store.set(file.path, next);
				return next;
			},
		},
		__mkFile: mkFile,
	} as unknown as App;
	return { app, read: (p: string) => store.get(p) ?? '' };
}

const NOTE = 'note.md';
const TARGET = (app: { __mkFile: (p: string) => TFile }, line: number, originalLine: string): TaskToggleTarget & { file: TFile } =>
	({ path: NOTE, file: app.__mkFile(NOTE), line, originalLine }) as TaskToggleTarget & { file: TFile };

/* ------------------------- 1. single write, in place ------------------------- */

{
	const { app, read } = makeApp({ [NOTE]: '# t\n\n- [ ] A\n- [ ] B\n' });
	const target = TARGET(app as never, 2, '- [ ] A');
	const outcome = await writeTaskToggle(app, target, true);
	assert.deepEqual(outcome, { wrote: true }, '1: a located line writes and reports wrote:true');
	assert.ok(read(NOTE).includes('- [x] A'), '1: the note carries the flip');
	assert.equal(target.line, 2, '1: line stays resolved');
	assert.equal(target.originalLine, '- [x] A', '1: originalLine is updated in place for the NEXT toggle');
}

/* ----------------------------- 2. serialization ----------------------------- */

{
	// Two writes fired back-to-back WITHOUT awaiting between them — the exact
	// shape of "two cards show the same note" / rapid clicks. Without the
	// queue both read the pre-write content and the second write restores the
	// first task's open checkbox (the lost-update bug this service exists for).
	const { app, read } = makeApp({ [NOTE]: '- [ ] A\n- [ ] B\n' }, { delayMs: 5 });
	const a = writeTaskToggle(app, TARGET(app as never, 0, '- [ ] A'), true);
	const b = writeTaskToggle(app, TARGET(app as never, 1, '- [ ] B'), true);
	const [oa, ob] = await Promise.all([a, b]);
	assert.equal(oa.wrote, true, '2: the first write lands');
	assert.equal(ob.wrote, true, '2: the second write lands too');
	assert.ok(read(NOTE).includes('- [x] A') && read(NOTE).includes('- [x] B'),
		'2: BOTH flips survive — no lost update from interleaved read-modify-writes');
}

/* ------------------------------ 3. write throws ------------------------------ */

{
	noticeMessages().length = 0;
	const { app, read } = makeApp({ [NOTE]: '- [ ] A\n', 'ok.md': '- [ ] C\n' }, { failPath: NOTE });
	const outcome = await writeTaskToggle(app, TARGET(app as never, 0, '- [ ] A'), true);
	assert.equal(outcome.wrote, false, '3: a failed write reports wrote:false');
	assert.ok(outcome.error !== undefined, '3: the error rides on the outcome');
	assert.ok(noticeMessages().includes(t('alltasks.toggleFailed')), '3: exactly the failure Notice is shown');
	// The queue must survive the failure: the NEXT write goes through.
	const ok = await writeTaskToggle(app, { path: 'ok.md', file: (app as never as { __mkFile: (p: string) => TFile }).__mkFile('ok.md'), line: 0, originalLine: '- [ ] C' } as TaskToggleTarget, true);
	assert.equal(ok.wrote, true, '3: the queue survives a failed write');
	assert.ok(read('ok.md').includes('- [x] C'), '3: ...and the next write lands');
	assert.equal(noticeMessages().length, 1, '3: no duplicate Notice for the retried write');
}

/* ---------------------------- 4. line not located ---------------------------- */

{
	noticeMessages().length = 0;
	const { app } = makeApp({ [NOTE]: 'completely different content\n' });
	const outcome = await writeTaskToggle(app, TARGET(app as never, 0, '- [ ] A'), true);
	assert.deepEqual(outcome, { wrote: false }, '4: an unlocatable line reports wrote:false with NO error');
	assert.equal(noticeMessages().length, 0, '4: a drifted line is not a user-facing failure');
}

/* ------------------------- 5. invalidation is wired ------------------------- */

{
	const src = readFileSync('src/task-toggle.ts', 'utf8');
	assert.ok(src.includes('invalidatePath(target.path)'),
		'5: a successful write invalidates the scan cache for the note');
	assert.ok(src.includes("from './dql/page-builder'"),
		'5: through the shared page cache, not a private copy');
}

}

main().then(
	() => console.log('task toggle contract: all scenarios OK'),
	(err: unknown) => { console.error(err); process.exit(1); },
);
