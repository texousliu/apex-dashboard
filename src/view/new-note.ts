/**
 * "New note" for a section or for one card — both buttons, one module.
 *
 * Extracted from `view.ts` (Phase 5). The two entry points differ only in
 * where the note lands and how it opens:
 *
 * | | folder / library section | notes / projects card |
 * | --- | --- | --- |
 * | folder | section folders, else `settings.libraryNewNotePath` | the card's `sectionNewNoteFolder` |
 * | frontmatter | `buildNewNoteProps` (mirrors the property filters) | none |
 * | attaches to | nothing — the section scan picks it up | the card's doc list |
 * | opens as | tab unless `newNoteOpenMode: 'popover'` | popover unless `newNoteOpenMode: 'tab'` |
 *
 * Note the last row inverts, and that inversion is real (deliberate, per
 * surface history), not a bug: library sections historically opened a real
 * tab, cards historically open the in-dashboard editor.
 *
 * Both flows share the same four steps — resolve folder → optional template
 * picker → title prompt → create (with a bare-note fallback when the template
 * is gone) — and both need the same reentrancy guard: a second click while the
 * prompt is open would stack a second dialog, which is a known bug class here.
 *
 * The in-flight flags live in a caller-owned `NewNoteState` rather than at
 * module scope: two dashboard leaves in one vault must be able to prompt
 * independently. Module scope would make the second leaf's click a no-op
 * while the first leaf's dialog is open.
 */
import { App, Notice, TFile } from 'obsidian';
import { t } from '../i18n';
import {
	buildNewNoteProps,
	createNoteWithProps,
	pickFolderFromMenu,
	pickTemplateFromMenu,
	sectionNewNoteFolder,
	sectionTemplatePaths,
} from '../library-new-note';
import { showPromptDialog } from '../prompt-dialog';
import type { SyncEngine } from '../sync';
import type { DashboardCard, DashboardColumn, DashboardData } from '../types';

/** What the two new-note flows need from the view. */
export interface NewNoteHost {
	app: App;
	/** Read per call: the card/column lookup must see the current board. */
	data(): DashboardData | null;
	sync(): SyncEngine;
	/** Fallback folder for library sections with no scan folders configured. */
	libraryNewNotePath(): string;
	/** In-dashboard editor (the card-flow default). */
	openNotePopover(file: TFile): void;
	/** Explicit refresh of one scanning section (see `refreshSectionAfterCreate`). */
	refreshSectionInPlace(columnName: string): boolean;
}

/** Per-leaf reentrancy guards. Owned by the view, mutated only here. */
export interface NewNoteState {
	libraryInFlight: boolean;
	cardInFlight: boolean;
}

export function createNewNoteState(): NewNoteState {
	return { libraryInFlight: false, cardInFlight: false };
}

/**
 * Refresh one scanning section once a just-created note is metadata-indexed
 * (frontmatter resolved). Polling the cache — instead of refreshing
 * immediately — keeps a filter-matching note from being rendered invisible by
 * an unindexed first pass; a 2s cap means a cache-less edge case still
 * refreshes rather than never.
 */
async function refreshSectionAfterCreate(host: NewNoteHost, columnName: string, file: TFile): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < 2000 && !host.app.metadataCache.getFileCache(file)) {
		await new Promise(resolve => window.setTimeout(resolve, 50));
	}
	host.refreshSectionInPlace(columnName);
}

/**
 * Create a note whose template may no longer exist: fall back to a bare note
 * and tell the user, rather than failing the whole creation.
 */
async function createWithTemplateFallback(
	host: NewNoteHost,
	folder: string,
	title: string,
	props: Record<string, string | string[]>,
	templatePath: string | undefined,
): Promise<TFile> {
	try {
		return await createNoteWithProps(host.app, folder, title, props, templatePath || undefined);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith('Template not found')) {
			new Notice(t('quickNote.templateNotFound'));
			return createNoteWithProps(host.app, folder, title, props);
		}
		throw err;
	}
}

/**
 * Per-card "new note" (notes/projects sections): prompt for a title, create
 * the note from the section's settings (template + save folder; vault root
 * when no folder is configured), attach it to the card's doc list, and open
 * it. Several configured templates first offer a picker menu at the click
 * point (dismissal falls back to the first entry).
 */
export async function cardNewNote(
	host: NewNoteHost,
	state: NewNoteState,
	cardId: string,
	pos?: { x: number; y: number },
): Promise<void> {
	if (state.cardInFlight) return;
	state.cardInFlight = true;
	try {
		let found: { column: DashboardColumn; card: DashboardCard } | null = null;
		for (const column of host.data()?.columns ?? []) {
			const card = column.cards.find(c => c.id === cardId);
			if (card) { found = { column, card }; break; }
		}
		if (!found) return;
		const { column, card } = found;

		const folder = sectionNewNoteFolder(column.libraryConfig);
		const templates = sectionTemplatePaths(column.libraryConfig);
		let templatePath = templates[0];
		if (templates.length > 1 && pos) {
			// Menu dismissed without a pick: the documented default (first).
			templatePath = (await pickTemplateFromMenu(templates, pos)) ?? templates[0];
		}
		const title = await showPromptDialog(host.app, {
			title: t('quickNote.titlePrompt'),
			placeholder: t('quickNote.titlePlaceholder'),
		});
		if (title == null) return; // cancelled (empty submit cancels too)

		try {
			const file = await createWithTemplateFallback(host, folder, title, {}, templatePath);
			await host.sync().addDocToCard(card.id, file.path);
			// Open the fresh note per the card's config (card edit modal): the
			// in-dashboard popover editor by default — identical to clicking one
			// of the card's docs — or a real editor tab.
			if (card.newNoteOpenMode === 'tab') {
				await host.app.workspace.getLeaf('tab').openFile(file);
			} else {
				host.openNotePopover(file);
			}
			new Notice(t('quickNote.created', { name: file.basename }));
		} catch (err) {
			console.error('[Dashboard] card new note failed:', err);
			new Notice(t('library.newNoteFailed'));
		}
	} finally {
		state.cardInFlight = false;
	}
}

/**
 * Toolbar "new note": folder sections create inside their configured folder
 * (menu when several); library sections create at
 * `settings.libraryNewNotePath` with the section's property filters
 * pre-filled so the note matches them. Several configured templates offer a
 * picker menu at the click point (dismissal falls back to the first entry). A
 * library section with hand-authored scan folders (dashboard-file YAML)
 * follows the folder branch — `queryVaultFiles` scopes its results to those
 * folders, so the global path would hide the note.
 *
 * The section refresh is explicit (`refreshSectionAfterCreate`, once the
 * note's frontmatter is indexed): the vault-'create' debounce alone freezes
 * whole-vault scans on immersive boards, and the tab path only masked that
 * because the workspace switch-in did a full re-render.
 */
export async function libraryNewNote(
	host: NewNoteHost,
	state: NewNoteState,
	columnName: string,
	pos?: { x: number; y: number },
): Promise<void> {
	if (state.libraryInFlight) return;
	state.libraryInFlight = true;
	try {
		const column = host.data()?.columns.find(c => c.name === columnName);
		if (!column || (column.sectionType !== 'folder' && column.sectionType !== 'library')) return;

		const folders = (column.libraryConfig?.folders ?? [])
			.map(f => f.trim().replace(/^\/+|\/+$/g, ''))
			.filter(f => f.length > 0);
		let folder: string;
		if (column.sectionType === 'folder' || folders.length > 0) {
			if (folders.length === 0) {
				new Notice(t('library.newNoteNoFolder'));
				return;
			}
			if (folders.length === 1) {
				folder = folders[0]!;
			} else {
				if (!pos) return;
				folder = (await pickFolderFromMenu(folders, pos)) ?? '';
				if (!folder) return; // menu dismissed
			}
		} else {
			folder = host.libraryNewNotePath().trim().replace(/^\/+|\/+$/g, '');
		}

		// Template picker: only when several are configured. Dismissed without
		// a pick → the documented default (first entry).
		const templates = sectionTemplatePaths(column.libraryConfig);
		let templatePath = templates[0];
		if (templates.length > 1 && pos) {
			templatePath = (await pickTemplateFromMenu(templates, pos)) ?? templates[0];
		}

		const title = await showPromptDialog(host.app, {
			title: t('quickNote.titlePrompt'),
			placeholder: t('quickNote.titlePlaceholder'),
		});
		if (title == null) return; // cancelled (empty submit cancels too — same as presets)

		const { props, skipped } = buildNewNoteProps(column.libraryConfig);
		try {
			const file = await createWithTemplateFallback(host, folder, title, props, templatePath);
			// Open the fresh note per the section's config (library config
			// modal): a real editor tab — the historical library behavior — or
			// the in-dashboard popover editor when opted in.
			if (column.libraryConfig?.newNoteOpenMode === 'popover') {
				host.openNotePopover(file);
			} else {
				await host.app.workspace.getLeaf('tab').openFile(file);
			}
			// The vault-'create' debounce alone cannot be trusted to show the
			// note: immersive boards freeze whole-vault scans on vault events
			// (anti-strobing), and the tab path only looked alive because the
			// switch-in full render masked it. Refresh the section explicitly
			// once the note's frontmatter is indexed — an immediate pass could
			// beat the cache and hide a filter-matching note.
			void refreshSectionAfterCreate(host, column.name, file);
			new Notice(t('quickNote.created', { name: file.basename }));
			if (skipped.length > 0) {
				new Notice(t('library.newNoteSkipped', { props: skipped.join(', ') }));
			}
		} catch (err) {
			console.error('[Dashboard] library new note failed:', err);
			new Notice(t('library.newNoteFailed'));
		}
	} finally {
		state.libraryInFlight = false;
	}
}
