/**
 * Verifies the incremental-refresh scope policy (`src/view/change-scope.ts`).
 *
 * This is the "which sections need rebuilding after this vault change" half of
 * the refresh pipeline — pure decisions, so nearly everything here is about
 * rules rather than DOM. Four rules carry the weight:
 *
 * 1. **Immersive boards freeze the scanning sections.** A pinned library tile
 *    is a view of the vault, not a live mirror: rebuilding it swaps the tile
 *    element, and at a high vault-event rate that reads as strobing. Calendar
 *    grids are the exception (in-place update, no element swap), and pinned
 *    tiles still refresh when the edit lands INSIDE their configured scope.
 * 2. **"No configured folders" means opposite things on the two layouts.** A
 *    whole-vault library must refresh on a classic board or nothing ever would;
 *    on an immersive board that same section must stay frozen. The two
 *    predicates are deliberately separate — this file pins the asymmetry so a
 *    future "cleanup" cannot quietly merge them.
 * 3. **Scope is a prefix test on folders, an exact match on Gantt sources.**
 *    `docs/a.md` is inside `docs`; `docs2/a.md` is not.
 * 4. **No DOM → full render; nothing swapped → no DnD rewire.** Both are
 *    cheap-exit paths that used to be buried at the bottom of a 122-line
 *    method, where a stray early `return` could silently skip the rewire.
 *
 * Run: `npm run test:change-scope`
 */
import { strict as assert } from 'node:assert';
import { El } from './mini-dom';
import {
	immersiveTileInScope,
	refreshSectionsFor,
	scanningSectionNeedsRefresh,
	sectionInScope,
	type ChangeScopeHost,
} from '../src/view/change-scope';
import type { DashboardColumn, DashboardData, DashboardSettings } from '../src/types';

// render/section-refresh builds its column selector with CSS.escape; Node has
// no CSS object. Only escaping matters here, and only for quote characters.
(globalThis as Record<string, unknown>).CSS = {
	escape: (value: string): string => value.replace(/["\\]/g, '\\$&'),
};

type LayoutMode = 'side' | 'immersive';

interface Rig {
	/** Column names passed to refreshSectionInPlace, in call order. */
	refreshes: string[];
	/** Data objects handed to fullRender. */
	fullRenders: DashboardData[];
	/** Every rewireAfterSwap call (kanban identity + immersive flag). */
	rewires: Array<{ kanban: unknown; immersive: boolean }>;
	/** How many times the policy asked for the kanban element. */
	kanbanAsks: number;
	kanbanEl: El | null;
	data: DashboardData | null;
	host: ChangeScopeHost;
}

function column(name: string, sectionType: string, extra: Partial<DashboardColumn> = {}): DashboardColumn {
	return { name, sectionType, cards: [], ...extra } as unknown as DashboardColumn;
}

function board(columns: DashboardColumn[], layout: LayoutMode): DashboardData {
	return { layout, columns, banner: {}, quickActions: [] } as unknown as DashboardData;
}

function makeRig(opts: {
	columns: DashboardColumn[];
	layout?: LayoutMode;
	/** false = the view has not been laid out yet (no kanban in the DOM). */
	withKanban?: boolean;
	/** null = board data not loaded (mid board-switch). */
	noData?: boolean;
}): Rig {
	const kanbanEl = opts.withKanban === false ? null : new El('div');
	if (kanbanEl) kanbanEl.addClass('dashboard-kanban');
	const data = opts.noData ? null : board(opts.columns, opts.layout ?? 'side');
	const rig: Rig = {
		refreshes: [],
		fullRenders: [],
		rewires: [],
		kanbanAsks: 0,
		kanbanEl,
		data,
		host: null as unknown as ChangeScopeHost,
	};
	rig.host = {
		app: {
			vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
			metadataCache: { getFileCache: () => ({}) },
		} as unknown as ChangeScopeHost['app'],
		data: () => rig.data,
		settings: () => ({ layoutMode: opts.layout ?? 'side', dashboardFile: 'dashboard.md' }) as unknown as DashboardSettings,
		kanban: () => {
			rig.kanbanAsks += 1;
			return rig.kanbanEl as unknown as HTMLElement | null;
		},
		callbacks: () => ({}) as unknown as ReturnType<ChangeScopeHost['callbacks']>,
		hoverParent: () => null,
		refreshSectionInPlace: name => { rig.refreshes.push(name); },
		fullRender: next => { rig.fullRenders.push(next); },
		rewireAfterSwap: (kanban, immersive) => { rig.rewires.push({ kanban, immersive }); },
	};
	return rig;
}

function main(): void {
	// 1. Guard: no board data (mid switch) — the policy must not touch anything.
	{
		const rig = makeRig({ columns: [column('docs', 'library')], noData: true });
		refreshSectionsFor(rig.host, ['docs/a.md'], false, true, false);
		assert.deepEqual(rig.refreshes, [], '1: no in-place rebuild without data');
		assert.equal(rig.fullRenders.length, 0, '1: no full render without data');
		assert.equal(rig.rewires.length, 0, '1: no DnD rewire without data');
		assert.equal(rig.kanbanAsks, 0, '1: does not even look for the kanban');
	}

	// 2. No DOM yet (first render still in flight) → one full render, no patching.
	{
		const rig = makeRig({ columns: [column('docs', 'library')], withKanban: false });
		refreshSectionsFor(rig.host, ['docs/a.md'], false, true, false);
		assert.equal(rig.fullRenders.length, 1, '2: falls back to a full render');
		assert.equal(rig.fullRenders[0], rig.data, '2: hands over the live data object');
		assert.deepEqual(rig.refreshes, [], '2: nothing patched in place');
		assert.equal(rig.rewires.length, 0, '2: nothing swapped, nothing rewired');
	}

	// 3. Immersive + whole-vault library: frozen. The calendar pass still runs
	//    (its grid updates in place, so it cannot strobe), but no tile is rebuilt.
	{
		const rig = makeRig({ columns: [column('docs', 'library')], layout: 'immersive' });
		refreshSectionsFor(rig.host, ['docs/a.md'], false, true, false);
		assert.deepEqual(rig.refreshes, [], '3: pinned whole-vault tile stays frozen');
		assert.equal(rig.fullRenders.length, 0, '3: a freeze is not a full render');
		assert.equal(rig.kanbanAsks, 1, '3: calendars still get their in-place pass');
		assert.equal(rig.rewires.length, 0, '3: nothing swapped');
	}

	// 4. Immersive + scoped library: refreshes on a hit, stays put on a miss.
	{
		const scoped = column('docs', 'library', { libraryConfig: { folders: ['/Docs/'] } } as Partial<DashboardColumn>);
		const hit = makeRig({ columns: [scoped], layout: 'immersive' });
		refreshSectionsFor(hit.host, ['docs/note.md'], false, true, false);
		assert.deepEqual(hit.refreshes, ['docs'], '4: edit inside the scope rebuilds the tile');

		const miss = makeRig({ columns: [scoped], layout: 'immersive' });
		refreshSectionsFor(miss.host, ['elsewhere/note.md'], false, true, false);
		assert.deepEqual(miss.refreshes, [], '4: edit outside the scope leaves it alone');

		// Suffix trap: a sibling folder is not a prefix match.
		const sibling = makeRig({ columns: [scoped], layout: 'immersive' });
		refreshSectionsFor(sibling.host, ['docs2/note.md'], false, true, false);
		assert.deepEqual(sibling.refreshes, [], '4: docs2 is not inside docs');
	}

	// 5. Immersive + pipeline: root folder scopes it, empty root keeps the
	//    whole-vault pass, and PM additionally follows its Gantt sources.
	{
		const pipeline = column('ship', 'pipeline', { pipelineConfig: { rootFolder: 'proj' } } as Partial<DashboardColumn>);
		const inRoot = makeRig({ columns: [pipeline], layout: 'immersive' });
		refreshSectionsFor(inRoot.host, ['proj/a.md'], false, true, false);
		assert.deepEqual(inRoot.refreshes, ['ship'], '5: pipeline root hit rebuilds the tile');

		const outside = makeRig({ columns: [pipeline], layout: 'immersive' });
		refreshSectionsFor(outside.host, ['other/a.md'], false, true, false);
		assert.deepEqual(outside.refreshes, [], '5: pipeline edit outside the root is ignored');

		const wholeVault = column('ship', 'pipeline', { pipelineConfig: { rootFolder: '  ' } } as Partial<DashboardColumn>);
		const any = makeRig({ columns: [wholeVault], layout: 'immersive' });
		refreshSectionsFor(any.host, ['whatever/a.md'], false, true, false);
		assert.deepEqual(any.refreshes, ['ship'], '5: blank root = whole vault = always in scope');

		const pm = column('plan', 'pm', {
			pmConfig: { rootFolder: 'proj', ganttSources: [{ path: 'Shared/Roadmap.md' }] },
		} as Partial<DashboardColumn>);
		const viaGantt = makeRig({ columns: [pm], layout: 'immersive' });
		refreshSectionsFor(viaGantt.host, ['shared/roadmap.md'], false, true, false);
		assert.deepEqual(viaGantt.refreshes, ['plan'], '5: a Gantt source is an exact vault path (case-insensitive)');

		const notGantt = makeRig({ columns: [pm], layout: 'immersive' });
		refreshSectionsFor(notGantt.host, ['shared/roadmap/child.md'], false, true, false);
		assert.deepEqual(notGantt.refreshes, [], '5: a Gantt source is a file, not a folder prefix');
	}

	// 6. Immersive + non-.md change: nothing is rebuilt at all (the tile rules
	//    only ever fire on markdown edits), and no calendar pass either.
	{
		const rig = makeRig({ columns: [column('docs', 'library')], layout: 'immersive' });
		refreshSectionsFor(rig.host, ['assets/pic.png'], false, false, true);
		assert.deepEqual(rig.refreshes, [], '6: media change does not rebuild a pinned tile');
		assert.equal(rig.kanbanAsks, 0, '6: no calendar pass without a markdown change');
	}

	// 7. Classic board, nothing actually swapped → no DnD rewire. Rewiring the
	//    whole kanban for a no-op would drop and re-add every listener.
	{
		const rig = makeRig({ columns: [column('docs', 'library')] });
		refreshSectionsFor(rig.host, ['docs/a.md'], false, true, false);
		assert.equal(rig.rewires.length, 0, '7: no swap, no rewire');
		assert.equal(rig.fullRenders.length, 0, '7: the kanban exists, so no full render');
	}

	// 8. Same for a media change on a classic board with no media sections:
	//    the media pass never even runs.
	{
		const rig = makeRig({ columns: [column('docs', 'library')] });
		refreshSectionsFor(rig.host, ['assets/pic.png'], false, false, true);
		assert.equal(rig.rewires.length, 0, '8: no media sections, no rewire');
	}

	// 9. Predicate: classic scope. No folders = whole vault = always in scope.
	{
		const whole = column('docs', 'library');
		assert.equal(sectionInScope(whole, ['anywhere/x.md'], false), true, '9: no folders = whole vault');
		assert.equal(sectionInScope(whole, [], false), true, '9: empty path list = whole vault');
		const scoped = column('docs', 'library', { libraryConfig: { folders: ['docs'] } } as Partial<DashboardColumn>);
		assert.equal(sectionInScope(scoped, ['docs/x.md'], false), true, '9: hit');
		assert.equal(sectionInScope(scoped, ['other/x.md'], false), false, '9: miss');
		assert.equal(sectionInScope(scoped, ['other/x.md'], true), true, '9: broad events refresh everything');
		assert.equal(sectionInScope(scoped, [], false), true, '9: an unnamed change refreshes everything');
	}

	// 10. Predicate: calendars follow markdown changes only — they aggregate
	//     tasks across every note, so folder scope cannot apply to them.
	{
		const cal = column('cal', 'calendar', { libraryConfig: { folders: ['docs'] } } as Partial<DashboardColumn>);
		assert.equal(scanningSectionNeedsRefresh(cal, ['elsewhere/x.md'], false, true), true, '10: any .md refreshes a calendar');
		assert.equal(scanningSectionNeedsRefresh(cal, ['elsewhere/x.md'], false, false), false, '10: a media-only change does not');
	}

	// 11. The asymmetry this whole module exists to protect: the same scope
	//     means "refresh" on a classic board and "stay frozen" on an immersive
	//     one, for a section that scans the whole vault.
	{
		const whole = column('docs', 'library');
		assert.equal(sectionInScope(whole, ['anywhere/x.md'], false), true, '11: classic refreshes a whole-vault scan');
		assert.equal(immersiveTileInScope(whole, ['anywhere/x.md']), false, '11: immersive freezes it');

		const scoped = column('docs', 'library', { libraryConfig: { folders: ['docs'] } } as Partial<DashboardColumn>);
		assert.equal(immersiveTileInScope(scoped, ['docs/x.md']), true, '11: scoped hit still refreshes');
		assert.equal(immersiveTileInScope(scoped, ['docs/x.md'].map(p => p.toUpperCase())), false, '11: paths arrive lowercased; uppercase means a caller bug');

		// Immersive ignores `broad` on purpose: a folder rename must not rebuild
		// every pinned tile.
		assert.equal(immersiveTileInScope(scoped, ['elsewhere/x.md']), false, '11: no broad escape on immersive');

		// Types the immersive pass never handles.
		assert.equal(immersiveTileInScope(column('cal', 'calendar'), ['a.md']), false, '11: calendar is refreshed by the grid pass, not here');
		assert.equal(immersiveTileInScope(column('pics', 'images'), ['a.png']), false, '11: media tiles stay frozen');
	}

	console.log('verify-change-scope: ok');
}

main();
