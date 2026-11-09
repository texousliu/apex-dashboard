import { t } from '../../i18n';
import { registerSection } from '../registry';

/** Sticky ("便利贴"): memo and todo cards mixed in one column, plus the
 *  one-click archive and the task-template button (a template creates a todo
 *  card seeded with its tasks). */
registerSection({
	types: ['sticky'],
	// `memo` / `todo` are the retired names for this type; parse migrates them,
	// the aliases also cover hand-built legacy columns.
	aliases: ['memo', 'todo'],
	holdsCards: true,
	picker: [{ type: 'sticky', icon: 'layers', labelKey: 'renderer.typeSticky', order: 10 }],
	headerActions(ctx) {
		ctx.buttons.add({
			icon: 'archive',
			label: t('renderer.archiveTasks'),
			onClick: () => ctx.callbacks.onArchiveTasks(ctx.column.name),
		});
		ctx.buttons.add({
			icon: 'layout-template',
			label: t('template.addFromTemplate'),
			onClick: () => ctx.callbacks.onAddFromTemplate(ctx.column.name),
		});
		ctx.buttons.addCard();
		ctx.buttons.remove();
	},
	render(ctx) {
		ctx.renderCards();
	},
});

/** Notes ("项目"/"笔记"): project cards, optional covers, new-note template and
 *  save folder behind the gear. */
registerSection({
	types: ['projects'],
	// `notes` is the value older boards were written with.
	aliases: ['notes'],
	holdsCards: true,
	picker: [{ type: 'projects', icon: 'layout-grid', labelKey: 'renderer.typeNotes', order: 40 }],
	headerActions(ctx) {
		ctx.buttons.addCard();
		ctx.buttons.config('notesCfg.title');
		ctx.buttons.remove();
	},
	render(ctx) {
		ctx.renderCards();
	},
});

/** Dashboard tiles: chart / weather / tracker cards. Same card list as notes,
 *  no gear (the cards carry their own settings). The retired `alltasks` type
 *  renders the same plain card list and is kept as an alias so old boards keep
 *  their layout. */
registerSection({
	types: ['dashboard', 'alltasks'],
	holdsCards: true,
	headerActions(ctx) {
		ctx.buttons.addCard();
		ctx.buttons.remove();
	},
	render(ctx) {
		ctx.renderCards();
	},
});
