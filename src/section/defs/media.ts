import { t } from '../../i18n';
import { renderLibrarySection } from '../../library-section';
import { renderMediaSection } from '../../media-section';
import { getMediaTagService } from '../../media-tags';
import { registerSection } from '../registry';
import { renderSectionState } from '../state';

/** Library / folder: note cards with the section's own toolbar. A folder
 *  section with no folder set would list the entire vault (the foldaer filter
 *  is skipped when empty), so it renders an explanation plus a header gear
 *  instead of calling the renderer. */
function folderUnconfigured(ctx: { type: string; column: { libraryConfig?: { folders?: string[] } } }): boolean {
	if (ctx.type !== 'folder') return false;
	const folders = ctx.column.libraryConfig?.folders;
	return !(folders && folders.some(f => f.trim()));
}

registerSection({
	types: ['library', 'folder'],
	scan: 'files',
	picker: [
		{ type: 'folder', icon: 'folder', labelKey: 'renderer.typeFolder', order: 20 },
		{ type: 'library', icon: 'database', labelKey: 'renderer.typeLibrary', order: 30 },
	],
	headerActions(ctx) {
		// A configured folder (and any library) renders the config button in its
		// own toolbar; adding one here would duplicate it beside the trash.
		if (folderUnconfigured(ctx)) ctx.buttons.config('folder.configure');
		ctx.buttons.remove();
	},
	render(ctx) {
		if (folderUnconfigured(ctx)) {
			renderSectionState(ctx.el, {
				icon: 'folder',
				text: t('folder.empty'),
				legacyClass: 'dashboard-library-empty dashboard-folder-empty',
			});
			return;
		}
		renderLibrarySection(ctx.el, ctx.column, ctx.app, (config) => {
			ctx.callbacks.onLibraryConfigChange(ctx.column.name, config);
		}, ctx.hoverParent, ctx.openNoteInPopover);
	},
});

/** Images / videos: full-vault thumbnail wall. The gear manages the excluded
 *  folder set through the same config route as library sections. */
registerSection({
	types: ['images', 'videos'],
	scan: 'media',
	picker: [
		{ type: 'images', icon: 'image', labelKey: 'renderer.typeImages', order: 110 },
		{ type: 'videos', icon: 'video', labelKey: 'renderer.typeVideos', order: 120 },
	],
	headerActions(ctx) {
		ctx.buttons.config('media.configure');
		ctx.buttons.remove();
	},
	render(ctx) {
		renderMediaSection(
			ctx.el,
			ctx.column,
			ctx.app,
			ctx.hoverParent,
			ctx.callbacks.onOpenNoteInPopover,
			getMediaTagService() ?? undefined,
		);
	},
});
