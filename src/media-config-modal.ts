import type { App } from 'obsidian';
import type { LibraryConfig } from './types';
import { t } from './i18n';
import { SectionConfigModal } from './section/config-modal';
import { ExcludeFoldersEditor } from './exclude-folders-editor';

/**
 * Configuration modal for images/videos sections. These sections scan the whole
 * vault by default; the currently supported setting is the excluded-folder set
 * (files inside them never reach the section). Persisted in the column's
 * `libraryConfig.excludeFolders` — the same field the all-tasks and calendar
 * sections use — so the parser round-trips it with no extra handling.
 */
export class MediaConfigModal extends SectionConfigModal {
	private readonly existing: LibraryConfig | undefined;
	private readonly onSave: (config: LibraryConfig) => void;
	private excludeEditor: ExcludeFoldersEditor | null = null;
	private includeEditor: ExcludeFoldersEditor | null = null;

	constructor(
		app: App,
		existing: LibraryConfig | undefined,
		onSave: (config: LibraryConfig) => void,
	) {
		super(app);
		this.existing = existing;
		this.onSave = onSave;
	}

	protected title(): string {
		return t('media.configure');
	}

	protected renderBody(body: HTMLElement): void {
		const excludeSection = body.createDiv({ cls: 'dashboard-library-config-section' });
		excludeSection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('exclude.folders') });
		excludeSection.createDiv({ cls: 'dashboard-library-config-hint', text: t('exclude.foldersHint') });
		this.excludeEditor = new ExcludeFoldersEditor(this.app, excludeSection, this.existing?.excludeFolders ?? []);

		// Display scope: when non-empty, only files under these folders reach
		// the section (excludes still subtract within it); empty = whole vault.
		const includeSection = body.createDiv({ cls: 'dashboard-library-config-section' });
		includeSection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('media.includeFolders') });
		includeSection.createDiv({ cls: 'dashboard-library-config-hint', text: t('media.includeFoldersHint') });
		this.includeEditor = new ExcludeFoldersEditor(this.app, includeSection, this.existing?.includeFolders ?? [], {
			placeholder: t('media.includeFolderPlaceholder'),
		});

	}

	/** Media sections only consume exclude/includeFolders; keep a complete
	 *  LibraryConfig shape (viewMode/sortBy/... defaults) so the YAML
	 *  round-trip never writes `undefined` values. */
	protected submit(): void {
		const base = this.existing ?? {
			filters: [],
			viewMode: 'grid' as const,
			sortBy: 'modified',
			sortDesc: true,
		};
		const folders = this.excludeEditor?.value ?? [];
		const includes = this.includeEditor?.value ?? [];
		this.onSave({
			...base,
			excludeFolders: folders.length > 0 ? folders : undefined,
			includeFolders: includes.length > 0 ? includes : undefined,
		});
		this.close();
	}
}
