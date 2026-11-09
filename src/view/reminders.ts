/**
 * Reminder watchdogs: the once-a-minute scan that turns task reminders,
 * pipeline / PM note due dates, countdown targets and anniversaries into the
 * "remind" modal or a Notice.
 *
 * Extracted from `view.ts` (Phase 5). The scan is a pure function of
 * (data, settings, the fired-key set) — the view owns the interval and the key
 * set, this module owns the rules.
 *
 * One structural defect was fixed while moving it: the countdown pass had been
 * nested *inside* the PM-columns loop (an over-indented block left over from an
 * earlier edit), so countdown reminders silently never fired on a board with no
 * PM section, and the pipeline / PM / anniversary passes each ran once per
 * column instead of once. Every pass now owns its own loop — which is also what
 * the writing says it does.
 */
import { App, Notice } from 'obsidian';
import type { DashboardData, DashboardSettings } from '../types';
import { t } from '../i18n';
import { parseNoteDue } from '../pipeline-model';
import { pmKeyDate } from '../pm-model';
import { ReminderNoticeModal } from '../reminder-notice';
import {
	anniversaryDateThisYear,
	lunarAnniversaryThisYear,
	lunarYearsBetween,
	parseAnniversaryDate,
} from '../anniversary-widget';

/** Interval between two reminder scans (1 minute). */
export const REMINDER_CHECK_MS = 60 * 1000;

export interface ReminderHost {
	app: App;
	data: DashboardData | null;
	settings: DashboardSettings;
	/** Keys already raised since the last render pass; the view clears it on
	 *  every render, which is what keeps dismissals from sticking forever. */
	fired: Set<string>;
	/** Write-back for the dismiss / snooze buttons on a task-card reminder. The
	 *  view passes its sync engine through; the module never touches it. */
	editTaskReminder: (cardId: string, taskPath: number[], reminder: string | undefined) => void;
}

/** Scan everything that can come due and raise the matching reminder. */
export function checkReminders(host: ReminderHost): void {
	const data = host.data;
	if (!data) return;
	const now = new Date();

	checkTaskReminders(host, data, now);
	checkPipelineReminders(host, data, now);
	checkPmReminders(host, data, now);
	checkCountdownReminders(host, now);
	checkAnniversaryReminders(host, now);
}

/** Task-card rows: `reminder` is `<date> <time>`, per task path. */
function checkTaskReminders(host: ReminderHost, data: DashboardData, now: Date): void {
	for (const col of data.columns) {
		for (const card of col.cards) {
			for (let i = 0; i < card.tasks.length; i++) {
				const task = card.tasks[i]!;
				if (!task.reminder || task.checked) continue;

				const key = `${card.id}-${JSON.stringify([i])}`;
				if (host.fired.has(key)) continue;

				const parts = task.reminder.trim().split(/\s+/);
				if (parts.length < 2) continue;
				const [dateStr, timeStr] = parts;
				const [year, month, day] = dateStr!.split('-').map(Number);
				const [hour, min] = timeStr!.split(':').map(Number);
				if (!year || !month || !day) continue;
				const due = new Date(year, month - 1, day, hour ?? 0, min ?? 0);

				if (now >= due) {
					host.fired.add(key);
					const cleanText = task.text.replace(/\[\[[^\]]+\]\]/g, (match) => {
						const inner = match.slice(2, -2);
						return inner.split('|').pop()?.split('/').pop()?.replace(/\.md$/, '') ?? inner;
					});
					showTaskReminderModal(host, cleanText, card.id, [i]);
				}
			}
		}
	}
}

/** Workflow (pipeline) notes: a note-level `due` + `remind: true` frontmatter
 *  pair raises the same reminder modal. Dismiss clears the alarm; snooze pushes
 *  the due value an hour out (written back to the note). The scan rides the
 *  metadata cache — no file reads. */
function checkPipelineReminders(host: ReminderHost, data: DashboardData, now: Date): void {
	for (const col of data.columns) {
		if (col.sectionType !== 'pipeline' || !col.pipelineConfig) continue;
		const cfg = col.pipelineConfig;
		for (const file of host.app.vault.getMarkdownFiles()) {
			if (!file.path.toLowerCase().startsWith(cfg.rootFolder.toLowerCase() + '/')) continue;
			const fm = host.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || fm['remind'] !== true) continue;
			const due = parseNoteDue(fm);
			if (!due) continue;
			const key = `pipe:${file.path}`;
			if (host.fired.has(key)) continue;
			const [y, mo, d] = due.date.split('-').map(Number);
			if (!y || !mo || !d) continue;
			const [h, mi] = (due.time ?? '09:00').split(':').map(Number);
			const when = new Date(y, mo - 1, d, h ?? 9, mi ?? 0);
			if (now < when) continue;
			host.fired.add(key);
			const modal = new ReminderNoticeModal(
				host.app,
				file.basename,
				() => {
					// Dismiss: drop the alarm flag, keep the due value.
					void host.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => { delete f['remind']; });
				},
				() => {
					// Snooze one hour, re-arm.
					const snoozed = new Date(Date.now() + 60 * 60 * 1000);
					const pad = (n: number) => String(n).padStart(2, '0');
					const value = `${snoozed.getFullYear()}-${pad(snoozed.getMonth() + 1)}-${pad(snoozed.getDate())} ${pad(snoozed.getHours())}:${pad(snoozed.getMinutes())}`;
					host.fired.delete(key);
					void host.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => { f['due'] = value; f['remind'] = true; });
				},
			);
			modal.open();
		}
	}
}

/** PM projects: the note's `keyDate` + `remind: true` pair raises the same
 *  reminder modal (dismiss clears the flag; snooze pushes the key date one hour
 *  out). Metadata-cache only — no file reads. */
function checkPmReminders(host: ReminderHost, data: DashboardData, now: Date): void {
	for (const col of data.columns) {
		if (col.sectionType !== 'pm' || !col.pmConfig) continue;
		const rootFolder = col.pmConfig.rootFolder.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
		if (!rootFolder) continue;
		for (const file of host.app.vault.getMarkdownFiles()) {
			if (!file.path.toLowerCase().startsWith(rootFolder + '/')) continue;
			const fm = host.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || fm['remind'] !== true) continue;
			const keyDate = pmKeyDate(fm);
			if (!keyDate) continue;
			const key = `pm:${file.path}`;
			if (host.fired.has(key)) continue;
			const [y, mo, d] = keyDate.date.split('-').map(Number);
			if (!y || !mo || !d) continue;
			const [h, mi] = (keyDate.time ?? '09:00').split(':').map(Number);
			const when = new Date(y, mo - 1, d, h ?? 9, mi ?? 0);
			if (now < when) continue;
			host.fired.add(key);
			const modal = new ReminderNoticeModal(
				host.app,
				file.basename,
				() => {
					// Dismiss: drop the alarm flag, keep the key date.
					void host.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => { delete f['remind']; });
				},
				() => {
					// Snooze one hour, re-arm.
					const snoozed = new Date(Date.now() + 60 * 60 * 1000);
					const pad = (n: number) => String(n).padStart(2, '0');
					const value = `${snoozed.getFullYear()}-${pad(snoozed.getMonth() + 1)}-${pad(snoozed.getDate())} ${pad(snoozed.getHours())}:${pad(snoozed.getMinutes())}`;
					host.fired.delete(key);
					void host.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => { f['keyDate'] = value; f['remind'] = true; });
				},
			);
			modal.open();
		}
	}
}

/** Countdown widgets: one Notice per configured countdown, on the first scan
 *  inside the reminder window. Board-level, not column-level. */
function checkCountdownReminders(host: ReminderHost, now: Date): void {
	if (!host.settings.countdownEnabled) return;
	for (const cd of host.settings.countdowns ?? []) {
		if (!cd.targetDate || cd.reminderDays <= 0) continue;
		const ckKey = `countdown-remind-${cd.id}`;
		if (host.fired.has(ckKey)) continue;
		const raw = cd.targetDate;
		const target = raw.includes('T') ? new Date(raw) : new Date(raw + 'T00:00:00');
		const diffMs = target.getTime() - now.getTime();
		const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
		if (daysLeft >= 0 && daysLeft <= cd.reminderDays) {
			host.fired.add(ckKey);
			const label = cd.label || cd.targetDate;
			new Notice(t('countdown.reminderNotice', { label, days: String(daysLeft) }));
		}
	}
}

/** Anniversary reminders: fire once a year on the entry's month/day (outside
 *  the columns loop — a per-column placement would just repeat the same guarded
 *  check). Feb 29 entries roll to Mar 1 in common years via the Date overflow in
 *  anniversaryDateThisYear. Lunar entries fire on the lunar anniversary's solar
 *  date this year (it drifts through the Gregorian calendar), counted in lunar
 *  years. */
function checkAnniversaryReminders(host: ReminderHost, now: Date): void {
	if (!host.settings.anniversaryEnabled) return;
	for (const av of host.settings.anniversaries ?? []) {
		if (!av.annualReminder || !av.startDate) continue;
		const avKey = `anniversary-remind-${av.id}`;
		if (host.fired.has(avKey)) continue;
		const start = parseAnniversaryDate(av.startDate);
		if (!start) continue;
		const lunar = av.calendar === 'lunar';
		const today = lunar ? lunarAnniversaryThisYear(start, now) : anniversaryDateThisYear(start, now);
		if (now.getFullYear() === today.getFullYear()
			&& now.getMonth() === today.getMonth()
			&& now.getDate() === today.getDate()) {
			host.fired.add(avKey);
			const label = av.label || av.startDate;
			const years = lunar
				? String(lunarYearsBetween(start, now) ?? (now.getFullYear() - start.getFullYear()))
				: String(now.getFullYear() - start.getFullYear());
			new Notice(t('anniversary.reminderNotice', { label, years }));
		}
	}
}

/** Dismiss drops the reminder; snooze pushes it an hour out (both written back
 *  through the host so the note stays the source of truth). */
function showTaskReminderModal(host: ReminderHost, taskText: string, cardId: string, taskPath: number[]): void {
	const modal = new ReminderNoticeModal(
		host.app,
		taskText,
		() => {
			host.editTaskReminder(cardId, taskPath, undefined);
		},
		() => {
			const snoozed = new Date(Date.now() + 60 * 60 * 1000);
			const pad = (n: number) => String(n).padStart(2, '0');
			const newReminder = `${snoozed.getFullYear()}-${pad(snoozed.getMonth() + 1)}-${pad(snoozed.getDate())} ${pad(snoozed.getHours())}:${pad(snoozed.getMinutes())}`;
			host.fired.delete(`${cardId}-${JSON.stringify(taskPath)}`);
			host.editTaskReminder(cardId, taskPath, newReminder);
		},
	);
	modal.open();
}
