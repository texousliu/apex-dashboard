/**
 * The three periodic watchdogs the view starts on open and stops on close:
 * the reminder scan, the weather TTL refresh, and the day-rollover check.
 *
 * Extracted from `view.ts` (Phase 5). Each one is a `setInterval` plus a "should
 * I bother?" guard — the guards themselves stay with the code they guard (the
 * reminder scan in `./reminders`, the rollover repaint in the view), so what
 * lands here is only the timer plumbing and the intervals' constants.
 *
 * The weather refresh is the one with real state: it refreshes cards and the
 * preserved sidebar widget *in place* rather than re-rendering, and clearing
 * the cache on stop is what makes a reopen fetch fresh data.
 */
import { App } from 'obsidian';
import type { DashboardData, DashboardSettings } from '../types';
import { clearWeatherCache } from '../weather-service';
import { refreshWeatherCards, refreshSidebarWeatherWidget } from '../renderer';
import { REMINDER_CHECK_MS } from './reminders';

/** How often the weather cache is allowed to refetch (30 minutes). */
export const WEATHER_REFRESH_MS = 30 * 60 * 1000;
/** How often the calendar day is compared against the rendered one (1 minute). */
export const DAY_ROLLOVER_CHECK_MS = 60 * 1000;

export interface WeatherRefreshHost {
	app: App;
	/** Read live: the timer fires long after the render that installed it. */
	data(): DashboardData | null;
	settings(): DashboardSettings;
	/** The element the cards and the sidebar widgets live under. */
	rootEl(): HTMLElement | undefined;
}

/** Start the reminder scan: one immediate pass (so a board that opens with a
 *  due reminder shows it right away) then once a minute. */
export function startReminderChecker(onCheck: () => void): number {
	onCheck();
	return window.setInterval(onCheck, REMINDER_CHECK_MS);
}

export function startDayRolloverChecker(onCheck: () => void): number {
	return window.setInterval(onCheck, DAY_ROLLOVER_CHECK_MS);
}

export function startWeatherRefresh(host: WeatherRefreshHost): number {
	return window.setInterval(() => {
		const data = host.data();
		if (!data) return;
		const hasWeather = data.columns.some(col =>
			col.cards.some(c => c.type === 'weather')
		);
		// The sidebar weather widget DOM is preserved across re-renders, so it
		// no longer refreshes as a side effect of re-renders - pull it into the
		// same periodic refresh. The widget renders through the weather cache,
		// so this only refetches once the TTL has lapsed.
		const settings = host.settings();
		const hasSidebarWeather = settings.widgetWeatherEnabled;
		if (!hasWeather && !hasSidebarWeather) return;
		// Refresh in place instead of rebuilding the whole dashboard. Full
		// render() here was the main source of periodic jank on mobile - it
		// emptied and rebuilt every card/section.
		clearWeatherCache();
		const root = host.rootEl();
		if (!root) return;
		if (hasWeather) refreshWeatherCards(root, data);
		if (hasSidebarWeather) refreshSidebarWeatherWidget(root, settings, host.app);
	}, WEATHER_REFRESH_MS);
}

/** Stop the weather refresh and drop the cache, so a reopen starts fresh. */
export function stopWeatherRefresh(timer: number | null): void {
	if (timer) window.clearInterval(timer);
	clearWeatherCache();
}

/** Stop a plain interval handle. Null-checked rather than truthy-checked: a
 *  handle of 0 is a real timer in browsers that count from zero. */
export function stopInterval(timer: number | null): void {
	if (timer !== null) window.clearInterval(timer);
}
