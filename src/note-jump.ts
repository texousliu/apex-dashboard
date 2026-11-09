import type { App, HoverParent, TFile } from 'obsidian';
import { Platform } from 'obsidian';
import { attachNoteHover } from './hover-preview';

/**
 * The three ways a surface can open a note — ONE shared vocabulary instead of
 * the per-module opener globals that used to accumulate (dvOpener /
 * dvLineOpener / libOpener / activeNoteOpener …).
 *
 * All three honor the workspace's "disable popover" setting: they are thin
 * facades over DashboardView.openNote, which decides popover vs tab.
 */
export interface NoteOpeners {
	/** Open the note (popover when enabled, tab otherwise). */
	file(file: TFile): void;
	/** Open the note and land on a 0-based source line (caret + scroll). */
	atLine(file: TFile, line?: number | null): void;
	/** Open the note at a `#heading` / `#^block` subpath. */
	inPopover(file: TFile, subpath?: string): void;
}

/** Adapt a single `(file, line?) => void` opener — the wiring calendar-style
 *  callers pass down — into the full NoteOpeners shape. */
export function noteOpenersFrom(fn: (file: TFile, line?: number) => void): NoteOpeners {
	return {
		file: (f) => fn(f),
		atLine: (f, line) => fn(f, line === null ? undefined : line),
		inPopover: (f) => fn(f),
	};
}

/** Descendants whose clicks must NOT trigger the row jump — inner links,
 *  wikilinks, checkboxes and other interactive controls resolve on their own. */
const DEFAULT_JUMP_IGNORE = 'a, .dashboard-wikilink, input[type="checkbox"]';

export interface NoteJumpOptions {
	app: App;
	openers: NoteOpeners;
	file: TFile;
	/** 0-based source line to land on; null/undefined/negative opens the note
	 *  at the top. */
	line?: number | null;
	/** Attach Obsidian's native page-preview popover on hover (desktop only). */
	hoverParent?: HoverParent | null;
	/** Extra selector of descendants to leave alone, appended to the default
	 *  ignore list (e.g. a source chip the row also renders). */
	ignore?: string;
	/** Stop the event after the jump so an ancestor cell/list handler (e.g. a
	 *  calendar cell that opens the day agenda) does not also fire. */
	stopPropagation?: boolean;
}

/**
 * Make the whole element open its source note on click — the ONE shared
 * implementation of the "click a row → open the note (at its line)" gesture
 * that used to be re-implemented per surface (dataview rows, calendar events,
 * day-agenda rows, all-day chips).
 *
 * Cursor classes: `is-clickable` always, `is-jumpable` additionally when a
 * line target exists (the note opens ON the task, not at the top).
 */
export function attachNoteJump(el: HTMLElement, opts: NoteJumpOptions): void {
	const { app, openers, file } = opts;
	const line = typeof opts.line === 'number' && opts.line >= 0 ? opts.line : null;
	el.addClass('is-clickable');
	if (line !== null) el.addClass('is-jumpable');
	if (opts.hoverParent && !Platform.isMobile) {
		attachNoteHover(app, el, file, opts.hoverParent);
	}
	const ignore = opts.ignore ? `${DEFAULT_JUMP_IGNORE}, ${opts.ignore}` : DEFAULT_JUMP_IGNORE;
	el.addEventListener('click', (e) => {
		if ((e.target as HTMLElement).closest(ignore)) return;
		if (opts.stopPropagation) e.stopPropagation();
		if (line !== null) openers.atLine(file, line);
		else openers.file(file);
	});
}
