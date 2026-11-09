/**
 * Verifies that clicking a task in a Dataview result opens the note AT the task,
 * the way a calendar chip click does.
 *
 * The row used to call the plain note opener, which drops the reader at the top
 * of the note: on a long daily note the task itself was nowhere in sight. TASK
 * rows know their source line. The gesture now lives in ONE shared helper
 * (src/note-jump.ts attachNoteJump) used by the dataview section, the calendar
 * grids and the day agenda.
 *
 * 1. `rowJumpLine` — the line a click should land on. Only TASK rows have one;
 *    a synthetic row (-1) or a non-task query opens the note at the top.
 * 2. `attachNoteJump` (behavioral) — cursor classes, the line-aware opener
 *    winning over the generic one, and checkbox / inner-link / chip clicks
 *    still left alone.
 * 3. Wiring — every surface goes through the shared helper, and the section
 *    receives the line opener and passes the calendar's `onOpenNoteAtLine`
 *    through.
 * 4. The view maps that callback to `openNote(file, undefined, line)`, and both
 *    the popover and the tab fallback reveal the line.
 *
 * Run: `npm run test:dataview-task-open`
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { TFile } from 'obsidian';
import { rowJumpLine } from '../src/dataview-section';
import { attachNoteJump, noteOpenersFrom, type NoteOpeners } from '../src/note-jump';
import type { ResultRow } from '../src/dql/types';
import { El } from './mini-dom';

const sectionSrc = readFileSync('src/dataview-section.ts', 'utf8');
const rendererSrc = readFileSync('src/renderer.ts', 'utf8');
const viewSrc = readFileSync('src/view.ts', 'utf8');
const popoverSrc = readFileSync('src/note-popover-modal.ts', 'utf8');
const gridSrc = readFileSync('src/calendar-grid.ts', 'utf8');
const agendaSrc = readFileSync('src/calendar-modal.ts', 'utf8');
const css = readFileSync('styles.css', 'utf8');

/** A row carrying only what the click path looks at. */
function rowWith(line: number | null): ResultRow {
	const task = line === null ? undefined : { text: '写周报', checked: false, path: '01-日记/2026-11-06.md', line, originalLine: '- [ ] 写周报' };
	return { page: null, values: [], task } as unknown as ResultRow;
}

/* ------------------------------ 1. rowJumpLine ------------------------------ */

assert.equal(rowJumpLine(rowWith(12)), 12, '1: a TASK row jumps to its own source line');
assert.equal(rowJumpLine(rowWith(0)), 0, '1: line 0 is a real target, not a falsy miss');
assert.equal(rowJumpLine(rowWith(-1)), null, '1: a synthetic task has no line to land on');
assert.equal(rowJumpLine(rowWith(null)), null, '1: a non-TASK row opens the note at the top');

/* --------------------------- 2. attachNoteJump --------------------------- */

const mkFile = { path: '01-日记/2026-11-06.md', basename: '2026-11-06', extension: 'md' } as unknown as TFile;

/** tsc sees the real HTMLElement type; the bundled mini-DOM provides El. */
function mkRow(): HTMLElement {
	return new El('div') as unknown as HTMLElement;
}

/** Dispatch a click AT a child (bubbling to the row) through the mini-DOM. */
function clickAt(el: unknown): void {
	(el as El).dispatchEvent({ type: 'click', target: el as El });
}

function recordedOpeners(): { calls: string[]; openers: NoteOpeners } {
	const calls: string[] = [];
	return {
		calls,
		openers: {
			file: (f) => calls.push(`file:${f.path}`),
			atLine: (f, line) => calls.push(`atLine:${f.path}:${line}`),
			inPopover: (f, subpath) => calls.push(`inPopover:${f.path}:${subpath ?? ''}`),
		},
	};
}

// a) a row with a line: both cursor classes, the line-aware opener wins.
{
	const row = mkRow();
	const rec = recordedOpeners();
	attachNoteJump(row, { app: null as never, openers: rec.openers, file: mkFile, line: 12 });
	assert.ok(row.hasClass('is-clickable') && row.hasClass('is-jumpable'), '2: a line target marks the row jumpable');
	row.click();
	assert.deepEqual(rec.calls, ['atLine:01-日记/2026-11-06.md:12'], '2: the click goes through the line-aware opener');
}

// b) no line: plain clickable, opens the note at the top.
{
	const row = mkRow();
	const rec = recordedOpeners();
	attachNoteJump(row, { app: null as never, openers: rec.openers, file: mkFile, line: null });
	assert.ok(row.hasClass('is-clickable') && !row.hasClass('is-jumpable'), '2: no line → plain clickable');
	row.click();
	assert.deepEqual(rec.calls, ['file:01-日记/2026-11-06.md'], '2: opens the note at the top');
}

// c) a negative line is treated as "no line".
{
	const row = mkRow();
	const rec = recordedOpeners();
	attachNoteJump(row, { app: null as never, openers: rec.openers, file: mkFile, line: -1 });
	row.click();
	assert.deepEqual(rec.calls, ['file:01-日记/2026-11-06.md'], '2: a synthetic -1 line opens at the top');
}

// d) inner links and checkboxes keep their own handlers.
{
	const row = mkRow();
	const rec = recordedOpeners();
	attachNoteJump(row, { app: null as never, openers: rec.openers, file: mkFile, line: 3 });
	const link = row.createEl('a', { text: 'link' });
	const check = row.createEl('input', { attr: { type: 'checkbox' } });
	clickAt(link);
	clickAt(check);
	assert.deepEqual(rec.calls, [], '2: inner links and the toggle checkbox are left alone');
	row.click();
	assert.deepEqual(rec.calls, ['atLine:01-日记/2026-11-06.md:3'], '2: a direct row click still jumps');
}

// e) caller-declared ignore selectors (e.g. the agenda's source chip).
{
	const row = mkRow();
	const rec = recordedOpeners();
	attachNoteJump(row, { app: null as never, openers: rec.openers, file: mkFile, line: 3, ignore: '.dashboard-alltasks-chip' });
	const chip = row.createDiv({ cls: 'dashboard-alltasks-chip' });
	clickAt(chip);
	assert.deepEqual(rec.calls, [], '2: extra ignore selectors are honored');
}

// f) noteOpenersFrom adapts the single-callback wiring the calendar uses.
{
	const calls: string[] = [];
	const openers = noteOpenersFrom((f, line) => calls.push(`${f.path}:${line ?? 'top'}`));
	openers.atLine(mkFile, 7);
	openers.file(mkFile);
	openers.atLine(mkFile, null);
	openers.inPopover(mkFile);
	assert.deepEqual(calls, [
		'01-日记/2026-11-06.md:7',
		'01-日记/2026-11-06.md:top',
		'01-日记/2026-11-06.md:top',
		'01-日记/2026-11-06.md:top',
	], '2: noteOpenersFrom routes everything through the one callback');
}

// g) stopPropagation keeps ancestor handlers (a calendar day cell) out.
{
	const cell = new El('div');
	const row = cell.createDiv({ cls: 'dashboard-calendar-event' }) as unknown as HTMLElement;
	const rec = recordedOpeners();
	let cellOpened = 0;
	cell.addEventListener('click', () => { cellOpened++; });
	attachNoteJump(row, { app: null as never, openers: rec.openers, file: mkFile, line: 5, stopPropagation: true });
	(row as unknown as El).click();
	assert.deepEqual(rec.calls, ['atLine:01-日记/2026-11-06.md:5'], '2: the jump fires');
	assert.equal(cellOpened, 0, '2: stopPropagation holds the ancestor handler back');
}

// The dataview section delegates to the shared helper (source wiring).
{
	const openSrc = sectionSrc.slice(
		sectionSrc.indexOf('function attachRowOpen('),
		sectionSrc.indexOf('// Re-export so the view can bust the page cache'),
	);
	assert.ok(openSrc.length > 0, '2: attachRowOpen exists');
	assert.ok(openSrc.includes('attachNoteJump(el, {'), '2: it delegates to the shared attachNoteJump');
	assert.ok(openSrc.includes('line: rowJumpLine(row),'),
		'2: it asks rowJumpLine instead of re-deriving the line');
	assert.ok(openSrc.includes("ignore: '.dashboard-dataview-task-checkbox',"),
		'2: the toggle checkbox keeps its own handler');
}

/* -------------------------------- 3. wiring -------------------------------- */

{
	// Auto ("free") mode is the DEFAULT shape for LIST/TASK results and was the
	// one renderer that never attached a row opener — clicking a task did
	// nothing at all, which is why the popover never appeared.
	const freeSrc = sectionSrc.slice(
		sectionSrc.indexOf('function renderFreeList('),
		sectionSrc.indexOf('/* ----------------------------- CALENDAR'),
	);
	assert.ok(freeSrc.includes('attachRowOpen(li, row);'), '3: free-mode rows open their note');
	assert.ok(freeSrc.indexOf('attachRowOpen(li, row);') < freeSrc.indexOf("result.queryType === 'TASK' && row.task"),
		'3: wired BEFORE the TASK branch returns, or task rows stay dead');
}

assert.ok(sectionSrc.includes('let dvOpeners: NoteOpeners | null = null;'),
	'3: the section holds the shared openers vocabulary');
assert.ok(sectionSrc.includes('onOpenNoteAtLine: ((file: TFile, line?: number) => void) | null,'),
	'3: renderDataviewSection takes the line opener as a parameter');
assert.ok(sectionSrc.includes('dvOpeners = {'),
	'3: and builds the openers from both callbacks for the inner renderers');

// The calendar surfaces jump through the SAME helper (the unification this
// file guards): all-day chips, week events and month rows in the grid, and
// the day-agenda rows.
assert.ok((gridSrc.match(/attachNoteJump\(/g) ?? []).length >= 3,
	'3: the calendar grid jumps through the shared helper (chips, week events, month rows)');
assert.ok(gridSrc.includes('stopPropagation: true'),
	'3: month rows stopPropagation so the day cell does not also open the agenda');
assert.ok(agendaSrc.includes('attachNoteJump(row, {'),
	'3: the day agenda jumps through the shared helper');
assert.ok(agendaSrc.includes("ignore: '.dashboard-alltasks-chip',"),
	'3: the agenda keeps its source chip clickable on its own');

{
	const callIdx = rendererSrc.indexOf('renderDataviewSection(el, column, app, activeHoverParent,');
	assert.ok(callIdx > 0, '3: the section is rendered by the dashboard renderer');
	const call = rendererSrc.slice(callIdx, callIdx + 400);
	assert.ok(call.includes('callbacks.onOpenNoteInPopover ?? null'),
		'3: the generic opener still comes from onOpenNoteInPopover');
	assert.ok(call.includes('callbacks.onOpenNoteAtLine ?? null'),
		'3: the line opener comes from the calendar-sections channel (onOpenNoteAtLine)');
	assert.ok(call.indexOf('onOpenNoteInPopover') < call.indexOf('onOpenNoteAtLine'),
		'3: argument order matches the signature (opener, then line opener)');
}

/* ------------------------------- 4. the view ------------------------------- */

assert.ok(viewSrc.includes('onOpenNoteAtLine: (file: TFile, line?: number) => this.openNote(file, undefined, line),'),
	'4: the view routes the line into openNote');
assert.ok(viewSrc.includes('if (this.plugin.settings.disableNotePopover || file.extension !== \'md\') {'),
	'4: openNote still honours the popover setting');
{
	// Popover path: the embedded editor is revealed at the line once it has
	// geometry (the "标识位置" half of the calendar behaviour).
	assert.ok(popoverSrc.includes('window.setTimeout(() => { revealMarkdownLine(view, line); }, 100);'),
		'4: the popover reveals the requested line after layout');
	assert.ok(popoverSrc.includes('view.setEphemeralState({ line });'),
		'4: revealMarkdownLine scrolls through the same channel Obsidian uses');
	assert.ok(popoverSrc.includes('editor.setCursor(from);') && popoverSrc.includes('editor.scrollIntoView({ from, to }, true);'),
		'4: and puts the caret on the line when the editor is available');
	// Tab fallback (popover disabled / non-markdown): same reveal.
	assert.ok(viewSrc.includes('revealMarkdownLine(view, line);'),
		'4: the tab path reveals the line too');
}

/* --------------------------------- 5. CSS --------------------------------- */

assert.ok(css.includes('.dashboard-dataview-free-item.is-clickable {'),
	'5: free-view rows show the pointer cursor they never had');
assert.ok(css.includes('.dashboard-dataview-table tbody tr.is-clickable {'),
	'5: clickable table rows get the pointer the old rule only denied to the rest');
assert.ok(/\.dashboard-dataview-free-item\.is-jumpable[^{]*\{/.test(css) === false,
	'5: no dead is-jumpable rule is needed — the cursor rides on is-clickable');

console.log('dataview task open: all scenarios OK');
