/**
 * Verifies the library / folder toolbar refresh button.
 *
 * The section already repaints itself from vault events, but that path skips
 * the rebuild when its render-input signature is unchanged — the case that
 * matters here is a note whose frontmatter only resolves after the metadata
 * cache catches up (signature same, content different). This button is the
 * manual escape hatch, so the tests pin four separate things:
 *
 * 1. Both section types render it, localized, inside the toolbar, next to the
 *    config gear and the new-note button (it must not replace either).
 * 2. A click really re-queries the vault: the file list is read again, a note
 *    created after the first render appears, a deleted one disappears, and
 *    neither happens without the click (the negative control — otherwise a
 *    passing "appears after click" proves nothing).
 * 3. Frontmatter that arrives late shows up on refresh, which is the exact
 *    scenario the signature guard cannot see.
 * 4. The refresh keeps the view: search text, current page and the toolbar
 *    elements themselves all survive. A refresh that rebuilt the toolbar would
 *    silently drop the user's search and jump them back to page 1.
 *
 * Run: `npm run test:library-refresh`
 */
import { strict as assert } from 'node:assert';
import { App, TFile } from 'obsidian';
import { renderLibrarySection } from '../src/library-section';
import type { LibraryConfig } from '../src/types';
import { El, findByClass } from './mini-dom';

(globalThis as unknown as Record<string, unknown>).activeDocument = {
	querySelector: () => null,
	addEventListener: () => {},
	removeEventListener: () => {},
};

// The search box debounces through window.setTimeout; there is no window here.
(globalThis as unknown as Record<string, unknown>).window = {
	setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
};

interface NoteSeed {
	path: string;
	/** Frontmatter the metadata cache reports for this note right now. */
	fm: Record<string, unknown>;
	mtime: number;
}

interface World {
	app: App;
	/** The live vault listing — mutating it simulates file-system changes. */
	files: TFile[];
	add(seed: NoteSeed): void;
	remove(path: string): void;
	/** Frontmatter swap: same file, different cache contents (the late-parse case). */
	setFm(path: string, fm: Record<string, unknown>): void;
	/** How many times the renderer asked the vault for its file list. */
	scans(): number;
}

function makeWorld(seeds: NoteSeed[]): World {
	const toFile = (seed: NoteSeed): TFile => Object.assign(new TFile(), {
		path: seed.path,
		basename: seed.path.replace(/^.*\//, '').replace(/\.md$/, ''),
		extension: 'md',
		stat: { mtime: seed.mtime, ctime: seed.mtime },
	});
	const files: TFile[] = seeds.map(toFile);
	const frontmatter = new Map<string, Record<string, unknown>>(seeds.map(s => [s.path, s.fm]));
	let scans = 0;

	const app = {
		vault: {
			getMarkdownFiles: () => { scans++; return files; },
			cachedRead: async () => '',
			adapter: { read: async () => '' },
		},
		metadataCache: {
			getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) ?? {}, tags: [] }),
			fileToLinktext: (file: TFile) => file.path,
		},
		workspace: { on: () => {}, off: () => {} },
		fileManager: {},
	} as unknown as App;

	return {
		app,
		files,
		add(seed) { files.push(toFile(seed)); frontmatter.set(seed.path, seed.fm); },
		remove(path) {
			const i = files.findIndex(f => f.path === path);
			if (i < 0) throw new Error(`cannot remove unknown note: ${path}`);
			files.splice(i, 1);
			frontmatter.delete(path);
		},
		setFm(path, fm) {
			if (!frontmatter.has(path)) throw new Error(`cannot retag unknown note: ${path}`);
			frontmatter.set(path, fm);
		},
		scans: () => scans,
	};
}

interface RenderOptions {
	sectionType?: 'library' | 'folder';
	config?: Partial<LibraryConfig>;
}

function renderSection(app: App, opts: RenderOptions = {}): El {
	const el = new El('div');
	renderLibrarySection(
		el as unknown as HTMLElement,
		{
			name: 'DB',
			color: '',
			sectionType: opts.sectionType ?? 'library',
			libraryConfig: {
				filters: [],
				viewMode: 'grid',
				sortBy: 'modified',
				sortDesc: true,
				...opts.config,
			},
		},
		app,
		() => {},
	);
	return el;
}

const cardTitles = (el: El): string[] =>
	findByClass(el, 'dashboard-library-card-title').map(t => t.textContent);

const refreshBtnOf = (el: El): El => {
	const found = findByClass(el, 'dashboard-library-refresh-btn');
	assert.equal(found.length, 1, 'exactly one refresh button');
	return found[0]!;
};

const countText = (el: El): string => findByClass(el, 'dashboard-library-count')[0]?.textContent ?? '';

const seed = (name: string, mtime = 1): NoteSeed =>
	({ path: `notes/${name}.md`, fm: {}, mtime });

async function main(): Promise<void> {
	// ---------- 1. Rendered on both section types, next to its neighbours ----------
	for (const sectionType of ['library', 'folder'] as const) {
		const world = makeWorld([seed('a')]);
		const el = renderSection(world.app, {
			sectionType,
			// A folder section with no folder would render the "unconfigured"
			// explanation instead of the toolbar.
			config: sectionType === 'folder' ? { folders: ['notes'] } : {},
		});

		const btn = refreshBtnOf(el);
		const label = btn.getAttribute('aria-label');
		assert.ok(
			label === '刷新' || label === '重新整理' || /refresh/i.test(label ?? ''),
			`aria-label localized on ${sectionType} (got ${String(label)})`,
		);
		assert.equal(
			(btn as unknown as { title?: string }).title,
			label,
			'title mirrors the aria-label',
		);

		// Same toolbar as the config gear / new-note button — the header keeps
		// only trash for these sections, so a refresh that landed there instead
		// would read as a different affordance.
		const toolbar = findByClass(el, 'dashboard-library-toolbar')[0];
		assert.ok(toolbar && btn.parent === toolbar, 'button lives in the section toolbar');
		assert.equal(findByClass(el, 'dashboard-library-config-btn').length, 1, 'config gear still rendered');
		assert.equal(findByClass(el, 'dashboard-library-newnote-btn').length, 1, 'new-note button still rendered');
	}
	console.log('refresh button rendered (library + folder): PASS');

	// ---------- 2. A click re-queries the vault ----------
	{
		const world = makeWorld([seed('a'), seed('b', 2)]);
		const el = renderSection(world.app);
		assert.equal(world.scans(), 1, 'initial render reads the vault once');
		assert.deepEqual(cardTitles(el).sort(), ['a', 'b'], 'both notes start on screen');

		// Negative control: the new note is in the vault but NOT on screen
		// until the button is clicked. Without this the next assertion would
		// pass even if the click did nothing (a background repaint could be
		// the real cause).
		world.add(seed('c', 3));
		assert.deepEqual(cardTitles(el).sort(), ['a', 'b'], 'new note stays hidden before the click');

		refreshBtnOf(el).click();
		assert.equal(world.scans(), 2, 'click reads the vault again');
		assert.deepEqual(cardTitles(el).sort(), ['a', 'b', 'c'], 'new note appears after the click');
		assert.match(countText(el), /3/, 'file count follows the new result set');
	}

	// ---------- 3. Deleting a note removes it from the card ----------
	{
		const world = makeWorld([seed('a'), seed('b', 2)]);
		const el = renderSection(world.app);
		world.remove('notes/a.md');
		assert.equal(cardTitles(el).length, 2, 'deleted note lingers before the click');

		refreshBtnOf(el).click();
		assert.deepEqual(cardTitles(el), ['b'], 'deleted note gone after the click');
	}

	// ---------- 4. Late frontmatter (the case the signature guard cannot see) ----------
	{
		// One note, filtered on status=done. The first render sees an empty
		// cache entry (Obsidian has not parsed it yet), so the section shows
		// nothing. The signature is path+mtime and never changes — only the
		// cache contents do — so a vault-event refresh would skip this rebuild.
		const world = makeWorld([seed('a')]);
		const el = renderSection(world.app, {
			config: { filters: [{ property: 'status', values: ['done'] }] },
		});
		assert.deepEqual(cardTitles(el), [], 'unparsed frontmatter means no match yet');

		world.setFm('notes/a.md', { status: 'done' });
		assert.deepEqual(cardTitles(el), [], 'cache catch-up alone does not repaint');

		refreshBtnOf(el).click();
		assert.deepEqual(cardTitles(el), ['a'], 'refresh picks up the resolved frontmatter');
	}
	console.log('refresh re-queries the vault: PASS');

	// ---------- 5. Search text survives a refresh ----------
	{
		const world = makeWorld([seed('alpha'), seed('beta', 2), seed('bravo', 3)]);
		const el = renderSection(world.app);
		const search = findByClass(el, 'dashboard-library-search')[0]!;

		search.value = 'bra';
		search.dispatchEvent({ type: 'input' });
		// The search handler debounces at 200ms.
		await new Promise(resolve => setTimeout(resolve, 260));
		assert.deepEqual(cardTitles(el), ['bravo'], 'search narrowed the result set');

		refreshBtnOf(el).click();
		assert.deepEqual(cardTitles(el), ['bravo'], 'refresh kept the search filter');
		assert.equal(findByClass(el, 'dashboard-library-search')[0], search, 'toolbar was not rebuilt');

		// And the filtered-away notes are still reachable once the box clears —
		// proving the query ran over the full vault, not the visible subset.
		search.value = '';
		search.dispatchEvent({ type: 'input' });
		await new Promise(resolve => setTimeout(resolve, 260));
		assert.deepEqual(cardTitles(el).sort(), ['alpha', 'beta', 'bravo'], 'full set visible again');
	}

	// ---------- 6. The current page survives a refresh ----------
	{
		const world = makeWorld([
			seed('a', 1), seed('b', 2), seed('c', 3), seed('d', 4), seed('e', 5),
		]);
		// sortDesc on mtime → e, d, c, b, a. Two per page → page 2 is c, b.
		const el = renderSection(world.app, { config: { pageSize: 2 } });
		assert.deepEqual(cardTitles(el), ['e', 'd'], 'page 1 first');

		const page2 = findByClass(el, 'dashboard-library-pagination-page').find(p => p.textContent === '2');
		assert.ok(page2, 'pagination offers page 2');
		page2!.click();
		assert.deepEqual(cardTitles(el), ['c', 'b'], 'page 2 shows the next slice');

		refreshBtnOf(el).click();
		assert.deepEqual(cardTitles(el), ['c', 'b'], 'refresh stays on page 2');

		// Shrinking the result set below the current page clamps instead of
		// rendering an empty page: three of five notes vanish, so page 2 no
		// longer exists and the render falls back to the only remaining page.
		world.remove('notes/a.md');
		world.remove('notes/b.md');
		world.remove('notes/c.md');
		refreshBtnOf(el).click();
		assert.deepEqual(cardTitles(el), ['e', 'd'], 'page clamped back to the last page');
		assert.deepEqual(
			findByClass(el, 'dashboard-library-pagination-page'),
			[],
			'a single page renders no pager at all (an unclamped page 2 would be empty)',
		);
	}

	console.log('refresh keeps search + page: PASS');
	console.log('verify-library-refresh: ok');
}

void main();
