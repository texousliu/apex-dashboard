/**
 * Verifies the board's section-event table (`src/view/board-events.ts`).
 *
 * Sections talk to the view by dispatching `dashboard-*` CustomEvents on the
 * board, so EVERY gear / sort / filter / page-size control in the app funnels
 * through this one function. That makes it exactly the kind of code where a
 * silent breakage shows up as "the card renders but the gear does nothing" —
 * no exception, no console line, just a dead control. These cases pin down:
 *
 * 1. `dashboard-library-config` routes by the CANONICAL section type (the
 *    event's own type wins over the column's), including the two media types
 *    that share one modal and the legacy fallback;
 * 2. the config-merge listeners persist a merged config and then refresh that
 *    one section in place (never a full render);
 * 3. the merge is serialization-safe: a `undefined` from the section (a
 *    "back to default" pick) drops the key instead of writing it;
 * 4. partial-update listeners touch only their slice (one pipeline stage's
 *    width, not every stage);
 * 5. guards hold: wrong page-size type, wrong section type, or a non-manual
 *    sort mode writes nothing at all;
 * 6. `dashboard-pm-updated` fans out to every pm section, and TickTick's
 *    view/resize swallow the render the config write would otherwise trigger.
 *
 * Run: `npm run test:board-events`
 */
import { strict as assert } from 'node:assert';
import { El } from './mini-dom';
import { attachBoardEventDelegation, type BoardEventHost } from '../src/view/board-events';
import type { DashboardData } from '../src/types';

interface Call {
	fn: string;
	args: unknown[];
}

interface Rig {
	host: BoardEventHost;
	board: El;
	calls: Call[];
	/** Mutate between events to prove the listeners read live data. */
	setData(data: DashboardData | null): void;
	/** Persisted config writes, in dispatch order. */
	writes: Array<{ column: string; key: string; value: Record<string, unknown> }>;
}

function makeRig(data: DashboardData | null): Rig {
	let current = data;
	const calls: Call[] = [];
	const writes: Rig['writes'] = [];
	const record = (fn: string, ...args: unknown[]): void => { calls.push({ fn, args }); };
	const launched = (fn: string) => (column: string): void => { record(fn, column); };

	const host: BoardEventHost = {
		app: {} as BoardEventHost['app'],
		data: () => current,
		sync: () => ({
			updateSectionConfig: async (column: string, key: string, value: Record<string, unknown>) => {
				writes.push({ column, key, value });
			},
		} as unknown as ReturnType<BoardEventHost['sync']>),
		plugin: () => ({ settings: { skillSourceFolders: 'a,b' } } as unknown as ReturnType<BoardEventHost['plugin']>),
		refreshSectionInPlace: name => { record('refreshSectionInPlace', name); return true; },
		openLibraryConfigModal: launched('openLibraryConfigModal'),
		openDataviewConfigModal: launched('openDataviewConfigModal'),
		openWebConfigModal: launched('openWebConfigModal'),
		openRssConfigModal: launched('openRssConfigModal'),
		openSkillsConfigModal: launched('openSkillsConfigModal'),
		openPipelineConfigModal: launched('openPipelineConfigModal'),
		openPmConfigModal: launched('openPmConfigModal'),
		openMediaConfigModal: launched('openMediaConfigModal'),
		openWereadConfigModal: launched('openWereadConfigModal'),
		openFolderConfigModal: launched('openFolderConfigModal'),
		openNotesSectionConfigModal: launched('openNotesSectionConfigModal'),
		dispatchSkillCreate: cfg => record('dispatchSkillCreate', cfg),
		handleLibraryNewNote: async (column, pos) => { record('handleLibraryNewNote', column, pos); },
		openTickTickFilterModal: name => { record('openTickTickFilterModal', name); },
		suppressNextRender: () => { record('suppressNextRender'); },
	};
	const board = new El('div');
	attachBoardEventDelegation(host, board as unknown as HTMLElement);
	return { host, board, calls, writes, setData: (next) => { current = next; } };
}

const fired = (rig: Rig, fn: string): Call[] => rig.calls.filter(c => c.fn === fn);

function dispatch(rig: Rig, type: string, detail: unknown): void {
	rig.board.dispatchEvent({ type, detail });
}

/** Config writes land in a promise chain (`then(() => refresh)`), so let the
 *  microtask queue drain before asserting. */
const settle = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

const column = (name: string, sectionType: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
	({ name, sectionType, title: name, cards: [], ...extra });

function baseData(): DashboardData {
	return {
		columns: [
			column('P1', 'pm', { pmConfig: { pinned: ['a'] } }),
			column('P2', 'pm', { pmConfig: {} }),
			column('L', 'library', { libraryConfig: {} }),
			column('PV', 'pipeline', { pipelineConfig: { sortBy: 'manual', stages: [{ value: 'todo', width: 2 }, { value: 'done', width: 3 }], stageOrder: { todo: ['a', 'b', 'c', 'd'] }, skills: {} } }),
			column('R', 'rss', { rssConfig: { pageSize: 10 } }),
			column('S', 'skills', { skillsConfig: { sortBy: 'name' } }),
			column('T', 'ticktick', { ticktickConfig: { view: 'today' } }),
		],
	} as unknown as DashboardData;
}

async function main(): Promise<void> {
	// 1. Gear routing is by the canonical type shipped in the event; the
	//    column's own type is only the fallback. Media types share one modal.
	{
		const rig = makeRig(baseData());
		const cases: Array<[string | undefined, string, string]> = [
			['folder', 'L', 'openFolderConfigModal'],
			['dataview', 'L', 'openDataviewConfigModal'],
			['web', 'L', 'openWebConfigModal'],
			['rss', 'L', 'openRssConfigModal'],
			['weread', 'L', 'openWereadConfigModal'],
			['pipeline', 'L', 'openPipelineConfigModal'],
			['skills', 'L', 'openSkillsConfigModal'],
			['pm', 'L', 'openPmConfigModal'],
			['images', 'L', 'openMediaConfigModal'],
			['videos', 'L', 'openMediaConfigModal'],
			['projects', 'L', 'openNotesSectionConfigModal'],
			// Unknown / absent type keeps the historical library fallback.
			['notes', 'L', 'openLibraryConfigModal'],
			[undefined, 'L', 'openLibraryConfigModal'],
		];
		for (const [type, colName, expected] of cases) {
			const before = rig.calls.length;
			dispatch(rig, 'dashboard-library-config', type === undefined ? { columnName: colName } : { columnName: colName, sectionType: type });
			const added = rig.calls.slice(before);
			assert.equal(added.length, 1, `1: ${type} opens exactly one modal`);
			assert.deepEqual(added[0], { fn: expected, args: [colName] }, `1: ${type} routes to ${expected}`);
		}

		// The event's type wins over the column's: a legacy 'notes' column whose
		// gear reports 'dataview' must not fall into the library modal.
		const notesCol: DashboardData = { columns: [column('N', 'notes', {})] } as unknown as DashboardData;
		rig.setData(notesCol);
		const before = rig.calls.length;
		dispatch(rig, 'dashboard-library-config', { columnName: 'N', sectionType: 'dataview' });
		assert.deepEqual(rig.calls.slice(before), [{ fn: 'openDataviewConfigModal', args: ['N'] }], '1: event type beats column type');
	}

	// 2. RSS page size: merge into rssConfig, persist, refresh that section.
	//    A non-numeric page size (toolbar bug / stale event) writes nothing.
	{
		const rig = makeRig(baseData());
		dispatch(rig, 'dashboard-rss-page-size', { columnName: 'R', pageSize: 50 });
		await settle();
		assert.deepEqual(rig.writes, [{ column: 'R', key: 'rssConfig', value: { pageSize: 50 } }], '2: page size merges');
		assert.deepEqual(fired(rig, 'refreshSectionInPlace'), [{ fn: 'refreshSectionInPlace', args: ['R'] }], '2: refreshes in place');

		const rig2 = makeRig(baseData());
		dispatch(rig2, 'dashboard-rss-page-size', { columnName: 'R', pageSize: '50' });
		await settle();
		assert.equal(rig2.writes.length, 0, '2: non-numeric page size ignored');
		assert.equal(rig2.calls.length, 0, '2: no refresh for a rejected change');
	}

	// 3. The merge is serialization-safe: a `undefined` pick removes the key
	//    (otherwise the serialized config grows a `key: undefined` line forever).
	{
		const rig = makeRig(baseData());
		dispatch(rig, 'dashboard-skills-prefs', { columnName: 'S', prefs: { sortBy: 'ctime', pageSize: undefined } });
		await settle();
		const written = rig.writes[0]!;
		assert.equal(written.key, 'skillsConfig', '3: writes skillsConfig');
		assert.equal(written.value.sortBy, 'ctime', '3: keeps the picked value');
		assert.equal('pageSize' in written.value, false, '3: undefined key dropped');

		// Wrong section type: a skills-prefs event aimed at a library column is
		// ignored rather than corrupting libraryConfig.
		const rig2 = makeRig(baseData());
		dispatch(rig2, 'dashboard-skills-prefs', { columnName: 'L', prefs: { sortBy: 'name' } });
		await settle();
		assert.equal(rig2.writes.length, 0, '3: wrong section type ignored');
	}

	// 4. Pipeline col width is a partial update: only the dragged stage
	//    changes, and the sibling stages keep their identity.
	{
		const rig = makeRig(baseData());
		dispatch(rig, 'dashboard-pipeline-col-width', { columnName: 'PV', stageValue: 'done', width: 7 });
		await settle();
		const value = rig.writes[0]!.value as { stages: Array<{ value: string; width: number }> };
		assert.equal(rig.writes[0]!.key, 'pipelineConfig', '4: writes pipelineConfig');
		assert.equal(value.stages.find(s => s.value === 'done')!.width, 7, '4: dragged stage updated');
		assert.equal(value.stages.find(s => s.value === 'todo')!.width, 2, '4: sibling stage untouched');
		// Width changes are layout-only: no in-place rebuild, no re-render.
		assert.equal(fired(rig, 'refreshSectionInPlace').length, 0, '4: no refresh for a width drag');
	}

	// 5. Manual-order merge only applies in manual sort mode; the slot merge
	//    runs over the stored order for THAT stage and leaves other stages be.
	{
		const rig = makeRig(baseData());
		dispatch(rig, 'dashboard-pipeline-manual-order', { columnName: 'PV', stageValue: 'todo', orderedPaths: ['d', 'a'] });
		await settle();
		const value = rig.writes[0]!.value as { stageOrder: Record<string, string[]> };
		// Slot replacement: the emitted paths take over the slots the SAME paths
		// occupied before, so cards filtered out of the emitted slice keep their
		// saved position instead of being demoted past the reordered ones.
		assert.deepEqual(value.stageOrder.todo, ['d', 'b', 'c', 'a'], '5: emitted paths replace their own slots');

		const auto = baseData();
		(auto.columns[3] as unknown as { pipelineConfig: { sortBy: string } }).pipelineConfig.sortBy = 'ctime';
		const rig2 = makeRig(auto);
		dispatch(rig2, 'dashboard-pipeline-manual-order', { columnName: 'PV', stageValue: 'todo', orderedPaths: ['d', 'a'] });
		await settle();
		assert.equal(rig2.writes.length, 0, '5: manual order ignored outside manual mode');
	}

	// 6. A PM board edit refreshes every pm section (the vault path is
	//    debounced; this is the instant feedback the modal expects).
	{
		const rig = makeRig(baseData());
		dispatch(rig, 'dashboard-pm-updated', undefined);
		assert.deepEqual(fired(rig, 'refreshSectionInPlace').map(c => c.args[0]), ['P1', 'P2'], '6: every pm section refreshed');

		// No data yet (first paint): the listener must not throw.
		const rig2 = makeRig(null);
		dispatch(rig2, 'dashboard-pm-updated', undefined);
		assert.equal(rig2.calls.length, 0, '6: no data → no-op');
	}

	// 7. TickTick view/resize persist config AND swallow the render the config
	//    write would trigger (the section rebuilds itself in place instead).
	{
		const rig = makeRig(baseData());
		dispatch(rig, 'dashboard-ticktick-view', { columnName: 'T', view: 'lists' });
		await settle();
		assert.deepEqual(rig.writes[0], { column: 'T', key: 'ticktickConfig', value: { view: 'lists' } }, '7: view persisted');
		assert.equal(fired(rig, 'suppressNextRender').length, 1, '7: render swallowed once');
		assert.deepEqual(fired(rig, 'refreshSectionInPlace').map(c => c.args[0]), ['T'], '7: section rebuilt in place');

		// Pin toggle with the wrong section type writes nothing.
		const rig2 = makeRig(baseData());
		dispatch(rig2, 'dashboard-pm-pin', { columnName: 'L', pinned: ['x'] });
		await settle();
		assert.equal(rig2.writes.length, 0, '7: wrong section type ignored');

		// Filter button opens the modal for that column.
		dispatch(rig2, 'dashboard-ticktick-filter', { columnName: 'T' });
		assert.deepEqual(rig2.calls, [{ fn: 'openTickTickFilterModal', args: ['T'] }], '7: filter opens the modal');
	}

	console.log('verify-board-events: ok');
}

void main();
