import { HoverParent, HoverPopover, ItemView, MarkdownView, Notice, Platform, setIcon, WorkspaceLeaf, TFile } from 'obsidian';
import type DashboardPlugin from './main';
import type { AppWithCommands } from './obsidian-internal';
import type { DashboardData, DashboardCard, QuickAction, BannerData, LibraryConfig, QuickNotePreset, PinnedNote, QuickCommand, SkillShortcut, DataviewConfig, ImmersiveItem, TaskCardConfig, TaskItem, SkillCreateConfig, WidgetBackground } from './types';
import { SyncEngine } from './sync';
import { renderDashboard, destroyAllCharts, renderSidebarWidgets, sidebarWidgetSignature, isStackedLayout, resolveEffectiveLayout, isImmersiveLayout, renderSidebarWeekCalendar, renderSection, invalidateScanningSectionSignatures } from './renderer';
import { renderImmersiveRoot, setupImmersiveDnD, attachImmersiveResizeHandle, attachImmersiveWidgetDelete, carryImmersivePlacement, refitImmersiveGrid, openImmersiveAddMenu, setupImmersiveTileMenu, stampedRects } from './immersive';
import { defaultWidgetSize, displaceOverlappedBy, isImmersiveMode, widgetItemId } from './immersive-grid';
import type { PreserveScope } from './preserve-scope';
import { refreshSidebarTaskCalendar } from './calendar-widget';
import { refreshCalendarSections } from './calendar-section';
import { refreshAlbumWidgets, destroyAlbumWidgets } from './album-widget';
import { refreshOpenDayAgendas } from './calendar-modal';
import { invalidatePath } from './alltasks-scan';
import { refreshSectionsForPath } from './section-refresh';
import { destroyAnniversaryTimers } from './anniversary-widget';
import { getMusicService } from './music-service';
import { getHabitService } from './habit-service';
import { getExpenseService } from './expense-service';
import { renderBanner, BannerEditModal, ImmersiveAppearanceModal, startBannerImageRotation, BANNER_IMAGE_ROTATION_MS as BANNER_IMAGE_ROTATION_MS_SHARED } from './banner';
import { renderSectionRail } from './section-rail';
import { renderWorkspaceSwitcher } from './workspace-switcher';
import { refreshBannerStats } from './banner-stats';
import { applyAppearance } from './appearance';
import { createNoteFromPreset, captureThought, openPinnedNote, openTodayNote, renderQuickNoteRegion } from './quick-note-section';
import { QuickNoteConfigModal } from './quick-note-config-modal';
import { getRecentDocs, renderRecentDocs } from './recent';
import { renderQuickActions, AddActionModal, DocSearchModal } from './quick-actions';
import { AgentPromptModal } from './agent-prompt-modal';
import { fireSkillDirect } from './skill-widget';
import { SkillWidgetConfigModal } from './skill-widget-config-modal';
import { CountdownSettingsModal } from './countdown-modal';
import { AlbumSettingsModal } from './album-settings-modal';
import { AnniversarySettingsModal } from './anniversary-settings-modal';
import type { CountdownConfig, AlbumConfig, AnniversaryConfig, DashboardSettings } from './types';
import { setupDragAndDrop } from './dnd';
import { startGuardedDrag } from './drag-guard';
import { clampSidebarWidth, clampWidgetUnitHeight } from './widget-span';
import { CardEditModal } from './card-edit-modal';
import { NotePopoverModal, revealMarkdownLine } from './note-popover-modal';
import { showConfirmDialog } from './confirm-dialog';
import { loadHolidayData } from './lunar-widget';
import type { HolidayInfo } from './holiday-service';
import { AddSectionModal } from './add-section-modal';
import { FolderConfigModal, folderResultToLibraryConfig } from './folder-config-modal';
import { sectionTemplatePaths } from './library-new-note';
import { NotesSectionConfigModal } from './notes-config-modal';
import { fetchTickTickProjects } from './ticktick-config-modal';
import { TickTickFilterModal } from './ticktick-filter-modal';
import { PomodoroService } from './pomodoro-service';
import { createPomodoroMiniPanel, type PomodoroMiniPanel } from './pomodoro-mini-panel';
import { createReadingMiniTimer, type ReadingMiniTimer } from './reading-mini-timer';
import { ReadingService } from './reading-service';
import { t } from './i18n';
import { getDailyNotesConfig } from './daily-notes';
import { readCardTasksFromToday, retitleCardBlock, todayDailyNote, writeCardTasksToToday } from './daily-task-source';
import { createMemoNote } from './memo-note';
import { dashboardMarkdownPath, planDashboardUpdate, type DashboardUpdateSource } from './render-update';
import { captureScrollStates, restoreScrollStates, captureRootScrollState, restoreRootScrollState } from './scroll-preserve';
import { checkReminders } from './view/reminders';
import { VaultWatcher } from './view/vault-watcher';
import {
	startReminderChecker as startReminderScan,
	startDayRolloverChecker as startRolloverTick,
	startWeatherRefresh as startWeatherTick,
	stopWeatherRefresh as stopWeatherTick,
	stopInterval,
} from './view/watchdogs';
import { renderScrollToTop } from './view/scroll-top';
import { attachBoardEventDelegation, type BoardEventHost } from './view/board-events';
import { refreshSectionsFor, type ChangeScopeHost } from './view/change-scope';
import { archiveCompletedTasks, saveTasksToDaily, type TaskWriteHost } from './view/task-writes';
import type { RenderCallbacks } from './types';
import {
	cardNewNote,
	createNewNoteState,
	libraryNewNote,
	type NewNoteHost,
	type NewNoteState,
} from './view/new-note';
import {
	createMobilePanelState,
	renderMobileActions,
	renderMobileWidgetBar,
	type MobilePanelHost,
	type MobilePanelState,
} from './view/mobile-panel';
import {
	refreshExpenseInPlace,
	refreshHabitInPlace,
	refreshLunarInPlace,
	refreshMusicInPlace,
	refreshPomodoroInPlace,
	refreshReadingInPlace,
	type WidgetRefreshHost,
} from './view/widget-refresh';
import {
	openWidgetTypeModal,
	openStickyCardTypeModal,
	openWeatherConfigModal,
	openTrackerConfigModal,
	openTemplatePicker,
	openLibraryConfigModal,
	openDataviewConfigModal,
	openWebConfigModal,
	openRssConfigModal,
	openSkillsConfigModal,
	openPipelineConfigModal,
	openPmConfigModal,
	openMediaConfigModal,
	openWereadConfigModal,
	dispatchSkillCreate,
	type ConfigModalHost,
} from './view/config-modals';

export const DASHBOARD_VIEW_TYPE = 'apex-dashboard-view';

export class DashboardView extends ItemView implements HoverParent {
	private plugin: DashboardPlugin;
	private sync: SyncEngine;
	private data: DashboardData | null = null;
	private cleanupFns: Array<() => void> = [];
	private dndCleanupFns: Array<() => void> = [];
	private suppressNextRender = false;
	/** Vault events → debounced refresh fan-out (own file: view/vault-watcher.ts). */
	private vaultWatcher: VaultWatcher;
	private bannerStatsTimer: number | null = null;
	/** Lazily built adapter for the sidebar widget refreshes. */
	private widgetHost: WidgetRefreshHost | null = null;
	/** Lazily built adapter for the board's section-event table. */
	private boardEvents: BoardEventHost | null = null;
	private bannerStatsEl: HTMLElement | null = null;
	private readonly BANNER_STATS_DEBOUNCE = 800;
	/** True after the first `metadataCache` `resolved` event corrected the
	 *  banner stats following startup. One-shot to avoid repeat recomputes. */
	private bannerStatsResolvedOnce = false;
	private bannerQuoteIndex = 0;
	private static readonly BANNER_QUOTE_ROTATION_MS = 60 * 60 * 1000; // 1 hour (on the hour)
	// Poster cadence shared with the immersive background layer (banner.ts).
	private static readonly BANNER_IMAGE_ROTATION_MS = BANNER_IMAGE_ROTATION_MS_SHARED;
	private static readonly BANNER_QUOTE_OFFSET_MS = 60 * 60 * 1000; // offset by 1 hour from image
	private reminderTimer: number | null = null;
	private firedReminders = new Set<string>();
	// Pinned by default: absence of the stored key (first ever load) reads as
	// pinned — "默认固定" per Rae. Only an explicit unpin ('false', saved by
	// the banner pin toggle) keeps the hover-to-expand rail.
	private sidebarPinned = this.app.loadLocalStorage('apex-dashboard-sidebar-pinned') !== 'false';
	private sidebarExpanded = false;
	private bannerCollapsed = this.app.loadLocalStorage('apex-dashboard-banner-collapsed') === 'true';
	private pendingScrollCardId: string | null = null;
	private pendingScrollToLastCardOfColumn: string | null = null;
	private pomodoroService: PomodoroService | null = null;
	private pomodoroMiniPanel: PomodoroMiniPanel | null = null;
	private readingMiniTimer: ReadingMiniTimer | null = null;
	private readingService: ReadingService | null = null;
	private habitUnsubscribe: (() => void) | null = null;
	private expenseUnsubscribe: (() => void) | null = null;
	private musicUnsubscribe: (() => void) | null = null;
	private pomodoroUnsubscribe: (() => void) | null = null;
	private readingUnsubscribe: (() => void) | null = null;
	private holidayData: Record<string, HolidayInfo> = {};
	private weatherRefreshTimer: number | null = null;
	private dayRolloverTimer: number | null = null;
	private lastRenderedDay = new Date().toDateString();
	/** Sidebar widgets DOM detached from the previous render, re-attached when the
	 *  widget signature (see sidebarWidgetSignature) is unchanged - so dashboard
	 *  data mutations never rebuild the widgets. Null right after consumption. */
	private sidebarWidgetsEl: HTMLElement | null = null;
	/** Reentrancy guard for the two new-note flows (one per leaf: a second
	 *  click while the title prompt is open must not stack a second dialog). */
	private newNoteState: NewNoteState = createNewNoteState();
	/** Lazily built adapter for view/new-note. */
	private newNote: NewNoteHost | null = null;
	/** Lazily built adapter for view/change-scope. */
	private changeScope: ChangeScopeHost | null = null;
	/** Lazily built adapter for view/task-writes. */
	private taskWrites: TaskWriteHost | null = null;
	/** Open/expanded state of the phone widget bar. Owned by the view (one per
	 *  leaf) and handed to view/mobile-panel, which is the only writer. */
	private mobilePanelState: MobilePanelState = createMobilePanelState();
	/** Lazily built adapter for the phone chrome. */
	private mobilePanel: MobilePanelHost | null = null;
	private sidebarWidgetsSig: string | null = null;
	/** Immersive layout: per-widget card elements detached from the previous
	 *  grid, re-attached tile-by-tile when the widget signature is unchanged
	 *  (the grid has no whole-area container to preserve — cards are individual
	 *  tiles). Same signature gate as sidebarWidgetsEl. */
	private immWidgetEls: Map<string, HTMLElement> = new Map();
	/** The immersive arrangement as last rendered (order + spans) — the commit
	 *  baseline for optimistic drag/resize updates. */
	private immItems: import('./types').ImmersiveItem[] = [];
	private isOpening = false;
	private isOpen = false;
	private lifecycleRevision = 0;
	private pendingInitialData: DashboardData | null = null;

	// HoverParent contract: Obsidian assigns/clears this when showing a Page
	// Preview popover over a dashboard link. Declared so the dashboard can act as
	// the hover owner for `hover-link` events.
	hoverPopover: HoverPopover | null = null;

	// The currently-open centered note editor popover, if any. Tracked so it can
	// be torn down (detaching its embedded leaf) when the view closes.
	private popoverModal: NotePopoverModal | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.sync = new SyncEngine(this.app, this.plugin.settings);
		this.sync.onDataUpdate((data, source) => {
			this.handleDataUpdate(data, source);
		});
		this.vaultWatcher = new VaultWatcher({
			app: this.app,
			vault: this.app.vault,
			metadataCache: this.app.metadataCache,
			dashboardPath: () => dashboardMarkdownPath(this.plugin.settings.dashboardFile),
			invalidateSectionSignatures: () => invalidateScanningSectionSignatures(),
			cancelPendingStats: () => this.cancelBannerStatsDebounce(),
			targets: {
				refreshRecentDocs: () => this.refreshRecentDocs(),
				refreshSidebarCalendar: () => this.refreshSidebarCalendarNow(),
				refreshOpenDayAgendas: () => refreshOpenDayAgendas(),
				refreshDailyLinkedCards: () => { void this.refreshDailyLinkedCards(); },
				refreshAlbumWidgets: () => this.refreshAlbumWidgetsNow(),
				refreshBannerStats: () => this.debouncedRefreshBannerStats(),
				refreshSections: (paths, broad, changedMd, changedMedia) => {
					refreshSectionsFor(this.changeScopeHost(), paths, broad, changedMd, changedMedia);
				},
			},
		});
	}

	getViewType(): string {
		return DASHBOARD_VIEW_TYPE;
	}

	/** Per-workspace layout switch (settings picker / switcher menu): write
	 *  THIS board file's `layout:` override. The engine echo re-renders the
	 *  whole board via planDashboardUpdate's layout trigger; other open views
	 *  on the same file pick it up through their own file watchers. */
	async setBoardLayout(layout: import('./types').DashboardLayoutMode | undefined): Promise<void> {
		await this.sync.updateLayout(layout);
	}

	/** The board file this view is currently rendering (settings UI reads the
	 *  active layout from here). */
	getBoardData(): DashboardData | null {
		return this.sync.getData();
	}

	getDisplayText(): string {
		return t('main.dashboard');
	}

	getIcon(): string {
		return 'home';
	}

	async onOpen(): Promise<void> {
		if (this.isOpening || this.isOpen) return;
		this.isOpening = true;
		const revision = ++this.lifecycleRevision;
		this.sync.updateSettings(this.plugin.settings);
		await this.sync.init();
		if (revision !== this.lifecycleRevision) return;
		// The banner "streak" auto-detects the Daily Notes core plugin, whose
		// internal-plugins state may report as not-yet-enabled during the very
		// first render. Re-compute once the metadata cache has fully resolved so
		// the number never flashes an incorrect value from the startup race.
		// One-shot guard: `resolved` can fire repeatedly on large vaults.
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			if (this.bannerStatsResolvedOnce) return;
			this.bannerStatsResolvedOnce = true;
			// Sections rendered before the cache resolved may hold partially
			// indexed frontmatter; their path+mtime signatures cannot see that,
			// so drop them to force a rebuild on the next vault event.
			invalidateScanningSectionSignatures();
			this.debouncedRefreshBannerStats();
		}));
		this.pomodoroService = new PomodoroService(this.plugin);
		this.readingService = new ReadingService(this.plugin);
		const holidayDataPromise = loadHolidayData(this.app);
		// Load both data files in parallel — on mobile either can block on an
		// iCloud download, and the old serial awaits stacked both waits into
		// view-open time. Holiday data may require a network request, so it must
		// never hold the first dashboard render hostage.
		await Promise.all([
			this.pomodoroService.loadSessions(),
			this.readingService.loadSessions(),
		]);
		if (revision !== this.lifecycleRevision) return;
		// Body-level floating countdown pill; polls the service on its own so
		// it survives sidebar re-renders and stays up while other tabs show.
		this.pomodoroMiniPanel = createPomodoroMiniPanel(
			this.plugin,
			this.pomodoroService,
			this.containerEl.ownerDocument,
		);
		// Tiny top-right elapsed-time pill while a reading session runs; its
		// stop button opens the same end-of-reading flow as the sidebar card.
		this.readingMiniTimer = createReadingMiniTimer(
			this.readingService,
			this.containerEl.ownerDocument,
		);
		// Habit data is plugin-level: every open view subscribes so a check-in
		// in one view refreshes the widget and banner in all of them.
		this.habitUnsubscribe = getHabitService()?.subscribe(() => this.onHabitChanged()) ?? null;
		this.expenseUnsubscribe = getExpenseService()?.subscribe(() => this.onExpenseChanged()) ?? null;
		// Music is desktop-only (no service on mobile → null subscription).
		this.musicUnsubscribe = getMusicService()?.subscribe(() => this.onMusicChanged()) ?? null;
		// Focus re-sync merges another device's records and notifies — refresh
		// the pomodoro/reading widgets without restarting the timers.
		this.pomodoroUnsubscribe = this.pomodoroService.subscribe(() => this.onPomodoroDataChanged());
		this.readingUnsubscribe = this.readingService.subscribe(() => this.onReadingDataChanged());
		this.registerVaultListeners();
		// Sidebar-widget events bubble to the view root, not the kanban host
		// (widgets render beside it): the skill widget's gear is heard here.
		this.containerEl.addEventListener('dashboard-skillwidget-config', ((e: CustomEvent) => {
			e.stopPropagation();
			new SkillWidgetConfigModal(this.app, this.plugin).open();
		}) as EventListener);
		// Calendar day-agenda add → rescan the live calendar surfaces. Needed
		// because a dashboard-file destination (a day with no daily note) is
		// skipped by the vault-event fan-out (record() ignores the dashboard's
		// own path), so the grid — and every agenda click that reads its
		// snapshot — stayed frozen until a view-switch rebuild. Dispatched on
		// .apex-dashboard-root by calendar-modal (bubbles up here); stable
		// host so render() rebuilds don't need to re-arm it.
		this.containerEl.addEventListener('dashboard-calendar-refresh', (() => {
			this.refreshCalendarSurfaces();
		}));
		this.startReminderChecker();
		this.startWeatherRefresh();
		this.startDayRolloverChecker();
		this.isOpen = true;
		this.isOpening = false;
		const initialData = this.pendingInitialData ?? this.sync.getData();
		this.pendingInitialData = null;
		if (initialData) this.render(initialData);
		void holidayDataPromise.then((data) => {
			if (revision !== this.lifecycleRevision || !this.isOpen) return;
			this.holidayData = data;
			this.refreshLunarWidgetsInPlace();
		});
	}

	async onClose(): Promise<void> {
		this.lifecycleRevision++;
		this.isOpening = false;
		this.isOpen = false;
		this.pendingInitialData = null;
		this.popoverModal?.close();
		this.popoverModal = null;
		this.runCleanup();
		this.unregisterVaultListeners();
		this.stopReminderChecker();
		this.stopWeatherRefresh();
		this.stopDayRolloverChecker();
		this.pomodoroMiniPanel?.destroy();
		this.pomodoroMiniPanel = null;
		this.readingMiniTimer?.destroy();
		this.readingMiniTimer = null;
		this.pomodoroService?.destroy();
		this.pomodoroService = null;
		this.readingService?.destroy();
		this.readingService = null;
		this.habitUnsubscribe?.();
		this.habitUnsubscribe = null;
		this.expenseUnsubscribe?.();
		this.expenseUnsubscribe = null;
		this.musicUnsubscribe?.();
		this.musicUnsubscribe = null;
		this.pomodoroUnsubscribe?.();
		this.pomodoroUnsubscribe = null;
		this.readingUnsubscribe?.();
		this.readingUnsubscribe = null;
		this.sync.destroy();
	}

	private handleDataUpdate(data: DashboardData, source: DashboardUpdateSource): void {
		const previous = this.data;
		this.data = data;
		if (this.isOpening || !this.isOpen) {
			this.pendingInitialData = data;
			return;
		}
		// Quiet mutation whose DOM was already patched in place: adopt the new
		// data graph (this.data is set above) but never paint. Must come BEFORE
		// the suppression check so it cannot consume that one-shot flag.
		if (source === 'local-silent') return;
		if (this.suppressNextRender) {
			this.suppressNextRender = false;
			return;
		}

		const plan = planDashboardUpdate(previous, data, source);
		if (plan.kind === 'none') return;
		if (plan.kind === 'sections') {
			// A height-only change on a calendar or web section is already live
			// in the DOM (the resize handle writes the inline height as it
			// drags); rebuilding would reset the calendar's month/week navigation
			// or reload the web section's embedded page for no gain.
			// Skip those; every other change re-renders as usual.
			const buildable = plan.names.filter((name) => {
				if (!previous) return true;
				const idx = data.columns.findIndex(c => c.name === name);
				const before = previous.columns[idx];
				const after = data.columns[idx];
				if (!before || !after || (after.sectionType !== 'calendar' && after.sectionType !== 'web')) return true;
				return JSON.stringify({ ...before, height: undefined }) !== JSON.stringify({ ...after, height: undefined });
			});
			if (buildable.length === 0) return;
			const refreshed = buildable.every((name) => this.refreshSectionInPlace(name));
			if (refreshed) return;
		}
		this.render(data);
	}

	async refresh(): Promise<void> {
		this.sync.updateSettings(this.plugin.settings);
		const data = this.sync.getData();
		if (data) {
			this.render(data);
		}
	}

	/** Reload the dashboard file from disk (e.g. after a backup restore) and
	 *  re-render. The sync engine re-reads and notifies, which triggers render. */
	async reloadFromDisk(): Promise<void> {
		await this.sync.reloadFromDisk();
	}

	/** Re-point this view's engine at the (already-updated) active workspace and
	 *  reload. Called by the plugin after any workspace switch/registry change.
	 *  Settings objects are replaced (not mutated) on every save, so the fresh
	 *  reference must be pushed into the engine before it re-resolves the file. */
	async applyWorkspaceSwitch(): Promise<void> {
		this.sync.updateSettings(this.plugin.settings);
		await this.sync.switchFile();
	}

	editBackground(): void { if (this.data) this.openBannerEditModal(this.data); }

	addSection(): void {
		// Same flow as the "+ 添加分区" button: pick the section type first,
		// then name it. The plain name prompt (always a notes section) is gone.
		if (this.isLayoutLocked()) return;
		this.openAddSectionModalInner();
	}

	/** Flip the banner between poster & quotes and the stats dashboard.
	 *  updateBanner persists the new mode and re-renders via the sync callback. */
	async toggleBannerMode(): Promise<void> {
		const data = this.sync.getData();
		if (!data) return;
		const nextMode = data.banner.mode === 'stats' ? 'quote' : 'stats';
		await this.sync.updateBanner({ mode: nextMode });
		new Notice(nextMode === 'stats' ? t('main.bannerModeStats') : t('main.bannerModeQuote'));
	}

	private render(data: DashboardData): void {
		// Snapshot EVERY scrolled container (stacked region, board, sidebar
		// rail, widget deck, card decks, task lists, widget internals — and the
		// root itself, which scrolls on mobile) before any teardown. Keyed by
		// card/widget/column anchors, so the replay at the end survives
		// reorders. The previous targeted saves missed the stacked widget deck:
		// detaching/re-attaching the widgets container resets scroll state, so
		// every re-render jumped the deck back to its first column. This must
		// run BEFORE the widgets detach below, while the deck is still in the
		// tree.
		const prevRoot = this.containerEl.children[1] as HTMLElement | undefined;
		const savedRootScroll = captureRootScrollState(prevRoot ?? createDiv());
		const layout = resolveEffectiveLayout(this.plugin.settings, this.data);
		// Detach the sidebar widgets before tearing the rest down. If their
		// inputs (signature below) are unchanged, this exact node is re-attached
		// in renderSidebar instead of being rebuilt - dashboard data mutations
		// then cost nothing for the widgets (calendar keeps its month navigation,
		// countdowns keep ticking, no vault re-scan). The immersive grid has no
		// whole-area container: its cards are individual tiles, so they detach
		// into a per-key map instead (renderImmersiveRoot re-attaches them).
		if (isImmersiveMode(layout)) {
			this.immWidgetEls = new Map();
			const prevGrid = prevRoot?.querySelector<HTMLElement>('.dashboard-imm .dashboard-kanban');
			prevGrid?.querySelectorAll<HTMLElement>(':scope > [data-widget-key]').forEach(el => {
				el.remove();
				const key = el.dataset.widgetKey;
				if (key) this.immWidgetEls.set(key, el);
			});
		} else {
			const oldWidgets = prevRoot?.querySelector('.dashboard-sidebar-widgets');
			if (oldWidgets instanceof HTMLElement) {
				oldWidgets.remove();
				this.sidebarWidgetsEl = oldWidgets;
			}
		}
		const widgetSig = sidebarWidgetSignature(
			this.plugin.settings,
			!!this.pomodoroService,
			!!this.readingService,
			!!this.holidayData && Object.keys(this.holidayData).length > 0,
			JSON.stringify([data.quickActions, data.quickActionOrder, data.hiddenPresets]),
			data,
		);
		const preserveWidgets = isImmersiveMode(layout)
			? this.immWidgetEls.size > 0 && this.sidebarWidgetsSig === widgetSig
			: !!this.sidebarWidgetsEl && this.sidebarWidgetsSig === widgetSig;

		// The live-DOM scope destroy functions must leave alone: one element
		// (side/stacked widgets area) or a per-card set (immersive tiles).
		const preserveScope: HTMLElement | Set<HTMLElement> | null = preserveWidgets
			? (isImmersiveMode(layout) ? new Set(this.immWidgetEls.values()) : this.sidebarWidgetsEl)
			: null;
		this.runCleanup(preserveScope);
		this.data = data;
		this.firedReminders.clear();
		this.sidebarWidgetsSig = widgetSig;

		const container = this.containerEl.children[1] as HTMLElement;

		// Sweep any touch-drag ghost clones stranded on activeDocument.body from a prior
		// interrupted drag (touchcancel). They live outside the container, so
		// container.empty() cannot reach them.
		activeDocument.body.querySelectorAll(':scope > .dashboard-card--ghost').forEach((el) => el.remove());

		container.empty();
		container.addClass('apex-dashboard-root');
		container.setAttribute('data-theme', this.plugin.settings.stylePreset);
		// Layout mode rides on an attribute so CSS owns the switch. Phones
		// always report 'side' (resolveEffectiveLayout excludes them) so their
		// DOM and CSS stay byte-identical regardless of this desktop-only
		// setting. The immersive layout replaces the banner/sidebar pipeline
		// entirely (see renderImmersiveRoot); before that lands it renders
		// through the side-shaped path, and only [data-layout="stacked"] CSS
		// keys off this attribute.
		container.setAttribute('data-layout', resolveEffectiveLayout(this.plugin.settings, this.data));

		// Apply user appearance overrides (background image layer + custom colors).
		// Must run after data-theme so inline `--db-*` overrides win by specificity,
		// and before banner/main are created so the bg layer sits behind content.
		applyAppearance(container, this.app, this.plugin.settings);

		// The immersive layout and the side/stacked layout are two separate
		// pipelines (own banner, own board host); each one is a method so this
		// one stays a teardown → build → re-wire → restore sequence.
		const boardHost = isImmersiveMode(layout)
			? this.renderImmersiveBoard(container, data, preserveWidgets)
			: this.renderClassicBoard(container, data, preserveWidgets);
		// The immersive grid owns section geometry; its section grip becomes a
		// whole-tile reorder handle (setupImmersiveDnD), so the side/stacked
		// grip-reorder wiring is skipped there. Card drags stay armed in both.
		setupDragAndDrop(boardHost, this.createCallbacks(), this.dndCleanupFns, { skipSectionGrip: isImmersiveMode(layout) });
		this.wireBoardEvents(boardHost);

		// Replay the pre-render scroll snapshot onto the rebuilt tree. Keys that
		// no longer resolve (a genuinely new structure) are skipped inside the
		// restore; the pending-scroll pass below may then re-scroll on purpose.
		restoreRootScrollState(container, savedRootScroll);

		this.applyPendingScrolls(container);
		this.renderScrollToTop(container);
	}

	/** Immersive pipeline: no banner/sidebar split — a full-bleed poster, a
	 *  pinned top region, and widgets + sections mixed in one free grid (still
	 *  on a .dashboard-kanban host, so every kanban-rooted mechanism keeps
	 *  working). Returns the grid, which acts as the board host. */
	private renderImmersiveBoard(container: HTMLElement, data: DashboardData, preserveWidgets: boolean): HTMLElement {
		const imm = renderImmersiveRoot({
			container,
			data,
			settings: this.plugin.settings,
			app: this.app,
			plugin: this.plugin,
			services: {
				pomodoroService: this.pomodoroService ?? undefined,
				readingService: this.readingService ?? undefined,
				holidayData: this.holidayData ?? undefined,
				onOpenNote: (file, line) => this.openNote(file, undefined, line),
				renderQuickActions: (host) => this.renderQuickActionsWidget(host),
			},
			callbacks: this.createCallbacks(),
			hoverParent: this,
			reuseWidgets: preserveWidgets ? this.immWidgetEls : null,
			getItems: () => this.immItems,
			onEditBackground: () => new ImmersiveAppearanceModal(this.app, data, updates => {
				void this.sync.updateImmersiveAppearance(updates).then(() => this.refresh());
			}).open(),
			onToggleEditing: () => {
				const grid = container.querySelector<HTMLElement>('.dashboard-imm .dashboard-kanban');
				const rects = grid ? stampedRects(grid) : new Map<string, { x: number; y: number; w: number; h: number }>();
				const items = this.immItems.map(item => ({ ...item, ...(rects.get(item.id) ?? {}) }));
				void this.sync.updateImmersiveEditing(this.data?.immersiveEditable === false, items);
			},
			registerCleanup: fn => this.cleanupFns.push(fn),
		});
		this.immItems = imm.items;
		this.immWidgetEls = imm.widgetEls;
		this.bannerStatsEl = null;
		setupImmersiveDnD(imm.grid, () => this.immItems, next => this.commitImmersiveItems(next), this.dndCleanupFns);
		setupImmersiveTileMenu(imm.grid, id => void this.removeImmersiveItem(id), this.dndCleanupFns);
		this.attachImmersiveResizeHandles(imm.grid);
		return imm.grid;
	}

	/** Side/stacked pipeline: banner → main → (optional scroll region) →
	 *  sidebar rail + scrolling kanban. Returns the kanban as the board host. */
	private renderClassicBoard(container: HTMLElement, data: DashboardData, preserveWidgets: boolean): HTMLElement {
		const bannerEl = renderBanner(
			container,
			data.banner,
			() => this.openBannerEditModal(data),
			this.app,
		);
		// Capture the stats panel (only present in stats mode) so vault changes
		// can refresh it in place without a full re-render.
		this.bannerStatsEl = bannerEl.querySelector('.dashboard-banner-stats');

		renderMobileActions(this.mobilePanelHost(), bannerEl);
		// Workspace switcher — banner, at the top-left corner of the stats
		// view's CENTER column (the CSS mirrors the stats grid: 20px panel
		// padding + 1/5 of the content width = the center column's left edge).
		// Rebuilt every render so the active highlight always matches settings.
		renderWorkspaceSwitcher(bannerEl, this.plugin);

		// Sidebar pin — desktop-only, bottom-left corner of the banner. Moved
		// here out of the quick-actions header because quick buttons became a
		// hideable sidebar widget (the pin must survive hiding them).
		this.renderBannerPinButton(bannerEl);

		if (this.bannerCollapsed && window.innerWidth > 640) {
			bannerEl.addClass('dashboard-banner--collapsed');
		}
		this.setupBannerBehavior(bannerEl);

		// Banner quote rotation
		this.setupBannerRotation(container, data.banner);

		renderMobileWidgetBar(this.mobilePanelHost(), container);

		const mainLayout = container.createDiv({ cls: 'dashboard-main' });

		// Stacked layout: the quick-notes work bar (capture pill, today note,
		// chips) moves OUT of the kanban to sit directly under the banner,
		// above the widget strip — the kanban sits below the strip there, so
		// its usual top slot would land the bar beneath the widgets. The side
		// layout keeps rendering it inside the kanban as before.
		//
		// Scroll model: the bar stays PINNED, while the widget deck and the
		// board scroll TOGETHER inside one region below it (the user wheels
		// through widgets and sections as one page). The side layout keeps the
		// old split (rail scrolls alone, board scrolls alone).
		const stacked = isStackedLayout(this.plugin.settings, data);
		if (stacked && this.plugin.settings.quickNotesEnabled) {
			renderQuickNoteRegion(mainLayout, this.plugin.settings, this.createCallbacks(), this.app);
		}
		const contentHost = stacked
			? mainLayout.createDiv({ cls: 'dashboard-scroll-region' })
			: mainLayout;

		// Rail state classes apply in BOTH layouts: in stacked mode they carry
		// strip semantics instead (collapse to a slim bar, expand on click,
		// pin keeps it open) via the [data-layout="stacked"] CSS overrides.
		const sidebar = contentHost.createDiv({ cls: 'dashboard-sidebar' });
		if (this.sidebarPinned) {
			sidebar.addClass('dashboard-sidebar--pinned');
		} else if (this.sidebarExpanded) {
			sidebar.addClass('dashboard-sidebar--expanded');
		} else {
			sidebar.addClass('dashboard-sidebar--collapsed');
		}
		this.applySidebarSizing(sidebar);
		this.renderSidebar(sidebar, container, preserveWidgets ? this.sidebarWidgetsEl : null);
		this.setupSidebarBehavior(sidebar, container);

		// Two-layer board: a NON-scrolling wrapper around the scrolling
		// .dashboard-kanban. (The switcher itself lives on the banner; the split
		// stays because it gives the scroll layer a clean, non-scrolling host.)
		const kanbanWrapper = contentHost.createDiv({ cls: 'dashboard-kanban-wrapper' });
		const kanban = kanbanWrapper.createDiv({ cls: 'dashboard-kanban' });
		renderDashboard(kanban, data, this.createCallbacks(), this.app, this.plugin.settings, this, { skipQuickNotes: stacked });

		// Section nav rail (right-edge dashes): one per section row, click
		// to center it. Hidden under two sections; the rail's own DOM order
		// matches the rendered rows (which match data.columns order).
		// Phones skip the rail entirely (Rae): the touch rail had no reveal
		// gesture and its capture-phase scroll listener (per-frame
		// getBoundingClientRect across every section row) was a measurable
		// scroll-jank source on mobile hardware.
		if (!Platform.isMobile) {
			renderSectionRail(
				container,
				kanban.querySelectorAll('.dashboard-section-row').length,
				data.columns.map(col => col.name),
			);
		}
		return kanban;
	}

	/** Scroll to the card the caller just created (or the last card of a
	 *  column, after "+" on a section header). Both settle after the pending id
	 *  is cleared, so a re-render that lands the card late still wins. */
	private applyPendingScrolls(container: HTMLElement): void {
		// Scroll to newly added card
		if (this.pendingScrollCardId) {
			const cardEl = container.querySelector(`[data-card-id="${this.pendingScrollCardId}"]`);
			if (cardEl) {
				window.requestAnimationFrame(() => {
					cardEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
				});
			}
			this.pendingScrollCardId = null;
		}
		if (this.pendingScrollToLastCardOfColumn) {
			const colName = this.pendingScrollToLastCardOfColumn;
			const sectionRow = container.querySelector(`[data-column="${colName}"]`);
			if (sectionRow) {
				const cards = sectionRow.querySelectorAll('.dashboard-card');
				const lastCard = cards[cards.length - 1];
				if (lastCard) {
					window.requestAnimationFrame(() => {
						lastCard.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
					});
				}
			}
			this.pendingScrollToLastCardOfColumn = null;
		}
	}

	/** Quick-buttons widget card builder — one implementation shared by the
	 *  sidebar rail (side/stacked) and the immersive grid. */
	private renderQuickActionsWidget(container: HTMLElement): void {
		if (!this.data) return;
		renderQuickActions(
			container,
			this.data.quickActions,
			(action) => { void this.executeAction(action); },
			(index) => {
				void showConfirmDialog(this.app, {
					title: t('common.confirmDelete'),
					message: t('common.confirmDeleteMessage'),
				}).then(confirmed => {
					if (confirmed) void this.sync.removeQuickAction(index);
				});
			},
			() => this.openAddActionModal(),
			this.data.quickActionOrder,
			(order) => { void this.sync.reorderQuickActions(order); },
			(key) => {
				void showConfirmDialog(this.app, {
					title: t('common.confirmDelete'),
					message: t('common.confirmDeleteMessage'),
				}).then(confirmed => {
					if (confirmed) void this.sync.removeQuickActionByKey(key);
				});
			},
			this.data.hiddenPresets,
			(action) => this.openEditActionModal(action),
			{
				bg: this.plugin.settings.quickButtonsBgColor,
				btn: this.plugin.settings.quickButtonsBtnColor,
				onChange: (kind, color) => {
					void (async () => {
						this.plugin.settings = {
							...this.plugin.settings,
							...(kind === 'bg'
								? { quickButtonsBgColor: color ?? undefined }
								: { quickButtonsBtnColor: color ?? undefined }),
						};
						await this.plugin.saveSettings();
					})();
				},
			},
		);
	}

	/** Section-internal events bubbling to the board host (the kanban, shared
	 *  by the side/stacked wrapper and the immersive grid). Registered once per
	 *  render on whichever host the active layout produced. */
	/** Section-internal events bubbling to the board host (the kanban, shared
	 *  by the side/stacked wrapper and the immersive grid). Registered once per
	 *  render on whichever host the active layout produced; the event table
	 *  itself lives in view/board-events.ts. */
	private wireBoardEvents(board: HTMLElement): void {
		attachBoardEventDelegation(this.boardEventHost(), board);
	}

	/** The view's side of `BoardEventHost`, built once — every member is a
	 *  getter or a one-line forwarder, so an event always sees live state. */
	private boardEventHost(): BoardEventHost {
		this.boardEvents ??= {
			app: this.app,
			data: () => this.data,
			sync: () => this.sync,
			plugin: () => this.plugin,
			refreshSectionInPlace: name => this.refreshSectionInPlace(name),
			openLibraryConfigModal: name => this.openLibraryConfigModal(name),
			openDataviewConfigModal: name => this.openDataviewConfigModal(name),
			openWebConfigModal: name => this.openWebConfigModal(name),
			openRssConfigModal: name => this.openRssConfigModal(name),
			openSkillsConfigModal: name => this.openSkillsConfigModal(name),
			openPipelineConfigModal: name => this.openPipelineConfigModal(name),
			openPmConfigModal: name => this.openPmConfigModal(name),
			openMediaConfigModal: name => this.openMediaConfigModal(name),
			openWereadConfigModal: name => this.openWereadConfigModal(name),
			dispatchSkillCreate: cfg => this.dispatchSkillCreate(cfg),
			openFolderConfigModal: name => this.openFolderConfigModal(name),
			openNotesSectionConfigModal: name => this.openNotesSectionConfigModal(name),
			handleLibraryNewNote: (name, pos) => { void libraryNewNote(this.newNoteHost(), this.newNoteState, name, pos); },
			openTickTickFilterModal: name => { void this.openTickTickFilterModal(name); },
			suppressNextRender: () => { this.suppressNextRender = true; },
		};
		return this.boardEvents;
	}

	/** Corner resize grips + hover delete buttons for every current grid tile
	 *  (both idempotent — a tile that already carries them is skipped).
	 *  Re-run after refreshSectionInPlace swaps a section node. */
	private attachImmersiveResizeHandles(grid: HTMLElement): void {
		for (const child of Array.from(grid.children)) {
			const el = child as HTMLElement;
			const id = el.dataset?.immId;
			if (!id) continue;
			// Reused widget tiles (immWidgetEls) still carry strips from the
			// previous render whose listeners close over the OLD grid and OLD
			// commit closure (stampedRects against a detached grid). Strip
			// them and re-bind fresh so both the drag math and the commit
			// resolve against the CURRENT grid. attach is idempotent, so this
			// is also what makes re-binding possible at all.
			el.querySelectorAll?.('.dashboard-imm-resize-h, .dashboard-imm-resize-v, .dashboard-imm-resize-handle')
				.forEach(n => n.remove());
			attachImmersiveResizeHandle(el, id, () => this.immItems, next => {
				// A resize keeps the tile pinned at its x/y; any PINNED tile its
				// new size now covers must give way — planImmersive stamps x/y
				// tiles verbatim with no mutual collision check, so without the
				// demotion the overlap renders forever (the "cards overlap
				// after resizing" bug). The stamped rects already carry the
				// drag's live span writes. Read the grid from the tile: cached
				// tiles may have re-parented since this closure was made.
				this.commitImmersiveItems(displaceOverlappedBy(next, id, stampedRects((el.parentElement) ?? grid)));
			});
			if (id.startsWith('widget:')) {
				attachImmersiveWidgetDelete(el, removeId => void this.removeImmersiveItem(removeId));
			}
		}
	}

	/** Apply a user-dragged immersive arrangement optimistically (content-fit
	 *  repack: measure → cap → pack → pure DOM moves; live widgets keep
	 *  running) and persist it. The engine write's own render echo is
	 *  swallowed via suppressNextRender and the vault-watcher reload no-ops on
	 *  the serialize-equality check — the handleMoveCard recipe. */
	private isLayoutLocked(): boolean {
		return !!this.data && isImmersiveLayout(this.plugin.settings, this.data) && this.data.immersiveEditable === false;
	}

	/** Re-wire the immersive GRID-LEVEL tile DnD + context menu after an
	 *  in-place refresh. Both mid-session refresh paths clear
	 *  `dndCleanupFns` (to drop the card-deck listeners of the swapped-out
	 *  tiles) — but that array also carries the cleanup of
	 *  `setupImmersiveDnD` / `setupImmersiveTileMenu`, whose whole-tile
	 *  move-drag and right-click menu live on the SURVIVING grid. Without
	 *  this re-wire the board keeps its looks yet silently loses tile
	 *  dragging until the next full render (the "return from a note and
	 *  cards can't be dragged; lock→edit layout restores them" bug). */
	private rewireImmersiveGridDnD(kanban: HTMLElement): void {
		if (!this.data || !isImmersiveLayout(this.plugin.settings, this.data)) return;
		setupImmersiveDnD(kanban, () => this.immItems, next => this.commitImmersiveItems(next), this.dndCleanupFns);
		setupImmersiveTileMenu(kanban, id => void this.removeImmersiveItem(id), this.dndCleanupFns);
	}

	private commitImmersiveItems(next: ImmersiveItem[]): void {
		if (this.isLayoutLocked()) return;
		const root = this.containerEl.children[1] as HTMLElement | undefined;
		const grid = root?.querySelector<HTMLElement>('.dashboard-imm .dashboard-kanban');
		if (grid) {
			// force: a reorder changes no heights, but the DOM order must be
			// rewritten (the fit's unchanged-measurements shortcut would skip).
			refitImmersiveGrid(grid, next, true);
		}
		this.immItems = next;
		this.suppressNextRender = true;
		void this.sync.updateImmersive(next);
	}

	private setupBannerBehavior(bannerEl: HTMLElement): void {
		const pinBtn = bannerEl.createEl('button', {
			cls: 'dashboard-banner-pin-btn',
			attr: { 'aria-label': 'Toggle banner' },
		});
		setIcon(pinBtn, 'bookmark');

		pinBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (window.innerWidth <= 640) return;
			this.bannerCollapsed = !this.bannerCollapsed;
			bannerEl.toggleClass('dashboard-banner--collapsed', this.bannerCollapsed);
			this.app.saveLocalStorage('apex-dashboard-banner-collapsed', String(this.bannerCollapsed));
		});

		const onResize = () => {
			if (window.innerWidth <= 640 && this.bannerCollapsed) {
				bannerEl.removeClass('dashboard-banner--collapsed');
			} else if (this.bannerCollapsed) {
				bannerEl.addClass('dashboard-banner--collapsed');
			}
		};
		window.addEventListener('resize', onResize);
		this.cleanupFns.push(() => window.removeEventListener('resize', onResize));
	}

	private setupBannerRotation(container: HTMLElement, banner: BannerData): void {
		// Quote rotation — stats mode has no quote text to rotate.
		if (banner.mode !== 'stats') {
			const quotes = banner.quotes;
			if (quotes && quotes.length > 1) {
				// Offset by 1 hour so quote and image swaps don't overlap
				const quoteIndex = Math.floor((Date.now() + DashboardView.BANNER_QUOTE_OFFSET_MS) / DashboardView.BANNER_QUOTE_ROTATION_MS) % quotes.length;
				this.bannerQuoteIndex = quoteIndex;

				const quoteEl = container.querySelector('.dashboard-banner-quote') as HTMLElement;
				const authorEl = container.querySelector('.dashboard-banner-author') as HTMLElement;
				if (quoteEl && authorEl) {
					const initial = quotes[quoteIndex]!;
					quoteEl.textContent = initial.quote;
					authorEl.textContent = initial.author;

					const rotateQuote = () => {
						this.bannerQuoteIndex = (this.bannerQuoteIndex + 1) % quotes.length;
						const next = quotes[this.bannerQuoteIndex]!;

						quoteEl.addClass('dashboard-banner-quote--fading');
						authorEl.addClass('dashboard-banner-author--fading');

						window.setTimeout(() => {
							quoteEl.textContent = next.quote;
							authorEl.textContent = next.author;
							quoteEl.removeClass('dashboard-banner-quote--fading');
							authorEl.removeClass('dashboard-banner-author--fading');
						}, 400);
					};

					const quoteTimer = window.setInterval(rotateQuote, DashboardView.BANNER_QUOTE_ROTATION_MS);
					this.cleanupFns.push(() => window.clearInterval(quoteTimer));
				}
			}
		}

		// Image rotation — applies to both quote and stats modes (stats uses the
		// same .dashboard-banner background, so it rotates identically). The
		// shared time-seed rotator also drives the immersive background layer.
		const bannerEl = container.querySelector<HTMLElement>('.dashboard-banner');
		if (bannerEl) {
			startBannerImageRotation(bannerEl, banner, this.app, DashboardView.BANNER_IMAGE_ROTATION_MS, fn => this.cleanupFns.push(fn));
		}
	}

	private renderSidebar(sidebar: HTMLElement, root: HTMLElement, reuseWidgets: HTMLElement | null): void {
		if (!this.data) return;

		const scroll = sidebar.createDiv({ cls: 'dashboard-sidebar-scroll' });

		// Week calendar and recent docs are CSS-hidden in stacked mode, so skip
		// building them there: the recent-docs list costs a full markdown-file
		// mtime sort per render, and the debounced refresh already no-ops when
		// the .dashboard-recent block is absent.
		if (!isStackedLayout(this.plugin.settings, this.data)) {
			renderSidebarWeekCalendar(scroll);
		}

		// Quick buttons participate in the widget drag/reorder system now; the
		// renderer adds them to the widget area like any other sidebar widget.
		// Shared with the immersive grid (same builder, same callbacks).
		const renderQuickActionsWidget = (container: HTMLElement): void => this.renderQuickActionsWidget(container);

		// Preserve: reuse the detached widgets DOM when the signature matched.
		// Either way, track the live element for the next render's detach step.
		this.sidebarWidgetsEl = renderSidebarWidgets(
			scroll,
			this.plugin.settings,
			this.app,
			this.pomodoroService ?? undefined,
			this.readingService ?? undefined,
			this.holidayData,
			(order) => {
				void (async () => {
					this.plugin.settings = {
						...this.plugin.settings,
						widgetOrder: order,
					};
					await this.plugin.saveSettings();
					this.render(this.data!);
				})();
			},
			reuseWidgets,
			(file, line) => this.openNote(file, undefined, line),
			renderQuickActionsWidget,
			this.data,
		);

		if (!isStackedLayout(this.plugin.settings, this.data)) {
			const docs = getRecentDocs(this.app, this.plugin.settings.recentDocCount);
			renderRecentDocs(
				scroll,
				docs,
				(path) => { void this.navigateToPath(path); },
			);
		}
	}

	/** Desktop-only sidebar pin, anchored at the banner's bottom-left corner.
	 *  Distinct from the banner-collapse bookmark button (top-right,
	 *  .dashboard-banner-pin-btn): this one pins/unpins the sidebar. Works in
	 *  both layouts — in stacked mode it pins the widget strip open instead of
	 *  the left rail. */
	private renderBannerPinButton(bannerEl: HTMLElement): void {
		if (Platform.isMobile) return;
		const pinBtn = bannerEl.createEl('button', {
			cls: 'dashboard-sidebar-pin-btn',
			attr: { 'aria-label': 'Toggle sidebar pin' },
		});
		const update = () => {
			setIcon(pinBtn, this.sidebarPinned ? 'pin' : 'pin-off');
			pinBtn.toggleClass('dashboard-sidebar-pin-btn--active', this.sidebarPinned);
		};
		update();
		pinBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.sidebarPinned = !this.sidebarPinned;
			this.app.saveLocalStorage('apex-dashboard-sidebar-pinned', String(this.sidebarPinned));
			const sidebar = this.containerEl.querySelector('.dashboard-sidebar');
			if (sidebar) {
				if (this.sidebarPinned) {
					sidebar.addClass('dashboard-sidebar--pinned');
					sidebar.removeClass('dashboard-sidebar--expanded');
					sidebar.removeClass('dashboard-sidebar--collapsed');
					this.sidebarExpanded = false;
				} else {
					sidebar.removeClass('dashboard-sidebar--pinned');
					sidebar.addClass('dashboard-sidebar--collapsed');
					this.sidebarExpanded = false;
				}
			}
			update();
		});
	}

	private setupSidebarBehavior(sidebar: HTMLElement, root: HTMLElement): void {
		// Create slim indicator (visible only when collapsed)
		sidebar.createDiv({ cls: 'dashboard-sidebar-slim-indicator' });

		// Use capture phase so child handlers can't stopPropagation before we see it
		sidebar.addEventListener('mousedown', (e: MouseEvent) => {
			if (this.sidebarPinned) return;
			if (sidebar.hasClass('dashboard-sidebar--collapsed')) {
				e.preventDefault();
				e.stopPropagation();
				sidebar.removeClass('dashboard-sidebar--collapsed');
				sidebar.addClass('dashboard-sidebar--expanded');
				this.sidebarExpanded = true;
			}
		}, true);

		// Click outside to collapse
		const outsideHandler = (e: MouseEvent) => {
			if (this.sidebarPinned) return;
			if (!this.sidebarExpanded) return;
			if (sidebar.contains(e.target as Node)) return;
			sidebar.removeClass('dashboard-sidebar--expanded');
			sidebar.addClass('dashboard-sidebar--collapsed');
			this.sidebarExpanded = false;
		};
		root.addEventListener('click', outsideHandler);
		this.cleanupFns.push(() => root.removeEventListener('click', outsideHandler));

		// Resize handles (desktop only): the stacked strip drags its unit
		// height, the side rail drags its width. Phones have neither surface
		// (the rail is display:none under 641px, the strip does not exist).
		// The handles are direct sidebar children, so the collapsed state's
		// `> *:not(.slim-indicator)` hiding rule keeps them unreachable there.
		if (Platform.isMobile) return;
		if (isStackedLayout(this.plugin.settings, this.data)) {
			this.attachStripHeightHandle(sidebar);
		} else {
			this.attachSidebarWidthHandle(sidebar);
		}
	}

	/** Write the persisted area sizing as CSS variables on the sidebar element.
	 *  Runs every render and deliberately stays OUT of the widget signature:
	 *  both values apply as plain custom properties (--db-sidebar-w /
	 *  --db-widget-unit-h), so committing a drag never rebuilds the widgets
	 *  DOM (live timers and listeners survive). Writing on the OUTER sidebar
	 *  also covers the widgets-reuse path, where the inner strip is a
	 *  re-attached node from a previous render. */
	private applySidebarSizing(sidebar: HTMLElement): void {
		const s = this.plugin.settings;
		if (isStackedLayout(s)) {
			sidebar.setCssProps({ '--db-widget-unit-h': `${clampWidgetUnitHeight(s.widgetUnitHeight)}px` });
		} else if (!Platform.isMobile) {
			// Unitless: the stylesheet multiplies by 1px for the width and by
			// 1/220 for the proportional content scale (see the CSS comment).
			sidebar.setCssProps({ '--db-sidebar-w': String(clampSidebarWidth(s.sidebarWidth)) });
		}
	}

	/** Stacked layout: drag the strip's bottom edge to scale the 6-row grid
	 *  unit (--db-widget-unit-h). Every card keeps its row fraction, so the
	 *  whole strip grows/shrinks proportionally. Live frames write the CSS
	 *  variable only; the value is persisted on release — the zero-writes-
	 *  mid-drag discipline of the section height handle. */
	private attachStripHeightHandle(sidebar: HTMLElement): void {
		const handle = sidebar.createDiv({ cls: 'dashboard-sidebar-strip-handle' });
		handle.setAttribute('aria-label', t('view.stripResizeHint'));
		handle.addEventListener('pointerdown', (e) => {
			const startY = e.clientY;
			// Settings anchor, not offsetHeight: the collapsed strip's rendered
			// height carries no usable unit value.
			const startH = clampWidgetUnitHeight(this.plugin.settings.widgetUnitHeight);
			sidebar.addClass('dashboard-sidebar--resizing');
			const shieldHost = sidebar.closest('.apex-dashboard-root') ?? sidebar.parentElement;
			shieldHost?.addClass('dashboard-frames-muted');
			let last = startH;
			startGuardedDrag(e, {
				cursor: 'ns-resize',
				onMove: (ev) => {
					// A re-render can tear the sidebar down mid-drag; resizing a
					// detached element is stale work.
					if (!sidebar.isConnected) {
						sidebar.removeClass('dashboard-sidebar--resizing');
						shieldHost?.removeClass('dashboard-frames-muted');
						return;
					}
					last = clampWidgetUnitHeight(startH + (ev.clientY - startY));
					sidebar.style.setProperty('--db-widget-unit-h', `${last}px`);
				},
				onUp: () => {
					sidebar.removeClass('dashboard-sidebar--resizing');
					shieldHost?.removeClass('dashboard-frames-muted');
					const finalH = Math.round(last);
					if (finalH === startH) return;
					this.commitSidebarSizing({ widgetUnitHeight: finalH }, '--db-widget-unit-h', `${finalH}px`);
				},
			});
		});
	}

	/** Side layout: drag the rail's right edge to resize the widget column
	 *  (--db-sidebar-w, unitless). Card content adapts through pure CSS: the
	 *  widgets area scales its em-based root font-size with the width ratio
	 *  and the fluid internals (flex/percent/ellipsis) reflow — no re-render,
	 *  no JS layout work. */
	private attachSidebarWidthHandle(sidebar: HTMLElement): void {
		const handle = sidebar.createDiv({ cls: 'dashboard-sidebar-width-handle' });
		handle.setAttribute('aria-label', t('view.sidebarResizeHint'));
		handle.addEventListener('pointerdown', (e) => {
			const startX = e.clientX;
			const startW = clampSidebarWidth(this.plugin.settings.sidebarWidth);
			sidebar.addClass('dashboard-sidebar--resizing');
			const shieldHost = sidebar.closest('.apex-dashboard-root') ?? sidebar.parentElement;
			shieldHost?.addClass('dashboard-frames-muted');
			let last = startW;
			startGuardedDrag(e, {
				cursor: 'col-resize',
				onMove: (ev) => {
					if (!sidebar.isConnected) {
						sidebar.removeClass('dashboard-sidebar--resizing');
						shieldHost?.removeClass('dashboard-frames-muted');
						return;
					}
					last = clampSidebarWidth(startW + (ev.clientX - startX));
					sidebar.style.setProperty('--db-sidebar-w', String(last));
				},
				onUp: () => {
					sidebar.removeClass('dashboard-sidebar--resizing');
					shieldHost?.removeClass('dashboard-frames-muted');
					const finalW = Math.round(last);
					if (finalW === startW) return;
					this.commitSidebarSizing({ sidebarWidth: finalW }, '--db-sidebar-w', String(finalW));
				},
			});
		});
	}

	/** Persist a committed resize and mirror the value onto every OTHER open
	 *  dashboard view's sidebar — a cheap setProperty sweep, because a full
	 *  refreshAllDashboards would rebuild boards for a pure CSS change. Other
	 *  views also pick the value up on their next render from settings. */
	private commitSidebarSizing(
		patch: { sidebarWidth?: number; widgetUnitHeight?: number },
		cssVar: string,
		value: string,
	): void {
		this.plugin.settings = { ...this.plugin.settings, ...patch };
		void this.plugin.saveSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
			const other = leaf.view as DashboardView | undefined;
			if (!other || other === this) continue;
			other.containerEl.querySelectorAll<HTMLElement>('.dashboard-sidebar')
				.forEach(el => el.style.setProperty(cssVar, value));
		}
	}

	/** The callback table the render layer receives.
	 *
	 *  Assembled from four groups so each one reads as what it is: card contents,
	 *  board geometry, section actions, board chrome. The explicit return type is
	 *  load-bearing — with spreads the compiler checks the ASSEMBLED object, so a
	 *  group that loses a key fails here instead of at one of the six call sites
	 *  that build a board. Groups must stay disjoint: a key appearing in two of
	 *  them would be silently overridden by the later spread.
	 */
	private createCallbacks(): RenderCallbacks {
		return {
			...this.cardCallbacks(),
			...this.layoutCallbacks(),
			...this.sectionCallbacks(),
			...this.chromeCallbacks(),
		};
	}

	private cardCallbacks() {
		/** Card contents: tasks, docs, memo bodies, covers, titles. These are the
		 *  callbacks that write CARD data — the board's own file, or the user's
		 *  daily note for the two task paths (view/task-writes.ts). */
		return {
			onCardEdit: (card: DashboardCard) => this.openCardEditModal(card),
			onOpenNoteInPopover: (file: TFile, subpath?: string) => this.openNote(file, subpath),
			onOpenNoteAtLine: (file: TFile, line?: number) => this.openNote(file, undefined, line),
			onCardDelete: async (cardId: string) => {
				if (this.isLayoutLocked()) return;
				const confirmed = await showConfirmDialog(this.app, {
					title: t('common.confirmDelete'),
					message: t('common.confirmDeleteMessage'),
				});
				if (!confirmed) return;
				void this.sync.deleteCard(cardId);
				new Notice(t('card.deleted'));
			},
			onCardPinTop: (cardId: string, columnName: string) => {
				// One-click pin-to-top on sticky cards: reuse the optimistic
				// same-column move path. Already first -> skip the pointless write.
				const col = this.data?.columns.find(c => c.name === columnName);
				if (!col || col.cards[0]?.id === cardId) return;
				void this.handleMoveCard(cardId, columnName, 0);
			},
			onTaskCardConfigSave: (card: DashboardCard, config: TaskCardConfig) => {
				void this.applyTaskCardConfig(card, config);
			},
			onCheckboxToggleQuiet: (cardId: string, taskPath: number[], checked: boolean) => this.sync.toggleTaskQuiet(cardId, taskPath, checked),
			onTaskAdd: (cardId: string, text: string, parentPath?: number[]) => this.sync.addTask(cardId, text, parentPath),
			onTaskDelete: async (cardId: string, taskPath: number[]) => {
				const confirmed = await showConfirmDialog(this.app, {
					title: t('common.confirmDelete'),
					message: t('common.confirmDeleteMessage'),
				});
				if (!confirmed) return;
				void this.sync.deleteTask(cardId, taskPath);
			},
			onTaskReorder: (cardId: string, fromPath: number[], toPath: number[], before: boolean) => this.sync.reorderTask(cardId, fromPath, toPath, before),
			onTaskMoveToCard: (srcCardId: string, fromPath: number[], destCardId: string, destPath: number[], mode: 'before' | 'after' | 'nest') => this.sync.moveTaskToCard(srcCardId, fromPath, destCardId, destPath, mode),
			onTaskEdit: (cardId: string, taskPath: number[], text: string) => this.sync.editTask(cardId, taskPath, text),
			onTaskNest: (cardId: string, taskPath: number[]) => this.sync.nestTask(cardId, taskPath),
			onTaskNestInto: (cardId: string, srcPath: number[], destPath: number[]) => this.sync.nestTaskInto(cardId, srcPath, destPath),
			onTaskUnnest: (cardId: string, taskPath: number[]) => this.sync.unnestTask(cardId, taskPath),
			onTaskToggleCollapse: (cardId: string, taskPath: number[]) => this.sync.toggleCollapseTaskQuiet(cardId, taskPath),
			onMemoUpdate: (card: DashboardCard, updates: Pick<DashboardCard, 'body' | 'blockquote'> & Partial<Pick<DashboardCard, 'tasks' | 'docs' | 'wikiLink' | 'url' | 'type'>>) => this.sync.updateMemoCard(card.id, updates),
			onMemoSaveAsNote: (card: DashboardCard) => this.saveMemoAsNote(card),
			onTaskSaveToDaily: (card: DashboardCard) => { void saveTasksToDaily(this.taskWriteHost(), card); },
			onDocAdd: (cardId: string, path: string) => this.sync.addDocToCard(cardId, path),
			onCardNewNote: (cardId: string, pos?: { x: number; y: number }) => { void cardNewNote(this.newNoteHost(), this.newNoteState, cardId, pos); },
			onDocDelete: (cardId: string, docPath: number[]) => this.sync.deleteDoc(cardId, docPath),
			onDocReorder: (cardId: string, fromPath: number[], toPath: number[], before: boolean) => this.sync.reorderDocs(cardId, fromPath, toPath, before),
			onDocMoveToCard: (srcCardId: string, fromPath: number[], destCardId: string, destPath: number[], mode: 'before' | 'after' | 'nest') => this.sync.moveDocToCard(srcCardId, fromPath, destCardId, destPath, mode),
			onDocNest: (cardId: string, docPath: number[]) => this.sync.nestDoc(cardId, docPath),
			onDocToggleCollapse: (cardId: string, docPath: number[]) => this.sync.toggleCollapseDocQuiet(cardId, docPath),
			onMemoColorChange: (card: DashboardCard, color: string) => this.sync.updateMemoColor(card.id, color),
			onProjectCoverChange: (card: DashboardCard, imagePath: string) => this.sync.updateProjectCover(card.id, imagePath),
			onCardTitleEdit: (cardId: string, newTitle: string) => this.sync.updateCard(cardId, { title: newTitle }),
			onFileDrop: (cardId: string, filePath: string) => this.handleFileDrop(cardId, filePath),
			onTaskReminderEdit: (cardId: string, taskPath: number[], reminder: string | undefined) => this.sync.editTaskReminder(cardId, taskPath, reminder),
		};
	}

	private layoutCallbacks() {
		/** Board geometry: columns, card sizes, grid placement, drag-move. Every
		 *  one of these is gated by the same layout lock — moving a card in a
		 *  pre-built board is exactly what "locked" means, so the check lives here
		 *  rather than being repeated at each call site. */
		return {
			onCardAdd: (colName: string) => {
				const column = this.data?.columns.find(col => col.name === colName);
				const effectiveType = column?.sectionType ?? colName.toLowerCase();
				if (effectiveType === 'dashboard') {
					this.openWidgetTypeModal(colName);
				} else if (effectiveType === 'sticky') {
					// Sticky sections mix memo and todo cards: ask which one to create.
					// (Retired memo/todo section types migrate to sticky at parse time.)
					this.openStickyCardTypeModal(colName);
				} else {
					this.openProjectSearchModal(colName);
				}
			},
			onColumnAdd: (name: string, sectionType?: string) => {
				void this.addColumnWithType(name, sectionType);
			},
			onRequestAddSection: () => this.openAddSectionModal(),
			onMoveCard: (cardId: string, targetCol: string, targetIdx: number) => this.handleMoveCard(cardId, targetCol, targetIdx),
			onCardWidthChange: (cardId: string, width: number) => { if (this.isLayoutLocked()) return; void this.sync.updateCardWidth(cardId, width); },
			onCardSizeChange: (cardId: string, size: string) => { if (this.isLayoutLocked()) return; void this.sync.updateCardSize(cardId, size as import('./types').CardSize); },
			onCardGridChange: (cardId: string, gridCols: number, gridRows: number) => { if (this.isLayoutLocked()) return; void this.sync.updateCardGrid(cardId, gridCols, gridRows); },
			onCardGridMove: (cardId: string, gridCol: number, gridRow: number) => { if (this.isLayoutLocked()) return; void this.sync.updateCardGridMove(cardId, gridCol, gridRow); },
			onColumnRename: (oldName: string, newName: string, columnIndex?: number) => { void this.sync.renameColumn(oldName, newName, columnIndex); },
			onColumnDelete: (columnName: string, columnIndex?: number) => this.deleteColumn(columnName, columnIndex),
			onColumnMove: (fromIndex: number, toIndex: number) => { if (this.isLayoutLocked()) return; void this.sync.moveColumn(fromIndex, toIndex); },
			onColumnMoveBeside: (fromIndex: number, targetIndex: number, side: 'left' | 'right') => { if (this.isLayoutLocked()) return; void this.sync.moveColumnBeside(fromIndex, targetIndex, side); },
			onColumnHeightChange: (name: string, height: number) => { if (this.isLayoutLocked()) return; void this.sync.updateColumnHeight(name, height); },
			onColumnWidthChange: (name: string, widthPct: number) => { if (this.isLayoutLocked()) return; void this.sync.updateColumnWidth(name, widthPct); },
		};
	}

	private sectionCallbacks() {
		/** Section-level actions: template picker, archive, and the two in-place
		 *  config writes. The config writes swallow the echo render themselves (the
		 *  section is repainted right after), which is why they look different from
		 *  the gear-event path in view/board-events.ts: that one comes from a
		 *  header button, this one from inside a section's own filter UI. */
		return {
			onAddFromTemplate: (columnName: string) => this.openTemplatePicker(columnName),
			onArchiveTasks: (columnName: string) => { void archiveCompletedTasks(this.taskWriteHost(), columnName); },
			onLibraryConfigChange: (columnName: string, config: LibraryConfig) => {
			this.suppressNextRender = true;
			void this.sync.updateSectionConfig(columnName, 'libraryConfig', config).then(() => {
				this.refreshSectionInPlace(columnName);
			});
		},
			onDataviewConfigChange: (columnName: string, config: DataviewConfig) => {
				this.suppressNextRender = true;
				void this.sync.updateSectionConfig(columnName, 'dataviewConfig', config).then(() => {
					this.refreshSectionInPlace(columnName);
				});
			},
		};
	}

	private chromeCallbacks() {
		/** Everything around the cards: banner, quick actions/notes, pinned notes,
		 *  commands, skill shortcuts, and opening a note. */
		return {
			onBannerEdit: () => {
				if (this.data) this.openBannerEditModal(this.data);
			},
			onQuickActionAdd: () => this.openAddActionModal(),
			onQuickActionRemove: (index: number) => {
				void showConfirmDialog(this.app, {
					title: t('common.confirmDelete'),
					message: t('common.confirmDeleteMessage'),
				}).then(confirmed => {
					if (confirmed) void this.sync.removeQuickAction(index);
				});
			},
			onQuickNoteCreate: (preset: QuickNotePreset) => void createNoteFromPreset(this.app, preset),
			onQuickNoteCapture: (text: string) => void captureThought(this.app, this.plugin.settings, text),
			onQuickSearchOpen: (file: TFile) => { void this.app.workspace.getLeaf('tab').openFile(file); },
			onOpenPinnedNote: (note: PinnedNote) => openPinnedNote(this.app, note),
			onQuickCommand: (cmd: QuickCommand) => {
				const commands = (this.app as AppWithCommands).commands;
				// Stale id (plugin disabled/uninstalled): warn instead of silently no-op'ing.
				if (!commands.commands[cmd.commandId]) {
					new Notice(t('quickNote.commandNotFound'));
					return;
				}
				commands.executeCommandById(cmd.commandId);
			},
			onSkillShortcut: (shortcut: SkillShortcut) => {
				if (shortcut.directSend) {
					void fireSkillDirect(this.app, shortcut, shortcut.target);
					return;
				}
				new AgentPromptModal(this.app, {
					label: shortcut.label,
					skillName: shortcut.skillName,
					promptTemplate: shortcut.promptTemplate,
				}, shortcut.target, {}).open();
			},
			onQuickNoteDaily: () => void openTodayNote(this.app),
			onQuickNoteConfig: () => new QuickNoteConfigModal(this.app, this.plugin).open(),
		};
	}
	private handleFileDrop(cardId: string, filePath: string): void {
		if (!this.data) return;
		let sectionType = 'projects';
		let cardType = 'generic';
		for (const col of this.data.columns) {
			const card = col.cards.find(c => c.id === cardId);
			if (card) {
				sectionType = col.sectionType ?? col.name.toLowerCase();
				cardType = card.type;
				break;
			}
		}
		if (cardType === 'weather' || cardType === 'tracker') return;
		if (cardType === 'task') {
			void this.sync.addTask(cardId, `[[${filePath}]]`);
		} else if (sectionType === 'sticky' && (cardType === 'generic' || cardType === 'note')) {
			void this.sync.addFileLinkToMemo(cardId, filePath);
		} else {
			void this.sync.addDocToCard(cardId, filePath);
		}
	}

	private async saveMemoAsNote(card: DashboardCard): Promise<void> {
		try {
			const { path, templateMissing } = await createMemoNote(this.app, {
				folder: this.plugin.settings.memoSavePath,
				templatePath: this.plugin.settings.memoTemplatePath,
				card,
				untitled: t('notice.memoUntitled'),
			});
			if (templateMissing) new Notice(t('notice.memoTemplateNotFound'));
			new Notice(t('notice.memoSaved', { path }), 4000);
		} catch (err) {
			console.error('[Dashboard] saveMemoAsNote failed:', err);
			new Notice(t('notice.memoSaveError'), 4000);
		}
	}

	/**
	 * Persist the task-card config modal (gear button) in one pass.
	 *
	 * Completion behavior + heading level ride a single updateCard write. The
	 * "load from today's daily note" toggle keeps the seed-before-flag rule:
	 * enabling drops the card's own task lines from the dashboard file, so the
	 * note must own them first. A heading level change MOVES the existing note
	 * block instead of appending a second copy — see retitleCardBlock.
	 */
	private async applyTaskCardConfig(card: DashboardCard, config: TaskCardConfig): Promise<void> {
		let wantDaily = config.tasksFromDaily;
		const enabling = wantDaily && card.tasksFromDaily !== true;
		if (enabling && !getDailyNotesConfig(this.app)) {
			// Only the daily-note source is refused — the other two settings
			// still apply, so the dialog never silently drops them.
			new Notice(t('notice.dailyNotesDisabled'), 5000);
			wantDaily = card.tasksFromDaily === true;
		}

		const level = config.dailyHeadingLevel;
		const prevLevel = card.dailyHeadingLevel ?? 3;
		// Moving the block beats re-creating it: without this the next mirror
		// write lands under a NEW heading and the old block keeps its tasks,
		// duplicating the list inside the note.
		if (card.tasksFromDaily && level !== prevLevel) {
			const file = todayDailyNote(this.app);
			if (file) {
				try {
					await retitleCardBlock(this.app, file, card.title ?? '', level);
				} catch (err) {
					console.error('[Dashboard] retitle daily block failed:', err);
				}
			}
		}

		if (enabling) {
			// Seed the note before the flag lands, using the freshly picked
			// heading level (that is how the block the card will read is
			// written). Same never-drop-tasks rationale as above.
			const existing = await readCardTasksFromToday(this.app, card.title ?? '', level);
			if (existing === null && card.tasks.length > 0) {
				await writeCardTasksToToday(this.app, card.title ?? '', card.tasks, level);
			}
		}

		await this.sync.updateCard(card.id, {
			taskCompleteBehavior: config.taskCompleteBehavior === 'end' ? undefined : config.taskCompleteBehavior,
			tasksFromDaily: wantDaily ? true : undefined,
			dailyHeadingLevel: level === 3 ? undefined : level,
		});
		if (wantDaily) {
			await this.sync.refreshDailyLinkedTasks();
			if (this.data) this.render(this.data);
		}
	}

	/** Identity of the daily-linked cards' current task lists; null when no
	 *  card is in that mode (nothing to watch). */
	/** Signature over what the card actually SHOWS (text / checked / reminder /
	 *  nesting) — not the raw TaskItem graphs. A note round-trip through
	 *  writeCardTasksToToday → readCardTasksFromToday re-creates the tasks, so
	 *  fields the note cannot carry (collapsed, transient ids) would make our
	 *  own mirror echo look like a change and repaint the whole board. */
	private dailyLinkedTasksSignature(): string | null {
		const cards = (this.data?.columns ?? []).flatMap(col => col.cards).filter(c => c.tasksFromDaily);
		if (cards.length === 0) return null;
		const shape = (tasks: TaskItem[]): unknown[] => tasks.map(task => [
			task.text,
			task.checked,
			task.reminder ?? '',
			shape(task.children ?? []),
		]);
		return JSON.stringify(cards.map(card => [card.id, shape(card.tasks)]));
	}

	/**
	 * Re-read the daily-linked cards after an .md change, re-rendering only when
	 * their task lists actually differ. Covers a hand edit in today's note and
	 * our own mirror writes echoing back through the vault watcher (those arrive
	 * unchanged, so no second paint).
	 */
	private async refreshDailyLinkedCards(): Promise<void> {
		const before = this.dailyLinkedTasksSignature();
		if (before === null) return;
		await this.sync.refreshDailyLinkedTasks();
		if (before !== this.dailyLinkedTasksSignature() && this.data) this.render(this.data);
	}

	private openBannerEditModal(data: DashboardData): void {
		const modal = new BannerEditModal(this.app, data.banner, (updates) => {
			void this.sync.updateBanner(updates);
		});
		modal.open();
	}

	private openCardEditModal(card: DashboardCard): void {
		const modal = new CardEditModal(this.app, card, (updates) => {
			void this.sync.updateCard(card.id, updates);
		});
		modal.open();
	}

	private openNotePopover(file: TFile, subpath?: string, line?: number): void {
		// Close any previously open popover so its embedded leaf is detached
		// before we open a fresh one.
		this.popoverModal?.close();
		const modal = new NotePopoverModal(this.app, file, subpath, line, (edited) => {
			this.onNoteEditedInPopover(edited);
		});
		this.popoverModal = modal;
		modal.open();
	}

	/** A note was edited inside the in-dashboard editor and the modal has
	 *  closed. Its embedded MarkdownView flushes to disk only on close, and
	 *  the surfaces showing that note's tasks hold snapshots taken before it
	 *  opened: the calendar grids paint cells from their last scan, each open
	 *  day agenda paints the list it was opened with, and a dataview card holds
	 *  the result set it queried. The vault-event fan-out cannot be relied on
	 *  either — it debounces 500ms behind the write (so a quick close-then-look
	 *  sees the old text) and skips the dashboard file itself by design. Re-read
	 *  from disk and repaint those surfaces. */
	private onNoteEditedInPopover(file: TFile): void {
		// The editor's write landed without our scan cache seeing it: force the
		// next scan of this note to read the file from disk (bypassing both the
		// mtime cache and the metadata pre-filter, which reindexes lazily).
		invalidatePath(file.path);
		this.refreshCalendarSurfaces();
		// Dataview cards are snapshots and stay off the vault debounce by design,
		// so the card the note was opened from would keep showing the pre-edit
		// rows until a manual refresh. Re-run the ones that show this note; they
		// repaint quietly (no blank, no scan spinner).
		refreshSectionsForPath(file.path);
	}

	/** Repaint the task surfaces that keep a snapshot: the sidebar calendar
	 *  (task dots), every embedded calendar grid (in place), and any open day
	 *  agenda. All three are no-ops when nothing they show changed. */
	private refreshCalendarSurfaces(): void {
		this.refreshSidebarCalendarNow();
		refreshCalendarSections(this.containerEl);
		refreshOpenDayAgendas();
	}

	/** Opens a note on card click. Honors the "disable popover" setting: when
	 *  on, the note opens directly in a tab (no in-dashboard editor).
	 *
	 *  subpath is the raw `#heading` / `#^block` fragment of a wikilink; the
	 *  tab path resolves it via openLinkText, the popover scrolls to it after
	 *  the embedded view is ready. line is a 0-based source line (calendar
	 *  task jumps): the note is revealed at that line in either path.
	 *
	 *  Non-markdown files (canvas whiteboards, base databases, pdf, media) are
	 *  always opened in a real tab — the in-dashboard popover only hosts a
	 *  MarkdownView and would render them broken. */
	private openNote(file: TFile, subpath?: string, line?: number): void {
		if (this.plugin.settings.disableNotePopover || file.extension !== 'md') {
			void this.openNoteInTab(file, subpath, line);
			return;
		}
		this.openNotePopover(file, subpath, line);
	}

	/** Tab-path open with an optional line reveal once the view is active. */
	private async openNoteInTab(file: TFile, subpath?: string, line?: number): Promise<void> {
		await this.app.workspace.openLinkText(subpath ? `${file.path}${subpath}` : file.path, '');
		if (line === undefined) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file?.path === file.path) revealMarkdownLine(view, line);
	}

	private async addColumnWithType(name: string, sectionType?: string): Promise<void> {
		await this.sync.addColumn(name, sectionType);
		if (sectionType === 'library') {
			this.openLibraryConfigModal(name);
		} else if (sectionType === 'folder') {
			this.openFolderConfigModal(name);
		} else if (sectionType === 'weread') {
			this.openWereadConfigModal(name);
		} else if (sectionType === 'dataview') {
			this.openDataviewConfigModal(name);
		} else if (sectionType === 'web') {
			this.openWebConfigModal(name);
		} else if (sectionType === 'rss') {
			this.openRssConfigModal(name);
		} else if (sectionType === 'pipeline') {
			this.openPipelineConfigModal(name);
		} else if (sectionType === 'skills') {
			this.openSkillsConfigModal(name);
		} else if (sectionType === 'pm') {
			this.openPmConfigModal(name);
		}
	}

	private openAddSectionModal(): void {
		if (this.isLayoutLocked()) return;
		// Immersive boards: the "+ 添加卡片" tile opens the card menu —
		// sections through the modal, widgets straight onto the board
		// (per-board membership, independent of the global toggles).
		if (this.data && isImmersiveLayout(this.plugin.settings, this.data)) {
			const root = this.containerEl.children[1] as HTMLElement | undefined;
			const anchor = root?.querySelector<HTMLElement>('.dashboard-imm .dashboard-imm-add-btn')
				?? root?.querySelector<HTMLElement>('.dashboard-imm .dashboard-add-section')
				?? undefined;
			if (anchor) {
				const boardKeys = new Set(this.immItems
					.filter(item => item.id.startsWith('widget:'))
					.map(item => item.id.slice('widget:'.length)));
				openImmersiveAddMenu({
					settings: this.plugin.settings,
					services: {
						pomodoroService: this.pomodoroService ?? undefined,
						readingService: this.readingService ?? undefined,
						holidayData: this.holidayData ?? undefined,
						onOpenNote: (file, line) => this.openNote(file, undefined, line),
						renderQuickActions: (host) => this.renderQuickActionsWidget(host),
					},
					boardKeys,
					anchor,
					onAddSection: () => this.openAddSectionModalInner(),
					onAddNoteCard: kind => void this.addImmersiveNoteCard(kind),
					onAddWidget: key => void this.addImmersiveWidget(key),
					onCreateInstance: kind => this.createImmersiveWidgetInstance(kind),
				});
				return;
			}
		}
		this.openAddSectionModalInner();
	}

	/** Add a memo/todo card to the board. Sticky sections are dissolved on
	 *  immersive boards — the backing column receives the card (created if no
	 *  sticky column exists); the full render turns it into a fresh card
	 *  tile. */
	private async addImmersiveNoteCard(kind: 'memo' | 'todo'): Promise<void> {
		if (!this.data) return;
		const findSticky = () => this.data?.columns.find(col => (col.sectionType ?? '').toLowerCase() === 'sticky');
		let column = findSticky();
		if (!column) {
			await this.sync.addColumn(t('default.stickyName'), 'sticky');
			column = findSticky();
		}
		if (!column) return;
		await this.sync.addCard(column.name, kind === 'todo' ? { type: 'task' as const } : { type: 'generic' as const });
	}

	private openAddSectionModalInner(): void {
		const modal = new AddSectionModal(this.app, (name, sectionType) => {
			void this.addColumnWithType(name, sectionType);
		});
		modal.open();
	}

	/** Append a widget card to this board's arrangement. No suppression: the
	 *  engine echo takes the full-render path (planDashboardUpdate's immersive
	 *  trigger), which mounts the new card through the normal pipeline. */
	private async addImmersiveWidget(key: string): Promise<void> {
		if (!this.data) return;
		try {
			const next = [...this.immItems, {
				id: widgetItemId(key),
				...defaultWidgetSize(key, {
					habit: this.plugin.settings.habitHeightRatio,
					reading: this.plugin.settings.readingHeightRatio,
					albums: this.plugin.settings.albums,
				}),
			}];
			await this.sync.updateImmersive(next);
		} catch (error) {
			// Surface the exact break: the add path was failing silently for
			// the skills widget (nothing written, no feedback).
			console.error('[Dashboard] addImmersiveWidget failed:', key, error);
			new Notice(t('immersive.addWidgetFailed', { message: error instanceof Error ? error.message : String(error) }));
		}
	}

	/** Remove a tile from this board's arrangement (widget membership is the
	 *  arrangement itself; the underlying widget config is untouched). */
	private async removeImmersiveItem(itemId: string): Promise<void> {
		if (this.isLayoutLocked()) return;
		if (!this.data) return;
		const next = this.immItems.filter(item => item.id !== itemId);
		if (next.length === this.immItems.length) return;
		await this.sync.updateImmersive(next);
	}

	/** Create the FIRST instance of an album/countdown/anniversary straight
	 *  from the board's add menu: the family's settings modal opens on a blank
	 *  baseline (the settings tab's add-button pattern), and saving persists
	 *  the instance AND places its card on this board — no settings detour
	 *  needed for the type to become reachable. */
	private createImmersiveWidgetInstance(kind: 'album' | 'countdown' | 'anniversary'): void {
		if (kind === 'countdown') {
			const baseline: CountdownConfig = {
				id: `cd-${Date.now()}`,
				label: '',
				targetDate: '',
				displayMode: 'days',
				reminderDays: 0,
			};
			new CountdownSettingsModal(this.app, baseline, updated => {
				void this.persistWidgetInstance(
					{ ...this.plugin.settings, countdowns: [...(this.plugin.settings.countdowns ?? []), updated] },
					`countdown-${updated.id}`,
				);
			}).open();
			return;
		}
		if (kind === 'album') {
			const baseline: AlbumConfig = {
				id: Date.now(),
				folder: '',
				intervalSec: 8,
				recursive: true,
				ratio: '1:1',
				transition: 'fade',
				heightRatio: 'full',
			};
			new AlbumSettingsModal(this.app, baseline, updated => {
				void this.persistWidgetInstance(
					{ ...this.plugin.settings, albums: [...(this.plugin.settings.albums ?? []), updated] },
					`album-${updated.id}`,
				);
			}).open();
			return;
		}
		const baseline: AnniversaryConfig = {
			id: `av-${Date.now()}`,
			label: '',
			startDate: '',
			calendar: 'solar',
			precision: 'ymd',
			annualReminder: false,
		};
		new AnniversarySettingsModal(this.app, baseline, updated => {
			void this.persistWidgetInstance(
				{ ...this.plugin.settings, anniversaries: [...(this.plugin.settings.anniversaries ?? []), updated] },
				`anniversary-${updated.id}`,
			);
		}).open();
	}

	/** Commit a freshly configured instance to settings (the settings tab's
	 *  applyUpdate pattern) and place its card on this board. */
	private async persistWidgetInstance(nextSettings: DashboardSettings, widgetKey: string): Promise<void> {
		this.plugin.settings = nextSettings;
		await this.plugin.saveSettings();
		this.plugin.refreshAllDashboards();
		void this.addImmersiveWidget(widgetKey);
	}

	/** Everything the section gear / add-card buttons open lives in
	 *  view/config-modals.ts; these forwarders keep the board delegation's call
	 *  sites (and their arguments) unchanged. */
	private modalHost(): ConfigModalHost {
		return {
			app: this.app,
			plugin: this.plugin,
			sync: this.sync,
			data: this.data,
			setPendingScrollColumn: (name) => { this.pendingScrollToLastCardOfColumn = name; },
		};
	}

	private openWidgetTypeModal(colName: string): void { openWidgetTypeModal(this.modalHost(), colName); }

	private openStickyCardTypeModal(colName: string): void { openStickyCardTypeModal(this.modalHost(), colName); }

	private openWeatherConfigModal(colName: string): void { openWeatherConfigModal(this.modalHost(), colName); }

	private openTrackerConfigModal(colName: string): void { openTrackerConfigModal(this.modalHost(), colName); }

	private openTemplatePicker(colName: string): void { openTemplatePicker(this.modalHost(), colName); }

	private openLibraryConfigModal(colName: string): void { openLibraryConfigModal(this.modalHost(), colName); }

	private openDataviewConfigModal(colName: string): void { openDataviewConfigModal(this.modalHost(), colName); }

	private openWebConfigModal(colName: string): void { openWebConfigModal(this.modalHost(), colName); }

	private openRssConfigModal(colName: string): void { openRssConfigModal(this.modalHost(), colName); }

	private dispatchSkillCreate(cfg: SkillCreateConfig): void { dispatchSkillCreate(this.modalHost(), cfg); }

	private openSkillsConfigModal(colName: string): void { openSkillsConfigModal(this.modalHost(), colName); }

	private openPipelineConfigModal(colName: string): void { openPipelineConfigModal(this.modalHost(), colName); }

	private openPmConfigModal(colName: string): void { openPmConfigModal(this.modalHost(), colName); }

	private openMediaConfigModal(colName: string): void { openMediaConfigModal(this.modalHost(), colName); }

	private openWereadConfigModal(colName: string): void { openWereadConfigModal(this.modalHost(), colName); }

	/**
	 * Optimistic card move: rewrite only the affected section(s) in place
	 * instead of letting the default full-board re-render tear down every
	 * section (the source of the long lag and the dragend transform "afterimage"
	 * on memo cards).
	 *
	 * moveCard updates `this.data` synchronously then persists; its
	 * `notifyCallbacks` is suppressed here (one-shot) and the file-watcher's
	 * own reload is a no-op via its serialize-equality check, so no extra
	 * full render fires. We then refresh just the source and target sections.
	 */
	/**
	 * Optimistic card move: physically relocate the dragged card's DOM node
	 * instead of re-rendering. This is zero-cost compared to refreshSectionInPlace
	 * (which rebuilds every memo card — each line re-parsing links, each wikilink
	 * re-resolved against the vault — the real source of the lingering lag).
	 *
	 * DnD listeners are bound per cardEl (setupDragAndDrop attaches dragstart to
	 * each card), so moving a node keeps its listeners intact — no rebind needed.
	 * The dragged card carries a `--dragging` class during the drag (desktop) /
	 * until cleanupDrag (touch); we clear it here in case dragend lands after us.
	 */
	private async handleMoveCard(cardId: string, targetCol: string, targetIdx: number): Promise<void> {
		if (this.isLayoutLocked()) return;
		const kanban = (this.containerEl.children[1] as HTMLElement)?.querySelector<HTMLElement>('.dashboard-kanban');
		const draggedEl = kanban?.querySelector<HTMLElement>(`.dashboard-card[data-card-id="${CSS.escape(cardId)}"]`) ?? null;
		const sourceCol = this.data?.columns.find(c => c.cards.some(card => card.id === cardId))?.name;

		this.suppressNextRender = true;
		try {
			await this.sync.moveCard(cardId, targetCol, targetIdx);
		} catch {
			// moveCard swallows disk I/O itself; guard anything else so a rejection
			// can't desync the UI from this.data.
			this.suppressNextRender = false;
			if (this.data) this.render(this.data);
			return;
		}

		// Cross-section moves change both rendering and column-bound callbacks.
		// Rebuild both rows; merely reordering destination children cannot move
		// a node from the source and leaves stale card type / event closures.
		this.suppressNextRender = false;
		if (sourceCol && sourceCol !== targetCol) {
			const sourceRefreshed = this.refreshSectionInPlace(sourceCol);
			const targetRefreshed = this.refreshSectionInPlace(targetCol);
			if ((!sourceRefreshed || !targetRefreshed) && this.data) this.render(this.data);
			return;
		}

		// Physically reorder the target section's card DOM to match the new data
		// order. If we can't (element missing — e.g. a concurrent full render
		// swapped the tree), fall back to the in-place section refresh, then full.
		const moved = draggedEl && this.reorderCardsInDOM(targetCol);
		if (sourceCol && sourceCol !== targetCol) {
			this.reorderCardsInDOM(sourceCol);
		}
		if (draggedEl) {
			draggedEl.removeClass('dashboard-card--dragging');
		}
		if (!moved) {
			let refreshed = this.refreshSectionInPlace(targetCol);
			if (sourceCol && sourceCol !== targetCol) {
				refreshed = this.refreshSectionInPlace(sourceCol) || refreshed;
			}
			if (!refreshed && this.data) {
				this.render(this.data);
			}
		}
	}

	/**
	 * Reorder the card DOM nodes in one section to match `this.data`'s card
	 * order for that column. Pure DOM shuffle (insertBefore) — no rebuild, so
	 * memo cards keep their already-parsed links and hover bindings. Returns
	 * false if the section's DOM can't be located.
	 */
	private reorderCardsInDOM(columnName: string): boolean {
		if (!this.data) return false;
		const kanban = (this.containerEl.children[1] as HTMLElement)?.querySelector<HTMLElement>('.dashboard-kanban');
		const section = kanban?.querySelector<HTMLElement>(`:scope > [data-column="${CSS.escape(columnName)}"]`);
		const cardsContainer = section?.querySelector<HTMLElement>('.dashboard-section-cards');
		if (!cardsContainer) return false;
		const column = this.data.columns.find(c => c.name === columnName);
		if (!column) return false;

		const existing = new Map<string, HTMLElement>();
		cardsContainer.querySelectorAll<HTMLElement>(':scope > .dashboard-card').forEach(el => {
			const id = el.dataset.cardId;
			if (id) existing.set(id, el);
		});

		// Re-append in data order; remove any drop indicator sitting first.
		cardsContainer.querySelectorAll(':scope > .dashboard-drop-indicator').forEach(el => el.remove());
		let cursor: Node | null = null;
		for (const card of column.cards) {
			const el = existing.get(card.id);
			if (!el) continue;
			if (cursor) {
				if (cursor.nextSibling !== el) cardsContainer.insertBefore(el, cursor.nextSibling);
			} else {
				if (cardsContainer.firstChild !== el) cardsContainer.insertBefore(el, cardsContainer.firstChild);
			}
			cursor = el;
		}
		return true;
	}

	private refreshSectionInPlace(columnName: string): boolean {
		if (!this.data) return false;
		const kanban = (this.containerEl.children[1] as HTMLElement)?.querySelector<HTMLElement>('.dashboard-kanban');
		if (!kanban) return false;
		const oldEl = kanban.querySelector<HTMLElement>(`:scope > [data-column="${CSS.escape(columnName)}"]`);
		if (!oldEl) return false;
		const column = this.data.columns.find(c => c.name === columnName);
		if (!column) return false;
		const callbacks = this.createCallbacks();
		const newEl = renderSection(column, callbacks, this.app, this.data, this.plugin.settings);
		// A section refresh can change its height above the user's current
		// viewport. Preserve scrolling ancestors as well as the section's own
		// scrollers so small controls (such as the Gantt kind cards) do not pull
		// the whole dashboard back to the top when their preferences are saved.
		const ancestorScroll: Array<{ el: HTMLElement; top: number; left: number }> = [];
		let scrollAncestor = oldEl.parentElement;
		while (scrollAncestor) {
			ancestorScroll.push({ el: scrollAncestor, top: scrollAncestor.scrollTop, left: scrollAncestor.scrollLeft });
			scrollAncestor = scrollAncestor.parentElement;
		}
		const viewportScroll = { x: window.scrollX, y: window.scrollY };
		// The rebuilt row starts every internal scroller at 0, which snaps the
		// card deck back to its first card and task lists back to their top —
		// the "page jumps away after finishing an edit" symptom. Carry the old
		// row's scroll positions over the node swap.
		const scrollStates = captureScrollStates(oldEl);
		// Immersive: the tile's grid placement lives inline on the element (the
		// packer wrote it); the fresh node would drop back to auto placement and
		// fly to the end of the grid — carry the placement over too.
		// carryImmersivePlacement also copies the height/min/max triple the fit
		// pass pinned — copying only minHeight (the old hand-rolled set) left
		// the swapped tile unpinned for a frame: the box grew to its content
		// (the internal scrollers need the explicit height to engage), then the
		// next fit snapped it back — the visible "cards flash taller on sort"
		// glitch on library sections whose content overflows the tile.
		const immId = oldEl.getAttribute('data-imm-id');
		if (immId) carryImmersivePlacement(oldEl, newEl);
		oldEl.replaceWith(newEl);
		// The swapped-in node carries no resize grip — re-attach it (the
		// method is idempotent) so the tile keeps its corner handle.
		if (immId && isImmersiveLayout(this.plugin.settings, this.data)) {
			attachImmersiveResizeHandle(newEl, immId, () => this.immItems, next => this.commitImmersiveItems(next));
		}
		restoreScrollStates(newEl, scrollStates);
		const restoreAncestorScroll = (): void => {
			for (const state of ancestorScroll) {
				state.el.scrollTop = state.top;
				state.el.scrollLeft = state.left;
			}
			if (window.scrollX !== viewportScroll.x || window.scrollY !== viewportScroll.y) window.scrollTo(viewportScroll.x, viewportScroll.y);
		};
		restoreAncestorScroll();
		window.requestAnimationFrame(restoreAncestorScroll);
		for (const fn of this.dndCleanupFns) fn();
		this.dndCleanupFns = [];
		setupDragAndDrop(kanban, callbacks, this.dndCleanupFns, { skipSectionGrip: isImmersiveLayout(this.plugin.settings, this.data) });
		// The wipe above also dropped the grid-level tile DnD + menu (their
		// cleanups lived in the same array) — re-wire them on the surviving grid.
		this.rewireImmersiveGridDnD(kanban);
		return true;
	}

	private async openTickTickFilterModal(colName: string): Promise<void> {
		const column = this.data?.columns.find(col => col.name === colName);
		const config = column?.ticktickConfig ?? { view: 'lists' as const };
		const region = this.plugin.settings.ticktickRegion === 'ticktick' ? 'ticktick' : 'dida365';
		const projects = await fetchTickTickProjects(region, this.plugin.settings.ticktickCookie, this.plugin.settings.ticktickDeviceVersion);
		new TickTickFilterModal(this.app, projects, config.hiddenProjects, (hiddenProjects) => {
			this.suppressNextRender = true;
			void this.sync.updateSectionConfig(colName, 'ticktickConfig', { ...config, hiddenProjects }).then(() => {
				this.refreshSectionInPlace(colName);
			});
		}).open();
	}

	private openFolderConfigModal(colName: string): void {
		const column = this.data?.columns.find(col => col.name === colName);
		const libraryConfig = column?.libraryConfig;
		const currentFolders = libraryConfig?.folders ?? [];
		const currentTags = libraryConfig?.filters.find(f => f.property === 'tags')?.values ?? [];
		// Non-tags filters feed the modal's property-filter section; the tags
		// section owns the dedicated tags filter instead.
		const currentPropertyFilters = (libraryConfig?.filters ?? []).filter(f => f.property !== 'tags');
		const currentGroupBy = libraryConfig?.kanbanGroupBy;
		const modal = new FolderConfigModal(
			this.app,
			currentFolders,
			libraryConfig?.excludeFolders,
			currentTags,
			currentGroupBy,
			libraryConfig?.showProperties,
			libraryConfig?.propertyLimit,
			(result) => {
				void this.sync.updateSectionConfig(colName, 'libraryConfig', folderResultToLibraryConfig(libraryConfig, result));
			},
			libraryConfig?.groupMode,
			libraryConfig?.visibleProperties,
			libraryConfig?.kanbanShowCovers,
			sectionTemplatePaths(libraryConfig),
			currentPropertyFilters,
		);
		modal.open();
	}

	/** Notes section settings: show covers, new-note templates + save folder.
	 *  Templates/folder ride the column's libraryConfig; the cover toggle is
	 *  the column's showCover field — both persist in one write. */
	private openNotesSectionConfigModal(colName: string): void {
		const column = this.data?.columns.find(col => col.name === colName);
		if (!column) return;
		const config = column.libraryConfig;
		const modal = new NotesSectionConfigModal(
			this.app,
			{
				templatePaths: sectionTemplatePaths(config),
				folder: (config?.folders ?? [])[0] ?? '',
				showCover: column.showCover !== false,
			},
			(settings) => {
				void this.sync.updateNotesSectionConfig(colName, {
					filters: [],
					viewMode: 'grid',
					sortBy: 'modified',
					sortDesc: true,
					...config,
					templatePaths: settings.templatePaths.length > 0 ? settings.templatePaths : undefined,
					templatePath: settings.templatePaths[0],
					folders: settings.folder ? [settings.folder] : undefined,
				}, settings.showCover);
			},
		);
		modal.open();
	}

	private openAddActionModal(): void {
		const modal = new AddActionModal(this.app, (action) => {
			void this.sync.addQuickAction(action);
		});
		modal.open();
	}

	private openEditActionModal(action: QuickAction): void {
		const index = this.data?.quickActions.findIndex(a => a.target === action.target) ?? -1;
		if (index < 0) return;
		const modal = new AddActionModal(
			this.app,
			(updated) => {
				void this.sync.updateQuickAction(index, { name: updated.name, icon: updated.icon });
			},
			action,
		);
		modal.open();
	}

	private async deleteColumn(columnName: string, columnIndex?: number): Promise<void> {
		if (this.isLayoutLocked()) return;
		const confirmed = await showConfirmDialog(this.app, {
			title: t('common.confirmDelete'),
			message: t('renderer.confirmDeleteSection', { column: columnName }),
		});
		if (!confirmed) return;
		await this.sync.deleteColumn(columnName, columnIndex);
		new Notice(t('renderer.sectionDeleted'));
	}

	private async executeAction(action: QuickAction): Promise<void> {
		if (action.type === 'file') {
			await this.navigateToPath(action.target);
		} else if (action.type === 'command') {
			// Route every command (including 'daily-notes') through Obsidian's command
			// system so the core Daily notes plugin honors its folder/format/template
			// settings. (Previously 'daily-notes' was short-circuited to a root-level
			// file that ignored all of those settings.)
			(this.app as AppWithCommands).commands.executeCommandById(action.target);
		}
	}

	private openProjectSearchModal(colName: string): void {
		const modal = new DocSearchModal(this.app, (link) => {
			void this.sync.addCard(colName, {
				title: link.name,
				body: `[[${link.path}]]`,
			});
		});
		modal.open();
	}

	private async navigateToPath(path: string): Promise<void> {
		let file = this.app.vault.getFileByPath(path);
		if (!file && !path.endsWith('.md')) {
			file = this.app.vault.getFileByPath(`${path}.md`);
		}

		if (!file) {
			const basename = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
			if (basename) {
				const found = this.app.vault.getMarkdownFiles().find(mf => mf.basename === basename);
				if (found) file = found;
			}
		}

		if (file) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			return;
		}

		const folderPath = path.replace(/\/$/, '');
		const abstractFile = this.app.vault.getAbstractFileByPath(folderPath);
		if (abstractFile) {
			const leaves = this.app.workspace.getLeavesOfType('file-explorer');
			if (leaves.length > 0) {
				this.app.workspace.setActiveLeaf(leaves[0]!, { focus: true });
			}
		}
	}

	private registerVaultListeners(): void {
		this.vaultWatcher.register();
	}

	private unregisterVaultListeners(): void {
		this.vaultWatcher.unregister();
	}

	/** Re-scan the sidebar task calendar in place (task dots). The widget DOM
	 *  is preserved across full re-renders, so without this the dots would
	 *  never update. */
	private refreshSidebarCalendarNow(): void {
		if (!this.plugin.settings.widgetCalendarEnabled) return;
		const root = this.containerEl.children[1] as HTMLElement | undefined;
		if (root) refreshSidebarTaskCalendar(root);
	}

	/** Re-scan the album folders in place via the widget's controller: an
	 *  unchanged path list leaves the slideshow position and timer untouched. */
	private refreshAlbumWidgetsNow(): void {
		const albums = this.plugin.settings.albums ?? [];
		if (!albums.some(a => a.folder.trim())) return;
		const root = this.containerEl.children[1] as HTMLElement | undefined;
		if (root) refreshAlbumWidgets(root, albums, this.app);
	}

	/** Cancel the stats-banner debounce (own timer, kept next to the banner
	 *  code). The vault watcher calls this on teardown. */
	private cancelBannerStatsDebounce(): void {
		if (this.bannerStatsTimer) {
			window.clearTimeout(this.bannerStatsTimer);
			this.bannerStatsTimer = null;
		}
	}

	// Sidebar widget data changed from another surface (service event, or a
	// network payload landing after first paint): repaint just that widget.
	// The triggers + the swap mechanics live in view/widget-refresh.ts.
	private onMusicChanged(): void {
		refreshMusicInPlace(this.widgetRefreshHost());
	}

	private onHabitChanged(): void {
		refreshHabitInPlace(this.widgetRefreshHost());
	}

	private onExpenseChanged(): void {
		refreshExpenseInPlace(this.widgetRefreshHost());
	}

	private onPomodoroDataChanged(): void {
		refreshPomodoroInPlace(this.widgetRefreshHost(), this.pomodoroService);
	}

	private onReadingDataChanged(): void {
		refreshReadingInPlace(this.widgetRefreshHost(), this.readingService);
	}

	private refreshLunarWidgetsInPlace(): void {
		refreshLunarInPlace(this.widgetRefreshHost());
	}

	/** Persist a pomodoro background picked inside the widget's palette and
	 *  repaint every board — it is a global setting, not a per-card style. */
	private applyPomodoroBackground(bg: WidgetBackground | undefined): void {
		this.plugin.settings = { ...this.plugin.settings, pomodoroBackground: bg };
		void this.plugin.saveSettings();
		this.plugin.refreshAllDashboards();
	}

	/** The view's side of `NewNoteHost`, built once. `data()` and `sync()` are
	 *  late-bound: a request can arrive after a board switch. */
	private newNoteHost(): NewNoteHost {
		this.newNote ??= {
			app: this.app,
			data: () => this.data,
			sync: () => this.sync,
			libraryNewNotePath: () => this.plugin.settings.libraryNewNotePath,
			openNotePopover: file => this.openNotePopover(file),
			refreshSectionInPlace: name => this.refreshSectionInPlace(name),
		};
		return this.newNote;
	}

	/** The view's side of `MobilePanelHost`, built once. Mutable values are
	 *  getters — a tap can arrive long after the settings changed. */
	private mobilePanelHost(): MobilePanelHost {
		this.mobilePanel ??= {
			app: this.app,
			state: this.mobilePanelState,
			settings: () => this.plugin.settings,
			data: () => this.data,
			root: () => this.containerEl.children[1] as HTMLElement | undefined,
			holiday: () => this.holidayData,
			pomodoro: () => this.pomodoroService,
			reading: () => this.readingService,
			sync: () => this.sync,
			openNote: (file, line) => this.openNote(file, undefined, line),
			executeAction: action => void this.executeAction(action),
			navigateToPath: path => { void this.navigateToPath(path); },
			openAddActionModal: () => this.openAddActionModal(),
			applyPomodoroBackground: bg => this.applyPomodoroBackground(bg),
		};
		return this.mobilePanel;
	}

	/** The view's side of `TaskWriteHost`, built once. `data()` and `sync()`
	 *  are late-bound: a click can land after a board switch. */
	private taskWriteHost(): TaskWriteHost {
		this.taskWrites ??= {
			app: this.app,
			data: () => this.data,
			settings: () => this.plugin.settings,
			sync: () => this.sync,
		};
		return this.taskWrites;
	}

	/** The view's side of `ChangeScopeHost`, built once. `kanban()` and
	 *  `data()` are late-bound: a vault event can arrive mid-board-switch. */
	private changeScopeHost(): ChangeScopeHost {
		this.changeScope ??= {
			app: this.app,
			data: () => this.sync.getData(),
			settings: () => this.plugin.settings,
			kanban: () => (this.containerEl.children[1] as HTMLElement | undefined)
				?.querySelector('.dashboard-kanban') as HTMLElement | null,
			callbacks: () => this.createCallbacks(),
			hoverParent: () => this,
			refreshSectionInPlace: name => this.refreshSectionInPlace(name),
			fullRender: data => this.render(data),
			rewireAfterSwap: (kanban, immersive, callbacks) => this.rewireAfterSwap(kanban, immersive, callbacks),
		};
		return this.changeScope;
	}

	/** Swapped sections came back as new DOM: their grip/card drags are gone,
	 *  so re-wire across the whole kanban. `dndCleanupFns` is wiped first or
	 *  the old (dead) listeners would be re-run on the next pass. */
	private rewireAfterSwap(kanban: HTMLElement, immersive: boolean, callbacks: RenderCallbacks): void {
		for (const fn of this.dndCleanupFns) fn();
		this.dndCleanupFns = [];
		setupDragAndDrop(kanban, callbacks, this.dndCleanupFns, { skipSectionGrip: immersive });
		// The wipe above also dropped the immersive grid's whole-tile move-drag
		// + context menu (same cleanup array) — re-wire them, or the board
		// looks normal yet tiles can't be dragged until a full re-render.
		this.rewireImmersiveGridDnD(kanban);
		if (immersive) this.attachImmersiveResizeHandles(kanban);
	}

	/** The view's side of `WidgetRefreshHost`, built once. Every field is a
	 *  getter over live state, so a service event always sees the current
	 *  settings and the holiday map as it stands (it may still be empty). */
	private widgetRefreshHost(): WidgetRefreshHost {
		this.widgetHost ??= {
			app: this.app,
			root: () => this.containerEl.children[1] as HTMLElement | undefined,
			settings: () => this.plugin.settings,
			data: () => this.data,
			holiday: () => this.holidayData,
			expandedMobileWidget: () => this.mobilePanelState.expanded,
			immItems: () => this.immItems,
			commitImmersiveItems: next => this.commitImmersiveItems(next),
			removeImmersiveItem: itemId => this.removeImmersiveItem(itemId),
			applyPomodoroBackground: bg => this.applyPomodoroBackground(bg),
			refreshBannerStats: () => this.debouncedRefreshBannerStats(),
		};
		return this.widgetHost;
	}

	/** Recompute the stats banner in place (only when in stats mode). Vault
	 *  changes are the trigger; debounced so a burst of edits costs one pass.
	 *  Refresh regardless of whether a statsConfig is saved — defaults resolve
	 *  at render time, so an absent config must not skip the refresh (that would
	 *  freeze the stats after first paint). */
	private debouncedRefreshBannerStats(): void {
		if (!this.data || this.data.banner.mode !== 'stats') return;
		if (this.bannerStatsTimer) window.clearTimeout(this.bannerStatsTimer);
		this.bannerStatsTimer = window.setTimeout(() => {
			const el = this.bannerStatsEl;
			if (el && el.isConnected) {
				refreshBannerStats(el, this.data!.banner.statsConfig, this.app);
			}
		}, this.BANNER_STATS_DEBOUNCE);
	}

	private refreshRecentDocs(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		if (!root) return;

		const recentSection = root.querySelector('.dashboard-recent');
		if (!recentSection) return;

		const parent = recentSection.parentElement;
		if (!parent) return;

		recentSection.remove();
		const docs = getRecentDocs(this.app, this.plugin.settings.recentDocCount);
		renderRecentDocs(parent, docs, (path) => { void this.navigateToPath(path); });
	}

	/** Tear down per-render resources. With `preserveSidebarWidgets`, the sidebar
	 *  widgets DOM is being re-attached (signature unchanged): its countdown
	 *  timers and the pomodoro/reading services' onTick wiring (which reference
	 *  live DOM inside it) must survive; a fresh widgets render re-wires them. */
	private runCleanup(preserve: PreserveScope = null): void {
		destroyAllCharts(preserve);
		destroyAlbumWidgets(preserve);
		destroyAnniversaryTimers(preserve);
		if (!preserve) {
			if (this.pomodoroService) {
				this.pomodoroService.setOnTick(null);
				this.pomodoroService.setOnComplete(null);
			}
			if (this.readingService) {
				this.readingService.setOnTick(null);
			}
		}
		for (const fn of this.cleanupFns) fn();
		this.cleanupFns = [];
		for (const fn of this.dndCleanupFns) fn();
		this.dndCleanupFns = [];
	}

	private renderScrollToTop(container: HTMLElement): void {
		renderScrollToTop(container, (fn) => this.cleanupFns.push(fn));
	}

	private startReminderChecker(): void {
		this.reminderTimer = startReminderScan(() => this.checkReminders());
	}

	private stopReminderChecker(): void {
		stopInterval(this.reminderTimer);
		this.reminderTimer = null;
	}

	private startWeatherRefresh(): void {
		this.weatherRefreshTimer = startWeatherTick({
			app: this.app,
			data: () => this.data,
			settings: () => this.plugin.settings,
			rootEl: () => this.containerEl.children[1] as HTMLElement | undefined,
		});
	}

	private stopWeatherRefresh(): void {
		stopWeatherTick(this.weatherRefreshTimer);
		this.weatherRefreshTimer = null;
	}

	private startDayRolloverChecker(): void {
		this.dayRolloverTimer = startRolloverTick(() => this.checkDayRollover());
	}

	private stopDayRolloverChecker(): void {
		stopInterval(this.dayRolloverTimer);
		this.dayRolloverTimer = null;
	}

	private checkDayRollover(): void {
		if (!this.data) return;
		const todayKey = new Date().toDateString();
		if (todayKey === this.lastRenderedDay) return;

		this.lastRenderedDay = todayKey;
		// Invalidate the widget signature so the preserved widgets DOM is rebuilt:
		// date-dependent widgets (lunar, year progress, countdown values, task
		// calendar) must recompute for the new day.
		this.sidebarWidgetsSig = null;
		this.render(this.data);
	}

	private checkReminders(): void {
		checkReminders({
			app: this.app,
			data: this.data,
			settings: this.plugin.settings,
			fired: this.firedReminders,
			editTaskReminder: (cardId, taskPath, reminder) => {
				void this.sync.editTaskReminder(cardId, taskPath, reminder);
			},
		});
	}
}
