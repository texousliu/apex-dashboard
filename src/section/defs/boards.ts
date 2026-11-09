import { Menu, Platform } from 'obsidian';
import { t } from '../../i18n';
import { renderPipelineSection } from '../../pipeline-section';
import { renderPmSection } from '../../pm-section';
import type { SectionContext } from '../registry';
import { registerSection } from '../registry';

type PipelineSortBy = 'mtime' | 'ctime' | 'platform' | 'name' | 'manual';

/** Within-stage card order: one fixed icon, the chosen mode as text beside it. */
function addPipelineSortButton(ctx: SectionContext): void {
	const current = ctx.column.pipelineConfig?.sortBy ?? 'mtime';
	const labelKey = current === 'ctime' ? 'pipeline.sortCtime'
		: current === 'platform' ? 'pipeline.sortPlatform'
			: current === 'name' ? 'pipeline.sortName'
				: current === 'manual' ? 'pipeline.sortManual' : null;

	const btn = ctx.buttons.add({
		icon: 'arrow-down-up',
		label: t('pipeline.sortBy'),
		cls: 'dashboard-pipeline-sort-btn',
		onClick: (e) => {
			e.stopPropagation();
			const options: Array<{ value: PipelineSortBy; label: string }> = [
				{ value: 'mtime', label: t('pipeline.sortMtime') },
				{ value: 'ctime', label: t('pipeline.sortCtime') },
				{ value: 'platform', label: t('pipeline.sortPlatform') },
				{ value: 'name', label: t('pipeline.sortName') },
				{ value: 'manual', label: t('pipeline.sortManual') },
			];
			const menu = new Menu();
			for (const opt of options) {
				menu.addItem(item => {
					item.setTitle(opt.label).onClick(() => {
						if (opt.value === current) return;
						btn.dispatchEvent(new CustomEvent('dashboard-pipeline-sort', {
							detail: { columnName: ctx.column.name, sortBy: opt.value === 'mtime' ? undefined : opt.value },
							bubbles: true,
						}));
					});
					if (opt.value === current) item.setIcon('check');
				});
			}
			menu.showAtMouseEvent(e);
		},
	});
	btn.title = t('pipeline.sortBy');
	if (labelKey) btn.createSpan({ cls: 'dashboard-pipeline-sort-label', text: t(labelKey) });
}

/** Pipeline: agent-driven workflow board (stage columns, drag-to-advance,
 *  skill dispatch). */
registerSection({
	types: ['pipeline'],
	scan: 'files',
	picker: [{ type: 'pipeline', icon: 'workflow', labelKey: 'renderer.typePipeline', order: 70 }],
	headerActions(ctx) {
		addPipelineSortButton(ctx);
		ctx.buttons.config('pipeline.cfgTitle');
		ctx.buttons.remove();
	},
	render(ctx) {
		// Phones and tablets cannot host the agent skills this section
		// dispatches — hide it entirely there (desktop-only feature).
		if (Platform.isMobile) {
			ctx.el.addClass('dashboard-section-row--pipeline-off-mobile');
			return;
		}
		renderPipelineSection(ctx.el, ctx.column, ctx.app, ctx.callbacks, ctx.hoverParent);
	},
});

/** PM: one card per project note, with the board modal, work notes, skills,
 *  archive/delete. Data-first (notes + metadata cache), so it runs on mobile
 *  too — card drag-reorder is HTML5 DnD and stays inert on touch. */
registerSection({
	types: ['pm'],
	scan: 'files',
	picker: [{ type: 'pm', icon: 'briefcase', labelKey: 'renderer.typePm', order: 60 }],
	headerActions(ctx) {
		const emit = (name: string) => () => ctx.el.dispatchEvent(new CustomEvent(name, {
			detail: { columnName: ctx.column.name },
			bubbles: true,
		}));
		ctx.buttons.add({ icon: 'plus', label: t('pm.new'), onClick: emit('dashboard-pm-new') });
		ctx.buttons.add({ icon: 'archive', label: t('pm.archive.title'), onClick: emit('dashboard-pm-archive') });
		ctx.buttons.config('pm.cfgTitle');
		ctx.buttons.remove();
	},
	render(ctx) {
		renderPmSection(ctx.el, ctx.column, ctx.app);
	},
});
