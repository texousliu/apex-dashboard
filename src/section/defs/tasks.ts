import { t } from '../../i18n';
import { renderSkillSection } from '../../skill-section';
import { renderTickTickSection } from '../../ticktick-section';
import { renderWereadSection } from '../../weread-section';
import { registerSection } from '../registry';

/** TickTick: tasks / habits from the unofficial V2 API (cookie auth). */
registerSection({
	types: ['ticktick'],
	picker: [{ type: 'ticktick', icon: 'check-circle', labelKey: 'renderer.typeTickTick', order: 150 }],
	headerActions(ctx) {
		const view = ctx.column.ticktickConfig?.view === 'lists' ? 'lists' : 'today';
		const dispatchView = (next: 'today' | 'lists') => {
			ctx.el.dispatchEvent(new CustomEvent('dashboard-ticktick-view', {
				detail: { columnName: ctx.column.name, view: next },
				bubbles: true,
			}));
		};

		ctx.buttons.add({
			icon: 'calendar-check',
			label: t('ticktick.viewToday'),
			cls: view === 'today' ? 'active' : undefined,
			onClick: () => dispatchView('today'),
		});
		ctx.buttons.add({
			icon: 'list',
			label: t('ticktick.viewLists'),
			cls: view === 'lists' ? 'active' : undefined,
			onClick: () => dispatchView('lists'),
		});
		// The project filter only makes sense on the lists view.
		if (view === 'lists') {
			ctx.buttons.add({
				icon: 'filter',
				label: t('ticktick.filterProjects'),
				onClick: () => ctx.el.dispatchEvent(new CustomEvent('dashboard-ticktick-filter', {
					detail: { columnName: ctx.column.name },
					bubbles: true,
				})),
			});
		}
		ctx.buttons.refresh('ticktick.refresh');
		ctx.buttons.remove();
	},
	render(ctx) {
		const settings = ctx.settings;
		renderTickTickSection(
			ctx.el,
			ctx.column,
			ctx.app,
			settings?.ticktickRegion === 'ticktick' ? 'ticktick' : 'dida365',
			(settings?.ticktickCookie ?? '').trim(),
			(settings?.ticktickCsrf ?? '').trim(),
			settings?.ticktickDeviceVersion,
			(settings?.ticktickTimezone ?? '').trim() || 'Asia/Shanghai',
			(fn) => ctx.setReload(fn),
			(projectId, width) => {
				const cfg = ctx.column.ticktickConfig;
				if (!cfg) return;
				const projectWidths = { ...(cfg.projectWidths ?? {}), [projectId]: width };
				ctx.el.dispatchEvent(new CustomEvent('dashboard-ticktick-resize', {
					detail: { columnName: ctx.column.name, projectWidths },
					bubbles: true,
				}));
			},
		);
	},
});

/** Weread: reading data from the official API, with a markdown import folder. */
registerSection({
	types: ['weread'],
	picker: [{ type: 'weread', icon: 'book-open', labelKey: 'renderer.typeWeread', order: 140 }],
	headerActions(ctx) {
		ctx.buttons.config('weread.configure');
		ctx.buttons.refresh('weread.refresh');
		ctx.buttons.remove();
	},
	render(ctx) {
		renderWereadSection(
			ctx.el,
			ctx.column,
			ctx.app,
			(ctx.settings?.wereadApiKey ?? '').trim(),
			ctx.settings?.wereadImportPath ?? 'Weread/划线',
			(fn) => ctx.setReload(fn),
		);
	},
});

/** Skills: AI-skill library (aggregated cards with source badges, per-store
 *  launch buttons, import / detail / reveal / trash, pinned skills). */
registerSection({
	types: ['skills'],
	picker: [{ type: 'skills', icon: 'wand-sparkles', labelKey: 'renderer.typeSkills', order: 80 }],
	headerActions(ctx) {
		// view.ts opens the one-time creator config on the first click.
		ctx.buttons.add({
			icon: 'plus',
			label: t('skills.createSkill'),
			onClick: () => ctx.el.dispatchEvent(new CustomEvent('dashboard-skills-create', {
				detail: { columnName: ctx.column.name },
				bubbles: true,
			})),
		});
		ctx.buttons.refresh('skills.refresh');
		ctx.buttons.config('skills.cfgTitle');
		ctx.buttons.remove();
	},
	render(ctx) {
		renderSkillSection(ctx.el, ctx.column, ctx.app, ctx.settings, (fn) => ctx.setReload(fn));
	},
});
