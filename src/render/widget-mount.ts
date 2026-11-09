/**
 * Sidebar widget mounting: which widget renders where, the strip's signature
 * (so a re-render can reuse the DOM instead of rebuilding it), the entry table
 * for every widget kind, and drag-reorder within the strip.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). This is the
 * only place that knows the full widget catalogue; the widgets themselves live
 * in their own top-level modules, and the three that hold live state moved to
 * render/sidebar-widgets.ts.
 */
import { App, Platform, TFile } from 'obsidian';
import type { DashboardSettings } from '../types';
import { getLocale, getLanguage } from '../i18n';
import { isAccentLight } from './color';
import type { HolidayInfo } from '../holiday-service';
import type { PomodoroService } from '../pomodoro-service';
import type { ReadingService } from '../reading-service';
import { effectiveLayout, isImmersiveMode } from '../immersive-grid';
import { RATIO_SPAN, buildStackedSpanSpecs, resolveStackedSpans, isTieredWidgetKey } from '../widget-span';
import { applyWidgetBackground, appendInlineBackgroundButton, getWidgetPlugin } from '../widget-background';
import { renderSidebarLunarWidget } from '../lunar-widget';
import { renderSidebarYearProgress } from '../year-progress-widget';
import { renderSidebarCalendar } from '../calendar-widget';
import { renderSidebarHabitWidget } from '../habit-widget';
import { renderSidebarSkillWidget, skillWidgetSig } from '../skill-widget';
import { renderSidebarQuickCaptureWidget, renderSidebarFileSearchWidget } from '../capture-search-widgets';
import { renderSidebarExpenseWidget } from '../expense-widget';
import { renderSidebarAlbumWidget } from '../album-widget';
import { renderSidebarAnniversaryWidget } from '../anniversary-widget';
import { renderSidebarMusicWidget } from '../music-widget';
import { renderSidebarReading } from './sidebar-reading';
import { renderSidebarWeather, renderSidebarPomodoro, renderSidebarCountdown } from './sidebar-widgets';

// ===== Sidebar Widget Rendering =====

export function renderSidebarWeekCalendar(container: HTMLElement): void {
	// Reuse the existing calendar node so cross-day refreshes don't grow the DOM.
	let row = container.querySelector<HTMLElement>('.dashboard-sidebar-week-calendar');
	if (row) {
		row.empty();
	} else {
		row = container.createDiv({ cls: 'dashboard-sidebar-week-calendar' });
	}

	const now = new Date();
	const today = now.getDay();
	const mondayOffset = today === 0 ? -6 : 1 - today;
	const monday = new Date(now);
	monday.setDate(now.getDate() + mondayOffset);

	const lang = getLocale();
	const accentLight = isAccentLight();

	for (let i = 0; i < 7; i++) {
		const d = new Date(monday);
		d.setDate(monday.getDate() + i);
		const isToday = d.toDateString() === now.toDateString();

		const cell = row.createDiv({
			cls: 'dashboard-sidebar-week-cell'
				+ (isToday ? ' dashboard-sidebar-week-cell--today' : '')
				+ (isToday && accentLight ? ' dashboard-sidebar-week-cell--today-on-light' : ''),
		});
		cell.createDiv({
			cls: 'dashboard-sidebar-week-day',
			text: d.toLocaleDateString(lang, { weekday: 'narrow' }),
		});
		cell.createDiv({
			cls: 'dashboard-sidebar-week-date',
			text: String(d.getDate()),
		});
	}
}

/** The effective board layout. Layout is PER-WORKSPACE: the board file's
 *  `layout:` frontmatter overrides the global default (settings.layoutMode),
 *  so two workspaces can run different layouts. Phones are always excluded:
 *  their layout is CSS-fixed and must not change shape because a desktop-only
 *  setting flipped — they always resolve to 'side'. Every layout branch
 *  funnels through this one helper (or isStackedLayout below) so the gate can
 *  never drift. */
export function resolveEffectiveLayout(
	settings: import('../types').DashboardSettings,
	data?: import('../types').DashboardData | null,
): import('../types').DashboardLayoutMode {
	return effectiveLayout(data?.layout ?? settings.layoutMode, Platform.isPhone);
}

/** True for BOTH immersive tones (dark glass and light glass). The immersive
 *  family shares one render pipeline, so every branch tests this instead of
 *  comparing against the 'immersive' literal. */
export function isImmersiveLayout(
	settings: import('../types').DashboardSettings,
	data?: import('../types').DashboardData | null,
): boolean {
	return isImmersiveMode(resolveEffectiveLayout(settings, data));
}

/** True when the board should render top-bottom (widget strip under the
 *  banner). Convenience view over resolveEffectiveLayout for the many
 *  side/stacked binary branches; the immersive layout takes its own path
 *  before these branches. */
export function isStackedLayout(
	settings: import('../types').DashboardSettings,
	data?: import('../types').DashboardData | null,
): boolean {
	return resolveEffectiveLayout(settings, data) === 'stacked';
}

/** Fingerprint of every input the sidebar widgets depend on. The view compares
 *  it across full re-renders: when unchanged, the previous widgets DOM is
 *  re-attached instead of rebuilt (see renderSidebarWidgets), so dashboard data
 *  mutations (card moves, section edits, ...) never churn the widgets. */
export function sidebarWidgetSignature(
	settings: import('../types').DashboardSettings,
	hasPomodoro: boolean,
	hasReading: boolean,
	hasHolidayData: boolean,
	quickActionsSig: string,
	data?: import('../types').DashboardData | null,
): string {
	return JSON.stringify({
		// The stacked widget area has a different internal structure (quick
		// actions card pinned leftmost + column-major strip wrapper) and the
		// immersive grid re-parents cards one per tile, so ANY layout switch
		// must rebuild rather than re-attach the previous mode's DOM.
		layout: resolveEffectiveLayout(settings, data),
		weatherEnabled: settings.widgetWeatherEnabled,
		weatherCity: settings.widgetWeatherCity,
		weatherLat: settings.widgetWeatherLat,
		weatherLon: settings.widgetWeatherLon,
		skillsWidgetEnabled: settings.widgetSkillsEnabled,
		skillsWidgetSig: skillWidgetSig(settings.skillWidgetButtons ?? []),
		pomodoroEnabled: settings.pomodoroEnabled,
		pomodoroLongBreakInterval: settings.pomodoroLongBreakInterval,
		// Stopwatch mode changes the widget's chrome (bell key, dots, labels)
		// and the reminder setting the bell's icon/title — both must rebuild.
		pomodoroMode: settings.pomodoroMode,
		pomodoroStopwatchReminderMinutes: settings.pomodoroStopwatchReminderMinutes,
		lunarEnabled: settings.widgetLunarEnabled,
		yearProgressEnabled: settings.widgetYearProgressEnabled,
		calendarEnabled: settings.widgetCalendarEnabled,
		calendarExcludeFolders: settings.calendarExcludeFolders,
		habitEnabled: settings.widgetHabitEnabled,
		// Tier settings must break the reuse signature: they change the stacked
		// grid spans, which are written as inline CSS variables at build time.
		// (sidebarWidth / widgetUnitHeight deliberately stay OUT — those apply
		// as plain CSS variables on the outer sidebar every render and must not
		// churn the widgets DOM.)
		habitHeightRatio: settings.habitHeightRatio,
		readingHeightRatio: settings.readingHeightRatio,
		expenseEnabled: settings.widgetExpenseEnabled,
		expenseCurrency: settings.expenseCurrency,
		albums: settings.albums ?? [],
		quickActionsBackground: settings.quickActionsBackground,
		pomodoroBackground: settings.pomodoroBackground,
		habitBackground: settings.habitBackground,
		musicBackground: settings.musicBackground,
		yearProgressBackground: settings.yearProgressBackground,
		anniversaryEnabled: settings.anniversaryEnabled,
		anniversaries: settings.anniversaries ?? [],
		// Playlist content itself must NOT enter the signature: every add would
		// rebuild the whole widget area. The service subscription refreshes it
		// in place instead; only the enable flag matters here. Phones have no
		// sidebar widget area; tablets share the desktop layout.
		musicEnabled: settings.widgetMusicEnabled && !Platform.isPhone,
		countdownEnabled: settings.countdownEnabled,
		countdowns: settings.countdowns,
		readingEnabled: settings.readingEnabled,
		quickActionsEnabled: settings.widgetQuickActionsEnabled,
		quickCaptureWidgetEnabled: settings.widgetQuickCaptureEnabled,
		fileSearchWidgetEnabled: settings.widgetFileSearchEnabled,
		// Quick buttons live inside the widget area now; their content (actions,
		// order, hidden presets) must break the reuse signature so add/remove/edit
		// rebuilds the area instead of re-attaching a stale quick-actions DOM.
		quickActionsSig,
		widgetOrder: settings.widgetOrder,
		hasPomodoro,
		hasReading,
		hasHolidayData,
		lang: getLanguage(),
	});
}

/** Render the sidebar widgets area. When `reuse` carries the widgets element
 *  detached from a previous render AND the widget signature is unchanged (the
 *  caller's responsibility), that element is re-attached as-is - listeners,
 *  countdown timers, pomodoro/reading service wiring and the task calendar's
 *  navigation state all survive the surrounding full re-render.
 *  Returns the widgets area element (reused or fresh), or null when no widget
 *  is enabled. */

/** Persist a singleton widget's background straight from the card's config
 *  button (plugin reached via the app service locator — the same idiom the
 *  countdown settings button uses). */
function saveSingletonBackground(
	app: App,
	key: 'quickActionsBackground' | 'pomodoroBackground' | 'habitBackground' | 'musicBackground' | 'yearProgressBackground',
	bg: import('../types').WidgetBackground | undefined,
): void {
	const plugin = getWidgetPlugin(app);
	if (!plugin) return;
	plugin.settings = { ...plugin.settings, [key]: bg };
	void plugin.saveSettings();
	plugin.refreshAllDashboards();
}

export function renderSidebarWidgets(
	container: HTMLElement,
	settings: import('../types').DashboardSettings,
	app: App,
	pomodoroService?: PomodoroService,
	readingService?: ReadingService,
	holidayData?: Record<string, HolidayInfo>,
	onWidgetReorder?: (order: string[]) => void,
	reuse?: HTMLElement | null,
	onOpenNote?: (file: TFile, line?: number) => void,
	renderQuickActions?: (container: HTMLElement) => void,
	data?: import('../types').DashboardData | null,
): HTMLElement | null {
	const anyEnabled = settings.widgetWeatherEnabled || settings.pomodoroEnabled || settings.widgetLunarEnabled || settings.widgetYearProgressEnabled || settings.widgetCalendarEnabled || settings.widgetHabitEnabled || settings.widgetExpenseEnabled || (settings.albums?.length ?? 0) > 0 || (settings.anniversaryEnabled && (settings.anniversaries?.length ?? 0) > 0) || (settings.countdownEnabled && (settings.countdowns?.length ?? 0) > 0) || settings.readingEnabled || (settings.widgetQuickActionsEnabled && !!renderQuickActions) || settings.widgetQuickCaptureEnabled || settings.widgetFileSearchEnabled || (settings.widgetMusicEnabled && !Platform.isPhone);
	if (!anyEnabled) return null;

	const stacked = isStackedLayout(settings, data);
	// Unchanged inputs: keep the previous DOM (and its live timers/listeners).
	// The layout marker check is local defense-in-depth on top of the caller's
	// signature gate: a side-built area (flat children) must never re-attach
	// into a stacked render (strip wrapper expected) or vice versa, even if a
	// future caller forgets to include the layout in its signature. The
	// immersive layout never calls this builder (its grid mounts cards one per
	// tile via buildWidgetEntries), so 'immersive' never matches here either.
	if (reuse && reuse.isConnected === false && reuse.childElementCount > 0
		&& reuse.dataset.layout === (stacked ? 'stacked' : 'side')) {
		container.appendChild(reuse);
		return reuse;
	}

	const widgetArea = container.createDiv({ cls: 'dashboard-sidebar-widgets' });
	widgetArea.dataset.layout = stacked ? 'stacked' : 'side';

	const ordered = sortWidgetEntries(
		buildWidgetEntries(settings, app, { pomodoroService, readingService, holidayData, onOpenNote, renderQuickActions }),
		settings,
	);

	// Stacked mode: quick actions is a regular card in the strip grid, always
	// FIRST in the build order = leftmost column (it also exits the reorder
	// system there, so the pinned position is deterministic). The saved drag
	// order is untouched and still rules the side layout. The strip wrapper is
	// created lazily on the first widget, so an empty enable set never gets a
	// stray container.
	const buildOrder = stacked
		? [...ordered.filter(e => e.key === 'quickActions'), ...ordered.filter(e => e.key !== 'quickActions')]
		: ordered;
	let stripRow: HTMLElement | null = null;
	const hostFor = (_key: string): HTMLElement => {
		if (!stacked) return widgetArea;
		stripRow ??= widgetArea.createDiv({ cls: 'dashboard-sidebar-widgets-row' });
		return stripRow;
	};

	// Stacked-mode height ratios: rows of the 6-row widget grid per fraction.
	// Adaptive column packing ("首选档 + 放不下自动换挡"): simulate the sparse
	// column-first grid over the DOM order and resolve each TIERED card's
	// span (habit / reading / album-*). Fixed cards keep their hardcoded
	// per-type CSS spans; tiered cards get the resolved span inline as
	// --db-widget-span, which their CSS rule reads with a historical fallback.
	const spans = stacked
		? resolveStackedSpans(buildStackedSpanSpecs(buildOrder.map(e => e.key), {
			// Explicit mapping: the settings field names (habitHeightRatio)
			// differ from the StackedRatios shape, and a whole-settings pass
			// would type-check (all-optional interface) while silently reading
			// undefined -> default tiers.
			habit: settings.habitHeightRatio,
			reading: settings.readingHeightRatio,
			albums: settings.albums,
		}))
		: null;

	for (let i = 0; i < buildOrder.length; i++) {
		const entry = buildOrder[i]!;
		const host = hostFor(entry.key);
		const el = mountWidgetCard(entry, host, app, settings);
		if (el && spans && isTieredWidgetKey(entry.key)) {
			el.setCssProps({ '--db-widget-span': String(spans[i] ?? RATIO_SPAN.full) });
		}
	}

	if (onWidgetReorder) {
		setupWidgetDnD(widgetArea, ordered.map(e => e.key), onWidgetReorder, stacked);
	}
	return widgetArea;
}

type WidgetEntry = { key: string; render: (host: HTMLElement) => void };

/** Services/callbacks the widget card builders may need — injected so the
 *  immersive grid can mount the same cards without a DashboardView. */
export interface WidgetBuildDeps {
	pomodoroService?: PomodoroService;
	readingService?: ReadingService;
	holidayData?: Record<string, HolidayInfo>;
	onOpenNote?: (file: TFile, line?: number) => void;
	renderQuickActions?: (container: HTMLElement) => void;
}

export const DEFAULT_WIDGET_ORDER: string[] = ['quickActions', 'quickCapture', 'fileSearch', 'lunar', 'weather', 'pomodoro', 'reading', 'countdown', 'anniversary', 'yearProgress', 'calendar', 'habit', 'expense', 'skills', 'album', 'music'];

/** Build one entry per ENABLED widget card (enable order, not display order).
 *  Shared by the side/stacked rail (renderSidebarWidgets) and the immersive
 *  grid, so both layouts mount byte-identical cards.
 *
 *  `memberKeys` switches the membership SOURCE: side/stacked boards follow the
 *  global settings toggles (undefined); immersive boards pass the keys listed
 *  in that workspace's arrangement — widget membership there is per-board,
 *  managed in the UI, independent of the global switches. */
export function buildWidgetEntries(settings: DashboardSettings, app: App, deps: WidgetBuildDeps, memberKeys?: Set<string>): WidgetEntry[] {
	const { pomodoroService, readingService, holidayData, onOpenNote, renderQuickActions } = deps;
	// member?: undefined = global-toggle mode; boolean = membership mode.
	const member = (key: string, globallyEnabled: boolean): boolean =>
		memberKeys ? memberKeys.has(key) : globallyEnabled;
	const enabled: WidgetEntry[] = [];
	if (member('quickActions', settings.widgetQuickActionsEnabled) && renderQuickActions) {
		const renderQuick = renderQuickActions;
		enabled.push({ key: 'quickActions', render: (host) => { renderQuick(host); } });
	}
	// Quick-input widgets (the quick-note bar's box is capture-OR-search; one
	// card each covers users who want both at once).
	if (member('quickCapture', settings.widgetQuickCaptureEnabled)) {
		enabled.push({ key: 'quickCapture', render: (host) => renderSidebarQuickCaptureWidget(host, app, settings) });
	}
	if (member('fileSearch', settings.widgetFileSearchEnabled)) {
		enabled.push({ key: 'fileSearch', render: (host) => renderSidebarFileSearchWidget(host, app) });
	}
	if (member('lunar', settings.widgetLunarEnabled)) {
		enabled.push({ key: 'lunar', render: (host) => renderSidebarLunarWidget(host, holidayData ?? {}, app) });
	}
	if (member('yearProgress', settings.widgetYearProgressEnabled)) {
		enabled.push({ key: 'yearProgress', render: (host) => renderSidebarYearProgress(host, settings.yearProgressBackground, app, bg => saveSingletonBackground(app, 'yearProgressBackground', bg)) });
	}
	if (member('calendar', settings.widgetCalendarEnabled)) {
		enabled.push({ key: 'calendar', render: (host) => renderSidebarCalendar(host, settings, app, onOpenNote) });
	}
	if (member('weather', settings.widgetWeatherEnabled)) {
		enabled.push({ key: 'weather', render: (host) => renderSidebarWeather(host, settings, app) });
	}
	if (member('pomodoro', settings.pomodoroEnabled) && pomodoroService) {
		enabled.push({ key: 'pomodoro', render: (host) => renderSidebarPomodoro(host, pomodoroService, settings, app, bg => saveSingletonBackground(app, 'pomodoroBackground', bg)) });
	}
	if (member('reading', settings.readingEnabled) && readingService) {
		enabled.push({ key: 'reading', render: (host) => renderSidebarReading(host, readingService) });
	}
	if (member('habit', settings.widgetHabitEnabled)) {
		enabled.push({ key: 'habit', render: (host) => renderSidebarHabitWidget(host, app, settings.habitBackground, bg => saveSingletonBackground(app, 'habitBackground', bg)) });
	}
	if (member('expense', settings.widgetExpenseEnabled)) {
		enabled.push({ key: 'expense', render: (host) => renderSidebarExpenseWidget(host, app) });
	}
	if (member('skills', settings.widgetSkillsEnabled)) {
		enabled.push({ key: 'skills', render: (host) => renderSidebarSkillWidget(host, app, settings) });
	}
	// Multiple album widgets: one card per albums[] entry, keyed album-<id>.
	// renderSidebarAlbumWidget reads the legacy flat fields, so each entry
	// renders through a per-album settings shim (spread — never mutated).
	for (const cfg of settings.albums ?? []) {
		const ref = cfg;
		if (memberKeys && !memberKeys.has(`album-${ref.id}`)) continue;
		enabled.push({
			key: `album-${ref.id}`,
			render: (host) => renderSidebarAlbumWidget(host, {
				...settings,
				widgetAlbumFolder: ref.folder,
				widgetAlbumIntervalSec: ref.intervalSec,
				widgetAlbumRecursive: ref.recursive,
				widgetAlbumRatio: ref.ratio,
				widgetAlbumTransition: ref.transition,
			}, app),
		});
	}
	// Anniversary widgets: one card per anniversaries[] entry, keyed
	// anniversary-<id> (the countdown multi-instance pattern). The master
	// toggle only rules in global mode; membership mode decides per instance.
	if (memberKeys || settings.anniversaryEnabled) {
		for (const cfg of settings.anniversaries ?? []) {
			const ref = cfg;
			if (memberKeys && !memberKeys.has(`anniversary-${ref.id}`)) continue;
			enabled.push({ key: `anniversary-${ref.id}`, render: (host) => renderSidebarAnniversaryWidget(host, ref, app, updated => {
			const plugin = getWidgetPlugin(app);
			if (!plugin) return;
			plugin.settings = {
				...plugin.settings,
				anniversaries: (plugin.settings.anniversaries ?? []).map(a => a.id === updated.id ? updated : a),
			};
			void plugin.saveSettings();
			plugin.refreshAllDashboards();
		}) });
		}
	}
	if (member('music', settings.widgetMusicEnabled) && !Platform.isPhone) {
		enabled.push({ key: 'music', render: (host) => renderSidebarMusicWidget(host, settings.musicBackground, app, bg => saveSingletonBackground(app, 'musicBackground', bg)) });
	}
	// Countdown: same master-toggle vs per-instance-membership split.
	if (memberKeys || settings.countdownEnabled) {
		for (const cd of settings.countdowns ?? []) {
			const cdRef = cd;
			if (memberKeys && !memberKeys.has(`countdown-${cd.id}`)) continue;
			enabled.push({ key: `countdown-${cd.id}`, render: (host) => renderSidebarCountdown(host, cdRef, app) });
		}
	}
	return enabled;
}

/** Sort entries into display order. Legacy: an order saved before quick
 *  buttons were a widget lacks the 'quickActions' key — it keeps its
 *  historical first spot until the user drags it elsewhere. */
export function sortWidgetEntries(entries: WidgetEntry[], settings: DashboardSettings): WidgetEntry[] {
	const order = settings.widgetOrder?.length ? settings.widgetOrder : DEFAULT_WIDGET_ORDER;
	return sortByOrder(entries, order);
}

/** Mount one widget card into `host` and stamp it (data-widget-key, the
 *  quick-actions widget classes/background gear, the album instance id).
 *  Returns the card element, or null when the builder attached nothing
 *  (defensive — every builder appends exactly one child). */
export function mountWidgetCard(entry: WidgetEntry, host: HTMLElement, app: App, settings: DashboardSettings): HTMLElement | null {
	const childCount = host.children.length;
	entry.render(host);
	const el = host.children[childCount] as HTMLElement | undefined;
	if (!el) return null;
	const key = entry.key;
	el.dataset.widgetKey = key;
	// The quick-actions section carries its own section classes; give it
	// the widget class too so it joins the drag-to-reorder system.
	if (key === 'quickActions') {
		el.addClass('dashboard-sidebar-widget');
		// Card background + config gear INSIDE the header's button group
		// (left of palette/add) — a corner button would overlap them.
		applyWidgetBackground(el, settings.quickActionsBackground, app, { skipFrame: true });
		const btnGroup = el.querySelector<HTMLElement>('.dashboard-qa-btn-group');
		if (btnGroup) {
			const gear = appendInlineBackgroundButton(btnGroup, app, settings.quickActionsBackground,
				bg => saveSingletonBackground(app, 'quickActionsBackground', bg));
			btnGroup.insertBefore(gear, btnGroup.firstChild);
		}
	}
	// Album cards carry their config id (the multi-instance refresh
	// matches on it).
	if (key.startsWith('album-')) {
		const cfg = (settings.albums ?? []).find(a => String(a.id) === key.slice('album-'.length));
		if (cfg) el.dataset.albumId = String(cfg.id);
	}
	return el;
}

function sortByOrder(items: WidgetEntry[], order: string[]): WidgetEntry[] {
	const orderMap = new Map(order.map((k, i) => [k, i]));
	const sorted = [...items].sort((a, b) => {
		// quickActions predates the widget system; a saved order without it
		// keeps it first (its historical spot above the widgets).
		const ai = orderMap.get(a.key) ?? (a.key === 'quickActions' ? -1 : order.length);
		const bi = orderMap.get(b.key) ?? (b.key === 'quickActions' ? -1 : order.length);
		return ai - bi;
	});
	return sorted;
}

function setupWidgetDnD(
	widgetArea: HTMLElement,
	currentKeys: string[],
	onReorder: (order: string[]) => void,
	stacked: boolean,
): void {
	let draggedKey: string | null = null;

	/** All drag-order cards: keyed by [data-widget-key], which sits on the
	 *  widget itself OR on the bare mount wrapper refreshDataWidget re-renders
	 *  lunar/pomodoro/reading into (the wrapper inherits the key). */
	const widgets = () => widgetArea.querySelectorAll('[data-widget-key]');

	/** Clear every drag-over indicator class (both axes swept as defense). */
	const clearDragOver = (el: HTMLElement): void => {
		el.removeClass('dashboard-sidebar-widget--drag-over-top');
		el.removeClass('dashboard-sidebar-widget--drag-over-bottom');
		el.removeClass('dashboard-sidebar-widget--drag-over-left');
		el.removeClass('dashboard-sidebar-widget--drag-over-right');
	};

	/** Insertion side for a pointer position over `wEl`: against the vertical
	 *  midpoint. Both layouts read the Y axis — the side rail stacks widgets
	 *  vertically, and the stacked deck is a column-major grid where "above
	 *  the target" is exactly "earlier in the flat order". */
	const isBefore = (wEl: HTMLElement, e: DragEvent): boolean => {
		const rect = wEl.getBoundingClientRect();
		return e.clientY < rect.top + rect.height / 2;
	};

	/** Controls whose own pointer gesture must not be hijacked by the widget's
	 *  drag-to-reorder: the music volume slider, text inputs, selects, buttons
	 *  and links. A native HTML5 drag starts on ANY mousedown inside a
	 *  `draggable` ancestor, so `draggable` is armed per gesture instead of
	 *  once at setup: pressing a control leaves it off (the control keeps its
	 *  drag/select behaviour), pressing plain widget surface turns it on.
	 *  `[data-no-drag]` is the opt-out hook for clickable non-form elements
	 *  (playlist rows and similar) that want the same protection. */
	const DRAG_BLOCKED = 'input, textarea, select, button, a[href], [contenteditable], [data-no-drag]';

	// Stacked mode pins the quick-actions card to the leftmost slot, so
	// dropping onto it (or dragging it) could never move anything on screen.
	// It exits the reorder system there entirely: no insertion indicators, no
	// persisted no-op order writes that would read as a broken drag.
	const isPinned = (keyEl: HTMLElement): boolean =>
		stacked && keyEl.dataset.widgetKey === 'quickActions';

	widgets().forEach(el => {
		const wEl = el as HTMLElement;
		if (isPinned(wEl)) return;
		wEl.setAttribute('draggable', 'false');
	});

	// Delegation on the widget AREA, not per-widget listeners: the in-place
	// data refresh (view.refreshDataWidget) re-mounts lunar/pomodoro/reading
	// inside a new wrapper mid-session, and drag events bubble — delegated
	// handlers keep working across those swaps without re-wiring.
	const keyElOf = (e: Event): HTMLElement | null => {
		const target = e.target as HTMLElement | null;
		const hit = target?.closest('[data-widget-key]') as HTMLElement | null;
		if (!hit || !widgetArea.contains(hit)) return null;
		return hit;
	};

	widgetArea.addEventListener('mousedown', (e) => {
		const keyEl = keyElOf(e);
		if (!keyEl || isPinned(keyEl)) return;
		const blocked = e.button !== 0 || !!(e.target as HTMLElement | null)?.closest(DRAG_BLOCKED);
		keyEl.setAttribute('draggable', blocked ? 'false' : 'true');
	});

	widgetArea.addEventListener('dragstart', (e) => {
		const keyEl = keyElOf(e);
		if (!keyEl || isPinned(keyEl)) return;
		draggedKey = keyEl.dataset.widgetKey ?? null;
		keyEl.addClass('dashboard-sidebar-widget--dragging');
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', draggedKey ?? '');
		}
	});

	widgetArea.addEventListener('dragend', (e) => {
		const keyEl = keyElOf(e);
		if (keyEl) {
			keyEl.setAttribute('draggable', 'false');
			keyEl.removeClass('dashboard-sidebar-widget--dragging');
		}
		widgets().forEach(el2 => clearDragOver(el2 as HTMLElement));
		draggedKey = null;
	});

	widgetArea.addEventListener('dragover', (e) => {
		const keyEl = keyElOf(e);
		if (!keyEl || isPinned(keyEl)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		if (!draggedKey || keyEl.dataset.widgetKey === draggedKey) return;
		widgets().forEach(el2 => clearDragOver(el2 as HTMLElement));
		keyEl.addClass(isBefore(keyEl, e) ? 'dashboard-sidebar-widget--drag-over-top' : 'dashboard-sidebar-widget--drag-over-bottom');
	});

	widgetArea.addEventListener('dragleave', (e) => {
		const keyEl = keyElOf(e);
		if (keyEl) clearDragOver(keyEl);
	});

	widgetArea.addEventListener('drop', (e) => {
		const keyEl = keyElOf(e);
		if (!keyEl || isPinned(keyEl)) return;
		e.preventDefault();
		clearDragOver(keyEl);
		if (!draggedKey || keyEl.dataset.widgetKey === draggedKey) return;

		const targetKey = keyEl.dataset.widgetKey ?? '';
		const insertBefore = isBefore(keyEl, e);

		const keys = [...currentKeys];
		const fromIdx = keys.indexOf(draggedKey);
		if (fromIdx === -1) return;
		keys.splice(fromIdx, 1);
		let toIdx = keys.indexOf(targetKey);
		if (toIdx === -1) return;
		if (!insertBefore) toIdx += 1;
		keys.splice(toIdx, 0, draggedKey);
		onReorder(keys);
	});
}
