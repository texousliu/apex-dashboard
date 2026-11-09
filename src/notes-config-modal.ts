import { t } from './i18n';
import { SectionConfigModal } from './section/config-modal';
import { PathPickerModal } from './path-picker-modal';
import { TemplateFilesEditor } from './template-files-editor';

/** Per-section settings as edited by {@link NotesSectionConfigModal}.
 *  Empty strings / arrays mean "unset" (bare note / vault root). */
export interface NotesSectionSettings {
	templatePaths: string[];
	folder: string;
	/** Cover strip on cards, default on (the retired standalone no-cover
	 *  section type survives as this toggle switched off). */
	showCover: boolean;
}

/**
 * Section settings for notes sections: whether cards show covers, the
 * template applied to notes created from the section's cards, and the folder
 * they are saved into (vault root when unset). Templates + folder persist
 * through the column's libraryConfig (templatePaths + folders[0]) so the
 * existing sync/parser plumbing round-trips them; showCover is a column
 * field (see updateNotesSectionConfig).
 */
export class NotesSectionConfigModal extends SectionConfigModal {
	private readonly cfg: NotesSectionSettings;
	private readonly onSave: (settings: NotesSectionSettings) => void;
	private tplEditor: TemplateFilesEditor | null = null;
	private folderInput: HTMLInputElement | null = null;

	constructor(
		app: import('obsidian').App,
		current: NotesSectionSettings,
		onSave: (settings: NotesSectionSettings) => void,
	) {
		super(app);
		this.cfg = { ...current };
		this.onSave = onSave;
	}

	protected title(): string {
		return t('notesCfg.title');
	}

	protected renderBody(body: HTMLElement): void {
		// Show covers: off reproduces the retired 无封面 section look.
		const coversRow = body.createDiv({ cls: 'dashboard-library-config-inline-row' });
		const coversBox = coversRow.createEl('input', {
			cls: 'dashboard-library-config-checkbox',
			attr: { type: 'checkbox' },
		});
		coversBox.checked = this.cfg.showCover;
		coversBox.addEventListener('change', () => { this.cfg.showCover = coversBox.checked; });
		coversRow.createDiv({ cls: 'dashboard-library-config-inline-label', text: t('notesCfg.showCover') });

		// New-note templates (vault files; body + non-conflicting frontmatter
		// seed the created note). Several entries turn the card's new-note
		// button into a template picker (first entry = default).
		const tplSection = body.createDiv({ cls: 'dashboard-library-config-section' });
		tplSection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('library.newNoteTemplate') });
		tplSection.createDiv({ cls: 'dashboard-library-config-hint', text: t('notesCfg.templateHint') });
		this.tplEditor = new TemplateFilesEditor(this.app, tplSection, this.cfg.templatePaths);

		// Save folder (created when missing; vault root when unset).
		const folderSection = body.createDiv({ cls: 'dashboard-library-config-section' });
		folderSection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('notesCfg.folder') });
		folderSection.createDiv({ cls: 'dashboard-library-config-hint', text: t('notesCfg.folderHint') });
		const folderRow = folderSection.createDiv({ cls: 'dashboard-media-folder-input-row' });
		const folderInput = folderRow.createEl('input', {
			cls: 'dashboard-media-filter-folder',
			attr: { type: 'text', placeholder: t('notesCfg.folderPlaceholder') },
		});
		this.folderInput = folderInput;
		folderInput.value = this.cfg.folder;
		folderRow.createEl('button', {
			cls: 'dashboard-media-folder-browse',
			text: t('folder.browse'),
		}).addEventListener('click', () => {
			new PathPickerModal(this.app, 'folder', (path) => {
				this.cfg.folder = path;
				folderInput.value = path;
			}).open();
		});
		folderInput.addEventListener('change', () => { this.cfg.folder = folderInput.value.trim(); });

	}

	protected submit(): void {
		// Editors are authoritative (the browse picker writes into them too).
		this.onSave({
			templatePaths: this.tplEditor?.value ?? [],
			folder: this.folderInput?.value.trim() ?? '',
			showCover: this.cfg.showCover,
		});
		this.close();
	}
}
