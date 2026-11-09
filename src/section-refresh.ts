/**
 * The section refresh bus — ONE registry answering "which live sections
 * should re-run right now?", replacing the per-module copies this used to be
 * (dataview's dvSectionHandles, calendar's sectionReloaders WeakMap).
 *
 * A section registers once per render with:
 *  - `el`:          its host element; entries whose DOM is gone are pruned;
 *  - `channels`:    which refresh triggers it wants (see SectionRefreshChannel);
 *  - `paths`:       the notes it currently shows (re-read live, so it always
 *                   reflects the latest run), or null for "everything";
 *  - `reload`:      the re-run itself (quiet or loud is the caller's choice).
 *
 * Channels keep the deliberate policy differences intact: dataview cards are
 * snapshots that stay OFF the vault-event debounce by design, so they only
 * listen to 'note-edited'; calendar grids live-refresh everywhere, so they
 * only listen to 'vault'.
 */

/** What can trigger a section re-run. */
export type SectionRefreshChannel =
	/** A note was edited in the in-dashboard popover: instant, path-scoped. */
	| 'note-edited'
	/** The view's vault-event debounce (or any container-level "refresh the
	 *  calendars" nudge): every md change, container-scoped. */
	| 'vault';

export interface SectionRefreshEntry {
	el: HTMLElement;
	channels: readonly SectionRefreshChannel[];
	/** Notes the section currently shows, or null = interested in everything. */
	paths: () => ReadonlySet<string> | null;
	reload: () => void | Promise<void>;
}

const entries: SectionRefreshEntry[] = [];

/** Drop entries whose DOM is gone (a re-rendered dashboard builds fresh
 *  section elements). Pruning is permanent for that entry. */
function prune(): void {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!entries[i]!.el.isConnected) entries.splice(i, 1);
	}
}

/** Register (or, for the same element, REPLACE) a section's entry — a
 *  re-render must not stack a second reload for the same card. */
export function registerSectionRefresh(entry: SectionRefreshEntry): void {
	prune();
	const existing = entries.findIndex(e => e.el === entry.el);
	if (existing >= 0) entries[existing] = entry;
	else entries.push(entry);
}

/** The popover-edit channel: re-run the sections listening to 'note-edited'
 *  that currently show `path` (null-paths sections always match). */
export function refreshSectionsForPath(path: string): void {
	prune();
	for (const entry of [...entries]) {
		if (!entry.channels.includes('note-edited')) continue;
		const paths = entry.paths();
		if (paths === null || paths.has(path)) void entry.reload();
	}
}

/** Container-scoped refresh: every live entry mounted under `container` that
 *  listens to `channel`. Returns how many reloads fired. */
export function refreshSectionsIn(container: ParentNode, channel: SectionRefreshChannel): number {
	prune();
	let fired = 0;
	for (const entry of [...entries]) {
		if (!entry.channels.includes(channel)) continue;
		if (!container.contains(entry.el)) continue;
		void entry.reload();
		fired++;
	}
	return fired;
}
