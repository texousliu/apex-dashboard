import { Modal } from 'obsidian';
import { applyModalTheme } from '../modal-theme';
import { t } from '../i18n';

/**
 * Shared shell for section configuration modals.
 *
 * Every config modal used to hand-write the same eleven lines: clear
 * contentEl, add the four container classes, apply the dashboard theme, build
 * the `.dashboard-modal` frame, a header with one title, a body, and a footer
 * with Cancel / Save wired to `close()` and a save handler. Then each one
 * repeated `onClose() { this.contentEl.empty(); }`. Twenty-two of them meant
 * twenty-two chances to forget the theme call or the bg class, and a visual
 * change had to be applied everywhere.
 *
 * A subclass now declares only what is actually different: the title, the
 * body fields, and what Save persists.
 *
 * ```ts
 * class FooConfigModal extends SectionConfigModal {
 *   protected title() { return t('foo.configure'); }
 *   protected renderBody(body: HTMLElement) { …fields… }
 *   protected submit() { this.onSave(this.read()); this.close(); }
 * }
 * ```
 *
 * Deliberate non-goals: no generic field builder (each modal's fields are
 * genuinely different), no dirty tracking (only a couple of modals need it and
 * they opt in by overriding `buildFooter`).
 */
export abstract class SectionConfigModal extends Modal {
	/** Body container — fields go here. */
	protected body!: HTMLElement;
	/** Footer container — only for modals that add their own buttons. */
	protected footer!: HTMLElement;
	/** The Save button, for modals that gate it on validation. */
	protected confirmBtn: HTMLButtonElement | null = null;

	/** Header title (already translated). */
	protected abstract title(): string;

	/** Fill the body. The footer already exists, so validation may read
	 *  `this.confirmBtn` while painting the first time. */
	protected abstract renderBody(body: HTMLElement): void;

	/** Persist and close — wired to Save. */
	protected abstract submit(): void;

	protected saveLabel(): string { return t('common.save'); }
	protected cancelLabel(): string { return t('common.cancel'); }

	/** Extra class on contentEl (per-modal scoping for CSS / tests). */
	protected contentClass(): string { return 'dashboard-library-config-modal'; }

	/** Size modifier appended to `.dashboard-modal`. */
	protected sizeClass(): string { return 'dashboard-modal--compact'; }

	onOpen(): void {
		const { contentEl, containerEl } = this;
		contentEl.empty();
		contentEl.addClass(this.contentClass());
		containerEl.addClass('modal--dashboard');
		containerEl.parentElement?.addClass('modal-bg--dashboard');
		applyModalTheme(containerEl);

		const container = contentEl.createDiv({ cls: `dashboard-modal ${this.sizeClass()}`.trim() });
		const header = container.createDiv({ cls: 'dashboard-modal-header' });
		header.createDiv({ cls: 'dashboard-modal-title', text: this.title() });

		this.body = container.createDiv({ cls: 'dashboard-modal-body' });
		this.footer = container.createDiv({ cls: 'dashboard-modal-footer' });
		this.buildFooter(this.footer);

		// Body last: DOM order stays header → body → footer, while the fields
		// can already reach the Save button they may need to disable.
		this.renderBody(this.body);
	}

	/** Cancel + Save. Override to add buttons (e.g. delete/reset). */
	protected buildFooter(footer: HTMLElement): void {
		footer.createEl('button', {
			cls: 'dashboard-modal-btn dashboard-modal-btn--cancel',
			text: this.cancelLabel(),
		}).addEventListener('click', () => this.close());

		this.confirmBtn = footer.createEl('button', {
			cls: 'dashboard-modal-btn dashboard-modal-btn--confirm',
			text: this.saveLabel(),
		});
		this.confirmBtn.addEventListener('click', () => this.submit());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
