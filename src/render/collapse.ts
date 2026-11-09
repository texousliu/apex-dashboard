/**
 * Path-keyed collapse/expand applied directly to the DOM.
 *
 * Shared by task rows (`data-task-path`) and project doc rows
 * (`data-doc-path`): both render their subtrees unconditionally and hide the
 * collapsed branches with a `--hidden` class, so a chevron click can flip
 * visibility in place instead of triggering a full re-render.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改") — it is the one piece
 * of the task-row cluster the doc rows also use.
 */
import { setIcon } from 'obsidian';

/**
 * Whether `maybeChildPath` is a descendant of `parentPath` (a strict prefix in
 * the path array). Used to find a collapsed item's DOM descendants for an
 * in-place show/hide that avoids a full dashboard re-render.
 */
export function isDescendantPath(parentPath: number[], maybeChildPath: number[]): boolean {
	if (maybeChildPath.length <= parentPath.length) return false;
	for (let i = 0; i < parentPath.length; i++) {
		if (maybeChildPath[i] !== parentPath[i]) return false;
	}
	return true;
}

/**
 * Parse the `data-task-path` / `data-doc-path` JSON attribute off a DOM node.
 * Returns an empty array (never matches as a descendant) if absent or malformed.
 */
export function readPathAttr(el: Element, attr: string): number[] {
	try {
		const raw = el.getAttribute(attr);
		return raw ? (JSON.parse(raw) as number[]) : [];
	} catch {
		return [];
	}
}

/**
 * Toggle a collapsed parent's children visibility directly on the DOM, plus the
 * chevron icon, WITHOUT triggering `notifyCallbacks` / a full `render()`.
 *
 * Why: collapsing/expanding is a pure visual state. Routing it through the sync
 * engine's `writeToDisk` + `notifyCallbacks` tore down and rebuilt the whole
 * board on every chevron click — the source of the long lag. Instead we flip a
 * `--hidden` class on every descendant item here, and let the sync engine
 * persist the `collapsed` flag on a debounced write with no re-render.
 *
 * DOM truth source: each parent item carries `aria-expanded` (set at render and
 * flipped here on every toggle). After flipping the toggled parent, we recompute
 * the `--hidden` class on EVERY descendant by walking its path prefix chain — a
 * descendant is shown only if every ancestor on that chain is expanded. This
 * handles nested collapse correctly: expanding A still keeps A's collapsed
 * child B's subtree hidden, because B's `aria-expanded=false` is on C's prefix.
 *
 * Note: children must actually exist in the DOM for this to work, so the
 * renderer creates them unconditionally (using `--hidden` for the collapsed
 * case) rather than skipping them — otherwise an expand after a full re-render
 * of a collapsed parent would find nothing to unhide.
 */
export function toggleCollapseInPlace(
	item: HTMLElement,
	parentPath: number[],
	pathAttr: string,
	nowCollapsed: boolean,
): void {
	const list = item.parentElement;
	if (!list) return;

	// Flip the chevron icon + record the new state as the DOM truth source.
	const toggle = item.querySelector(':scope > .dashboard-task-toggle');
	if (toggle instanceof HTMLElement) {
		setIcon(toggle, nowCollapsed ? 'chevron-right' : 'chevron-down');
	}
	item.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');

	// Build a path-keyed map of every item's expanded state ONCE, so the per-
	// descendant ancestor walk is O(1) per step instead of re-querying the list
	// (which made a single toggle O(n²) on large trees).
	const expandedByPath = new Map<string, boolean>();
	list.querySelectorAll<HTMLElement>(`:scope > [${pathAttr}]`).forEach((el) => {
		expandedByPath.set(JSON.stringify(readPathAttr(el, pathAttr)), el.getAttribute('aria-expanded') !== 'false');
	});

	// Recompute visibility for every descendant: show only if every ancestor on
	// its path prefix is currently expanded (read from the map above).
	list.querySelectorAll<HTMLElement>(`:scope > [${pathAttr}]`).forEach((sibling) => {
		if (sibling === item) return;
		const siblingPath = readPathAttr(sibling, pathAttr);
		if (!isDescendantPath(parentPath, siblingPath)) return;

		let hidden = false;
		// Walk every strict ancestor index of siblingPath (skip the node itself).
		for (let len = parentPath.length; len < siblingPath.length; len++) {
			const ancestorExpanded = expandedByPath.get(JSON.stringify(siblingPath.slice(0, len)));
			// Fail-safe: a strict prefix should always be a parent that exists in a
			// well-formed render. If it's missing, hide rather than risk leaking a
			// subtree due to stale/DOM drift.
			if (ancestorExpanded === false || ancestorExpanded === undefined) {
				hidden = true;
				break;
			}
		}
		sibling.toggleClass('dashboard-task-item--hidden', hidden);
		sibling.toggleClass('dashboard-project-doc-item--hidden', hidden);
	});
}
