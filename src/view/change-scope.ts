/**
 * "Given these changed vault paths, which sections actually need rebuilding?"
 *
 * Moved out of `view.ts` (Phase 5). It is the decision half of the incremental
 * refresh: `render/section-refresh.ts` owns the mechanics of swapping one
 * section node, this owns the policy of *which* nodes qualify. Split because
 * the policy is the part with the subtle rules — and the part you can reason
 * about (and test) without a DOM.
 *
 * The rule seems simple and is not, because the board has two refresh
 * philosophies at once:
 *
 * - **Classic boards refresh per section.** A note edit only rebuilds the
 *   sections whose scan scope contains it, plus calendars (tasks live in any
 *   note) when any `.md` changed, plus media sections when a media file did.
 * - **Immersive boards freeze the scanning sections.** On a hybrid immersive
 *   board those sections are pinned views; each in-place rebuild swaps the
 *   tile element, and at a high vault-event rate that reads as continuous
 *   strobing. They refresh on the next full render like everything else — with
 *   two exceptions, both scoped: calendar grids update in place (no element
 *   swap, so no strobing), and a pinned tile still refreshes when the edit
 *   lands inside its configured scope.
 *
 * The two scope rules are deliberately NOT the same function — see
 * `sectionInScope` vs `immersiveTileInScope`. A whole-vault library refreshes
 * on a classic board (nothing else would ever refresh it) and stays frozen on
 * an immersive one (that freeze is the whole point). Unifying them is the
 * obvious refactor and the wrong one.
 */
import type { App } from 'obsidian';
import type { HoverParent } from 'obsidian';
import type { DashboardColumn, DashboardData, DashboardSettings, RenderCallbacks } from '../types';
import { isImmersiveLayout } from '../render/widget-mount';
import { refreshCalendarSections } from '../calendar-section';
import { dashboardMarkdownPath } from '../render-update';
import { refreshMediaSections, refreshScanningSections } from '../render/section-refresh';

/** What the scope policy needs from the view. */
export interface ChangeScopeHost {
	app: App;
	/** Fresh board data; null while the board is switching. */
	data(): DashboardData | null;
	settings(): DashboardSettings;
	/** The kanban element currently on screen, or null before layout. */
	kanban(): HTMLElement | null;
	callbacks(): RenderCallbacks;
	/** Handed to the render layer as the hover parent (the view itself). */
	hoverParent(): HoverParent | null;
	/** Rebuild one section in place — the immersive-safe path. */
	refreshSectionInPlace(columnName: string): void;
	/** No DOM to patch: ask for a whole-board rebuild. */
	fullRender(data: DashboardData): void;
	/** Swapped sections lost their grip/card drags; re-wire across the board. */
	rewireAfterSwap(kanban: HTMLElement, immersive: boolean, callbacks: RenderCallbacks): void;
}

/** Trim surrounding slashes. Folders are stored both ways; comparisons are not. */
function stripSlashes(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, '');
}

/** Trim + lowercase — the shape every root-folder comparison uses. */
function normalizeFolder(folder: string): string {
	return stripSlashes(folder).toLowerCase();
}

/** The folders a library/folder section scans (empty = whole vault). */
function configuredFolders(col: DashboardColumn): string[] {
	return (col.libraryConfig?.folders ?? []).map(stripSlashes).filter(f => f.length > 0);
}

/** The root folder a pipeline/pm section scans ('' = whole vault). */
function configuredRoot(col: DashboardColumn): string {
	const raw = (col.sectionType === 'pipeline' ? col.pipelineConfig?.rootFolder : col.pmConfig?.rootFolder) ?? '';
	return normalizeFolder(raw);
}

/** Does the edit hit a PM section's Gantt sources? Those are files, not folders. */
function hitsGanttSource(col: DashboardColumn, lowerPaths: readonly string[]): boolean {
	return (col.pmConfig?.ganttSources || []).some(ref => lowerPaths.includes(ref.path.toLowerCase()));
}

/**
 * Classic-board scope: does this section's scan range contain one of the
 * changed paths? `broad` (a folder-level vault event that does not name the
 * files) conservatively refreshes everything.
 */
export function sectionInScope(
	col: DashboardColumn,
	lowerPaths: readonly string[],
	broad: boolean,
): boolean {
	const folders = configuredFolders(col);
	// Pipeline/PM sections scope to their root folder (empty = whole vault).
	if (folders.length === 0 && (col.sectionType === 'pipeline' || col.sectionType === 'pm')) {
		const root = configuredRoot(col);
		if (root.length > 0) {
			if (broad || lowerPaths.length === 0) return true;
			return lowerPaths.some(p => p.startsWith(root + '/')) || (col.sectionType === 'pm' && hitsGanttSource(col, lowerPaths));
		}
		return true;
	}
	// No configured folders: the section scans the whole vault.
	if (folders.length === 0) return true;
	if (broad || lowerPaths.length === 0) return true;
	return lowerPaths.some(p => folders.some(f => p.startsWith(f.toLowerCase() + '/')));
}

/** Classic-board gate: calendars follow every `.md` (tasks live in any note). */
export function scanningSectionNeedsRefresh(
	col: DashboardColumn,
	lowerPaths: readonly string[],
	broad: boolean,
	changedMd: boolean,
): boolean {
	if (col.sectionType === 'calendar') return changedMd;
	return sectionInScope(col, lowerPaths, broad);
}

/**
 * Immersive-tile scope: strictly narrower than `sectionInScope`. A tile with
 * no configured scope scans the whole vault, and rebuilding those is exactly
 * the strobing the freeze exists to prevent — so "no folders" means "stay
 * frozen", not "always in scope". Pipeline/PM keep their whole-vault pass
 * through because their root is a single folder whose absence is meaningful.
 *
 * Note this ignores `broad`: on an immersive board a folder-level event does
 * not widen the scope. Documented at the call site for a reason — flipping it
 * would make every folder rename rebuild every pinned tile.
 */
export function immersiveTileInScope(col: DashboardColumn, lowerPaths: readonly string[]): boolean {
	const st = col.sectionType;
	if (st === 'pipeline' || st === 'pm') {
		const root = configuredRoot(col);
		if (root.length === 0) return true;
		return lowerPaths.some(p => p.startsWith(root + '/')) || (st === 'pm' && hitsGanttSource(col, lowerPaths));
	}
	if (st === 'library' || st === 'folder') {
		const folders = (col.libraryConfig?.folders ?? []).map(normalizeFolder).filter(f => f.length > 0);
		if (folders.length === 0) return false; // whole-vault scan: keep the freeze
		return lowerPaths.some(p => folders.some(f => p.startsWith(f + '/')));
	}
	return false;
}

export function refreshSectionsFor(
	host: ChangeScopeHost,
	lowerPaths: readonly string[],
	broad: boolean,
	changedMd: boolean,
	changedMedia: boolean,
): void {
	const data = host.data();
	if (!data) return;
	const settings = host.settings();
	const immersive = isImmersiveLayout(settings, data);
	const hasScanning = !immersive && data.columns.some(col => {
		const st = col.sectionType;
		return st === 'library' || st === 'calendar' || st === 'folder' || st === 'pipeline' || st === 'pm';
	});
	const hasMedia = !immersive && data.columns.some(col => {
		const st = col.sectionType;
		return st === 'images' || st === 'videos';
	});
	if (!hasScanning && !hasMedia) {
		// Immersive board: nothing goes through the scanning/media passes.
		// Only markdown edits matter at all here.
		if (immersive && changedMd) {
			// Calendar grids stay live even here — in-place update, no element
			// swap, so no strobing.
			const kanban0 = host.kanban();
			if (kanban0) refreshCalendarSections(kanban0);
			// Pinned tiles still live-refresh, but only inside their scope
			// (refreshSectionInPlace carries tile placement + scroll + DnD).
			for (const col of data.columns) {
				if (immersiveTileInScope(col, lowerPaths)) host.refreshSectionInPlace(col.name);
			}
		}
		return;
	}

	const kanban = host.kanban();
	if (!kanban) {
		// View not laid out yet — fall back to a full render.
		host.fullRender(data);
		return;
	}

	const callbacks = host.callbacks();
	let swapped = 0;
	if (hasScanning) {
		swapped += refreshScanningSections(
			kanban, data, callbacks, host.app, settings, host.hoverParent(),
			col => scanningSectionNeedsRefresh(col, lowerPaths, broad, changedMd),
			dashboardMarkdownPath(settings.dashboardFile),
		);
		// Calendar sections refresh their grid in place (nav/filter state
		// preserved) instead of going through refreshScanningSections.
		if (changedMd) refreshCalendarSections(kanban);
	}
	if (hasMedia && changedMedia) {
		swapped += refreshMediaSections(kanban, data, callbacks, host.app, settings, host.hoverParent());
	}
	if (swapped > 0) {
		// Refreshed sections were replaced (new DOM), so their grip/card DnD
		// handlers are gone. DnD is board-wide, so rewiring one section means
		// rewiring all of them.
		host.rewireAfterSwap(kanban, immersive, callbacks);
	}
}
