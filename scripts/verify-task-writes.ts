/**
 * Verifies the two "write into the user's notes" paths
 * (`src/view/task-writes.ts`).
 *
 * These are the only places in the plugin that touch files the user typed by
 * hand, so the cases that matter are not the happy paths but the refusals and
 * the ordering:
 *
 * 1. **Nothing is written when the flow aborts.** No tasks, daily notes not
 *    configured, user cancelled, destination unresolvable — the board and the
 *    vault must both be untouched.
 * 2. **Save merges into the existing block.** Re-saving an edited card updates
 *    its entries in place, appends new ones, and leaves hand-added lines alone.
 *    A missing heading prepends a block AFTER the frontmatter (never replaces
 *    the file).
 * 3. **Archive writes the log BEFORE clearing the board.** The vault write is
 *    the thing that can fail (disk full, read-only vault); if it does, the
 *    tasks must still be on the board. This is asserted by making `modify`
 *    throw and checking `sync.archiveTasks` was never called.
 * 4. **The destination is reported.** Both flows end with a Notice carrying the
 *    path, because the destination is configurable.
 *
 * Run: `npm run test:task-writes`
 */
import { strict as assert } from 'node:assert';
import { El, findByClass } from './mini-dom';
import { SENTINEL_NOW, withFrozenNow } from './test-clock';
import { Notice, TFile } from 'obsidian';
import { archiveCompletedTasks, saveTasksToDaily, type TaskWriteHost } from '../src/view/task-writes';
import type { DashboardCard, DashboardData, DashboardSettings, TaskItem } from '../src/types';

/** The stub keeps notices in a module-level array; the typings do not know it. */
const notices = Notice as unknown as { messages: string[] };

const body = new El('body');
(globalThis as Record<string, unknown>).activeDocument = {
	body,
	querySelector: () => null,
	querySelectorAll: () => [],
	addEventListener: () => {},
	removeEventListener: () => {},
};

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const task = (text: string, checked = false, children: TaskItem[] = []): TaskItem =>
	({ text, checked, children }) as unknown as TaskItem;

interface Rig {
	host: TaskWriteHost;
	/** Every vault mutation, in call order (`create:<path>` / `modify:<path>`). */
	writes: string[];
	/** Created folders, in call order. */
	folders: string[];
	/** Paths handed to sync.archiveTasks. */
	archivedColumns: string[];
	data: DashboardData | null;
	/** Existing notes, path → content. Mutated by the flows under test. */
	files: Map<string, string>;
	/** Make the next `modify` throw (a read-only / full disk vault). */
	failModify: boolean;
	/** Daily-notes plugin folder/format; null = plugin disabled. */
	daily: { folder: string; format: string } | null;
	settings: Partial<DashboardSettings>;
}

const fakeFile = (path: string): TFile => Object.assign(new TFile(), {
	path,
	basename: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
});

function makeRig(opts: {
	settings?: Partial<DashboardSettings>;
	daily?: { folder: string; format: string } | null;
	notes?: Record<string, string>;
	columns?: DashboardData['columns'];
} = {}): Rig {
	const rig: Rig = {
		writes: [],
		folders: [],
		archivedColumns: [],
		data: { columns: opts.columns ?? [], banner: {}, quickActions: [] } as unknown as DashboardData,
		files: new Map(Object.entries(opts.notes ?? {})),
		failModify: false,
		daily: opts.daily === undefined ? null : opts.daily,
		settings: { taskArchiveTarget: 'file', taskArchivePath: 'Archive/Done', ...opts.settings },
		host: null as unknown as TaskWriteHost,
	};

	const app = {
		internalPlugins: {
			getPluginById: (id: string) => (id === 'daily-notes'
				? rig.daily ? { enabled: true, instance: { options: rig.daily } } : { enabled: false }
				: undefined),
		},
		vault: {
			adapter: {
				exists: async (p: string) => rig.folders.includes(p),
				mkdir: async (p: string) => { rig.folders.push(p); },
			},
			getAbstractFileByPath: (p: string) => (rig.files.has(p) ? fakeFile(p) : null),
			read: async (file: TFile) => rig.files.get(file.path) ?? '',
			create: async (p: string, content: string) => {
				rig.writes.push(`create:${p}`);
				rig.files.set(p, content);
				return fakeFile(p);
			},
			modify: async (file: TFile, content: string) => {
				if (rig.failModify) {
					rig.failModify = false;
					throw new Error('read-only vault');
				}
				rig.writes.push(`modify:${file.path}`);
				rig.files.set(file.path, content);
			},
		},
	} as unknown as TaskWriteHost['app'];

	rig.host = {
		app,
		data: () => rig.data,
		settings: () => rig.settings as DashboardSettings,
		sync: () => ({ archiveTasks: async (column: string) => { rig.archivedColumns.push(column); } }) as never,
	};
	return rig;
}

/** Answer the pending `showConfirmDialog` (or leave it hanging when null). */
async function answerConfirm(confirmed: boolean): Promise<void> {
	await flush();
	const overlay = findByClass(body, 'dashboard-confirm-overlay')[0];
	assert.ok(overlay, 'a confirm dialog is on screen');
	const btn = confirmed
		? findByClass(overlay, 'dashboard-confirm-delete')[0]
		: findByClass(overlay, 'dashboard-confirm-cancel')[0];
	assert.ok(btn, 'the expected button is present');
	btn.dispatchEvent({ type: 'click' });
}

function card(overrides: Partial<DashboardCard>): DashboardCard {
	return { id: 'c1', type: 'task', title: 'Sprint', tasks: [], ...overrides } as unknown as DashboardCard;
}

async function main(): Promise<void> {
	// 1. Save: a card with no tasks refuses, and writes nothing.
	{
		const rig = makeRig({ daily: { folder: 'Daily', format: 'YYYY-MM-DD' } });
		notices.messages.length = 0;
		await saveTasksToDaily(rig.host, card({ tasks: [] }));
		assert.deepEqual(rig.writes, [], '1: no write');
		assert.ok(notices.messages.length === 1, '1: one notice explains why');
	}

	// 2. Save: daily notes disabled → refusal, no write, no folder creation.
	{
		const rig = makeRig({ daily: null });
		notices.messages.length = 0;
		await saveTasksToDaily(rig.host, card({ tasks: [task('a')] }));
		assert.deepEqual(rig.writes, [], '2: no write');
		assert.deepEqual(rig.folders, [], '2: no folder created either');
		assert.ok(notices.messages.length === 1, '2: one notice explains why');
	}

	// 3. Save into a note that does not exist yet: create it inside the daily
	//    folder (created first), with the heading + serialized tasks.
	{
		const rig = makeRig({ daily: { folder: 'Daily', format: 'YYYY-MM-DD' } });
		notices.messages.length = 0;
		await saveTasksToDaily(rig.host, card({ title: 'Sprint', tasks: [task('a'), task('b', true)] }));
		assert.deepEqual(rig.folders, ['Daily'], '3: daily folder created');
		assert.equal(rig.writes.length, 1, '3: exactly one write');
		assert.ok(rig.writes[0]!.startsWith('create:Daily/'), '3: created inside the daily folder');
		const content = [...rig.files.values()][0]!;
		assert.ok(content.startsWith('### Sprint\n'), '3: block starts with the card heading');
		assert.ok(content.includes('- [ ] a') && content.includes('- [x] b'), '3: tasks serialized');
		assert.ok(notices.messages.some(m => m.includes('Daily/')), '4: notice reports the destination');
	}

	// 4. Save into an existing note WITH the heading: merge, do not append a
	//    second copy. The hand-added line the card knows nothing about stays.
	{
		// Sentinel instant, not a date that could plausibly be "today": if the
		// freeze ever stops reaching moment(), the path below cannot match by
		// accident (see scripts/test-clock.ts).
		const path = `Daily/${SENTINEL_NOW.slice(0, 10)}.md`;
		const existing = [
			'---', 'tags: [daily]', '---', '',
			'### Sprint', '- [ ] a', '- [ ] hand-added', '',
			'## Other', 'body',
		].join('\n');
		const rig = makeRig({
			daily: { folder: 'Daily', format: 'YYYY-MM-DD' },
			notes: { [path]: existing },
		});
		await withFrozenNow(SENTINEL_NOW, () =>
			saveTasksToDaily(rig.host, card({ title: 'Sprint', tasks: [task('a', true)] })));
		assert.ok(rig.files.has(path), '4: "today" resolves to the frozen date, not the real one');
		const content = rig.files.get(path)!;
		assert.equal(content.match(/### Sprint/g)?.length, 1, '4: still exactly one block');
		assert.ok(content.includes('- [x] a'), '4: card entry updated in place');
		assert.ok(content.includes('- [ ] hand-added'), '4: hand-added line survives the merge');
		assert.ok(content.startsWith('---\ntags: [daily]\n---'), '4: frontmatter untouched');
	}

	// 5. Save into an existing note WITHOUT the heading: prepend a block after
	//    the frontmatter (the file must never be rewritten from scratch).
	{
		const path = `Daily/${SENTINEL_NOW.slice(0, 10)}.md`;
		const rig = makeRig({
			daily: { folder: 'Daily', format: 'YYYY-MM-DD' },
			notes: { [path]: '---\ntags: [daily]\n---\n\n## Notes\nkept\n' },
		});
		await withFrozenNow(SENTINEL_NOW, () =>
			saveTasksToDaily(rig.host, card({ title: 'Sprint', tasks: [task('a')] })));
		assert.ok(rig.files.has(path), '5: "today" resolves to the frozen date, not the real one');
		const content = rig.files.get(path)!;
		assert.ok(content.startsWith('---\ntags: [daily]\n---\n### Sprint'), '5: block lands right after the frontmatter');
		assert.ok(content.includes('## Notes\nkept'), '5: existing body preserved below');
		assert.equal(content.match(/### Sprint/g)?.length, 1, '5: one block only');
	}

	// 6. Archive: nothing to archive → refusal, no write, board untouched.
	{
		const rig = makeRig({
			columns: [{ name: 'todo', sectionType: 'sticky', cards: [card({ tasks: [task('open')] })] }] as never,
		});
		notices.messages.length = 0;
		await archiveCompletedTasks(rig.host, 'todo');
		assert.deepEqual(rig.writes, [], '6: no write');
		assert.deepEqual(rig.archivedColumns, [], '6: board untouched');
		assert.ok(notices.messages.length === 1, '6: one notice explains why');
	}

	// 7. Archive: unknown column / no data → silent no-op (not an error notice;
	//    a stale menu item must not shout).
	{
		const rig = makeRig({ columns: [] as never });
		notices.messages.length = 0;
		await archiveCompletedTasks(rig.host, 'gone');
		assert.deepEqual(rig.writes, [], '7: no write');
		assert.equal(notices.messages.length, 0, '7: silent');
	}

	// 8. Archive: cancelled → no write, no board mutation.
	{
		const rig = makeRig({
			columns: [{ name: 'todo', sectionType: 'sticky', cards: [card({ tasks: [task('done', true)] })] }] as never,
		});
		const run = archiveCompletedTasks(rig.host, 'todo');
		await answerConfirm(false);
		await run;
		assert.deepEqual(rig.writes, [], '8: no write after cancel');
		assert.deepEqual(rig.archivedColumns, [], '8: board untouched after cancel');
	}

	// 9. Archive to the configured file: append (not overwrite), with the
	//    running-log line carrying time + task + card, then clear the board.
	{
		const rig = makeRig({
			// The convention (documented in the settings UI) is an explicit .md path;
			// slashes are stripped, and a missing extension is added (case 13).
			settings: { taskArchiveTarget: 'file', taskArchivePath: '/Archive/Done.md/' },
			notes: { 'Archive/Done.md': '# Log\n\n- old entry\n' },
			columns: [{
				name: 'todo', sectionType: 'sticky',
				cards: [card({ title: 'Sprint', tasks: [task('done', true), task('open')] })],
			}] as never,
		});
		notices.messages.length = 0;
		const run = archiveCompletedTasks(rig.host, 'todo');
		await answerConfirm(true);
		await run;
		const content = rig.files.get('Archive/Done.md')!;
		assert.ok(content.startsWith('# Log\n\n- old entry\n'), '9: existing log preserved');
		assert.ok(content.includes('done'), '9: archived task logged');
		assert.ok(content.includes('Sprint'), '9: log line names the card');
		assert.ok(!content.includes('open'), '9: unchecked task is not archived');
		assert.deepEqual(rig.archivedColumns, ['todo'], '9: board cleared after the write');
		assert.ok(notices.messages.some(m => m.includes('Archive/Done.md')), '9: notice reports the destination');
	}

	// 10. Archive must CREATE the destination file (with its folder) when it is
	//     missing, and still append cleanly.
	{
		const rig = makeRig({
			settings: { taskArchiveTarget: 'file', taskArchivePath: 'Log/Archived.md' },
			columns: [{ name: 'todo', sectionType: 'sticky', cards: [card({ tasks: [task('done', true)] })] }] as never,
		});
		const run = archiveCompletedTasks(rig.host, 'todo');
		await answerConfirm(true);
		await run;
		assert.deepEqual(rig.folders, ['Log'], '10: destination folder created');
		assert.ok(rig.writes[0] === 'create:Log/Archived.md', '10: destination file created');
		assert.deepEqual(rig.archivedColumns, ['todo'], '10: board cleared');
	}

	// 11. THE invariant: the log write happens BEFORE the board is cleared. If
	//     the write fails, the tasks stay put (a retry is possible, nothing is
	//     lost) and the failure is reported.
	{
		const rig = makeRig({
			settings: { taskArchiveTarget: 'file', taskArchivePath: 'Archive/Done.md' },
			notes: { 'Archive/Done.md': '# Log\n' },
			columns: [{ name: 'todo', sectionType: 'sticky', cards: [card({ tasks: [task('done', true)] })] }] as never,
		});
		rig.failModify = true;
		notices.messages.length = 0;
		const run = archiveCompletedTasks(rig.host, 'todo');
		await answerConfirm(true);
		await run;
		assert.deepEqual(rig.archivedColumns, [], '11: board NOT cleared when the log write fails');
		assert.equal(rig.files.get('Archive/Done.md'), '# Log\n', '11: destination unchanged');
		assert.ok(notices.messages.length >= 1, '11: failure reported');
	}

	// 12. Archive to "today's daily note" when the core plugin is off: abort
	//     BEFORE clearing the board (the same invariant, different exit).
	{
		const rig = makeRig({
			settings: { taskArchiveTarget: 'daily' },
			daily: null,
			columns: [{ name: 'todo', sectionType: 'sticky', cards: [card({ tasks: [task('done', true)] })] }] as never,
		});
		notices.messages.length = 0;
		const run = archiveCompletedTasks(rig.host, 'todo');
		await answerConfirm(true);
		await run;
		assert.deepEqual(rig.writes, [], '12: no write without a resolvable daily note');
		assert.deepEqual(rig.archivedColumns, [], '12: board untouched');
		assert.ok(notices.messages.length >= 1, '12: explains why');
	}

	// 13. A destination typed WITHOUT an extension gains `.md`. The vault only
	//     indexes markdown by extension, so `Archive/Done` used to create a file
	//     the explorer never lists — the tasks were written, the notice said
	//     "archived", and the user could not find them.
	{
		const rig = makeRig({
			settings: { taskArchiveTarget: 'file', taskArchivePath: 'Archive/Done' },
			columns: [{ name: 'todo', sectionType: 'sticky', cards: [card({ tasks: [task('done', true)] })] }] as never,
		});
		const run = archiveCompletedTasks(rig.host, 'todo');
		await answerConfirm(true);
		await run;
		assert.ok(rig.writes[0] === 'create:Archive/Done.md', '13: extension appended');
		assert.ok(!rig.writes.some(w => w.endsWith('Archive/Done')), '13: nothing written without .md');
		assert.ok(notices.messages.some(m => m.includes('Archive/Done.md')), '13: notice reports the real path');
	}

	console.log('verify-task-writes: ok');
}

void main();
