import type { App } from 'obsidian';
import type { DashboardCard, TaskCardConfig } from './types';
import { t } from './i18n';
import { SectionConfigModal } from './section/config-modal';

/**
 * Per-card config for a todo-list card (the gear button on the card).
 *
 * The settings outgrew the native dropdown menu — completion behavior, the
 * daily-note task source and the heading level used when the card title is
 * written into a note — so they live in one dialog with an explicit Save.
 */
export class TaskCardConfigModal extends SectionConfigModal {
	private readonly card: DashboardCard;
	private readonly onSave: (config: TaskCardConfig) => void;

	private behavior: 'stay' | 'end' | 'afterUnfinished';
	private fromDaily: boolean;
	private headingLevel: 1 | 2 | 3 | 4 | 5 | 6;
	private affixPrefix: string;
	private affixSuffix: string;

	constructor(app: App, card: DashboardCard, onSave: (config: TaskCardConfig) => void) {
		super(app);
		this.card = card;
		this.onSave = onSave;
		this.behavior = card.taskCompleteBehavior ?? 'end';
		this.fromDaily = card.tasksFromDaily === true;
		this.headingLevel = card.dailyHeadingLevel ?? 3;
		this.affixPrefix = card.taskPrefix ?? '';
		this.affixSuffix = card.taskSuffix ?? '';
	}

	protected title(): string {
		return t('taskConfig.title');
	}

	protected renderBody(body: HTMLElement): void {
		const form = body.createDiv({ cls: 'dashboard-modal-form' });

		// Completion behavior: where a checked task lands in the list.
		const behaviorField = form.createDiv();
		behaviorField.createEl('label', { text: t('taskConfig.behavior') });
		const behaviorSelect = behaviorField.createEl('select', { cls: 'dashboard-modal-input' });
		for (const value of ['stay', 'end', 'afterUnfinished'] as const) {
			behaviorSelect.createEl('option', { attr: { value }, text: t(`taskBehavior.${value}`) });
		}
		behaviorSelect.value = this.behavior;
		behaviorSelect.addEventListener('change', () => {
			const v = behaviorSelect.value;
			this.behavior = v === 'stay' || v === 'afterUnfinished' ? v : 'end';
		});
		behaviorField.createDiv({ cls: 'dashboard-modal-hint', text: t('taskConfig.behaviorDesc') });

		// Daily-note source: on = the note's title block owns the task list.
		const sourceField = form.createDiv();
		const sourceToggle = sourceField.createDiv({ cls: 'dashboard-modal-check-row' });
		const sourceCheck = sourceToggle.createEl('input', { attr: { type: 'checkbox' } });
		sourceCheck.checked = this.fromDaily;
		const sourceLabel = sourceToggle.createEl('label', { text: t('renderer.tasksFromDaily') });
		sourceLabel.addEventListener('click', () => {
			sourceCheck.checked = !sourceCheck.checked;
			sourceCheck.dispatchEvent(new Event('change'));
		});
		sourceCheck.addEventListener('change', () => { this.fromDaily = sourceCheck.checked; });
		sourceField.createDiv({ cls: 'dashboard-modal-hint', text: t('taskConfig.tasksFromDailyDesc') });

		// Heading depth of the card title inside the daily note.
		const headingField = form.createDiv();
		headingField.createEl('label', { text: t('taskConfig.headingLevel') });
		const headingSelect = headingField.createEl('select', { cls: 'dashboard-modal-input' });
		for (const level of [1, 2, 3, 4, 5, 6] as const) {
			headingSelect.createEl('option', {
				attr: { value: String(level) },
				text: headingOptionLabel(level),
			});
		}
		headingSelect.value = String(this.headingLevel);
		headingSelect.addEventListener('change', () => {
			const n = Number(headingSelect.value);
			this.headingLevel = (n >= 1 && n <= 6 ? n : 3) as 1 | 2 | 3 | 4 | 5 | 6;
		});
		headingField.createDiv({ cls: 'dashboard-modal-hint', text: t('taskConfig.headingLevelDesc') });

		// New-task affixes: the templates wrapped around whatever the user types
		// into the card's add-task box. The rules live in src/task-affixes.ts —
		// this dialog only collects the two strings, so the placeholders it
		// documents must stay in sync with TASK_AFFIX_PLACEHOLDERS (a verify
		// case asserts every one of them is listed here).
		const prefixField = form.createDiv();
		prefixField.createEl('label', { text: t('taskConfig.affixPrefix') });
		const prefixInput = prefixField.createEl('input', {
			cls: 'dashboard-modal-input',
			attr: { type: 'text' },
		});
		prefixInput.value = this.affixPrefix;
		prefixInput.addEventListener('input', () => { this.affixPrefix = prefixInput.value; });

		const suffixField = form.createDiv();
		suffixField.createEl('label', { text: t('taskConfig.affixSuffix') });
		const suffixInput = suffixField.createEl('input', {
			cls: 'dashboard-modal-input',
			attr: { type: 'text' },
		});
		suffixInput.value = this.affixSuffix;
		suffixInput.addEventListener('input', () => { this.affixSuffix = suffixInput.value; });

		const affixHint = form.createDiv({ cls: 'dashboard-modal-hint' });
		affixHint.createDiv({ text: t('taskConfig.affixDesc') });
		affixHint.createDiv({ cls: 'dashboard-task-affix-help-title', text: t('taskConfig.affixPlaceholders') });
		const placeholderList = affixHint.createEl('ul', { cls: 'dashboard-task-affix-placeholders' });
		placeholderList.createEl('li', { text: t('taskConfig.affixPhText') });
		placeholderList.createEl('li', { text: t('taskConfig.affixPhDate') });
		placeholderList.createEl('li', { text: t('taskConfig.affixPhTime') });
		placeholderList.createEl('li', { text: t('taskConfig.affixPhTitle') });
		affixHint.createDiv({ text: t('taskConfig.affixHint') });

	}

	protected submit(): void {
		this.onSave({
			taskCompleteBehavior: this.behavior,
			tasksFromDaily: this.fromDaily,
			dailyHeadingLevel: this.headingLevel,
			// Trimmed here so the stored template never carries accidental
			// leading/trailing spaces; empty means "no affix".
			taskPrefix: this.affixPrefix.trim(),
			taskSuffix: this.affixSuffix.trim(),
		});
		this.close();
	}
}

/** Heading-level option label, e.g. `### · H3`. */
export function headingOptionLabel(level: number): string {
	return `${'#'.repeat(level)} · H${level}`;
}
