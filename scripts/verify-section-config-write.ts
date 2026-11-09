/**
 * Verifies the single section-config write path (SyncEngine.updateSectionConfig).
 *
 * Nine `updateXxxConfig` methods used to repeat the same read-modify-write:
 * map the columns, swap one field, persist. Nine copies meant nine places to
 * get the "unknown column is a no-op" / "persist exactly once" / "leave the
 * other fields alone" behaviour right — and the per-section configs were the
 * easiest thing to break silently, since a wrong key just gets ignored on the
 * next parse.
 *
 * 1. Every declared key writes only its own field, on its own column.
 * 2. Other columns are untouched.
 * 3. An unknown column name is a no-op (no phantom writes).
 * 4. The notes section's two-field save (config + showCover) stays one write.
 * 5. No drift — the old per-type method names are gone from the engine.
 *
 * Run: `npm run test:section-config-write`
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { TFile, type App } from 'obsidian';
import { SyncEngine, type SectionConfigKey } from '../src/sync';
import { parse } from '../src/parser';
import type { DashboardSettings } from '../src/types';

const initial = `---
columns:
  - name: 探针
    type: library
    viewMode: list
  - name: 邻列
    type: library
    viewMode: grid
---
## 探针
## 邻列
`;

function makeEngine(): { sync: SyncEngine; writes: () => number; disk: () => string } {
	let disk = initial;
	let writes = 0;
	const file = Object.assign(new TFile(), { path: 'probe-board.md', basename: 'probe-board' });
	const app = {
		vault: {
			getFileByPath: () => file,
			read: async () => disk,
			modify: async (_file: unknown, text: string) => { disk = text; writes += 1; },
			on: () => ({}),
			offref: () => {},
			adapter: { exists: async () => true, write: async () => {}, list: async () => ({ files: [] }) },
		},
	} as unknown as App;
	const sync = new SyncEngine(app, { dashboardFile: 'probe-board' } as DashboardSettings);
	return { sync, writes: () => writes, disk: () => disk };
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function column(data: unknown, name: string): Record<string, unknown> {
	const cols = (data as { columns: Array<Record<string, unknown>> }).columns;
	const found = cols.find(c => c.name === name);
	assert.ok(found, `column ${name} exists`);
	return found!;
}

async function main(): Promise<void> {
	const { sync, writes, disk } = makeEngine();
	await sync.init();
	const baseline = parse(disk());

	/* ---------- 1. every key writes only its own field ---------- */
	// Serialisable shapes: the writer serialises the whole board, so a probe
	// must look like the real config it replaces.
	const PROBES: Record<SectionConfigKey, Record<string, unknown>> = {
		libraryConfig: { filters: [], viewMode: 'list', sortBy: 'title', sortDesc: false },
		dataviewConfig: { query: 'TASK', title: 'PROBE' },
		webConfig: { url: 'https://probe.test' },
		rssConfig: { feeds: [] },
		pipelineConfig: { rootFolder: 'Probe', statusField: 'status', stages: [], skills: [] },
		skillsConfig: { pinned: ['probe'] },
		pmConfig: { rootFolder: 'Probe', stages: [], skills: [] },
		wereadConfig: { widgets: [] },
		ticktickConfig: { view: 'lists' },
	};

	for (const key of SyncEngine.SECTION_CONFIG_KEYS) {
		const before = writes();
		const probe = PROBES[key];
		await sync.updateSectionConfig('探针', key, probe as never);
		await settle();

		assert.equal(writes(), before + 1, `1: ${key} persists exactly once`);
		const col = column(sync.getData(), '探针');
		assert.deepEqual(col[key], probe, `1: ${key} landed on the column`);
		// The other section-config slot never moved.
		assert.equal(
			column(sync.getData(), '邻列')[key] ?? null,
			column(baseline, '邻列')[key] ?? null,
			`1: ${key} did not touch the sibling column`,
		);
	}

	/* ---------- 2. unknown column is a no-op ---------- */
	{
		const before = writes();
		await sync.updateSectionConfig('不存在的列', 'webConfig', { url: 'https://x.test' } as never);
		await settle();
		assert.equal(writes(), before, '2: unknown column does not write');
	}

	/* ---------- 3. notes keeps its two-field single write ---------- */
	{
		const before = writes();
		await sync.updateNotesSectionConfig('探针', {
			filters: [], viewMode: 'grid', sortBy: 'modified', sortDesc: true,
		}, false);
		await settle();
		assert.equal(writes(), before + 1, '3: config + cover flag in one save');
		const col = column(sync.getData(), '探针');
		assert.equal(col.showCover, false, '3: cover opt-out persisted');
		assert.ok(col.libraryConfig, '3: library settings persisted');
	}

	/* ---------------------------- 4. no drift ---------------------------- */
	{
		const src = readFileSync('src/sync.ts', 'utf8');
		for (const name of [
			'updateLibraryConfig', 'updateWereadConfig', 'updateTickTickConfig',
			'updateDataviewConfig', 'updateWebConfig', 'updateRssConfig',
			'updatePipelineConfig', 'updateSkillsConfig', 'updatePmConfig',
		]) {
			assert.ok(!src.includes(`${name}(`), `4: ${name} is gone`);
		}
		assert.equal(src.split('private async patchColumn(').length - 1, 1, '4: one read-modify-write helper');
		assert.ok(src.includes('SECTION_CONFIG_KEYS'), '4: the key list is declared, not implicit');
	}

	// Every declared key must still be a real DashboardColumn field — a typo
	// here would silently write a field the parser ignores.
	const keysCovered: SectionConfigKey[] = [...SyncEngine.SECTION_CONFIG_KEYS];
	assert.ok(keysCovered.includes('libraryConfig') && keysCovered.includes('pmConfig'), '4: representative keys present');

	console.log('section config write: all scenarios OK');
}

void main();
