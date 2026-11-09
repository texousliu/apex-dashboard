/**
 * In-place refresh of a single sidebar widget when its data changes underneath
 * it — a service event fired from another surface, or a network payload that
 * landed after the first paint.
 *
 * Extracted from `view.ts` (Phase 5). Every one of these follows the same two
 * steps: swap the widget's node for a freshly rendered one at the same
 * position, then do the same for the mobile panel when that widget is the one
 * expanded. Side by side they read as one behaviour with five data sources;
 * scattered through the view they read as five unrelated handlers. The view
 * keeps one-line methods that hand itself in as the host, which leaves the
 * service subscriptions and the holiday loader untouched.
 */
import type { App } from 'obsidian';
import type { DashboardData, DashboardSettings, ImmersiveItem, WidgetBackground } from '../types';
import type { HolidayInfo } from '../holiday-service';
import type { PomodoroService } from '../pomodoro-service';
import type { ReadingService } from '../reading-service';
import { refreshMusicWidget } from '../music-widget';
import { refreshHabitWidget, renderSidebarHabitWidget } from '../habit-widget';
import { refreshExpenseWidget, renderSidebarExpenseWidget } from '../expense-widget';
import { renderSidebarPomodoro } from '../render/sidebar-widgets';
import { renderSidebarReading } from '../render/sidebar-reading';
import { renderSidebarLunarWidget } from '../lunar-widget';
import { captureScrollStates, restoreScrollStates } from '../scroll-preserve';
import { attachImmersiveResizeHandle, attachImmersiveWidgetDelete } from '../immersive';
import { isImmersiveLayout } from '../render/widget-mount';

/** The widgets that can own the mobile panel — the same key the tab strip
 *  toggles, one per sidebar widget with a mobile view. */
export type MobileWidgetKey = 'pomodoro' | 'reading' | 'lunar' | 'calendar' | 'habit' | 'expense';

/** What the in-place refreshes need from the view. Everything the view owns
 *  as mutable state is a getter: the host object is built once and reused on
 *  every service event, so a captured value would go stale the moment the
 *  settings or the holiday map changed. */
export interface WidgetRefreshHost {
	app: App;
	/** The view's content root (`containerEl.children[1]`) — every widget
	 *  selector below is queried from here. */
	root(): HTMLElement | undefined;
	settings(): DashboardSettings;
	/** Board data; only read to tell whether a swapped widget is an immersive
	 *  grid tile, which needs its grip re-attached. */
	data(): DashboardData | null;
	/** Holiday map from the network loader — empty until it lands. */
	holiday(): Record<string, HolidayInfo>;
	/** Which widget's mobile panel is currently open, if any. */
	expandedMobileWidget(): MobileWidgetKey | null;
	immItems(): ImmersiveItem[];
	commitImmersiveItems(next: ImmersiveItem[]): void;
	removeImmersiveItem(itemId: string): void | Promise<void>;
	/** Persist a pomodoro background picked inside the widget and repaint
	 *  every board (it is a global setting, not a per-card style). */
	applyPomodoroBackground(bg: WidgetBackground | undefined): void;
	/** Recompute the stats banner (the view debounces it). */
	refreshBannerStats(): void;
}

/** Music state changed (transport tick, playlist edit from any surface):
 *  refresh only the derived parts of the sidebar widget. Desktop-only. */
export function refreshMusicInPlace(host: WidgetRefreshHost): void {
	const root = host.root();
	if (root) refreshMusicWidget(root);
}

/** Habit data changed (toggle/add/rename/remove from any view or overlay):
 *  refresh the habit widget in place + the mobile habit panel, and let the
 *  banner debounce recompute when it shows the habit heatmap. */
export function refreshHabitInPlace(host: WidgetRefreshHost): void {
	const root = host.root();
	if (root) refreshHabitWidget(root);
	refreshMobileWidgetPanel(host, 'habit', panel => renderSidebarHabitWidget(panel, host.app));
	host.refreshBannerStats();
}

/** Expense data changed (entry added / record deleted from any view or the
 *  stats overlay): refresh the widget's derived labels in place + the mobile
 *  expense panel. The form inputs are never touched, so typing in this view
 *  survives entries made elsewhere. */
export function refreshExpenseInPlace(host: WidgetRefreshHost): void {
	const root = host.root();
	if (root) refreshExpenseWidget(root);
	refreshMobileWidgetPanel(host, 'expense', panel => renderSidebarExpenseWidget(panel, host.app));
}

/** Pomodoro data changed externally (focus re-sync merged another device's
 *  records): re-render the widget in place + the mobile panel. Timer state
 *  lives in the service, so a running session is untouched. */
export function refreshPomodoroInPlace(host: WidgetRefreshHost, service: PomodoroService | null): void {
	if (!service) return;
	refreshDataWidget(host, '.dashboard-sidebar-pomodoro', (container) =>
		renderSidebarPomodoro(container, service, host.settings(), host.app, bg =>
			host.applyPomodoroBackground(bg)));
	refreshMobileWidgetPanel(host, 'pomodoro', panel =>
		renderSidebarPomodoro(panel, service, host.settings()));
}

/** Reading data changed externally (focus re-sync merged another device's
 *  records): re-render the widget in place + the mobile panel. */
export function refreshReadingInPlace(host: WidgetRefreshHost, service: ReadingService | null): void {
	if (!service) return;
	refreshDataWidget(host, '.dashboard-sidebar-reading', (container) =>
		renderSidebarReading(container, service));
	refreshMobileWidgetPanel(host, 'reading', panel => renderSidebarReading(panel, service));
}

/** Holiday data can arrive over the network after the first mobile paint.
 *  Update only the lunar widget/panel; a second full dashboard render here was
 *  one of the startup memory spikes that could trigger a WebView reload. */
export function refreshLunarInPlace(host: WidgetRefreshHost): void {
	refreshDataWidget(host, '.dashboard-sidebar-lunar', (container) =>
		renderSidebarLunarWidget(container, host.holiday(), host.app));
	refreshMobileWidgetPanel(host, 'lunar', panel =>
		renderSidebarLunarWidget(panel, host.holiday(), host.app));
}

/** Re-render one sidebar data widget in place: render into a fresh mount at
 *  the same position, then drop the old node (emptying in place would nest a
 *  second .dashboard-sidebar-widget inside and confuse the sidebar's widget
 *  enumeration/drag handlers). The swapped widget's internal scroll (habit
 *  list, music playlist) carries over the swap so a data refresh elsewhere
 *  never yanks the widget's viewport. */
export function refreshDataWidget(
	host: WidgetRefreshHost,
	selector: string,
	render: (container: HTMLElement) => void,
): void {
	const widget = host.root()?.querySelector<HTMLElement>(selector);
	if (!widget || !widget.isConnected) return;
	const parent = widget.parentElement;
	if (!parent) return;
	const scrollStates = captureScrollStates(widget);
	const mount = createDiv();
	mount.addClass('dashboard-sidebar-widget-mount');
	// Carry the replaced widget's identity onto the mount: the stacked widget
	// grid keys its per-type sizing off [data-widget-key] on the DIRECT child,
	// which after this swap is the mount, not the widget.
	const key = widget.dataset.widgetKey;
	if (key) mount.dataset.widgetKey = key;
	const span = widget.style.getPropertyValue('--db-widget-span');
	if (span) mount.style.setProperty('--db-widget-span', span);
	// Immersive: the widget IS a grid tile — without carrying its id and
	// inline placement the swapped-in mount drops to auto placement and
	// slides off to the end of the board. Same carry pattern as the key.
	const immId = widget.dataset.immId;
	if (immId) {
		mount.dataset.immId = immId;
		if (widget.style.gridColumn) mount.style.gridColumn = widget.style.gridColumn;
		if (widget.style.gridRow) mount.style.gridRow = widget.style.gridRow;
		if (widget.style.minHeight) mount.style.minHeight = widget.style.minHeight;
	}
	parent.insertBefore(mount, widget);
	widget.remove();
	render(mount);
	restoreScrollStates(mount, scrollStates);
	// The corner resize grip and the hover delete button lived inside the
	// swapped-out card.
	if (immId && isImmersiveLayout(host.settings(), host.data())) {
		attachImmersiveResizeHandle(mount, immId, () => host.immItems(), next => host.commitImmersiveItems(next));
		if (immId.startsWith('widget:')) {
			attachImmersiveWidgetDelete(mount, removeId => void host.removeImmersiveItem(removeId));
		}
	}
}

/** Repaint the mobile panel for `key` when (and only when) that widget is the
 *  one expanded: the panel is a separate mount from the desktop widget, so
 *  every in-place refresh has to keep the two in sync. Collapsed panels are
 *  left alone — they re-render from scratch when tapped open. */
export function refreshMobileWidgetPanel(
	host: WidgetRefreshHost,
	key: MobileWidgetKey,
	render: (container: HTMLElement) => void,
): void {
	if (host.expandedMobileWidget() !== key) return;
	const panel = host.root()?.querySelector<HTMLElement>('.dashboard-mobile-widget-panel');
	if (!panel) return;
	panel.empty();
	render(panel);
}
