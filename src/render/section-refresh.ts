/**
 * The two "rescan and swap the section in place" refresh paths: file-scanning
 * sections (library / folder / pipeline / pm, guarded by a render-input
 * signature) and media sections (images / videos).
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). They sit
 * next to each other because both answer the same question — "did anything
 * this section renders actually change?" — and both swap a single section node
 * instead of re-rendering the board.
 */
import { App, TFile } from 'obsidian';
import type { HoverParent } from 'obsidian';
import type { DashboardColumn, DashboardData, DashboardSettings, RenderCallbacks } from '../types';
import { destroyMediaSection } from '../media-section';
import { captureScrollStates, restoreScrollStates } from '../scroll-preserve';
import { carryImmersivePlacement } from '../immersive';
import { normalizeExcludeFolders, isUnderExcludedFolder } from '../exclude-folders';
import { renderSection, getSectionType } from './section-frame';
import { sectionScan } from '../section/registry';
import { linkContext } from './link-context';



/** Render-input signatures per scanning section, keyed
 *  `<scope>|<index>:<name>` (scope = the owning board file, so two open
 *  dashboards on different workspaces never share entries). Populated by
 *  refreshScanningSections; see scanningSectionSignature. */
const scanningSectionSignatures = new Map<string, string>();

/** Drop every cached scanning-section signature. Called when the metadata
 *  cache (re)resolves: a section first rendered before resolution may hold
 *  partially-indexed frontmatter/tags, and a path+mtime signature cannot see
 *  that difference — clearing forces the next vault event to rebuild it. */
export function invalidateScanningSectionSignatures(): void {
	scanningSectionSignatures.clear();
}

/** Cheap fingerprint of everything a library/folder section's render derives
 *  from vault state: its libraryConfig plus the path, mtime, and ctime of
 *  every in-scope markdown file. Frontmatter/tag changes ride mtime (any
 *  content write bumps it). An equal signature means a rebuild would be
 *  byte-identical, so the DOM swap can be skipped without visible loss.
 *  `mdFiles` is the pass-wide vault listing (one getMarkdownFiles() for every
 *  section instead of one per section — noticeable on phones with several
 *  scanning sections and a large vault). */
function scanningSectionSignature(column: DashboardColumn, app: App, mdFiles: TFile[]): string {
	const cfg = column.libraryConfig;
	const folders = (cfg?.folders ?? [])
		.map(f => f.trim().replace(/^\/+|\/+$/g, ''))
		.filter(f => f.length > 0);
	// Pipeline sections scope to their root folder (empty = whole vault) and
	// skip their excluded folders in both the scan and this signature. PM
	// sections scope the same way through their own root.
	const pipeCfg = column.pipelineConfig ?? null;
	const pipelineRoot = pipeCfg
		? pipeCfg.rootFolder.trim().replace(/^\/+|\/+$/g, '').toLowerCase()
		: null;
	const pmRoot = column.sectionType === 'pm' && column.pmConfig
		? column.pmConfig.rootFolder.trim().replace(/^\/+|\/+$/g, '').toLowerCase()
		: null;
	const excluded = normalizeExcludeFolders([
		...(cfg?.excludeFolders ?? []),
		...(pipeCfg?.excludeFolders ?? []),
		...(column.pmConfig?.excludeFolders ?? []),
	]);
	const scopeRoots = [pipelineRoot, pmRoot].filter((root): root is string => root !== null && root.length > 0);
	const parts: string[] = [];
	for (const file of mdFiles) {
		if (folders.length > 0) {
			const lp = file.path.toLowerCase();
			if (!folders.some(f => lp.startsWith(f.toLowerCase() + '/'))) continue;
		}
		if (scopeRoots.length > 0) {
			const lp = file.path.toLowerCase();
			if (!scopeRoots.some(root => lp.startsWith(root + '/')) && !(column.pmConfig?.ganttSources || []).some(ref => ref.path.toLowerCase() === lp)) continue;
		}
		if (isUnderExcludedFolder(file.path, excluded)) continue;
		parts.push(`${file.path}|${file.stat.mtime}|${file.stat.ctime}`);
	}
	// Vault iteration order is not contractual; sort for a stable signature.
	parts.sort();
	return JSON.stringify([column.name, cfg ?? null, column.pipelineConfig ?? null, column.pmConfig ?? null, parts]);
}

/**
 * Re-render only the vault-scanning sections (library/folder) in place,
 * leaving media and card sections untouched. Used by the view's vault-event
 * debounce so editing a note no longer tears down the whole board (and the
 * media section's <video> thumbnails with it). `shouldRefresh` narrows the
 * pass to sections whose scan scope intersects the changed paths;
 * `signatureScope` keys the signature cache per board file.
 */
export function refreshScanningSections(
	kanban: HTMLElement,
	data: DashboardData,
	callbacks: RenderCallbacks,
	app: App,
	settings: DashboardSettings | undefined,
	hoverParent: HoverParent | null,
	shouldRefresh?: (column: DashboardColumn) => boolean,
	signatureScope?: string,
): number {
	linkContext.hoverParent = hoverParent;
	const mdFiles = app.vault.getMarkdownFiles();
	let refreshed = 0;
	for (const column of data.columns) {
		if (sectionScan(getSectionType(column)) !== 'files') continue;
		if (shouldRefresh && !shouldRefresh(column)) continue;
		const oldEl = kanban.querySelector(`:scope > [data-column="${CSS.escape(column.name)}"]`);
		if (!oldEl) continue;
		// Skip the swap when the section's render inputs are unchanged since the
		// last one (out-of-scope edit, write inside an excluded folder, non-md
		// churn under a scan folder): rebuilding would flash identical content.
		const key = `${signatureScope ?? ''}|${data.columns.indexOf(column)}:${column.name}`;
		const signature = scanningSectionSignature(column, app, mdFiles);
		if (scanningSectionSignatures.get(key) === signature) continue;
		scanningSectionSignatures.set(key, signature);
		const newEl = renderSection(column, callbacks, app, data, settings);
		// Carry the old row's scroll positions over the swap (file lists,
		// library kanban) so a vault-event refresh doesn't yank the viewport;
		// immersive boards additionally keep the tile's grid identity (see
		// carryImmersivePlacement — auto placement would teleport the tile).
		const scrollStates = captureScrollStates(oldEl);
		carryImmersivePlacement(oldEl as HTMLElement, newEl);
		oldEl.replaceWith(newEl);
		restoreScrollStates(newEl, scrollStates);
		refreshed++;
	}
	return refreshed;
}

/**
 * Re-render only the media sections (images/videos) in place. Releases the old
 * sections' <video> decoders + lazy observers (via destroyMediaSection) before
 * swapping. Only invoked on structural vault changes (create/delete/rename),
 * never on plain note edits, so videos are not churned during normal editing.
 */
export function refreshMediaSections(
	kanban: HTMLElement,
	data: DashboardData,
	callbacks: RenderCallbacks,
	app: App,
	settings: DashboardSettings | undefined,
	hoverParent: HoverParent | null,
	shouldRefresh?: (column: DashboardColumn) => boolean,
): number {
	linkContext.hoverParent = hoverParent;
	let refreshed = 0;
	for (const column of data.columns) {
		if (sectionScan(getSectionType(column)) !== 'media') continue;
		if (shouldRefresh && !shouldRefresh(column)) continue;
		const matched = kanban.querySelector(`:scope > [data-column="${CSS.escape(column.name)}"]`);
		if (!(matched instanceof HTMLElement)) continue;
		const scrollStates = captureScrollStates(matched);
		destroyMediaSection(matched);
		const newEl = renderSection(column, callbacks, app, data, settings);
		carryImmersivePlacement(matched, newEl);
		matched.replaceWith(newEl);
		restoreScrollStates(newEl, scrollStates);
		refreshed++;
	}
	return refreshed;
}
