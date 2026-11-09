/**
 * Verifies the section registry — the single place that now answers "what is
 * this section type and how does it draw itself".
 *
 * Before Phase 2, adding a section type meant editing the name→type table and
 * the 550-line if-chain in renderer.ts, the type chooser in add-section-modal,
 * and the config event route in view.ts. A missed spot surfaced as "the gear
 * does nothing" or "my card never refreshes".
 *
 * 1. Coverage — every chooser entry resolves, every definition's types resolve
 *    back to it, and the chooser order is the documented tray order.
 * 2. Aliases — retired ids fold into their modern type (memo/todo → sticky,
 *    notes → projects).
 * 3. Header composition — each type's buttons, in order, with the shared
 *    classes; the gear ships the canonical type with the config event.
 * 4. Body routing — a cheap render per family still produces the documented
 *    DOM, unknown types fall back to the notes section.
 * 5. No drift — the renderer keeps no per-type if-chain, and the chooser is
 *    derived rather than hand-listed.
 *
 * Run: `npm run test:section-registry`
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { App } from 'obsidian';
import { El, findByClass, findTag } from './mini-dom';
import { renderSection } from '../src/renderer';
import {
	canonicalSectionType,
	createSectionButtons,
	fallbackSection,
	hasSectionType,
	registerSection,
	registeredSections,
	resolveSection,
	sectionPickerOptions,
	sectionScan,
	type SectionContext,
} from '../src/section';
import { t } from '../src/i18n';
import type { DashboardColumn, DashboardData, RenderCallbacks } from '../src/types';

/* ---------------------------- render environment ---------------------------- */

(globalThis as { activeDocument?: unknown }).activeDocument = {
	querySelector: () => null,
	querySelectorAll: () => [],
};
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

const app = {
	vault: { getFileByPath: () => null, getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
	loadLocalStorage: () => null,
	saveLocalStorage: () => {},
	metadataCache: { getFileCache: () => null },
} as unknown as App;

/** Every callback records its name, so a click is observable without stubbing
 *  the whole RenderCallbacks surface by hand. */
function makeCallbacks(log: string[]): RenderCallbacks {
	return new Proxy({}, {
		get: (_target, key) => (...args: unknown[]) => {
			log.push(`${String(key)}:${String(args[0] ?? '')}`);
		},
	}) as unknown as RenderCallbacks;
}

function makeColumn(sectionType: string, over: Partial<DashboardColumn> = {}): DashboardColumn {
	return {
		name: sectionType,
		sectionType,
		cards: [],
		showCover: true,
		...over,
	} as unknown as DashboardColumn;
}

/* ------------------------- 1. coverage + chooser order ------------------------- */

const EXPECTED_CHOOSER = [
	'sticky', 'folder', 'library', 'projects', 'dataview', 'pm', 'pipeline',
	'skills', 'calendar', 'rss', 'images', 'videos', 'web', 'weread', 'ticktick',
];

{
	const options = sectionPickerOptions();
	assert.deepEqual(options.map(o => o.value), EXPECTED_CHOOSER, '1: chooser lists the 15 types in tray order');
	assert.ok(options.every(o => o.icon.length > 0 && o.labelKey.length > 0), '1: every entry has an icon + label');
	assert.equal(new Set(options.map(o => o.value)).size, options.length, '1: no duplicate chooser entries');
}

{
	for (const def of registeredSections()) {
		for (const type of def.types) {
			assert.equal(resolveSection(type), def, `1: ${type} resolves to its definition`);
			assert.ok(hasSectionType(type), `1: ${type} is a known type`);
			assert.equal(canonicalSectionType(type), type, `1: ${type} is already canonical`);
		}
	}
	assert.ok(registeredSections().length >= 13, '1: every family registered');
}

/* --------------------------------- 2. aliases --------------------------------- */

assert.equal(canonicalSectionType('memo'), 'sticky', '2: memo folds into sticky');
assert.equal(canonicalSectionType('todo'), 'sticky', '2: todo folds into sticky');
assert.equal(canonicalSectionType('notes'), 'projects', '2: notes folds into projects');
assert.equal(canonicalSectionType('dataview'), 'dataview', '2: canonical types are untouched');
assert.equal(canonicalSectionType('nonsense'), 'nonsense', '2: unknown ids pass through');
assert.equal(resolveSection('memo'), resolveSection('sticky'), '2: alias and canonical share one definition');

/* ---------------------------- 3. header composition ---------------------------- */

/** Build just the header for a type, the way renderSection does, without
 *  running the section body (which would hit the vault). */
function header(type: string, over: Partial<DashboardColumn> = {}): {
	el: El;
	labels: string[];
	buttons: El[];
	log: string[];
	dispatch: unknown[];
} {
	const column = makeColumn(type, over);
	const el = new El('div');
	const actions = el.createDiv({ cls: 'dashboard-section-header-actions' });
	const log: string[] = [];
	const callbacks = makeCallbacks(log);
	const dispatch: unknown[] = [];
	el.addEventListener('dashboard-library-config', (e) => {
		dispatch.push((e as unknown as { detail: unknown }).detail);
	});

	const ctx: SectionContext = {
		// tsc sees the real HTMLElement type; the bundled mini-DOM provides El.
		el: el as unknown as HTMLElement,
		header: el as unknown as HTMLElement,
		actions: actions as unknown as HTMLElement,
		column,
		type: canonicalSectionType(type),
		app, data: undefined, settings: undefined,
		callbacks,
		hoverParent: null,
		openNoteInPopover: null,
		buttons: createSectionButtons({
			el: el as unknown as HTMLElement,
			column,
			actions: actions as unknown as HTMLElement,
			callbacks,
			type: canonicalSectionType(type),
			index: -1,
			reload: { fn: null },
		}),
		setReload: () => { /* refresh wiring is covered by the section's own verify */ },
		renderCards: () => { /* body not under test here */ },
	};

	resolveSection(type)!.headerActions?.(ctx);
	const buttons = findTag(actions, 'button');
	return { el, labels: buttons.map(b => b.getAttribute('aria-label') ?? ''), buttons, log, dispatch };
}

const isDelete = (btn: El): boolean => btn.hasClass('dashboard-section-delete-btn');

{
	const { buttons, labels } = header('dataview');
	assert.equal(buttons.length, 3, '3: dataview = refresh + config + delete');
	assert.deepEqual(labels.slice(0, 2), [t('dataview.refresh'), t('dataview.configure')], '3: refresh then gear');
	assert.ok(isDelete(buttons[2]!), '3: delete is last and carries the danger class');
	assert.ok(!labels.includes(t('renderer.addCardTo', { column: 'dataview' })), '3: no add-card button on a data section');
}

{
	const { buttons, labels } = header('sticky');
	assert.equal(buttons.length, 4, '3: sticky = archive + template + add card + delete');
	assert.deepEqual(labels.slice(0, 2), [t('renderer.archiveTasks'), t('template.addFromTemplate')], '3: sticky extras come first');
	assert.ok(isDelete(buttons[3]!), '3: delete last');
}

{
	const { buttons, labels } = header('projects');
	assert.equal(buttons.length, 3, '3: notes = add card + gear + delete');
	assert.equal(labels[1], t('notesCfg.title'), '3: notes gear opens the notes config');
}

{
	const { buttons } = header('library');
	assert.equal(buttons.length, 1, '3: a configured library keeps its gear in its own toolbar');
	assert.ok(isDelete(buttons[0]!), '3: only delete in the header');
}

{
	const { buttons, labels } = header('images');
	assert.equal(buttons.length, 2, '3: media = gear + delete');
	assert.equal(labels[0], t('media.configure'), '3: media gear label');
}

{
	const { buttons } = header('calendar');
	assert.equal(buttons.length, 1, '3: calendar has no extra header buttons');
}

{
	const { buttons } = header('ticktick');
	assert.equal(buttons.length, 4, '3: ticktick = today + lists + refresh + delete');
}

{
	const { labels } = header('ticktick', { ticktickConfig: { view: 'lists' } } as Partial<DashboardColumn>);
	assert.ok(labels.includes(t('ticktick.filterProjects')), '3: the project filter appears on the lists view only');
	assert.ok(!header('ticktick').labels.includes(t('ticktick.filterProjects')), '3: and not on the today view');
}

{
	// The gear ships the canonical type so view.ts does not re-derive it from a
	// possibly-legacy sectionType string.
	const { dispatch, buttons } = header('notes');
	assert.ok(isDelete(buttons[buttons.length - 1]!), '3: the legacy notes type renders the notes header');
	const gear = buttons.find(b => b.getAttribute('aria-label') === t('notesCfg.title'));
	assert.ok(gear, '3: notes gear present');
	gear!.click();
	assert.deepEqual(dispatch, [{ columnName: 'notes', sectionType: 'projects' }], '3: config event carries the canonical type');
}

/* ------------------------------ 4. body routing ------------------------------ */

{
	// A folder section with no folder set would list the whole vault: it renders
	// an explanation and a header gear instead of a card grid.
	const column = makeColumn('folder');
	const log: string[] = [];
	const el = renderSection(column, makeCallbacks(log), app, { columns: [column] } as unknown as DashboardData) as unknown as El;
	assert.ok(findByClass(el, 'dashboard-folder-empty').length === 1, '4: unconfigured folder explains itself');
	assert.equal(findTag(el, 'button').length, 2, '4: and the header gear + delete (the toolbar never rendered)');
}

{
	// Without settings the calendar cannot scan; it must not throw.
	const column = makeColumn('calendar');
	const log: string[] = [];
	const el = renderSection(column, makeCallbacks(log), app) as unknown as El;
	assert.equal(findByClass(el, 'dashboard-library-empty').length, 1, '4: calendar without settings shows the empty state');
	assert.equal(el.dataset.sectionType, 'calendar', '4: the row carries its section type');
}

{
	// Card sections build the shared card container even when empty.
	const column = makeColumn('sticky');
	const log: string[] = [];
	const el = renderSection(column, makeCallbacks(log), app) as unknown as El;
	assert.equal(findByClass(el, 'dashboard-section-cards').length, 1, '4: sticky renders the card container');
}

{
	// An unknown type falls back to the notes section instead of blowing up.
	const column = makeColumn('mystery-type');
	assert.equal(fallbackSection(), resolveSection('projects'), '4: the fallback is the notes section');
	const log: string[] = [];
	const el = renderSection(column, makeCallbacks(log), app) as unknown as El;
	assert.equal(findByClass(el, 'dashboard-section-cards').length, 1, '4: unknown types still render a card list');
	assert.ok(findTag(el, 'button').some(isDelete), '4: and keep the delete button');
}

/* -------------------------------- 5. no drift -------------------------------- */

{
	assert.throws(
		() => registerSection({ types: ['dataview'], render: () => { /* dup */ } }),
		/registered twice/,
		'5: a duplicate type registration fails loudly',
	);
}

{
	// renderSection moved to render/section-frame.ts in Phase 4; the registry
	// dispatch contract follows the code.
	const frameSrc = readFileSync('src/render/section-frame.ts', 'utf8');
	// Scope the check to renderSection: the card renderer legitimately still
	// branches on the section type (sticky memo vs project cards).
	const body = frameSrc.slice(
		frameSrc.indexOf('export function renderSection('),
		frameSrc.indexOf('/** Draw the plain card list'),
	);
	assert.ok(body.length > 0, '5: renderSection located');
	assert.ok(!body.includes('if (sectionType ==='), '5: renderSection keeps no per-type if-chain');
	assert.ok(body.includes('const def = resolveSection(sectionType) ?? fallbackSection();'),
		'5: the renderer dispatches through the registry');
	assert.ok(body.includes('def.headerActions?.(ctx);') && body.includes('def.render(ctx);'),
		'5: header actions then body, in that order');

	const addSrc = readFileSync('src/add-section-modal.ts', 'utf8');
	assert.ok(addSrc.includes('sectionPickerOptions()'), '5: the chooser reads the registry');
	assert.ok(!addSrc.includes("value: 'sticky'"), '5: and no longer hand-lists the types');
}

{
	// 6. Scan policy — "which sections rescan the vault" is answered by the
	//    definition, not by a Set in the refresh module. Before this, a new
	//    scanning section had to be added in two places and silently never
	//    refreshed when it wasn't.
	const expected: Record<string, string> = {
		library: 'files', folder: 'files', pipeline: 'files', pm: 'files',
		images: 'media', videos: 'media',
	};
	for (const type of ['sticky', 'projects', 'dashboard', 'alltasks', 'dataview', 'web', 'rss', 'calendar', 'ticktick', 'weread', 'skills']) {
		expected[type] = 'none';
	}
	for (const [type, scan] of Object.entries(expected)) {
		assert.equal(sectionScan(type), scan, `6: ${type} scans ${scan}`);
	}
	// The retired ids inherit their definition's policy.
	assert.equal(sectionScan('memo'), 'none', '6: retired ids resolve to their definition');
	assert.equal(sectionScan('nope'), 'none', '6: unknown types never rescan');

	const refreshSrc = readFileSync('src/render/section-refresh.ts', 'utf8');
	assert.ok(!refreshSrc.includes('SCANNING_SECTION_TYPES'), '6: the scanning Set is gone');
	assert.ok(!refreshSrc.includes('MEDIA_SECTION_TYPES'), '6: the media Set is gone');
	assert.ok(refreshSrc.includes("sectionScan(getSectionType(column)) !== 'files'"), '6: scanning pass reads the registry');
	assert.ok(refreshSrc.includes("sectionScan(getSectionType(column)) !== 'media'"), '6: media pass reads the registry');

	// 7. Parser drift guard. The parse layer deliberately does NOT import the
	//    render registry (parsing runs before any section is registered, and a
	//    typo in a board file should not depend on the renderer), so its known-
	//    type list is a hand copy. This is the copy's guard: a type added to one
	//    side and not the other fails here instead of silently parsing as
	//    "projects" (or being rejected as unknown).
	const parserSrc = readFileSync('src/parser.ts', 'utf8');
	const match = parserSrc.match(/const SECTION_TYPES = new Set\(\[([^\]]+)\]\);/);
	assert.ok(match, '7: parser still declares its known-type list');
	const parserTypes = [...match![1]!.matchAll(/'([a-z0-9]+)'/g)].map(m => m[1]!);
	const registered = registeredSections()
		.flatMap(def => [...def.types, ...(def.aliases ?? [])])
		.sort();
	assert.deepEqual(parserTypes.slice().sort(), registered, '7: parser types == registry types + aliases');
}

console.log('section registry: all scenarios OK');
