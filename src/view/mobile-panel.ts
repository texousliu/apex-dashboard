/**
 * The phone's half of the dashboard chrome: the widget bar (strip → tab row →
 * panel), the two banner action buttons, and the drawers they open.
 *
 * Extracted from `view.ts` (Phase 5). What makes these one slice is not that
 * they look alike — it is that the desktop never calls any of them: the side
 * rail (`renderSidebar`) and the immersive grid are separate pipelines. The
 * panel also happens to be a **second mount tree**: the same widget can be on
 * screen twice (rail + panel), which is why the in-place refreshes in
 * `widget-refresh.ts` have to keep both in sync.
 *
 * The open/expanded state travels in a plain object the view owns, one per
 * view instance. It deliberately is not module state: Obsidian can host two
 * dashboard leaves side by side, and a module-level flag would have them open
 * each other's panels.
 */
import type { App, TFile } from 'obsidian';
import { setIcon } from 'obsidian';
import type { DashboardData, DashboardSettings, QuickAction, WidgetBackground } from '../types';
import type { HolidayInfo } from '../holiday-service';
import type { PomodoroService } from '../pomodoro-service';
import type { ReadingService } from '../reading-service';
import type { SyncEngine } from '../sync';
import { t } from '../i18n';
import { getRecentDocs, renderRecentDocs } from '../recent';
import { renderQuickActions } from '../quick-actions';
import { showConfirmDialog } from '../confirm-dialog';
import { renderSidebarPomodoro } from '../render/sidebar-widgets';
import { renderSidebarReading } from '../render/sidebar-reading';
import { renderSidebarLunarWidget } from '../lunar-widget';
import { renderSidebarCalendar } from '../calendar-widget';
import { renderSidebarHabitWidget } from '../habit-widget';
import { renderSidebarExpenseWidget } from '../expense-widget';
import type { MobileWidgetKey } from './widget-refresh';

/** Which widget the panel is showing, and whether the tab row is out. */
export interface MobilePanelState {
	/** Tab row revealed by tapping the strip; collapsing it drops the
	 *  expanded widget along with it. */
	tabsOpen: boolean;
	/** The open panel's widget, if any. Read by `widget-refresh` to decide
	 *  whether the second mount tree needs repainting too. */
	expanded: MobileWidgetKey | null;
}

export function createMobilePanelState(): MobilePanelState {
	return { tabsOpen: false, expanded: null };
}

/** What the phone chrome needs from the view. Mutable values are getters: the
 *  host is built once and every tap re-reads them. */
export interface MobilePanelHost {
	app: App;
	state: MobilePanelState;
	settings(): DashboardSettings;
	data(): DashboardData | null;
	/** The view's content root (`containerEl.children[1]`) — drawers anchor
	 *  to it and measure the first section row for their top edge. */
	root(): HTMLElement | undefined;
	/** Holiday map, empty until the network loader lands. */
	holiday(): Record<string, HolidayInfo>;
	pomodoro(): PomodoroService | null;
	reading(): ReadingService | null;
	sync(): SyncEngine;
	openNote(file: TFile, line?: number): void;
	executeAction(action: QuickAction): void;
	navigateToPath(path: string): void;
	openAddActionModal(): void;
	/** A pomodoro background picked inside the panel is a global setting, not
	 *  a per-card style — the view persists it and repaints every board. */
	applyPomodoroBackground(bg: WidgetBackground | undefined): void;
}

/** The two round buttons over the banner (quick actions / recent docs). Also
 *  owns the phone's "tap the right half to reveal the edit button" gesture —
 *  it is a touch affordance, so it lives with the rest of the phone chrome. */
export function renderMobileActions(host: MobilePanelHost, bannerEl: HTMLElement): void {
	const actions = bannerEl.createDiv({ cls: 'dashboard-mobile-actions' });

	const linksBtn = actions.createEl('button', {
		cls: 'dashboard-mobile-action-btn',
		attr: { 'aria-label': t('mobile.quickActions') },
	});
	setIcon(linksBtn, 'zap');
	linksBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		openMobileDrawer(host, 'quickActions');
	});

	const recentBtn = actions.createEl('button', {
		cls: 'dashboard-mobile-action-btn',
		attr: { 'aria-label': t('mobile.recent') },
	});
	setIcon(recentBtn, 'clock');
	recentBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		openMobileDrawer(host, 'recent');
	});

	// On mobile, tapping right half of banner reveals the edit button
	const overlay = bannerEl.querySelector('.dashboard-banner-overlay') as HTMLElement;
	if (overlay) {
		overlay.addEventListener('click', (e) => {
			const rect = overlay.getBoundingClientRect();
			const tapX = e.clientX - rect.left;
			if (tapX > rect.width * 0.5) {
				const editBtn = overlay.querySelector('.dashboard-banner-edit-btn') as HTMLElement;
				if (editBtn) {
					editBtn.addClass('dashboard-banner-edit-btn--mobile-visible');
				}
			}
		});
	}
}

/** Build the widget bar and start from a closed state: every full render
 *  resets the panel, so a re-render never leaves a stale widget expanded in a
 *  bar whose tabs are hidden. */
export function renderMobileWidgetBar(host: MobilePanelHost, container: HTMLElement): void {
	host.state.tabsOpen = false;
	host.state.expanded = null;

	const bar = container.createDiv({ cls: 'dashboard-mobile-widget-bar' });

	// Thin strip: collapsed state, tap to expand tabs
	const strip = bar.createDiv({ cls: 'dashboard-mobile-widget-strip' });
	strip.createDiv({ cls: 'dashboard-mobile-widget-strip-hint' });
	strip.addEventListener('click', (e) => {
		e.stopPropagation();
		host.state.tabsOpen = !host.state.tabsOpen;
		if (!host.state.tabsOpen) {
			host.state.expanded = null;
		}
		syncMobileWidgetPanel(host, bar);
	});

	// Tab row: hidden by default, revealed by tapping strip
	const tabs = bar.createDiv({ cls: 'dashboard-mobile-widget-tabs' });

	// Rae: the phone carries NO quick-input tabs — mobile follows the
	// quick-note bar's capture/search mode setting alone; the standalone
	// widgets are a desktop-rail affordance.
	const widgets: Array<{ key: MobileWidgetKey; label: string; icon: string }> = [
		{ key: 'lunar', label: t('mobile.lunar'), icon: 'moon' },
		...(host.settings().widgetCalendarEnabled
			? [{ key: 'calendar' as const, label: t('mobile.calendar'), icon: 'calendar' }]
			: []),
		{ key: 'pomodoro', label: t('mobile.pomodoro'), icon: 'hourglass' },
		...(host.settings().widgetHabitEnabled
			? [{ key: 'habit' as const, label: t('mobile.habit'), icon: 'check-circle-2' }]
			: []),
		...(host.settings().widgetExpenseEnabled
			? [{ key: 'expense' as const, label: t('mobile.expense'), icon: 'wallet' }]
			: []),
		{ key: 'reading', label: t('mobile.reading'), icon: 'book-open' },
	];

	bar.createDiv({ cls: 'dashboard-mobile-widget-panel' });

	for (const w of widgets) {
		const btn = tabs.createEl('button', {
			cls: 'dashboard-mobile-widget-btn',
			attr: { 'aria-label': w.label },
		});
		setIcon(btn, w.icon);

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (host.state.expanded === w.key) {
				host.state.expanded = null;
			} else {
				host.state.expanded = w.key;
			}
			syncMobileWidgetPanel(host, bar);
		});

		btn.dataset.widgetKey = w.key;
	}

	syncMobileWidgetPanel(host, bar);
}

/** Repaint the bar's chrome (strip / tab row / active tab) and, in the panel,
 *  whichever widget is open — or nothing at all when none is.
 *
 *  Named "sync" rather than "refresh" on purpose: `widget-refresh.ts` exports
 *  a `refreshMobileWidgetPanel` that does something narrower (repaint ONLY the
 *  panel, and only when that widget is the expanded one). Two functions with
 *  one name and different reach is how a future caller ends up rebuilding the
 *  tab row on a habit toggle. */
export function syncMobileWidgetPanel(host: MobilePanelHost, bar: HTMLElement): void {
	const strip = bar.querySelector('.dashboard-mobile-widget-strip');
	const tabs = bar.querySelector('.dashboard-mobile-widget-tabs');
	const panel = bar.querySelector<HTMLElement>('.dashboard-mobile-widget-panel');
	if (!strip || !tabs || !panel) return;

	// Toggle strip active state
	strip.classList.toggle('dashboard-mobile-widget-strip--active', host.state.tabsOpen);

	// Toggle tabs visibility
	tabs.classList.toggle('dashboard-mobile-widget-tabs--open', host.state.tabsOpen);

	// Update button active states
	tabs.querySelectorAll('.dashboard-mobile-widget-btn').forEach((btn) => {
		const el = btn as HTMLElement;
		el.classList.toggle('active', el.dataset.widgetKey === host.state.expanded);
	});

	// Render panel content. empty() first: the panel is one node, and a widget
	// rendered into a non-empty panel would nest a second copy of itself.
	panel.empty();

	if (!host.state.expanded) {
		panel.removeClass('dashboard-mobile-widget-panel--open');
		return;
	}

	panel.addClass('dashboard-mobile-widget-panel--open');

	const expanded = host.state.expanded;
	const pomodoro = host.pomodoro();
	const reading = host.reading();

	if (expanded === 'pomodoro' && pomodoro) {
		renderSidebarPomodoro(panel, pomodoro, host.settings(), host.app, bg => host.applyPomodoroBackground(bg));
	} else if (expanded === 'reading' && reading) {
		renderSidebarReading(panel, reading);
	} else if (expanded === 'lunar') {
		renderSidebarLunarWidget(panel, host.holiday(), host.app);
	} else if (expanded === 'calendar') {
		// The tab tap is explicit intent: autoLoad skips the phone deferred-scan
		// placeholder so the grid (and its dots) appear without a second tap.
		renderSidebarCalendar(
			panel,
			host.settings(),
			host.app,
			(file, line) => host.openNote(file, line),
			{ autoLoad: true },
		);
	} else if (expanded === 'habit') {
		renderSidebarHabitWidget(panel, host.app);
	} else if (expanded === 'expense') {
		renderSidebarExpenseWidget(panel, host.app);
	}
}

/** Slide-in sheet under the first section row. Re-opening replaces whatever
 *  was there, so the two banner buttons can be tapped in any order. */
export function openMobileDrawer(host: MobilePanelHost, type: 'quickActions' | 'recent'): void {
	closeMobileDrawer(host);

	const root = host.root();
	if (!root) return;

	const firstSection = root.querySelector('.dashboard-section-row') as HTMLElement;
	const drawerTop = firstSection ? firstSection.getBoundingClientRect().top : 0;

	const drawer = root.createDiv({ cls: 'dashboard-mobile-drawer' });
	drawer.style.top = `${drawerTop}px`;

	const content = drawer.createDiv({ cls: 'dashboard-mobile-drawer-content' });

	if (type === 'quickActions') {
		content.createEl('h4', { text: t('mobile.quickActions'), cls: 'dashboard-mobile-drawer-title' });
		const data = host.data();
		if (data) {
			renderQuickActions(
				content,
				data.quickActions,
				(action) => { void host.executeAction(action); closeMobileDrawer(host); },
				(index) => {
					void (async () => {
						const confirmed = await showConfirmDialog(host.app, {
							title: t('common.confirmDelete'),
							message: t('common.confirmDeleteMessage'),
						});
						if (!confirmed) return;
						void host.sync().removeQuickAction(index);
					})();
				},
				() => host.openAddActionModal(),
				data.quickActionOrder,
				(order) => { void host.sync().reorderQuickActions(order); },
				(key) => {
					void (async () => {
						const confirmed = await showConfirmDialog(host.app, {
							title: t('common.confirmDelete'),
							message: t('common.confirmDeleteMessage'),
						});
						if (!confirmed) return;
						void host.sync().removeQuickActionByKey(key);
					})();
				},
				data.hiddenPresets,
				undefined,
			);
		}
	} else {
		content.createEl('h4', { text: t('mobile.recent'), cls: 'dashboard-mobile-drawer-title' });
		const docs = getRecentDocs(host.app, host.settings().recentDocCount);
		renderRecentDocs(content, docs, (path) => { void host.navigateToPath(path); });
	}

	const backdrop = drawer.createDiv({ cls: 'dashboard-mobile-drawer-backdrop' });
	backdrop.addEventListener('click', () => closeMobileDrawer(host));

	window.requestAnimationFrame(() => {
		content.addClass('dashboard-mobile-drawer-content--open');
	});
}

/** Drop the drawer if it is on screen. Safe to call unconditionally. */
export function closeMobileDrawer(host: MobilePanelHost): void {
	const root = host.root();
	if (!root) return;
	const existing = root.querySelector('.dashboard-mobile-drawer');
	if (existing) existing.remove();
}
