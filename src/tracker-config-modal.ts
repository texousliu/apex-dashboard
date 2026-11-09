import type { App } from 'obsidian';
import type { TrackerConfig, TrackerStyle } from './types';
import { suggestTrackerKeys } from './tracker-service';
import { t } from './i18n';
import { SectionConfigModal } from './section/config-modal';

export class TrackerConfigModal extends SectionConfigModal {
	private onSave: (title: string, config: TrackerConfig) => void;

	private keyValue = '';
	private daysValue = 30;
	private styleValue: TrackerStyle = 'line';

	constructor(
		app: App,
		onSave: (title: string, config: TrackerConfig) => void,
	) {
		super(app);
		this.onSave = onSave;
	}

	protected title(): string {
		return t('tracker.configTitle');
	}

	protected renderBody(body: HTMLElement): void {
		// Frontmatter key
		const keySection = body.createDiv({ cls: 'dashboard-library-config-section' });
		keySection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('tracker.keyLabel') });
		const keyInput = keySection.createEl('input', {
			cls: 'dashboard-modal-input',
			attr: { type: 'text', placeholder: t('tracker.keyPlaceholder') },
		});
		keyInput.addEventListener('input', () => {
			this.keyValue = keyInput.value.trim();
		});

		// Suggested keys
		const suggestions = suggestTrackerKeys(this.app);
		if (suggestions.length > 0) {
			const sugWrap = keySection.createDiv({ cls: 'tracker-key-suggestions' });
			sugWrap.createDiv({ cls: 'tracker-key-suggestions-label', text: t('tracker.keySuggestions') });
			const tagRow = sugWrap.createDiv({ cls: 'tracker-key-tags' });
			for (const k of suggestions.slice(0, 8)) {
				const tag = tagRow.createEl('button', { cls: 'tracker-key-tag', text: k });
				tag.addEventListener('click', () => {
					this.keyValue = k;
					keyInput.value = k;
				});
			}
		}

		// Chart style selector
		const styleSection = body.createDiv({ cls: 'dashboard-library-config-section' });
		styleSection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('tracker.styleLabel') });
		const styleRow = styleSection.createDiv({ cls: 'dashboard-library-view-toggle' });

		const styleOptions: { value: TrackerStyle; label: string }[] = [
			{ value: 'line', label: t('tracker.styleLine') },
			{ value: 'heatmap', label: t('tracker.styleHeatmap') },
			{ value: 'bar', label: t('tracker.styleBar') },
		];

		for (const opt of styleOptions) {
			const btn = styleRow.createEl('button', {
				cls: 'dashboard-library-view-btn' + (opt.value === this.styleValue ? ' active' : ''),
				text: opt.label,
			});
			btn.addEventListener('click', () => {
				this.styleValue = opt.value;
				styleRow.querySelectorAll('.dashboard-library-view-btn').forEach(b => b.removeClass('active'));
				btn.addClass('active');
			});
		}

		// Days selector
		const daysSection = body.createDiv({ cls: 'dashboard-library-config-section' });
		daysSection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('tracker.daysLabel') });
		const daysRow = daysSection.createDiv({ cls: 'dashboard-library-view-toggle' });

		const dayOptions = [
			{ value: 7, label: t('tracker.days7') },
			{ value: 14, label: t('tracker.days14') },
			{ value: 30, label: t('tracker.days30') },
			{ value: 90, label: t('tracker.days90') },
			{ value: 180, label: t('tracker.days180') },
			{ value: 365, label: t('tracker.days365') },
		];

		for (const opt of dayOptions) {
			const btn = daysRow.createEl('button', {
				cls: 'dashboard-library-view-btn' + (opt.value === this.daysValue ? ' active' : ''),
				text: opt.label,
			});
			btn.addEventListener('click', () => {
				this.daysValue = opt.value;
				daysRow.querySelectorAll('.dashboard-library-view-btn').forEach(b => b.removeClass('active'));
				btn.addClass('active');
			});
		}

		// Enter in the key field saves, same as clicking the footer button.
		keyInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.confirmBtn?.click();
			}
		});

		keyInput.focus();
	}

	protected submit(): void {
		// A tracker without a key has nothing to chart — stay open.
		if (!this.keyValue) return;
		this.onSave(this.keyValue, { key: this.keyValue, days: this.daysValue, style: this.styleValue });
		this.close();
	}
}
