/**
 * Verifies the vault watcher (`src/view/vault-watcher.ts`), the cluster
 * extracted from view.ts in Phase 5.
 *
 * What it pins is the policy the watcher now owns:
 *
 * 1. A burst of .md edits collapses into ONE fan-out pass carrying both paths.
 * 2. A media edit wakes the album rescan but not the note-derived surfaces.
 * 3. The board file's own writes are ignored (the engine already re-rendered).
 * 4. A folder-level event sets the broad flag, waking everything.
 * 5. A newly created note's first metadataCache 'changed' drops the scan
 *    signatures and forces a corrective pass.
 * 6. unregister() unsubscribes, cancels the pending debounce and cancels the
 *    banner-stats debounce.
 *
 * Run: `npm run test:vault-watcher`
 */
import { strict as assert } from 'node:assert';
import { TFile } from 'obsidian';
import type { App, MetadataCache, Vault } from 'obsidian';
import { VaultWatcher } from '../src/view/vault-watcher';

// Manual timers: the watcher's 500ms debounce runs when the test says so.
const timers = new Map<number, () => void>();
let nextTimerId = 1;
(globalThis as unknown as Record<string, unknown>).window = {
	setTimeout(fn: () => void) {
		const id = nextTimerId++;
		timers.set(id, fn);
		return id;
	},
	clearTimeout(id: number) {
		timers.delete(id);
	},
	setInterval() { return 0; },
	clearInterval() {},
};
function runDebounce(): void {
	const pending = [...timers.values()];
	timers.clear();
	for (const fn of pending) fn();
}

type Handler = (file: unknown, oldPath?: string) => void;

function makeEmitter() {
	const handlers = new Map<string, Handler>();
	return {
		handlers,
		on(name: string, cb: Handler) {
			handlers.set(name, cb);
			return { name, cb };
		},
		offref(ref: { name: string }) {
			handlers.delete(ref.name);
		},
		emit(name: string, file: unknown, oldPath?: string): void {
			handlers.get(name)?.(file, oldPath);
		},
	};
}

function mdFile(path: string): TFile {
	const file = new (TFile as unknown as new () => TFile)();
	Object.assign(file, { path, extension: 'md', basename: path.split('/').pop()!.replace(/\.md$/, '') });
	return file;
}

function imageFile(path: string): TFile {
	const file = new (TFile as unknown as new () => TFile)();
	Object.assign(file, { path, extension: 'png' });
	return file;
}

const DASHBOARD = 'Boards/Dashboard.md';

function setup() {
	const vault = makeEmitter();
	const metadata = makeEmitter();
	const calls: string[] = [];
	const sectionBatches: Array<{ paths: string[]; broad: boolean; md: boolean; media: boolean }> = [];

	const watcher = new VaultWatcher({
		app: {} as App,
		vault: vault as unknown as Vault,
		metadataCache: metadata as unknown as MetadataCache,
		dashboardPath: () => DASHBOARD,
		invalidateSectionSignatures: () => calls.push('invalidate'),
		cancelPendingStats: () => calls.push('cancelStats'),
		targets: {
			refreshRecentDocs: () => calls.push('recent'),
			refreshSidebarCalendar: () => calls.push('calendar'),
			refreshOpenDayAgendas: () => calls.push('agendas'),
			refreshDailyLinkedCards: () => calls.push('daily'),
			refreshAlbumWidgets: () => calls.push('albums'),
			refreshBannerStats: () => calls.push('banner'),
			refreshSections: (paths, broad, md, media) => {
				sectionBatches.push({ paths: [...paths], broad, md, media });
			},
		},
	});
	return { watcher, vault, metadata, calls, sectionBatches };
}

// 1. A burst of .md edits collapses into one pass.
{
	const { watcher, vault, calls, sectionBatches } = setup();
	watcher.register();
	// register() tears down first (it is safe to call twice), which also
	// cancels the banner-stats debounce — start each case from a clean log.
	calls.length = 0;
	vault.emit('modify', mdFile('Notes/a.md'));
	vault.emit('modify', mdFile('Notes/b.md'));
	assert.equal(sectionBatches.length, 0, '1: nothing flushes before the debounce fires');
	runDebounce();
	assert.equal(sectionBatches.length, 1, '1: one flush for two edits');
	assert.deepEqual(sectionBatches[0]!.paths.sort(), ['notes/a.md', 'notes/b.md'],
		'1: both paths ride the same batch (lowercased for scope matching)');
	assert.equal(sectionBatches[0]!.md, true, '1: the batch counts as a note change');
	assert.equal(sectionBatches[0]!.media, false, '1: and not a media change');
	for (const name of ['recent', 'calendar', 'agendas', 'daily', 'banner']) {
		assert.ok(calls.includes(name), `1: a note change wakes "${name}"`);
	}
	assert.ok(!calls.includes('albums'), '1: a note change leaves the album slideshow alone');
	watcher.unregister();
}

// 2. A media change wakes the album rescan only. Media arrives as
//    create/delete/rename — a plain `modify` is only recorded for .md
//    (an image overwritten on the same path renders identically).
{
	const { watcher, vault, calls, sectionBatches } = setup();
	watcher.register();
	// register() tears down first (it is safe to call twice), which also
	// cancels the banner-stats debounce — start each case from a clean log.
	calls.length = 0;
	vault.emit('create', imageFile('Pictures/x.png'));
	runDebounce();
	assert.deepEqual(calls, ['albums'], '2: a media change wakes only the album rescan');
	assert.equal(sectionBatches.length, 1, '2: the sections still get the batch');
	assert.equal(sectionBatches[0]!.media, true, '2: flagged as a media change');
	assert.equal(sectionBatches[0]!.md, false, '2: and not as a note change');
	watcher.unregister();
}

// 3. The board's own writes are ignored.
{
	const { watcher, vault, calls, sectionBatches } = setup();
	watcher.register();
	// register() tears down first (it is safe to call twice), which also
	// cancels the banner-stats debounce — start each case from a clean log.
	calls.length = 0;
	vault.emit('modify', mdFile(DASHBOARD));
	runDebounce();
	assert.deepEqual(calls, [], '3: a write to the board file wakes nothing');
	assert.deepEqual(sectionBatches[0]!.paths, [], '3: and contributes no paths');
	assert.equal(sectionBatches[0]!.md, false, '3: so the batch is neither a note nor media change');
	watcher.unregister();
}

// 4. A folder-level event sets the broad flag.
{
	const { watcher, vault, calls, sectionBatches } = setup();
	watcher.register();
	// register() tears down first (it is safe to call twice), which also
	// cancels the banner-stats debounce — start each case from a clean log.
	calls.length = 0;
	vault.emit('delete', { path: 'Notes', children: [] }); // not a TFile → folder
	runDebounce();
	assert.equal(sectionBatches[0]!.broad, true, '4: a folder event is treated as broad');
	assert.equal(sectionBatches[0]!.md, true, '4: broad counts as a note change');
	assert.equal(sectionBatches[0]!.media, true, '4: and as a media change');
	assert.ok(calls.includes('albums'), '4: so the album rescan runs too');
	watcher.unregister();
}

// 5. A new note's first cache index forces a corrective pass.
{
	const { watcher, vault, metadata, calls, sectionBatches } = setup();
	watcher.register();
	calls.length = 0;
	const fresh = mdFile('Notes/new.md');
	vault.emit('create', fresh);
	runDebounce();
	const afterCreate = sectionBatches.length;
	calls.length = 0;

	metadata.emit('changed', fresh);
	runDebounce();
	assert.ok(calls.includes('invalidate'), '5: the first index drops the scan signatures');
	assert.equal(sectionBatches.length, afterCreate + 1, '5: and runs one corrective pass');

	// Bounded, not looping: every flush re-arms the lag guard for its own
	// paths, so the NEXT 'changed' for one of them earns exactly one more
	// corrective pass (and arms it again). Obsidian fires 'changed' once per
	// modification, so this cannot cycle.
	calls.length = 0;
	const before = sectionBatches.length;
	metadata.emit('changed', fresh);
	runDebounce();
	assert.equal(sectionBatches.length, before + 1, '5: one index event costs at most one pass');
	metadata.emit('changed', fresh);
	runDebounce();
	assert.equal(sectionBatches.length, before + 2, '5: and never more than one pass per event');
	watcher.unregister();
}

// 6. unregister() tears everything down.
{
	const { watcher, vault, metadata, calls, sectionBatches } = setup();
	watcher.register();
	calls.length = 0;
	assert.equal(vault.handlers.size, 4, '6: four vault events are subscribed');
	assert.equal(metadata.handlers.size, 1, '6: one metadata event is subscribed');

	vault.emit('modify', mdFile('Notes/a.md'));
	watcher.unregister();
	assert.equal(timers.size, 0, '6: the pending debounce is cancelled');
	assert.ok(calls.includes('cancelStats'), '6: the banner-stats debounce is cancelled too');
	assert.equal(vault.handlers.size, 0, '6: vault listeners are gone');
	assert.equal(metadata.handlers.size, 0, '6: metadata listener is gone');
	runDebounce();
	assert.equal(sectionBatches.length, 0, '6: a cancelled batch never flushes');
}

console.log('vault-watcher: ok');
