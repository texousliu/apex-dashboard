/**
 * The live sidebar widgets that own timers or async fetches: weather, pomodoro
 * (with its activity picker) and countdown.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). These three
 * share one thing the other widgets do not: they hold state across renders
 * (weather cache + fetch, a running pomodoro tick, interval timers keyed by
 * content element), which is why `countdownTimers` and its teardown live here
 * rather than next to the chart registry.
 */
import { App, setIcon } from 'obsidian';
import { t, getLocale } from '../i18n';
import { fetchWeather, getCachedWeather, getWeatherDescription, getWeatherEmoji } from '../weather-service';
import { activityColor } from '../pomodoro-service';
import type { PomodoroService } from '../pomodoro-service';
import { showPomodoroStats as openWidePomodoroStats } from '../pomodoro-stats-modal';
import { CountdownSettingsModal } from '../countdown-modal';
import { formatTime } from './time-format';
import { applyWidgetBackground, appendInlineConfigButton, getWidgetPlugin } from '../widget-background';
import { PomodoroSettingsModal } from '../pomodoro-settings-modal';
import { isInPreserveScope, type PreserveScope } from '../preserve-scope';

/** Countdown tick timers keyed by their timer id, mapped to the widget content
 *  they animate. destroyAllCharts skips entries still inside a preserved widget
 *  area, so re-attaching the sidebar widgets DOM keeps them running. */
const countdownTimers = new Map<number, HTMLElement>();

/** Stop countdown ticks whose content element is being discarded.
 *  `preserveWidgets` is the detached-but-reused sidebar widgets element from the
 *  previous render (see renderSidebarWidgets): timers animating its countdowns
 *  survive so the re-attached DOM keeps ticking. Timers are also self-cleaning
 *  (they check isConnected), so any survivors of a discarded DOM unwind
 *  themselves. Called by destroyAllCharts alongside the chart registry teardown. */
export function destroyIdleCountdownTimers(preserveWidgets?: PreserveScope): void {
	for (const [id, content] of countdownTimers) {
		if (isInPreserveScope(preserveWidgets, content)) continue;
		window.clearInterval(id);
		countdownTimers.delete(id);
	}
}

export function renderSidebarWeather(container: HTMLElement, settings: import('../types').DashboardSettings, app: App): void {
	const widget = container.createDiv({ cls: 'dashboard-sidebar-widget dashboard-sidebar-weather' });
	renderSidebarWeatherInto(widget, settings, app);
}

/** Render weather content into an existing widget element (fresh or preserved).
 *  Reads through the weather cache, so a periodic call only refetches once the
 *  30-minute TTL has lapsed. */
function renderSidebarWeatherInto(widget: HTMLElement, settings: import('../types').DashboardSettings, app: App): void {
	const cityName = settings.widgetWeatherCity || '';

	// All weather content renders into a dedicated BODY div; async rebuilds
	// empty the body, never the widget itself — the immersive board mounts
	// its resize strips / delete button as siblings inside the card, and
	// `widget.empty()` wiped them the moment data arrived (weather card was
	// the one tile that "cannot be resized").
	const bodyOf = (host: HTMLElement): HTMLElement =>
		host.querySelector<HTMLElement>('.dashboard-sidebar-weather-body')
		?? host.createDiv({ cls: 'dashboard-sidebar-weather-body' });
	bodyOf(widget).createDiv({ cls: 'dashboard-sidebar-weather-loading', text: '...' });

	const config = {
		// `??`, not `||`: 0 is a real coordinate (the equator, the prime
		// meridian). With `||` a user who picked either got the Shanghai
		// default silently.
		latitude: settings.widgetWeatherLat ?? 31.23,
		longitude: settings.widgetWeatherLon ?? 121.47,
		cityName: cityName || 'Shanghai',
	};

	const cached = getCachedWeather(config);
	if (cached) {
		bodyOf(widget).empty();
		renderSidebarWeatherContent(bodyOf(widget), cached, config.cityName);
		return;
	}

	fetchWeather(config).then(data => {
		bodyOf(widget).empty();
		renderSidebarWeatherContent(bodyOf(widget), data, config.cityName);
	}).catch(() => {
		const body = bodyOf(widget);
		body.empty();
		body.createDiv({ cls: 'dashboard-sidebar-weather-error', text: '--' });
	});
}

/** Refresh the live sidebar weather widget in place. The widgets DOM survives
 *  full re-renders (signature-guarded reuse), so the periodic weather timer
 *  refreshes it here instead of relying on a re-render happening to occur. */
export function refreshSidebarWeatherWidget(root: HTMLElement, settings: import('../types').DashboardSettings, app: App): void {
	const el = root.querySelector<HTMLElement>('.dashboard-sidebar-weather');
	if (!el) return;
	const body = el.querySelector<HTMLElement>('.dashboard-sidebar-weather-body');
	body?.empty();
	renderSidebarWeatherInto(el, settings, app);
}

function renderSidebarWeatherContent(el: HTMLElement, data: import('../types').WeatherData, cityName: string): void {
	const top = el.createDiv({ cls: 'dashboard-sidebar-weather-top' });
	top.createDiv({ cls: 'dashboard-sidebar-weather-icon', text: getWeatherEmoji(data.weatherCode) });
	const tempWrap = top.createDiv({ cls: 'dashboard-sidebar-weather-temp-wrap' });
	tempWrap.createDiv({ cls: 'dashboard-sidebar-weather-temp', text: `${Math.round(data.temperature)}°` });

	const info = el.createDiv({ cls: 'dashboard-sidebar-weather-info' });
	info.createDiv({ cls: 'dashboard-sidebar-weather-city', text: cityName });
	const descLine = info.createDiv({ cls: 'dashboard-sidebar-weather-desc-line' });
	descLine.createSpan({ cls: 'dashboard-sidebar-weather-desc', text: getWeatherDescription(data.weatherCode) });

	const details = el.createDiv({ cls: 'dashboard-sidebar-weather-details' });
	details.createDiv({ cls: 'dashboard-sidebar-weather-detail', text: `${t('weather.feelsLike') ?? 'Feels like'} ${Math.round(data.feelsLike)}°` });
	details.createDiv({ cls: 'dashboard-sidebar-weather-detail', text: `${t('weather.humidity') ?? 'Humidity'} ${Math.round(data.humidity)}%` });
	details.createDiv({ cls: 'dashboard-sidebar-weather-detail', text: `${Math.round(data.windSpeed)} km/h` });

	if (data.dailyDates.length > 1) {
		const forecast = el.createDiv({ cls: 'dashboard-sidebar-weather-forecast' });
		const count = Math.min(data.dailyDates.length, 5);
		for (let i = 0; i < count; i++) {
			const day = forecast.createDiv({ cls: 'dashboard-sidebar-weather-fday' });
			const d = new Date(data.dailyDates[i]! + 'T00:00:00');
			const dayName = d.toLocaleDateString(getLocale(), { weekday: 'short' });
			day.createDiv({ cls: 'dashboard-sidebar-weather-fday-name', text: i === 0 ? t('weather.today') ?? 'Today' : dayName });
			day.createDiv({ cls: 'dashboard-sidebar-weather-fday-icon', text: getWeatherEmoji(data.dailyCodes[i]!) });
			const temps = day.createDiv({ cls: 'dashboard-sidebar-weather-fday-temps' });
			temps.createSpan({ cls: 'dashboard-sidebar-weather-fday-high', text: `${Math.round(data.dailyMax[i]!)}°` });
			temps.createSpan({ cls: 'dashboard-sidebar-weather-fday-low', text: `${Math.round(data.dailyMin[i]!)}°` });
		}
	}
}

export function renderSidebarPomodoro(
	container: HTMLElement,
	service: PomodoroService,
	settings: import('../types').DashboardSettings,
	app?: App,
	onBgChange?: (bg: import('../types').WidgetBackground | undefined) => void,
): void {
	const widget = container.createDiv({ cls: 'dashboard-sidebar-widget dashboard-sidebar-pomodoro' });
	if (app) applyWidgetBackground(widget, settings.pomodoroBackground, app);

	const state = service.getState();
	const stopwatch = state.mode === 'stopwatch';

	// Top row: today count left + activity selector centered + stats button right
	const topRow = widget.createDiv({ cls: 'dashboard-sidebar-pomodoro-top' });

	const todayCount = service.getTodayCount();
	const statsHint = topRow.createDiv({
		cls: 'dashboard-sidebar-pomodoro-stats-hint',
		text: '🍅 ' + t('pomodoro.today') + ' ' + todayCount,
	});

	topRow.createDiv({ cls: 'dashboard-sidebar-pomodoro-top-spacer' });

	// Activity selector (in title position)
	const currentActivity = service.getActivity();
	createActivitySelector(topRow, service, currentActivity);

	// Top-right cluster: settings gear + stats key. The countdown/stopwatch
	// toggle used to be a third key here; it lives in the gear's settings
	// modal now, so the activity selector can center on the row (three-zone
	// layout; the today-hint pins absolutely at the left, outside the flow).
	const rightCluster = topRow.createDiv({ cls: 'dashboard-sidebar-pomodoro-top-right' });
	if (app && onBgChange) {
		appendInlineConfigButton(rightCluster, t('pomodoro.settingsTitle'), () => {
			const plugin = getWidgetPlugin(app);
			if (!plugin) return;
			new PomodoroSettingsModal(app, service, plugin, settings.pomodoroBackground, onBgChange).open();
		});
	}
	const statsBtn = rightCluster.createDiv({ cls: 'dashboard-sidebar-pomodoro-stats-btn' });
	setIcon(statsBtn, 'bar-chart-2');

	// Ring
	const ringWrap = widget.createDiv({ cls: 'dashboard-sidebar-pomodoro-ring-wrap' });
	const svgSize = 72;
	const strokeWidth = 6;
	const radius = (svgSize - strokeWidth) / 2;
	const circumference = 2 * Math.PI * radius;

	const svg = ringWrap.createSvg('svg', {
		cls: 'dashboard-sidebar-pomodoro-ring',
		attr: { viewBox: `0 0 ${svgSize} ${svgSize}`, width: String(svgSize), height: String(svgSize) },
	});
	svg.createSvg('circle', {
		cls: 'dashboard-sidebar-pomodoro-ring-bg',
		attr: { cx: svgSize / 2, cy: svgSize / 2, r: radius, 'stroke-width': strokeWidth, fill: 'none' },
	});
	const progressCircle = svg.createSvg('circle', {
		cls: 'dashboard-sidebar-pomodoro-ring-progress',
		attr: {
			cx: svgSize / 2, cy: svgSize / 2, r: radius, 'stroke-width': strokeWidth, fill: 'none',
			'stroke-linecap': 'round', 'stroke-dasharray': circumference, 'stroke-dashoffset': '0',
			transform: `rotate(-90 ${svgSize / 2} ${svgSize / 2})`,
		},
	});
	const timeText = ringWrap.createDiv({
		cls: 'dashboard-sidebar-pomodoro-time',
		text: formatTime(state.remainingSeconds),
	});

	// Dots inside ring, below time
	const dotsWrap = ringWrap.createDiv({ cls: 'dashboard-sidebar-pomodoro-dots' });
	const interval = settings.pomodoroLongBreakInterval;
	for (let i = 0; i < interval; i++) {
		dotsWrap.createDiv({
			cls: 'dashboard-sidebar-pomodoro-dot' + (i < state.completedWorkSessions ? ' dashboard-sidebar-pomodoro-dot--filled' : ''),
		});
	}
	// The interval dots narrate countdown cycles; a stopwatch run has none.
	dotsWrap.toggleClass('is-hidden', stopwatch);

	const mainBtn = widget.createEl('button', {
		cls: 'dashboard-sidebar-pomodoro-main-btn',
		text: t('pomodoro.startFocus'),
	});

	// --- Helpers ---
	function updateRing(remaining: number, total: number): void {
		const progress = total > 0 ? remaining / total : 1;
		progressCircle.setAttribute('stroke-dashoffset', String(circumference * (1 - progress)));
		timeText.textContent = formatTime(remaining);
	}
	updateRing(state.remainingSeconds, state.totalSeconds);

	/** One state-driven repaint for both modes: ring, time, main-button label,
	 *  dots. Called on mount, every tick, and after every button action. */
	function applyState(): void {
		const s = service.getState();
		if (s.mode === 'stopwatch') {
			// remainingSeconds carries the ELAPSED count here; the ring fills
			// toward the reminder (or work-length) reference and clamps full.
			timeText.textContent = formatTime(s.remainingSeconds);
			const progress = s.totalSeconds > 0 ? Math.min(1, s.remainingSeconds / s.totalSeconds) : 0;
			progressCircle.setAttribute('stroke-dashoffset', String(circumference * (1 - progress)));
			mainBtn.textContent = s.status === 'running'
				? t('pomodoro.stop')
				: s.status === 'paused' ? t('pomodoro.resumeFocus') : t('pomodoro.startFocus');
			mainBtn.toggleClass('dashboard-sidebar-pomodoro-main-btn--running', s.status === 'running');
			return;
		}
		updateRing(s.remainingSeconds, s.totalSeconds);
		const running = s.status === 'running';
		const standby = s.status === 'paused' && s.remainingSeconds === s.totalSeconds;
		mainBtn.textContent = running
			? t('pomodoro.stop')
			: standby
				? (s.phase === 'work' ? t('pomodoro.resumeFocus') : t('pomodoro.startBreak'))
				: t('pomodoro.startFocus');
		mainBtn.toggleClass('dashboard-sidebar-pomodoro-main-btn--running', running);
		const dots = dotsWrap.querySelectorAll('.dashboard-sidebar-pomodoro-dot');
		dots.forEach((dot, i) => dot.toggleClass('dashboard-sidebar-pomodoro-dot--filled', i < s.completedWorkSessions));
		const tc = service.getTodayCount();
		statsHint.textContent = t('pomodoro.today') + ' ' + tc;
	}

	service.setOnTick(() => applyState());

	service.setOnComplete(() => applyState());

	mainBtn.addEventListener('click', () => {
		const s = service.getState();
		if (s.mode === 'stopwatch') {
			// Stopping a count-up ENDS the run and records its actual minutes
			// (that is the whole point of the stopwatch counting pomodoros).
			if (s.status === 'running') service.stopStopwatch();
			else service.start();
		} else if (s.status === 'running') {
			service.reset();
		} else {
			service.start();
		}
		applyState();
	});

	statsBtn.addEventListener('click', () => {
		showPomodoroStats(widget.ownerDocument, service);
	});

	// Initial paint through the same mode-aware path the ticks use (covers
	// the paused-ready standby labels a fresh mount would otherwise miss).
	applyState();
}

function createActivitySelector(
	parent: HTMLElement,
	service: PomodoroService,
	initialActivity: string,
): { activityTrigger: HTMLElement; updateActivityDisplay: (name: string) => void } {
	const wrap = parent.createDiv({ cls: 'dashboard-pomodoro-activity-selector' });

	const trigger = wrap.createDiv({
		cls: 'dashboard-pomodoro-activity-trigger' + (initialActivity ? ' dashboard-pomodoro-activity-trigger--set' : ''),
	});

	let colorDot: HTMLElement | null = null;

	if (initialActivity) {
		colorDot = trigger.createDiv({ cls: 'dashboard-pomodoro-activity-color-dot' });
		colorDot.style.backgroundColor = activityColor(initialActivity);
		trigger.createSpan({ text: initialActivity });
	} else {
		trigger.createSpan({ text: t('pomodoro.tapToSetActivity'), cls: 'dashboard-pomodoro-activity-placeholder' });
	}

	let panel: HTMLElement | null = null;

	function updateActivityDisplay(name: string): void {
		trigger.empty();
		trigger.toggleClass('dashboard-pomodoro-activity-trigger--set', name.length > 0);
		if (name) {
			const dot = trigger.createDiv({ cls: 'dashboard-pomodoro-activity-color-dot' });
			dot.style.backgroundColor = activityColor(name);
			trigger.createSpan({ text: name });
		} else {
			trigger.createSpan({ text: t('pomodoro.tapToSetActivity'), cls: 'dashboard-pomodoro-activity-placeholder' });
		}
	}

	function closePanel(): void {
		if (panel) {
			panel.remove();
			panel = null;
		}
	}

	function openPanel(): void {
		closePanel();

		panel = wrap.createDiv({ cls: 'dashboard-pomodoro-activity-panel' });

		const input = panel.createEl('input', {
			cls: 'dashboard-pomodoro-activity-panel-input',
			attr: { type: 'text', placeholder: t('pomodoro.inputActivity') },
		});

		const recentActivities = service.getRecentActivities(6);
		if (recentActivities.length > 0) {
			const chipsWrap = panel.createDiv({ cls: 'dashboard-pomodoro-activity-chips' });
			for (const act of recentActivities) {
				const chip = chipsWrap.createDiv({ cls: 'dashboard-pomodoro-activity-chip' });
				const dot = chip.createDiv({ cls: 'dashboard-pomodoro-activity-color-dot' });
				dot.style.backgroundColor = activityColor(act);
				chip.createSpan({ text: act });
				chip.addEventListener('click', (e) => {
					e.stopPropagation();
					service.setActivity(act);
					updateActivityDisplay(act);
					closePanel();
				});
			}
		}

		input.focus();

		const finish = (save: boolean) => {
			const val = input.value.trim();
			if (save && val) {
				service.setActivity(val);
				updateActivityDisplay(val);
			}
			closePanel();
		};

		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
		});
	}

	trigger.addEventListener('click', (e) => {
		e.stopPropagation();
		if (panel) {
			closePanel();
		} else {
			openPanel();
		}
	});

	// Close panel when clicking outside
	const doc = parent.ownerDocument;
	const onDocClick = (e: MouseEvent) => {
		if (panel && !panel.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
			closePanel();
		}
	};
	doc.addEventListener('click', onDocClick);

	return { activityTrigger: trigger, updateActivityDisplay };
}

export function renderSidebarCountdown(
	container: HTMLElement,
	cd: import('../types').CountdownConfig,
	app: App,
): void {
	const widget = container.createDiv({ cls: 'dashboard-sidebar-widget dashboard-sidebar-countdown' });
	applyWidgetBackground(widget, cd.background, app);

	// Settings button (absolute positioned)
	const settingsBtn = widget.createEl('button', {
		cls: 'dashboard-sidebar-countdown-settings-btn',
		attr: { 'aria-label': t('countdown.settingsTitle') },
	});
	setIcon(settingsBtn, 'settings');

	settingsBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		const modal = new CountdownSettingsModal(app, cd, (updated) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { settings?: import('../types').DashboardSettings; saveSettings?: () => Promise<void>; refreshAllDashboards?: () => void }> } }).plugins?.plugins?.['apex-dashboard'];
			if (plugin?.settings) {
				plugin.settings = {
					...plugin.settings,
					countdowns: (plugin.settings.countdowns ?? []).map(c => c.id === updated.id ? updated : c),
				};
				void plugin.saveSettings?.();
				plugin.refreshAllDashboards?.();
			}
		});
		modal.open();
	});

	// Content
	const content = widget.createDiv({ cls: 'dashboard-sidebar-countdown-content' });

	const targetDate = cd.targetDate;
	if (!targetDate) {
		content.createDiv({ cls: 'dashboard-sidebar-countdown-placeholder', text: t('countdown.setTarget') });
		return;
	}

	const target = targetDate.includes('T') ? new Date(targetDate) : new Date(targetDate + 'T00:00:00');
	const now = new Date();

	if (now >= target) {
		if (cd.label) {
			content.createDiv({ cls: 'dashboard-sidebar-countdown-until', text: t('countdown.untilLabel', { label: cd.label }) });
		}
		content.createDiv({ cls: 'dashboard-sidebar-countdown-expired', text: t('countdown.expired') });
		return;
	}

	const diffMs = target.getTime() - now.getTime();
	const remainDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
	const remainHours = Math.ceil(diffMs / (1000 * 60 * 60));
	const displayMode = cd.displayMode;
	const remainMinutes = Math.ceil(diffMs / (1000 * 60));
	const currentVal = displayMode === 'minutes' ? remainMinutes : displayMode === 'hours' ? remainHours : remainDays;

	// "距离xx还有" label above the number
	if (cd.label) {
		content.createDiv({ cls: 'dashboard-sidebar-countdown-until', text: t('countdown.untilLabel', { label: cd.label }) });
	}

	// Value display with flip
	const flipWrap = content.createDiv({ cls: 'dashboard-sidebar-countdown-flip' });
	const valueEl = flipWrap.createDiv({ cls: 'dashboard-sidebar-countdown-value', text: String(currentVal) });
	flipWrap.createDiv({ cls: 'dashboard-sidebar-countdown-unit', text: displayMode === 'minutes' ? t('countdown.minutes') : displayMode === 'hours' ? t('countdown.hours') : t('countdown.days') });

	// Auto-refresh with flip animation
	let prevVal = currentVal;
	const timer = window.setInterval(() => {
		if (!content.isConnected) {
			window.clearInterval(timer);
			countdownTimers.delete(timer);
			return;
		}
		const now2 = new Date();
		if (now2 >= target) {
			window.clearInterval(timer);
			countdownTimers.delete(timer);
			content.empty();
			content.createDiv({ cls: 'dashboard-sidebar-countdown-expired', text: t('countdown.expired') });
			return;
		}		const diff = target.getTime() - now2.getTime();
		const newVal = displayMode === 'minutes' ? Math.ceil(diff / (1000 * 60)) : displayMode === 'hours' ? Math.ceil(diff / (1000 * 60 * 60)) : Math.ceil(diff / (1000 * 60 * 60 * 24));
		if (newVal !== prevVal) {
			prevVal = newVal;
			valueEl.textContent = String(newVal);
			valueEl.addClass('dashboard-sidebar-countdown-value--flip');
			window.setTimeout(() => valueEl.removeClass('dashboard-sidebar-countdown-value--flip'), 400);
		}
	}, 60000);
	countdownTimers.set(timer, content);
}

function showPomodoroStats(doc: Document, service: PomodoroService): void {
	// Landscape stats modal lives in its own module (KPIs, donut, trend,
	// ranking, heatmap, recent records + tag management entry).
	openWidePomodoroStats(doc, service);
}
