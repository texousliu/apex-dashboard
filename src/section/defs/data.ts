import { t } from '../../i18n';
import { renderCalendarSection } from '../../calendar-section';
import { renderDataviewSection, setDataviewApp } from '../../dataview-section';
import { renderRssSection } from '../../rss-section';
import { renderWebSection } from '../../web-section';
import { registerSection } from '../registry';

/** Dataview: DQL query results (TABLE / LIST / TASK / CALENDAR). */
registerSection({
	types: ['dataview'],
	picker: [{ type: 'dataview', icon: 'table-2', labelKey: 'renderer.typeDataview', order: 50 }],
	headerActions(ctx) {
		// Manual refresh only: a dataview card is a snapshot and deliberately
		// stays off the vault-change debounce.
		ctx.buttons.refresh('dataview.refresh');
		ctx.buttons.config('dataview.configure');
		ctx.buttons.remove();
	},
	render(ctx) {
		setDataviewApp(ctx.app);
		renderDataviewSection(
			ctx.el,
			ctx.column,
			ctx.app,
			ctx.hoverParent,
			// onOpenNoteAtLine is the calendar's task-jump channel: TASK rows open
			// the popover at their own source line instead of the note top.
			ctx.callbacks.onOpenNoteInPopover ?? null,
			ctx.callbacks.onOpenNoteAtLine ?? null,
			(fn) => ctx.setReload(fn),
			(cfg) => ctx.callbacks.onDataviewConfigChange(ctx.column.name, cfg),
		);
	},
});

/** Web: an embedded page. Frameable sites load in an iframe; sites whose
 *  headers refuse framing load in a desktop webview (see web-section). */
registerSection({
	types: ['web'],
	picker: [{ type: 'web', icon: 'globe', labelKey: 'renderer.typeWeb', order: 130 }],
	// The frame fills the row: the row needs an inline height so a drag-resized
	// section can also grow past the CSS default.
	fixedHeight: true,
	headerActions(ctx) {
		ctx.buttons.refresh('web.refresh');
		ctx.buttons.config('web.configure');
		ctx.buttons.remove();
	},
	render(ctx) {
		renderWebSection(ctx.el, ctx.column, (fn) => ctx.setReload(fn));
	},
});

/** RSS: subscription list (reverse-chronological rows, reader modal, per-row
 *  download). */
registerSection({
	types: ['rss'],
	picker: [{ type: 'rss', icon: 'rss', labelKey: 'renderer.typeRss', order: 100 }],
	headerActions(ctx) {
		// Historically shares the web label key: both refresh a remote document.
		ctx.buttons.refresh('web.refresh');
		ctx.buttons.config('rss.configure');
		ctx.buttons.remove();
	},
	render(ctx) {
		renderRssSection(ctx.el, ctx.column, ctx.app, (fn) => ctx.setReload(fn));
	},
});

/** Calendar: the sidebar calendar's enlarged view (month grid with multi-day
 *  bars, week time grid). Shares the widget's scan and refreshes in place on
 *  vault task changes. */
registerSection({
	types: ['calendar'],
	picker: [{ type: 'calendar', icon: 'calendar-days', labelKey: 'renderer.typeCalendar', order: 90 }],
	headerActions(ctx) {
		ctx.buttons.remove();
	},
	render(ctx) {
		if (ctx.settings) renderCalendarSection(ctx.el, ctx.app, ctx.settings, ctx.callbacks.onOpenNoteAtLine);
		else ctx.el.createDiv({ cls: 'dashboard-library-empty', text: t('calendar.noEvents') });
	},
});
