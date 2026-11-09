/**
 * Verifies the shared section state block (src/section/state.ts) — the one
 * renderer for "nothing to show yet / still scanning / this query failed".
 *
 * Before Phase 3 each section hand-rolled this markup: seven root class names,
 * three child structures (title+hint, icon+text+hint, plain text), and a
 * configure button wired by hand at each site. Changing the visual language
 * meant editing a dozen files.
 *
 * 1. Shape — kind modifier, optional icon/text/hint/action, compact variant.
 * 2. Action — the configure helper bubbles the same event the header gear
 *    sends, carries the canonical type, and does not leak the click to the
 *    section row.
 * 3. Legacy class — old root classes still ride along so placement rules
 *    (grid span, flex growth) keep working.
 * 4. Reached the DOM — a section that used to hand-roll its guide state now
 *    renders the shared block.
 * 5. No drift — no module still builds the retired child classes.
 *
 * Run: `npm run test:section-state`
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { App } from 'obsidian';
import { El, findByClass } from './mini-dom';
import { configureStateAction, renderSectionState } from '../src/section/state';
import { renderSection } from '../src/renderer';
import type { DashboardColumn, DashboardData, RenderCallbacks } from '../src/types';

/* ---------------------------- render environment ---------------------------- */

(globalThis as { window?: unknown }).window = globalThis;
(globalThis as Record<string, unknown>).createDiv = (o?: { cls?: string; text?: string }): El => {
	const el = new El('div');
	if (o?.cls) el.addClass(...o.cls.split(/\s+/));
	if (o?.text !== undefined) el.textContent = o.text;
	return el;
};
// Node's native CustomEvent hides `detail` behind a prototype getter that
// mini-dom's Object.assign-based dispatch cannot copy.
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
	type: string;
	detail: unknown;
	bubbles: boolean;
	constructor(type: string, o?: { detail?: unknown; bubbles?: boolean }) {
		this.type = type;
		this.detail = o?.detail;
		this.bubbles = o?.bubbles ?? false;
	}
};

function makeColumn(sectionType: string, over: Partial<DashboardColumn> = {}): DashboardColumn {
	return {
		name: sectionType,
		sectionType,
		cards: [],
		showCover: true,
		...over,
	} as unknown as DashboardColumn;
}

function makeCallbacks(): RenderCallbacks {
	const log: string[] = [];
	return new Proxy({}, {
		get: (_t, key) => (...args: unknown[]) => { log.push(`${String(key)}:${String(args[0] ?? '')}`); },
	}) as unknown as RenderCallbacks;
}

const app = {
	vault: { getFileByPath: () => null, getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
	loadLocalStorage: () => null,
	saveLocalStorage: () => {},
	metadataCache: { getFileCache: () => null },
} as unknown as App;

/* --------------------------------- 1. shape -------------------------------- */

{
	const host = new El('div');
	const root = renderSectionState(host as unknown as HTMLElement, { text: '还没有内容' });

	assert.equal(host.children.length, 1, '1: one block, no wrapper soup');
	assert.ok(root.hasClass('dashboard-section-state'), '1: shared root class');
	assert.ok(root.hasClass('dashboard-section-state--empty'), '1: empty is the default kind');
	assert.equal(findByClass(host, 'dashboard-section-state-icon').length, 0, '1: no icon unless asked');
	assert.equal(findByClass(host, 'dashboard-section-state-text')[0]!.textContent, '还没有内容', '1: text rendered');
	assert.equal(findByClass(host, 'dashboard-section-state-hint').length, 0, '1: no hint unless asked');
	assert.equal(findByClass(host, 'dashboard-section-state-action').length, 0, '1: no button unless asked');
}

{
	const host = new El('div');
	renderSectionState(host as unknown as HTMLElement, {
		kind: 'error',
		icon: 'alert-triangle',
		text: '解析失败',
		hint: '检查查询语句',
		legacyClass: 'dashboard-dataview-error',
		action: { label: '重试', onClick: () => { /* nothing */ } },
	});

	const root = findByClass(host, 'dashboard-section-state')[0]!;
	assert.ok(root.hasClass('dashboard-section-state--error'), '1: error modifier');
	assert.ok(root.hasClass('dashboard-dataview-error'), '3: legacy root class kept');
	assert.equal(findByClass(host, 'dashboard-section-state-icon').length, 1, '1: icon slot');
	assert.equal(findByClass(host, 'dashboard-section-state-hint')[0]!.textContent, '检查查询语句', '1: hint rendered');
	assert.equal(findByClass(host, 'dashboard-section-state-action')[0]!.textContent, '重试', '1: action label');

	// Child order is the documented one: icon, text, hint, action.
	assert.deepEqual(
		root.children.map(c => c.className.split(/\s+/)[0]),
		['dashboard-section-state-icon', 'dashboard-section-state-text', 'dashboard-section-state-hint', 'dashboard-section-state-action'],
		'1: child order',
	);
}

{
	const host = new El('div');
	renderSectionState(host as unknown as HTMLElement, { kind: 'loading', text: '扫描中', compact: true });
	const root = findByClass(host, 'dashboard-section-state')[0]!;
	assert.ok(root.hasClass('dashboard-section-state--loading'), '1: loading modifier');
	assert.ok(root.hasClass('dashboard-section-state--compact'), '1: compact modifier');
}

{
	// The "needs configuring" title used to be bold + body-coloured above a
	// muted hint; keep that hierarchy instead of flattening every state.
	const host = new El('div');
	renderSectionState(host as unknown as HTMLElement, { text: '未配置', hint: '点齿轮选择目录', strongText: true });
	assert.ok(findByClass(host, 'dashboard-section-state--strong').length === 1, '1: strong text variant');
	const css = readFileSync('styles.css', 'utf8');
	assert.ok(css.includes('.dashboard-section-state--strong .dashboard-section-state-text'),
		'1: the stylesheet honours the strong variant');
}

/* -------------------------------- 2. action -------------------------------- */

{
	const host = new El('div');
	let clicks = 0;
	let bubbled = false;
	host.addEventListener('click', () => { bubbled = true; });
	renderSectionState(host as unknown as HTMLElement, {
		text: '未配置',
		action: { label: '配置', onClick: () => { clicks += 1; } },
	});
	findByClass(host, 'dashboard-section-state-action')[0]!.click();
	assert.equal(clicks, 1, '2: action fires once');
	assert.equal(bubbled, false, '2: action click does not leak to the section row');
}

{
	const el = new El('div');
	const seen: unknown[] = [];
	el.addEventListener('dashboard-library-config', (e) => {
		seen.push((e as unknown as { detail: unknown }).detail);
	});
	renderSectionState(el as unknown as HTMLElement, {
		text: '未配置',
		action: configureStateAction({ label: '配置', from: el as unknown as HTMLElement, columnName: '资讯', sectionType: 'rss' }),
	});
	findByClass(el, 'dashboard-section-state-action')[0]!.click();
	assert.deepEqual(seen, [{ columnName: '资讯', sectionType: 'rss' }], '2: same event the header gear sends');
}

/* ------------------------- 3. reached the real DOM ------------------------- */

{
	// An unconfigured folder used to write its own plain text div.
	const column = makeColumn('folder');
	const el = renderSection(column, makeCallbacks(), app, { columns: [column] } as unknown as DashboardData) as unknown as El;
	const state = findByClass(el, 'dashboard-section-state')[0];
	assert.ok(state, '3: folder guide state uses the shared block');
	assert.ok(state!.hasClass('dashboard-folder-empty'), '3: and keeps its legacy class');
	assert.equal(findByClass(el, 'dashboard-section-state-icon').length, 1, '3: folder state carries the folder icon');
}

/* -------------------------------- 4. no drift ------------------------------- */

const RETIRED_CHILD_CLASSES = [
	'dashboard-dataview-empty-icon',
	'dashboard-dataview-empty-text',
	'dashboard-dataview-empty-hint',
	'dashboard-dataview-error-icon',
	'dashboard-dataview-error-text',
	'dashboard-web-empty-icon',
	'dashboard-web-empty-text',
	'dashboard-web-empty-hint',
	'dashboard-rss-empty-config-icon',
	'dashboard-rss-empty-config-text',
	'dashboard-rss-empty-config-hint',
	'dashboard-pipeline-empty-title',
	'dashboard-pipeline-empty-hint',
];

for (const file of [
	'src/dataview-section.ts',
	'src/web-section.ts',
	'src/rss-section.ts',
	'src/pipeline-section.ts',
	'src/pm-section.ts',
	'src/skill-section.ts',
	'src/section/defs/media.ts',
]) {
	const src = readFileSync(file, 'utf8');
	assert.ok(src.includes('renderSectionState'), `4: ${file} uses the shared state block`);
	for (const cls of RETIRED_CHILD_CLASSES) {
		assert.ok(!src.includes(cls), `4: ${file} no longer builds .${cls}`);
	}
}

{
	// The stylesheet owns the look; a page that migrated must not re-declare it.
	const css = readFileSync('styles.css', 'utf8');
	for (const cls of ['.dashboard-section-state', '.dashboard-section-state--compact', '.dashboard-section-state--error']) {
		assert.ok(css.includes(cls), `4: styles.css declares ${cls}`);
	}
}

console.log('section state: all scenarios OK');
