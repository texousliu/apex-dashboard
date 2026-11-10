/**
 * The two paths that write into the USER'S notes (as opposed to the board's own
 * data file). Moved out of `view.ts` (Phase 5).
 *
 * Both are "compute → write → report": the view's job is to know *when* (a
 * button, a menu item), this module's job is everything after that. Kept
 * together because they share the failure discipline that makes them safe:
 *
 * - **Write before mutating the board.** `archiveCompletedTasks` appends the
 *   running log first and only then clears the completed tasks. If the write
 *   throws, the tasks are still on the board — a retry is possible, nothing is
 *   lost. The reverse order (clear, then fail to log) silently deletes work.
 * - **Merge, never overwrite.** `saveTasksToDaily` folds the card's tasks into
 *   the existing heading block: card entries update, new ones append, and lines
 *   that exist only in the note (hand-added, or removed from the card) are left
 *   alone. Absent heading → prepend a block after the frontmatter.
 * - **Say where it went.** Both end with a Notice carrying the destination
 *   path, because the destination is configurable and "saved" alone leaves the
 *   user hunting.
 *
 * Every early return before the write is a *deliberate* abort (nothing to do,
 * daily notes not configured, user cancelled) and leaves the board untouched.
 */
import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../i18n';
import { nowMoment } from '../datetime';
import { showConfirmDialog } from '../confirm-dialog';
import { ensureFolder, getOrCreateDailyNote } from '../daily-notes';
import { dailyBlockHeading, mergeDailyTasksBlock } from '../daily-note-block';
import { retitleCardBlock } from '../daily-task-source';
import { archiveCompleted, serializeTasksForNote } from '../task-tree';
import type { SyncEngine } from '../sync';
import type { DashboardCard, DashboardData, DashboardSettings } from '../types';

/** What these two writes need from the view. */
export interface TaskWriteHost {
	app: App;
	/** Fresh board data; null while the board is switching. */
	data(): DashboardData | null;
	settings(): DashboardSettings;
	/** Board mutation for the archive path (removes the archived tasks). */
	sync(): SyncEngine;
}

interface DailyNotesOptions {
	folder?: string;
	format?: string;
}

interface DailyNotesPlugin {
	enabled?: boolean;
	instance?: { options?: DailyNotesOptions };
}

/** Read the core "Daily notes" plugin handle (folder/format live on instance.options). */
function getDailyNotesPlugin(app: App): DailyNotesPlugin | undefined {
	const internalPlugins = (app as unknown as {
		internalPlugins?: { getPluginById?: (id: string) => DailyNotesPlugin | undefined };
	}).internalPlugins;
	return internalPlugins?.getPluginById?.('daily-notes');
}

/** Insert `block` right after the YAML frontmatter (or at the very top when there
 *  is none), preserving the original frontmatter text verbatim. */
function prependAfterFrontmatter(md: string, block: string): string {
	const fmMatch = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (fmMatch) {
		const header = fmMatch[0];
		const body = md.slice(header.length).replace(/^\s+/, '');
		return body ? `${header}${block}\n\n${body}` : `${header}${block}\n`;
	}
	const body = md.replace(/^\s+/, '');
	return body ? `${block}\n\n${body}` : `${block}\n`;
}

/**
 * Card toolbar → "save tasks to today's daily note".
 *
 * Re-saving is the common case (the card is edited, then saved again), so the
 * interesting branch is the existing note: retitle the old block first (a
 * heading-level change would otherwise leave a duplicate copy behind), then
 * merge the card's state into it.
 */
export async function saveTasksToDaily(host: TaskWriteHost, card: DashboardCard): Promise<void> {
	try {
		if (!card.tasks || card.tasks.length === 0) {
			new Notice(t('notice.noTasksToSave'));
			return;
		}

		// Locate today's daily note via the core "Daily notes" plugin settings.
		const dailyPlugin = getDailyNotesPlugin(host.app);
		const options = dailyPlugin?.instance?.options;
		if (!dailyPlugin?.enabled || !options) {
			new Notice(t('notice.dailyNotesDisabled'), 5000);
			return;
		}

		const folder = (options.folder || '').trim().replace(/^\/+|\/+$/g, '');
		const format = options.format || 'YYYY-MM-DD';
		const dateStr = nowMoment().format(format);
		const fileName = `${dateStr}.md`;
		const path = folder ? `${folder}/${fileName}` : fileName;

		const title = card.title?.trim() || t('notice.memoUntitled');
		// Heading depth is per-card config (default ### Title).
		const heading = dailyBlockHeading(title, card.dailyHeadingLevel ?? 3);
		const block = `${heading}\n${serializeTasksForNote(card.tasks)}`;

		if (folder) await ensureFolder(host.app, folder);

		const existing = host.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			// A heading-level change moves the old block instead of leaving a
			// stale copy behind (which would duplicate the task list).
			try {
				await retitleCardBlock(host.app, existing, title, card.dailyHeadingLevel ?? 3);
			} catch (err) {
				console.error('[Dashboard] retitle daily block failed:', err);
			}
			const raw = await host.app.vault.read(existing);
			// Merge, don't overwrite: existing entries are updated to the
			// card's state, new card entries are appended, and task lines
			// that exist only in the note (hand-added / removed from the
			// card) are left untouched. Absent heading → prepend a block.
			const { content, replaced } = mergeDailyTasksBlock(raw, heading, card.tasks);
			if (replaced) {
				await host.app.vault.modify(existing, content);
			} else {
				await host.app.vault.modify(existing, prependAfterFrontmatter(raw, block));
			}
		} else {
			await host.app.vault.create(path, `${block}\n`);
		}
		new Notice(t('notice.tasksSavedToDaily', { path }), 4000);
	} catch (err) {
		console.error('[Dashboard] saveTasksToDaily failed:', err);
		new Notice(t('notice.dailySaveError'), 4000);
	}
}

/**
 * Section header menu → "archive completed tasks".
 *
 * Two phases on purpose: collect what would be archived and confirm with the
 * count, then write the log, then clear the board. The count in the confirm
 * dialog is computed by running the same `archiveCompleted` that the write
 * uses, so "3 tasks" always matches what lands in the log.
 */
export async function archiveCompletedTasks(host: TaskWriteHost, columnName: string): Promise<void> {
	try {
		const data = host.data();
		if (!data) return;
		const column = data.columns.find((c) => c.name === columnName);
		if (!column) return;

		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

		const entries: Array<{ task: string; card: string }> = [];
		for (const card of column.cards) {
			const { archived } = archiveCompleted(card.tasks);
			if (archived.length === 0) continue;
			const cardTitle = card.title?.trim() || t('notice.memoUntitled');
			for (const item of archived) {
				entries.push({ task: item.text, card: cardTitle });
			}
		}

		if (entries.length === 0) {
			new Notice(t('notice.archiveEmpty'));
			return;
		}

		const confirmed = await showConfirmDialog(host.app, {
			title: t('renderer.archiveTasks'),
			message: t('notice.archiveConfirm', { count: entries.length }),
		});
		if (!confirmed) return;

		// Write the running log before mutating the board: if the write fails,
		// the tasks stay on the board (no data loss). Destination is either
		// today's daily note (created from the daily-notes template when
		// missing; a stale blank note is template-rescued) or the configured
		// fixed file with auto-created folders.
		const lines = entries.map((e) => t('notice.archiveLine', { time, task: e.task, card: e.card }));
		const appendText = `${lines.join('\n')}\n`;

		let destFile: TFile;
		const settings = host.settings();
		if (settings.taskArchiveTarget === 'daily') {
			const note = await getOrCreateDailyNote(host.app, nowMoment().format('YYYY-MM-DD'));
			if (!note) {
				// Daily notes not configured / path unresolvable: abort BEFORE
				// removing anything from the board.
				new Notice(t('notice.archiveDailyUnavailable'), 4000);
				return;
			}
			destFile = note;
		} else {
			const configured = settings.taskArchivePath.trim().replace(/^\/+|\/+$/g, '');
			// The vault only indexes markdown by extension. A path typed without
			// `.md` used to create an extension-less file the explorer never
			// shows — the archived tasks "vanished" with a success notice.
			const base = configured || '归档/已完成';
			const fullPath = /\.[a-z0-9]+$/i.test(base) ? base : `${base}.md`;
			const slash = fullPath.lastIndexOf('/');
			const folder = slash >= 0 ? fullPath.slice(0, slash) : '';
			if (folder) await ensureFolder(host.app, folder);
			const existing = host.app.vault.getAbstractFileByPath(fullPath);
			destFile = existing instanceof TFile ? existing : await host.app.vault.create(fullPath, '');
		}

		const raw = await host.app.vault.read(destFile);
		const sep = raw === '' || raw.endsWith('\n') ? '' : '\n';
		await host.app.vault.modify(destFile, `${raw}${sep}${appendText}`);

		await host.sync().archiveTasks(columnName);

		new Notice(t('notice.archived', { count: entries.length, path: destFile.path }), 4000);
	} catch (err) {
		console.error('[Dashboard] archiveCompletedTasks failed:', err);
		new Notice(t('notice.archiveError'), 4000);
	}
}
