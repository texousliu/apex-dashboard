/**
 * Verifies the card-size (S/M/L) toggle for the library and folder sections'
 * card views:
 *
 * 1. Parser round-trip — 'small'/'large' persist to the dashboard file,
 *    'medium' (default) writes nothing, garbage parses to undefined.
 * 2. renderLibrarySection toolbar — the size control is a single collapsed
 *    dropdown (the old always-visible S/M/L row was replaced): the pill shows
 *    the current letter, the menu lists all three with a check on the active
 *    one. It is visible in grid/gallery and hidden in list/table/kanban;
 *    picking a size reports it through onConfigChange and re-renders the grid
 *    with the matching size class. 'medium' stays un-suffixed (legacy layout).
 *
 * Run: `npm run test:library-card-size`
 */
import { strict as assert } from 'node:assert';
import { Menu } from 'obsidian';
import { parse, serialize } from '../src/parser';
import { renderLibrarySection } from '../src/library-section';
import { El, findByClass } from './mini-dom';

/** Bridge to the stub's `Menu.last` (tsc only sees the real Obsidian typings,
 *  which have no static `last`). */
interface StubMenu { items: Array<{ title: string; checked: boolean; click(): void }> }
const lastMenu = (): StubMenu => (Menu as unknown as { last: StubMenu | null }).last!;

(globalThis as unknown as Record<string, unknown>).activeDocument = {
	querySelector: () => null,
	addEventListener: () => {},
	removeEventListener: () => {},
};

// ---------- 1. Parser round-trip ----------

const roundTrip = (size: string | undefined): string | undefined => {
	const dash = parse([
		'---',
		'columns:',
		'  - name: C1',
		'    type: folder',
		'    library:',
		`      cardSize: ${size}`,
		'---',
		'',
		'## C1',
	].join('\n'));
	const col = dash.columns[0];
	return serialize(dash).match(/cardSize: (\w+)/)?.[1] ?? undefined;
};

assert.equal(roundTrip('small'), 'small', 'small round-trips');
assert.equal(roundTrip('large'), 'large', 'large round-trips');
assert.equal(roundTrip('medium'), undefined, 'medium (default) writes nothing');
assert.equal(roundTrip('huge'), undefined, 'garbage value dropped');

console.log('cardSize parser round-trip: PASS');

// ---------- 2. Toolbar + rendering ----------

const makeApp = () => {
	const file = {
		path: 'notes/a.md', basename: 'a', extension: 'md',
		stat: { mtime: 1, ctime: 1 },
	};
	return {
		vault: {
			getMarkdownFiles: () => [file],
			cachedRead: async () => '---\ntitle: x\n---\n\nbody',
			adapter: { read: async () => { throw new Error('no adapter in stub'); } },
		},
		metadataCache: {
			getFileCache: () => ({ frontmatter: { title: 'x' }, tags: [] }),
			fileToLinktext: (f: { path: string }) => f.path,
		},
		workspace: { on: () => {}, off: () => {} },
		fileManager: {},
		lastEvent: null,
	} as unknown as Parameters<typeof renderLibrarySection>[2];
};

const el = new El('div');
let saved: { cardSize?: string } | undefined;
// tsc sees HTMLElement (real typings); the bundled mini-DOM provides El.
renderLibrarySection(
	el as unknown as HTMLElement,
	{ name: 'C1', color: '', sectionType: 'folder', libraryConfig: { filters: [], viewMode: 'grid', sortBy: 'modified', sortDesc: true, folders: ['notes'] } },
	makeApp(),
	cfg => { saved = { ...cfg } as { cardSize?: string }; },
);

const sizeToggle = findByClass(el, 'dashboard-library-size-toggle')[0]!;
const sizeBtn = (): El => findByClass(sizeToggle, 'dashboard-toolbar-dropdown')[0]
	?? assert.fail('size dropdown rendered');
const sizeText = (): string | undefined =>
	findByClass(sizeBtn(), 'dashboard-toolbar-dropdown-text')[0]?.textContent;
/** The menu order is small / medium / large (index 0/1/2). */
const openSizeMenu = (): StubMenu => { sizeBtn().click(); return lastMenu(); };
const pickSize = (index: number): void => { openSizeMenu().items[index]!.click(); };
const gridHost = (): El => findByClass(el, 'dashboard-library-grid')[0]
	?? findByClass(el, 'dashboard-library-gallery')[0]
	?? assert.fail('card grid rendered');

// Collapsed pill shows M; the menu lists all three with medium checked.
assert.equal(sizeText(), 'M', 'collapsed pill shows the current size (M)');
assert.ok(!sizeToggle.hasClass('is-hidden'), 'visible in grid view');

const sizeMenu = openSizeMenu();
assert.equal(sizeMenu.items.length, 3, 'menu lists three sizes');
assert.equal(sizeMenu.items.filter(i => i.checked).length, 1, 'exactly one size checked');
assert.ok(sizeMenu.items[1]!.checked, 'medium checked by default');

// aria-label is localized on the collapsed button.
assert.ok(/卡片|cards/i.test(sizeBtn().getAttribute('aria-label') ?? ''),
	`aria label localized: ${sizeBtn().getAttribute('aria-label')}`);

// Default grid carries no size class (legacy layout).
assert.ok(!gridHost().hasClass('dashboard-library-cards--small')
	&& !gridHost().hasClass('dashboard-library-cards--large'), 'medium stays un-suffixed');

// Pick S: config reported, grid re-rendered with the class.
pickSize(0);
assert.equal((saved as { cardSize?: string } | undefined)?.cardSize, 'small', 'onConfigChange carries cardSize');
assert.equal(sizeText(), 'S', 'pill shows S after picking it');
assert.ok(gridHost().hasClass('dashboard-library-cards--small'), 'grid re-rendered with small class');

// Pick L through the freshly built menu.
pickSize(2);
assert.ok(gridHost().hasClass('dashboard-library-cards--large'), 'grid re-rendered with large class');

// Switch to list: control hides; back to gallery: visible and gallery-sized.
const viewToggle = findByClass(el, 'dashboard-library-view-toggle')
	.find(v => !v.hasClass('dashboard-library-size-toggle'))!;
/** viewModes order: grid(0) / gallery(1) / list(2) / table(3) / kanban(4). */
const pickView = (index: number): void => {
	findByClass(viewToggle, 'dashboard-toolbar-dropdown')[0]!.click();
	lastMenu().items[index]!.click();
};
pickView(2);
assert.ok(sizeToggle.hasClass('is-hidden'), 'hidden in list view');
pickView(3);
assert.ok(sizeToggle.hasClass('is-hidden'), 'hidden in table view');
pickView(1);
assert.ok(!sizeToggle.hasClass('is-hidden'), 'visible in gallery view');
assert.ok(gridHost().hasClass('dashboard-library-gallery'), 'gallery view renders gallery grid');
assert.ok(gridHost().hasClass('dashboard-library-cards--large'), 'card size carries over to gallery');

// A persisted small config renders small from the start (no toggle needed).
const el2 = new El('div');
renderLibrarySection(
	el2 as unknown as HTMLElement,
	{ name: 'C2', color: '', sectionType: 'library', libraryConfig: { filters: [], viewMode: 'gallery', sortBy: 'modified', sortDesc: true, cardSize: 'small' } },
	makeApp(),
	() => {},
);
const gallery2 = findByClass(el2, 'dashboard-library-gallery')[0]!;
assert.ok(gallery2.hasClass('dashboard-library-cards--small'), 'persisted small applied on open');
assert.equal(findByClass(findByClass(el2, 'dashboard-library-size-toggle')[0]!, 'dashboard-toolbar-dropdown-text')[0]?.textContent,
	'S', 'pill shows S on open');

console.log('card size toolbar + rendering: PASS');
console.log('library card size: ALL PASS');
