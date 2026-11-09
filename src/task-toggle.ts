import { App, Notice, TFile } from 'obsidian';
import { toggleTaskInFile, type VaultTask } from './alltasks-scan';
import { invalidatePath } from './dql/page-builder';
import { t } from './i18n';

/**
 * The ONE write path for "flip a task's checkbox in its source note" — the
 * persistence half of the task-toggle gesture. Every surface that shows vault
 * tasks (dataview rows, the calendar section/widget, the day agendas) used to
 * call `toggleTaskInFile` + `invalidatePath` itself, each with its own error
 * handling (Notice / console.error / swallowed) and NO coordination between
 * them: two cards showing the same task, or two quick clicks, could interleave
 * their read-modify-writes and the later write would restore the earlier state.
 *
 * The optimistic DOM half deliberately stays per-surface (each list mirrors
 * the flip differently — dataview prunes rows, the todo card reorders, the
 * agenda flips a class); this module only owns WRITE + QUEUE + FAILURE.
 *
 * The todo-list cards keep their own persist (`sync.toggleTaskQuiet`): they
 * write the dashboard data file + the daily-note mirror, a different artifact
 * with its own serialization there.
 */

/** The minimal locator one toggle write needs. `line` / `originalLine` are
 *  updated IN PLACE on success (by the writer) so in-place surfaces that keep
 *  toggling the SAME task object stay truthful without a re-scan. */
export interface TaskToggleTarget {
	/** Vault path — used for the scan-cache invalidation. */
	path: string;
	/** Resolved file to write. */
	file: TFile;
	/** 0-based line of the task (best effort; re-resolved on write). */
	line: number;
	/** The scanned source line, the fallback for locating the task. */
	originalLine: string;
}

export interface TaskToggleOutcome {
	/** false = the task line could not be located (already flipped elsewhere,
	 *  file changed under us, ambiguous skeleton). Nothing was written. */
	wrote: boolean;
	/** Present when the write THREW; a Notice has already been shown, so
	 *  callers must not surface a second one. The promise never rejects. */
	error?: unknown;
}

/** Serial write queue: each entry is a read-modify-write of a note, so
 *  overlapping writes must not interleave. Runs read the current file content
 *  when they actually execute, so the last state always wins. */
let writeQueue: Promise<unknown> = Promise.resolve();

/** Queue one task-checkbox write. Resolves (never rejects) with the outcome;
 *  on a thrown error the user has already seen the failure Notice. */
export function writeTaskToggle(app: App, target: TaskToggleTarget, nextChecked: boolean): Promise<TaskToggleOutcome> {
	const run = writeQueue.then(async (): Promise<TaskToggleOutcome> => {
		try {
			// The writer only reads path/file/line/originalLine and mutates
			// line/originalLine in place.
			const wrote = await toggleTaskInFile(app, target as unknown as VaultTask, nextChecked);
			if (wrote) invalidatePath(target.path);
			return { wrote };
		} catch (err) {
			console.error('[Dashboard] task toggle write failed:', err);
			new Notice(t('alltasks.toggleFailed'));
			return { wrote: false, error: err };
		}
	});
	// Keep the queue alive across failures.
	writeQueue = run.then(() => undefined, () => undefined);
	return run;
}
