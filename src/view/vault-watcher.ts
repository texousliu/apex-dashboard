/**
 * Vault watching: registers the create / modify / delete / rename listeners,
 * collapses a burst of events into one trailing debounce, and decides which
 * derived surface a batch can actually affect.
 *
 * Extracted from `view.ts` (Phase 5). The pushback when this cluster first came
 * up was that it needed ten view methods and six private fields, so pulling it
 * out would only relocate the coupling. The fix was to narrow the fan-out
 * first: the watcher now holds its own event refs, pending sets, lag guard and
 * debounce timer, and calls the view through `VaultRefreshTargets` — one named
 * callback per surface, with the "which change wakes which surface" policy
 * living here, where it can be read in one place.
 */
import { App, Events, MetadataCache, TAbstractFile, TFile, Vault } from 'obsidian';
import { fileKind } from '../file-types';

/** Trailing debounce for a burst of vault events. */
const VAULT_REFRESH_DEBOUNCE = 500;
/** How many paths may sit in the md-cache lag guard before the oldest are
 *  dropped (a path whose `changed` never arrives must not accumulate). */
const MD_CACHE_LAG_LIMIT = 200;

/** The surfaces a vault batch can wake. Each one is a no-op when nothing it
 *  shows changed, so the caller does not have to be precise. */
export interface VaultRefreshTargets {
	/** The recent-documents strip. */
	refreshRecentDocs(): void;
	/** Sidebar task calendar (task dots) — preserved DOM, so a re-render never
	 *  repaints it. */
	refreshSidebarCalendar(): void;
	/** Day agendas, which hold the list they were opened with. */
	refreshOpenDayAgendas(): void;
	/** Cards whose tasks mirror today's daily note (re-read, not re-rendered). */
	refreshDailyLinkedCards(): void;
	/** Album slideshows, on a media change. */
	refreshAlbumWidgets(): void;
	/** Stats banner, which keeps its own extra debounce (it walks the vault). */
	refreshBannerStats(): void;
	/** Rebuild the sections whose scan scope intersects the batch. */
	refreshSections(paths: readonly string[], broad: boolean, changedMd: boolean, changedMedia: boolean): void;
}

export interface VaultWatcherHost {
	app: App;
	vault: Vault;
	metadataCache: MetadataCache;
	/** Normalized path of the board file itself — its writes belong to the
	 *  engine, which has already re-rendered whatever they changed. */
	dashboardPath(): string;
	/** Drop the scan signatures so the next pass rebuilds the scanning
	 *  sections (a cache-only change is invisible to their path/mtime keys). */
	invalidateSectionSignatures(): void;
	/** The stats-banner debounce timer lives with the banner code; teardown
	 *  has to cancel it so a pending pass cannot run against a closed view. */
	cancelPendingStats(): void;
	targets: VaultRefreshTargets;
}

export class VaultWatcher {
	private eventRefs: Array<{ evt: Events; ref: unknown }> = [];
	private changedPaths = new Set<string>();
	private broad = false;
	/** Newly created .md paths whose first metadataCache index hasn't landed
	 *  yet. */
	private pendingMdIndex = new Set<string>();
	/** Md paths from the last flushed batch: a metadataCache 'changed'
	 *  arriving for one of these means the cache was NOT ready when the rebuild
	 *  ran (frontmatter writes — pin/due/checklist — can index slower than the
	 *  500ms vault debounce), so that rebuild read stale data and a corrective
	 *  pass is needed. */
	private mdCacheLag = new Set<string>();
	private timer: number | null = null;

	constructor(private readonly host: VaultWatcherHost) {}

	/** (Re-)register every listener. Safe to call twice. */
	register(): void {
		this.unregister();
		const events = this.host.vault;
		const dashboardPath = this.host.dashboardPath();

		// Record one vault change. File events contribute their path (renames
		// both ends); folder events and unknown entities set the broad flag —
		// a folder carries no file path to scope-match, so refresh everything.
		// Our own dashboard-file writes are skipped: the engine owns that state
		// and the view already re-rendered whatever they changed.
		const record = (file: TAbstractFile | null, oldPath?: string): void => {
			if (file instanceof TFile) {
				if (file.path !== dashboardPath) this.changedPaths.add(file.path);
				if (oldPath && oldPath !== dashboardPath) this.changedPaths.add(oldPath);
			} else {
				this.broad = true;
			}
			this.schedule();
		};

		const createRef = events.on('create', (file: TAbstractFile) => {
			// A brand-new note's frontmatter is indexed asynchronously: the
			// create-debounce may render before the cache has the properties
			// (a pipeline board's strict status filter would hide the card).
			// Track it so its FIRST metadataCache 'changed' (index complete)
			// forces one more refresh pass.
			if (file instanceof TFile && file.extension === 'md') {
				this.pendingMdIndex.add(file.path);
			}
			record(file);
		});
		const modifyRef = events.on('modify', (file: TAbstractFile) => {
			// Plain content edits only matter to the note-derived views; an
			// image overwrite with the same path renders identically.
			if (file instanceof TFile && file.extension === 'md') {
				record(file);
			}
		});
		const deleteRef = events.on('delete', (file: TAbstractFile) => {
			if (file instanceof TFile) this.pendingMdIndex.delete(file.path);
			record(file);
		});
		const renameRef = events.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile) {
				if (this.pendingMdIndex.delete(oldPath)) this.pendingMdIndex.add(file.path);
			}
			record(file, oldPath);
		});
		// First cache index of a newly created note: the path/mtime/ctime
		// signature cannot see a cache-only change, so drop the signature
		// cache for this one pass. Gated to pending creations — firing on
		// every edit would nullify the signature short-circuit entirely.
		const metadata = this.host.metadataCache;
		const metaChangedRef = metadata.on('changed', (file: TFile) => {
			if (file.extension !== 'md') return;
			const isCreation = this.pendingMdIndex.delete(file.path);
			// Cache landed after the last refresh pass already used this file —
			// that pass rendered stale frontmatter (e.g. a pin that "bounced
			// back"); drop the signatures and run one corrective pass.
			const isLagged = this.mdCacheLag.has(file.path);
			if (!isCreation && !isLagged) return;
			if (isLagged) this.mdCacheLag.delete(file.path);
			this.host.invalidateSectionSignatures();
			record(file);
		});

		this.eventRefs = [
			{ evt: events, ref: createRef },
			{ evt: events, ref: modifyRef },
			{ evt: events, ref: deleteRef },
			{ evt: events, ref: renameRef },
			{ evt: metadata, ref: metaChangedRef },
		];
	}

	unregister(): void {
		for (const { evt, ref } of this.eventRefs) {
			evt.offref(ref as Parameters<typeof evt.offref>[0]);
		}
		this.eventRefs = [];
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.changedPaths = new Set();
		this.broad = false;
		this.pendingMdIndex = new Set();
		this.mdCacheLag = new Set();
		this.host.cancelPendingStats();
	}

	/** One trailing debounce for every vault event. A burst of edits costs a
	 *  single fan-out pass instead of five independently-reset timers. */
	private schedule(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const paths = this.changedPaths;
			const broad = this.broad;
			this.changedPaths = new Set();
			this.broad = false;
			this.flush(paths, broad);
		}, VAULT_REFRESH_DEBOUNCE);
	}

	/** Apply one debounced batch of vault changes. Each derived view is gated
	 *  by what the batch can actually affect: note-derived sidebars and
	 *  calendar sections need an .md change, album slideshows and media
	 *  sections an image/audio/video one, and scanning sections a change
	 *  inside their scan scope. */
	private flush(paths: ReadonlySet<string>, broad: boolean): void {
		const lowerPaths = [...paths].map(p => p.toLowerCase());
		const changedMd = broad || lowerPaths.some(p => p.endsWith('.md'));
		const changedMedia = broad || lowerPaths.some(p => {
			const dot = p.lastIndexOf('.');
			const ext = dot >= 0 ? p.slice(dot + 1) : '';
			const kind = fileKind(ext);
			return kind === 'image' || kind === 'audio' || kind === 'video';
		});
		const targets = this.host.targets;
		if (changedMd) {
			targets.refreshRecentDocs();
			targets.refreshSidebarCalendar();
			// Cards whose tasks mirror today's daily note (and only those) need
			// a re-read; the helper renders only when the lists actually differ.
			targets.refreshDailyLinkedCards();
			// Day agendas hold the list they were opened with; an edit made in a
			// tab (the popover path nudges on close) still leaves them stale.
			// They repaint only on a visible change.
			targets.refreshOpenDayAgendas();
			// Keeps its own extra debounce: the stats recompute walks the vault.
			targets.refreshBannerStats();
		}
		if (changedMedia) {
			targets.refreshAlbumWidgets();
		}
		targets.refreshSections(lowerPaths, broad, changedMd, changedMedia);
		// Arm the lag guard: any of these whose cache lands LATER must force
		// one corrective refresh (the pass above may have read stale cache).
		// UNION, never replace — a replace wipes slow-index entries before
		// their 'changed' arrives, and the corrective pass never fires.
		for (const p of paths) this.mdCacheLag.add(p);
		// Bound the set so a 'changed'-less path cannot accumulate forever.
		if (this.mdCacheLag.size > MD_CACHE_LAG_LIMIT) {
			const excess = this.mdCacheLag.size - MD_CACHE_LAG_LIMIT;
			let dropped = 0;
			for (const p of this.mdCacheLag) {
				if (dropped >= excess) break;
				this.mdCacheLag.delete(p);
				dropped += 1;
			}
		}
	}
}
