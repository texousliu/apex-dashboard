import { Modal, setIcon } from 'obsidian';
import { t } from './i18n';
import { applyModalTheme } from './modal-theme';
import { sectionPickerOptions } from './section';

export interface SectionTypeOption {
	value: string;
	icon: string;
	labelKey: string;
}

/**
 * Section types offered when adding a new section. Rendered as a wrapping grid
 * of icon+label cards so the picker is usable on narrow/mobile screens (the
 * previous inline name+9-buttons+confirm row ran out of space on mobile).
 * Order = display rows (the grid is fixed at 5 columns on desktop, see
 * .dashboard-add-section-grid): sticky & data sources first, then the
 * agent boards + calendar/RSS, then media & web embeds, and the reading/task
 * integrations last (Rae's layout).
 */
export const SECTION_TYPE_OPTIONS: SectionTypeOption[] = sectionPickerOptions();

export class AddSectionModal extends Modal {
	private selectedType: string;
	private readonly onAdd: (name: string, sectionType: string) => void;
	private nameInput: HTMLInputElement | null = null;

	constructor(
		app: import('obsidian').App,
		onAdd: (name: string, sectionType: string) => void,
		initialType = 'projects',
	) {
		super(app);
		this.onAdd = onAdd;
		this.selectedType = initialType;
	}

	onOpen(): void {
		const { contentEl, containerEl } = this;
		contentEl.empty();
		contentEl.addClass('dashboard-library-config-modal');
		containerEl.addClass('modal--dashboard');
		containerEl.parentElement?.addClass('modal-bg--dashboard');
		applyModalTheme(containerEl);

		const container = contentEl.createDiv({ cls: 'dashboard-modal dashboard-modal--compact' });

		const header = container.createDiv({ cls: 'dashboard-modal-header' });
		header.createDiv({ cls: 'dashboard-modal-title', text: t('section.addTitle') });

		const body = container.createDiv({ cls: 'dashboard-modal-body' });

		body.createDiv({ cls: 'dashboard-library-config-section-title', text: t('section.chooseType') });
		const grid = body.createDiv({ cls: 'dashboard-add-section-grid' });
		this.renderTypeGrid(grid);

		const nameRow = body.createDiv({ cls: 'dashboard-library-config-inline-row dashboard-add-section-name-row' });
		nameRow.createDiv({ cls: 'dashboard-library-config-inline-label', text: t('section.nameLabel') });
		this.nameInput = nameRow.createEl('input', {
			cls: 'dashboard-task-input dashboard-section-name-input',
			attr: { type: 'text', placeholder: t('section.namePlaceholder') },
		});
		this.nameInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.tryConfirm();
			}
		});

		const footer = container.createDiv({ cls: 'dashboard-modal-footer' });
		footer.createEl('button', {
			cls: 'dashboard-modal-btn dashboard-modal-btn--cancel',
			text: t('common.cancel'),
		}).addEventListener('click', () => this.close());
		const confirmBtn = footer.createEl('button', {
			cls: 'dashboard-modal-btn dashboard-modal-btn--confirm',
			text: t('common.save'),
		});
		confirmBtn.addEventListener('click', () => this.tryConfirm());

		window.setTimeout(() => this.nameInput?.focus(), 0);
	}

	private renderTypeGrid(grid: HTMLElement): void {
		grid.empty();
		for (const opt of SECTION_TYPE_OPTIONS) {
			const card = grid.createDiv({
				cls: 'dashboard-add-section-card' + (opt.value === this.selectedType ? ' active' : ''),
				attr: { 'data-type': opt.value, role: 'button' },
			});
			const iconEl = card.createDiv({ cls: 'dashboard-add-section-card-icon' });
			setIcon(iconEl, opt.icon);
			card.createDiv({ cls: 'dashboard-add-section-card-name', text: t(opt.labelKey) });
			card.addEventListener('click', () => {
				this.selectedType = opt.value;
				this.renderTypeGrid(grid);
			});
		}
	}

	/** Localized label of the currently selected type, used as the default section name. */
	private defaultName(): string {
		const opt = SECTION_TYPE_OPTIONS.find((o) => o.value === this.selectedType);
		return opt ? t(opt.labelKey) : this.selectedType;
	}

	private tryConfirm(): void {
		const name = this.nameInput?.value.trim() || this.defaultName();
		this.onAdd(name, this.selectedType);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
