/**
 * Verifies the two "new note" flows (`src/view/new-note.ts`).
 *
 * Both buttons walk the same four steps — resolve folder → optional template
 * picker → title prompt → create (falling back to a bare note when the
 * template is gone) — so what is worth pinning down is where they *diverge*,
 * because every divergence is a rule someone will later "simplify" into a bug:
 *
 * 1. folder source: a folder section must have configured folders (a library
 *    section without scan folders falls back to `settings.libraryNewNotePath`);
 * 2. open mode INVERTS between the two surfaces: a library/section note opens
 *    in a tab unless it opted into the popover, a card note opens in the
 *    popover unless it opted into a tab;
 * 3. a card note is attached to the card's doc list, a section note is not —
 *    the section finds it by scanning, and only after its frontmatter is
 *    indexed (`refreshSectionAfterCreate`);
 * 4. frontmatter is pre-filled from the section's property filters, and the
 *    properties no single value can satisfy are reported to the user;
 * 5. the reentrancy guard: a second click while the title prompt is open must
 *    not stack a second dialog, and the guard must always be released.
 *
 * The dialog itself (a real DOM overlay) is driven here: these are flows, and
 * the interesting bug shape is "what happens between the prompt and the
 * write", which a pure-function test cannot see.
 *
 * Run: `npm run test:new-note`
 */
import { strict as assert } from 'node:assert';
import type { App } from 'obsidian';
import { Menu, Notice, TFile } from 'obsidian';
import { El, findByClass, findTag } from './mini-dom';
import { cardNewNote, createNewNoteState, libraryNewNote, type NewNoteHost, type NewNoteState } from '../src/view/new-note';
import type { DashboardCard, DashboardColumn, DashboardData, LibraryConfig } from '../src/types';

// The prompt dialog is body-level: it needs `activeDocument.body.createDiv`
// (mini-dom supplies the helpers) and a document that tolerates keydown
// listener churn. `querySelector` returns null on purpose — with no dashboard
// root, `applyModalTheme` is a no-op and the dialog needs no theme mirroring.
const doc = new El('body');
(globalThis as Record<string, unknown>).activeDocument = {
	body: doc,
	querySelector: () => null,
	querySelectorAll: () => [],
	addEventListener: () => {},
	removeEventListener: () => {},
};
(globalThis as Record<string, unknown>).window = globalThis;

const base = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/, '');

/** A real stub `TFile`: template resolution goes through `instanceof TFile`,
 *  so a plain `{ path, basename }` object would read as "template missing". */
const fakeFile = (path: string): TFile => Object.assign(new TFile(), { path, basename: base(path) });

/** One run's records: every observable side effect the flows can have. */
interface Rig {
	host: NewNoteHost;
	state: NewNoteState;
	created: { path: string; content: string }[];
	refreshed: string[];
	popovers: string[];
	tabs: string[];
	attached: { cardId: string; path: string }[];
}

function makeRig(options: {
	columns: DashboardColumn[];
	libraryNewNotePath?: string;
	/** Pretend these vault paths exist (note bodies, templates). */
	files?: Record<string, string>;
}): Rig {
	const files = new Map<string, string>(Object.entries(options.files ?? {}));
	const rig = {
		created: [] as { path: string; content: string }[],
		refreshed: [] as string[],
		popovers: [] as string[],
		tabs: [] as string[],
		attached: [] as { cardId: string; path: string }[],
	} as Rig;

	const app = {
		vault: {
			adapter: {
				exists: async (p: string) => files.has(p),
				mkdir: async () => {},
			},
			getAbstractFileByPath: (p: string) => (files.has(p) ? fakeFile(p) : null),
			getFileByPath: (p: string) => (files.has(p) ? fakeFile(p) : null),
			read: async (f: { path: string }) => files.get(f.path) ?? '',
			create: async (path: string, content: string) => {
				rig.created.push({ path, content });
				files.set(path, content);
				return fakeFile(path);
			},
		},
		// Indexed immediately: `refreshSectionAfterCreate` must not wait 2s here.
		metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
		workspace: {
			getLeaf: () => ({
				openFile: async (f: { path: string }) => {
					rig.tabs.push(f.path);
				},
			}),
		},
	} as unknown as App;

	const data = { columns: options.columns } as unknown as DashboardData;
	rig.host = {
		app,
		data: () => data,
		sync: () => ({ addDocToCard: async (cardId: string, path: string) => { rig.attached.push({ cardId, path }); } }),
		libraryNewNotePath: () => options.libraryNewNotePath ?? '',
		openNotePopover: (file: { path: string }) => { rig.popovers.push(file.path); },
		refreshSectionInPlace: (name: string) => { rig.refreshed.push(name); return true; },
	} as unknown as NewNoteHost;
	rig.state = createNewNoteState();
	return rig;
}

const column = (over: Partial<DashboardColumn> & { name: string }): DashboardColumn =>
	({
		sectionType: 'library',
		cards: [],
		subcolumns: [],
		...over,
	} as unknown as DashboardColumn);

const card = (over: Partial<DashboardCard> & { id: string }): DashboardCard =>
	({ type: 'generic', column: 'docs', title: '', docs: [], tasks: [], ...over } as unknown as DashboardCard);

/** Let the flow's promise chain advance (microtasks + the 0ms timer it may
 *  await between steps). */
const flush = (): Promise<void> => new Promise<void>(resolve => { setTimeout(resolve, 0); });

/** Type a title into the open prompt (or cancel it) and let the flow resume. */
async function answerPrompt(title: string | null): Promise<void> {
	// The prompt opens after the flow's own awaits (menu resolution, folder
	// checks), so give the chain a tick before looking for it.
	await flush();
	const overlays = findByClass(doc, 'dashboard-confirm-overlay');
	assert.equal(overlays.length, 1, 'exactly one prompt is on screen');
	const overlay = overlays[0]!;
	if (title === null) {
		findByClass(overlay, 'dashboard-confirm-cancel')[0]!.click();
	} else {
		const input = findTag(overlay, 'input')[0]!;
		input.value = title;
		input.dispatchEvent({ type: 'keydown', key: 'Enter' });
	}
	await flush();
}

/** Stub-only test hooks, behind the obsidian typings' back. */
const stubNotices = Notice as unknown as { messages: string[] };
const stubMenu = Menu as unknown as {
	last: null | { items: { title: string; click: () => void }[]; dismiss: () => void };
};

const promptCount = (): number => findByClass(doc, 'dashboard-confirm-overlay').length;

/** Drop any leftover dialog + notice log between cases. */
function reset(): void {
	for (const overlay of findByClass(doc, 'dashboard-confirm-overlay')) overlay.remove();
	stubNotices.messages.length = 0;
	stubMenu.last = null;
}

const LIB: LibraryConfig = {
	filters: [],
	viewMode: 'grid',
	sortBy: 'modified',
	sortDesc: true,
};

async function main(): Promise<void> {
	// ---------------------------------------------------------------- 1
	// A folder section with no configured folders cannot create anything: the
	// note would be invisible to the section's own scan.
	{
		reset();
		const rig = makeRig({ columns: [column({ name: 'docs', sectionType: 'folder', libraryConfig: { ...LIB } })] });
		void libraryNewNote(rig.host, rig.state, 'docs');
		await flush();
		assert.equal(promptCount(), 0, '1: no prompt when there is nowhere to put the note');
		assert.equal(rig.created.length, 0, '1: nothing created');
		assert.equal(stubNotices.messages.length, 1, '1: one notice');
		assert.equal(rig.state.libraryInFlight, false, '1: guard released');
	}

	// ---------------------------------------------------------------- 2
	// Sections that are neither folder nor library have no new-note button, and
	// a stray event for one must not prompt.
	{
		reset();
		const rig = makeRig({ columns: [column({ name: 'board', sectionType: 'pipeline' })] });
		void libraryNewNote(rig.host, rig.state, 'board');
		await flush();
		assert.equal(promptCount(), 0, '2: pipeline section does not prompt');
		assert.equal(rig.created.length, 0, '2: nothing created');
		assert.equal(rig.state.libraryInFlight, false, '2: guard released');
	}

	// ---------------------------------------------------------------- 3
	// Library section without scan folders → settings path, slashes trimmed.
	// Default open mode is a real tab; no doc attach on this surface.
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB } })],
			libraryNewNotePath: '/inbox/',
		});
		void libraryNewNote(rig.host, rig.state, 'docs');
		await answerPrompt('我的笔记');
		assert.equal(rig.created.length, 1, '3: one note');
		assert.equal(rig.created[0]!.path, 'inbox/我的笔记.md', '3: created in the settings path, slashes trimmed');
		assert.deepEqual(rig.tabs, ['inbox/我的笔记.md'], '3: opens in a tab by default');
		assert.deepEqual(rig.popovers, [], '3: no popover');
		assert.deepEqual(rig.attached, [], '3: section notes are not attached to a card');
		assert.deepEqual(rig.refreshed, ['docs'], '3: the section is refreshed explicitly');
		assert.equal(rig.state.libraryInFlight, false, '3: guard released');
	}

	// ---------------------------------------------------------------- 4
	// `newNoteOpenMode: 'popover'` inverts the default for a library section.
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB, newNoteOpenMode: 'popover' } })],
			libraryNewNotePath: 'inbox',
		});
		void libraryNewNote(rig.host, rig.state, 'docs');
		await answerPrompt('P');
		assert.deepEqual(rig.popovers, ['inbox/P.md'], '4: popover honoured');
		assert.deepEqual(rig.tabs, [], '4: no tab');
	}

	// ---------------------------------------------------------------- 5
	// Several scan folders → a menu at the click point; picking one wins.
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB, folders: ['a', 'b'] } })],
		});
		void libraryNewNote(rig.host, rig.state, 'docs', { x: 5, y: 5 });
		const menu = stubMenu.last;
		assert.ok(menu, '5: a folder menu is shown');
		assert.deepEqual(menu.items.map(i => i.title), ['a', 'b'], '5: every folder is offered');
		menu.items[1]!.click();
		await answerPrompt('N');
		assert.equal(rig.created[0]!.path, 'b/N.md', '5: the picked folder is used');
	}

	// ---------------------------------------------------------------- 6
	// Same menu, dismissed: nothing is created and the guard is released (a
	// dismissal is not an error the user needs a notice for).
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB, folders: ['a', 'b'] } })],
		});
		void libraryNewNote(rig.host, rig.state, 'docs', { x: 5, y: 5 });
		stubMenu.last!.dismiss();
		await flush();
		assert.equal(promptCount(), 0, '6: dismissed menu does not fall through to the prompt');
		assert.equal(rig.created.length, 0, '6: nothing created');
		assert.equal(rig.state.libraryInFlight, false, '6: guard released');
	}

	// ---------------------------------------------------------------- 7
	// Without a click position the folder menu cannot be anchored, so the flow
	// stops rather than guessing a folder.
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB, folders: ['a', 'b'] } })],
		});
		void libraryNewNote(rig.host, rig.state, 'docs');
		await flush();
		assert.equal(promptCount(), 0, '7: no position means no prompt');
		assert.equal(stubMenu.last, null, '7: no menu without a position');
		assert.equal(rig.created.length, 0, '7: nothing created');
	}

	// ---------------------------------------------------------------- 8
	// Several templates → picker; the chosen template seeds the note.
	{
		reset();
		const rig = makeRig({
			columns: [column({
				name: 'docs',
				libraryConfig: { ...LIB, templatePaths: ['tpl/a.md', 'tpl/b.md'] },
			})],
			libraryNewNotePath: 'inbox',
			files: { 'tpl/a.md': 'A body', 'tpl/b.md': 'B body' },
		});
		void libraryNewNote(rig.host, rig.state, 'docs', { x: 1, y: 1 });
		const menu = stubMenu.last!;
		// The first entry is tagged as the fallback used when the menu is
		// dismissed, so match on the path prefix rather than the exact label.
		assert.equal(menu.items.length, 2, '8: every template is offered');
		assert.ok(menu.items[0]!.title.startsWith('tpl/a.md'), '8: first entry is the default');
		assert.equal(menu.items[1]!.title, 'tpl/b.md', '8: later entries are plain paths');
		menu.items[1]!.click();
		await answerPrompt('T');
		assert.ok(rig.created[0]!.content.includes('B body'), '8: the picked template seeds the note');
	}

	// ---------------------------------------------------------------- 9
	// A template that no longer exists must not kill the creation: fall back to
	// a bare note, tell the user, and create exactly once (not zero, not two).
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB, templatePaths: ['gone.md'] } })],
			libraryNewNotePath: 'inbox',
		});
		void libraryNewNote(rig.host, rig.state, 'docs');
		await answerPrompt('F');
		assert.equal(rig.created.length, 1, '9: one note despite the missing template');
		assert.equal(rig.created[0]!.path, 'inbox/F.md', '9: at the usual place');
		assert.ok(!rig.created[0]!.content.includes('undefined'), '9: no template leftovers');
		assert.equal(stubNotices.messages.length, 2, '9: template notice + created notice');
	}

	// ---------------------------------------------------------------- 10
	// Property filters pre-fill the frontmatter; a filter no single value can
	// satisfy is reported instead of pretending the note matches.
	{
		reset();
		const rig = makeRig({
			columns: [column({
				name: 'docs',
				libraryConfig: {
					...LIB,
					filters: [
						{ property: 'owner', operator: 'equals', values: ['me'] },
						{ property: 'stage', operator: 'notEquals', values: ['done'] },
					],
				},
			})],
			libraryNewNotePath: 'inbox',
		});
		void libraryNewNote(rig.host, rig.state, 'docs');
		await answerPrompt('Props');
		assert.ok(rig.created[0]!.content.includes('"owner": "me"'), '10: matching filter is pre-filled');
		assert.ok(rig.created[0]!.content.includes('"stage"') === false, '10: un-satisfiable filter is not guessed');
		assert.ok(
			stubNotices.messages.some(m => m.includes('stage')),
			'10: the skipped property is named in a notice',
		);
	}

	// ---------------------------------------------------------------- 11
	// Cancelled prompt → nothing created, and the guard must be released (a
	// stuck guard silently disables the button until the next render).
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB } })],
			libraryNewNotePath: 'inbox',
		});
		void libraryNewNote(rig.host, rig.state, 'docs');
		await answerPrompt(null);
		assert.equal(rig.created.length, 0, '11: cancel creates nothing');
		assert.equal(rig.state.libraryInFlight, false, '11: guard released');
		// And the button works again immediately.
		void libraryNewNote(rig.host, rig.state, 'docs');
		await answerPrompt('Again');
		assert.equal(rig.created.length, 1, '11: the next click goes through');
	}

	// ---------------------------------------------------------------- 12
	// Reentrancy: a second click while the prompt is open must not stack a
	// second dialog nor create twice.
	{
		reset();
		const rig = makeRig({
			columns: [column({ name: 'docs', libraryConfig: { ...LIB } })],
			libraryNewNotePath: 'inbox',
		});
		void libraryNewNote(rig.host, rig.state, 'docs');
		await flush();
		void libraryNewNote(rig.host, rig.state, 'docs');
		await flush();
		assert.equal(promptCount(), 1, '12: one dialog only');
		await answerPrompt('Once');
		assert.equal(rig.created.length, 1, '12: one note only');
	}

	// ---------------------------------------------------------------- 13
	// Card flow: the note is attached to the card's doc list and opens in the
	// popover by default — the opposite default from the section flow.
	{
		reset();
		const rig = makeRig({
			columns: [column({
				name: 'notes',
				sectionType: 'projects',
				libraryConfig: { ...LIB, folders: ['projects'] },
				cards: [card({ id: 'c1' })],
			})],
		});
		void cardNewNote(rig.host, rig.state, 'c1');
		await answerPrompt('Doc');
		assert.equal(rig.created[0]!.path, 'projects/Doc.md', '13: card folder is the section folder');
		assert.equal(rig.attached.length, 1, '13: attached once');
		assert.deepEqual(rig.attached[0], { cardId: 'c1', path: 'projects/Doc.md' }, '13: to this card');
		assert.deepEqual(rig.popovers, ['projects/Doc.md'], '13: popover is the card default');
		assert.deepEqual(rig.tabs, [], '13: no tab');
		assert.deepEqual(rig.refreshed, [], '13: card flow does not refresh a section');
	}

	// ---------------------------------------------------------------- 14
	// `newNoteOpenMode: 'tab'` inverts it for the card flow.
	{
		reset();
		const rig = makeRig({
			columns: [column({
				name: 'notes',
				sectionType: 'projects',
				libraryConfig: { ...LIB, folders: ['projects'] },
				cards: [card({ id: 'c1', newNoteOpenMode: 'tab' })],
			})],
		});
		void cardNewNote(rig.host, rig.state, 'c1');
		await answerPrompt('Doc');
		assert.deepEqual(rig.tabs, ['projects/Doc.md'], '14: tab honoured');
		assert.deepEqual(rig.popovers, [], '14: no popover');
	}

	// ---------------------------------------------------------------- 15
	// A card with no configured folder still creates — at the vault root, which
	// is a bare filename (no leading slash).
	{
		reset();
		const rig = makeRig({
			columns: [column({
				name: 'notes',
				sectionType: 'projects',
				cards: [card({ id: 'c1' })],
			})],
		});
		void cardNewNote(rig.host, rig.state, 'c1');
		await answerPrompt('Root');
		assert.equal(rig.created[0]!.path, 'Root.md', '15: vault root path has no leading slash');
	}

	// ---------------------------------------------------------------- 16
	// Unknown card id (a stale click after a delete) → no prompt, no write.
	{
		reset();
		const rig = makeRig({ columns: [column({ name: 'notes', sectionType: 'projects' })] });
		void cardNewNote(rig.host, rig.state, 'nope');
		await flush();
		assert.equal(promptCount(), 0, '16: no prompt for an unknown card');
		assert.equal(rig.created.length, 0, '16: nothing created');
		assert.equal(rig.state.cardInFlight, false, '16: guard released');
	}

	// ---------------------------------------------------------------- 17
	// The two guards are independent: a card prompt in flight must not block a
	// section prompt (different buttons, both legitimately usable).
	{
		reset();
		const rig = makeRig({
			columns: [
				column({
					name: 'notes',
					sectionType: 'projects',
					libraryConfig: { ...LIB, folders: ['projects'] },
					cards: [card({ id: 'c1' })],
				}),
				column({ name: 'docs', libraryConfig: { ...LIB } }),
			],
			libraryNewNotePath: 'inbox',
		});
		void cardNewNote(rig.host, rig.state, 'c1');
		await flush();
		assert.equal(promptCount(), 1, '17: card prompt is up');
		void libraryNewNote(rig.host, rig.state, 'docs');
		await flush();
		assert.equal(promptCount(), 2, '17: section prompt opens alongside it');
		assert.equal(rig.state.cardInFlight, true, '17: card guard still held');
		assert.equal(rig.state.libraryInFlight, true, '17: library guard held too');
	}

	console.log('verify-new-note: ok');
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
