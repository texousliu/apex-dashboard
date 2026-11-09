/**
 * Dashboard rendering entry point.
 *
 * Phase 4 split the original 4557-line file by responsibility; everything now
 * lives under `src/render/`. What is left here is deliberate:
 *
 * 1. `renderDashboard` — the board pass: stamp the ambient link context, draw
 *    the quick-note bar, then one section per column plus the ghost tile.
 * 2. `destroyAllCharts` — the pre-render teardown (charts + countdown ticks).
 * 3. The public surface existing importers already use (`view.ts`,
 *    `calendar-*.ts`, `main.ts` and the verify scripts). Re-exporting instead
 *    of rewriting call sites keeps the split reviewable as "movement only".
 */
import { App, Component } from 'obsidian';
import type { HoverParent } from 'obsidian';
import type { DashboardData, RenderCallbacks, DashboardSettings } from './types';
import { t } from './i18n';
import { renderQuickNoteRegion } from './quick-note-section';
import type { PreserveScope } from './preserve-scope';
import { destroyAllChartInstances } from './render/tracker-chart';
import { linkContext } from './render/link-context';
import { isImmersiveLayout } from './render/widget-mount';
import { renderSection } from './render/section-frame';
import { destroyIdleCountdownTimers } from './render/sidebar-widgets';

// --- Public surface -------------------------------------------------------
// Reading tracker (also used by reading-mini-timer).
export { renderSidebarReading, refreshSidebarReadingWidget, openEndReadingModal } from './render/sidebar-reading';
// Inline links + note resolution (used by calendar-grid / calendar-modal /
// calendar-widget / main).
export { renderTextWithLinks } from './render/text-links';
export { teardownBasenameIndex } from './render/note-index';
// Task rows.
export { readTaskPath } from './render/task-row';
// Sticky notes.
export { memoMarkdownSource, renderMemoMarkdown } from './render/memo';
// Sidebar widgets: the stateful trio, plus the card bodies that own their own
// fetch/refresh (weather cards, tracker cards).
export { renderSidebarWeather, renderSidebarPomodoro, renderSidebarCountdown, refreshSidebarWeatherWidget } from './render/sidebar-widgets';
export { refreshWeatherCards, renderCard } from './render/card';
// Widget mounting and layout resolution.
export {
	renderSidebarWidgets,
	buildWidgetEntries,
	sortWidgetEntries,
	mountWidgetCard,
	sidebarWidgetSignature,
	resolveEffectiveLayout,
	isImmersiveLayout,
	isStackedLayout,
	DEFAULT_WIDGET_ORDER,
	renderSidebarWeekCalendar,
} from './render/widget-mount';
export type { WidgetBuildDeps } from './render/widget-mount';
// Section frame + in-place refresh paths.
export { renderSection, applyPairWidth } from './render/section-frame';
export { refreshScanningSections, refreshMediaSections, invalidateScanningSectionSignatures } from './render/section-refresh';

/** Destroy chart instances and idle countdown timers ahead of a re-render.
 *  `preserveWidgets` is the detached-but-reused sidebar widgets element from the
 *  previous render (see renderSidebarWidgets): timers animating its countdowns
 *  survive so the re-attached DOM keeps ticking. Timers are also self-cleaning
 *  (they check isConnected), so any survivors of a discarded DOM unwind themselves. */
export function destroyAllCharts(preserveWidgets?: PreserveScope): void {
	destroyAllChartInstances();
	destroyIdleCountdownTimers(preserveWidgets);
}

export function renderDashboard(
	container: HTMLElement,
	data: DashboardData,
	callbacks: RenderCallbacks,
	app: App,
	settings?: DashboardSettings,
	hoverParent: HoverParent | null = null,
	opts?: { skipQuickNotes?: boolean },
): void {
	linkContext.hoverParent = hoverParent;
	linkContext.noteOpener = callbacks.onOpenNoteInPopover ?? null;
	// The dashboard view doubles as the markdown Component (ItemView extends
	// Component); other hover-parent callers fall back to plain memo lines.
	linkContext.markdownComponent = hoverParent instanceof Component ? hoverParent : null;

	container.empty();
	container.addClass('dashboard-kanban');

	// Quick Notes region: pinned at the top, above all sections (non-reorderable).
	// Stacked layout hoists it out of the kanban entirely — the view renders it
	// above the widget strip instead (skipQuickNotes), because the kanban sits
	// below the strip there and the bar must stay directly under the banner.
	if (settings?.quickNotesEnabled && !opts?.skipQuickNotes) {
		renderQuickNoteRegion(container, settings, callbacks, app);
	}

	for (const column of data.columns) {
		const section = renderSection(column, callbacks, app, data, settings);
		container.appendChild(section);
	}

	const addColBtn = container.createDiv({ cls: 'dashboard-add-section' });
	// Immersive boards have no "sections" — every tile is a card, so the
	// ghost tile speaks the card language too.
	addColBtn.setText(settings && isImmersiveLayout(settings, data)
		? t('renderer.addCard')
		: t('renderer.addSection'));
	addColBtn.setAttribute('role', 'button');
	addColBtn.addEventListener('click', () => {
		callbacks.onRequestAddSection();
	});
}
