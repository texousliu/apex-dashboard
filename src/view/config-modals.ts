/**
 * Every modal a section header's gear (or an add-card button) opens.
 *
 * Extracted from `view.ts` (Phase 5). They were already a uniform shape — look
 * up the column, hand the modal the current config, write the result back
 * through the sync engine — so they read better side by side than scattered
 * through the view class. The view keeps one-line methods that pass itself in
 * as the host, which is what leaves every call site in the board delegation
 * untouched.
 */
import { App } from 'obsidian';
import type DashboardPlugin from '../main';
import type { SyncEngine } from '../sync';
import type { DashboardData, SkillCreateConfig } from '../types';
import { t } from '../i18n';
import { rememberSkillNames } from '../skill-registry';
import { fireSkillDirect } from '../skill-widget';
import { AgentPromptModal } from '../agent-prompt-modal';
import { WidgetTypeModal, type WidgetType } from '../widget-type-modal';
import { StickyCardTypeModal } from '../sticky-card-type-modal';
import { WeatherConfigModal } from '../weather-config-modal';
import { TrackerConfigModal } from '../tracker-config-modal';
import { TemplatePickerModal } from '../template-modal';
import { LibraryConfigModal } from '../library-config-modal';
import { DataviewConfigModal } from '../dataview-config-modal';
import { WebConfigModal } from '../web-config-modal';
import { RssConfigModal } from '../rss-config-modal';
import { SkillSectionConfigModal } from '../skill-section-config-modal';
import { PipelineConfigModal } from '../pipeline-config-modal';
import { PmConfigModal } from '../pm-config-modal';
import { MediaConfigModal } from '../media-config-modal';
import { WereadConfigModal } from '../weread-config-modal';

/** What the modal launchers need from the view: the app, the section-config
 *  write path, the plugin (template store + skill registry) and the current
 *  board data (for "the config this column already has"). */
export interface ConfigModalHost {
	app: App;
	plugin: DashboardPlugin;
	sync: SyncEngine;
	data: DashboardData | null;
	/** Ask the view to scroll to the last card of this column after the next
	 *  render (set when a modal is about to create a card). */
	setPendingScrollColumn(colName: string): void;
}

export function openWidgetTypeModal(host: ConfigModalHost, colName: string): void {
	const modal = new WidgetTypeModal(host.app, (type: WidgetType) => {
		if (type === 'weather') {
			openWeatherConfigModal(host, colName);
		} else if (type === 'tracker') {
			openTrackerConfigModal(host, colName);
		}
	});
	modal.open();
}

/** Sticky ("便利贴") sections: choose memo or todo before the card is created. */
export function openStickyCardTypeModal(host: ConfigModalHost, colName: string): void {
	const modal = new StickyCardTypeModal(host.app, (kind) => {
		host.setPendingScrollColumn(colName);
		if (kind === 'todo') {
			void host.sync.addCard(colName, { type: 'task', title: t('sync.todoTitle') });
		} else {
			const now = new Date();
			const pad = (n: number) => String(n).padStart(2, '0');
			const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
			void host.sync.addCard(colName, { type: 'generic', title: t('sync.memoTitle', { date }) });
		}
	});
	modal.open();
}

export function openWeatherConfigModal(host: ConfigModalHost, colName: string): void {
	const modal = new WeatherConfigModal(host.app, (title, config) => {
		void host.sync.addCard(colName, {
			title,
			type: 'weather',
			weatherConfig: config,
		});
	});
	modal.open();
}

export function openTrackerConfigModal(host: ConfigModalHost, colName: string): void {
	const modal = new TrackerConfigModal(host.app, (title, config) => {
		void host.sync.addCard(colName, {
			title,
			type: 'tracker',
			trackerConfig: config,
		});
	});
	modal.open();
}

export function openTemplatePicker(host: ConfigModalHost, colName: string): void {
	const modal = new TemplatePickerModal(
		host.app,
		host.plugin,
		(template) => {
			host.setPendingScrollColumn(colName);
			void host.sync.addCard(colName, {
				title: template.name,
				type: 'task',
				tasks: template.tasks.map(text => ({ text, checked: false })),
			});
		},
	);
	modal.open();
}

export function openLibraryConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const existingConfig = column?.libraryConfig ?? {
		filters: [],
		viewMode: 'grid' as const,
		sortBy: 'modified',
		sortDesc: true,
	};
	const modal = new LibraryConfigModal(
		host.app,
		existingConfig,
		(config) => {
			void host.sync.updateSectionConfig(colName, 'libraryConfig', config);
		},
	);
	modal.open();
}

export function openDataviewConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const existing = column?.dataviewConfig ?? { query: '' };
	const modal = new DataviewConfigModal(
		host.app,
		existing,
		(config) => { void host.sync.updateSectionConfig(colName, 'dataviewConfig', config); },
	);
	modal.open();
}

/** Web section: URL + engine mode + zoom. Saving goes through the plain
 *  sync path — handleDataUpdate('local') rebuilds the section in place,
 *  reloading the frame with the new URL. */
export function openWebConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const existing = column?.webConfig ?? { url: '' };
	const modal = new WebConfigModal(
		host.app,
		existing,
		(config) => { void host.sync.updateSectionConfig(colName, 'webConfig', config); },
	);
	modal.open();
}

/** RSS section: subscription sources + download folder. Same plain sync
 *  path — the section rebuilds in place and re-reads its feeds. */
export function openRssConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const existing = column?.rssConfig ?? { feeds: [], downloadFolder: '' };
	const modal = new RssConfigModal(
		host.app,
		existing,
		(config) => { void host.sync.updateSectionConfig(colName, 'rssConfig', config); },
	);
	modal.open();
}

/** Run the configured creator skill — via the confirm dialog by default,
 *  direct-send only when the config opted in. */
export function dispatchSkillCreate(host: ConfigModalHost, cfg: SkillCreateConfig): void {
	const spec = { label: cfg.skillName, skillName: cfg.skillName, promptTemplate: cfg.promptTemplate };
	if (cfg.directSend) fireSkillDirect(host.app, spec, cfg.agent);
	else new AgentPromptModal(host.app, spec, cfg.agent, {}).open();
}

/** Skills sections: visible stores + default sort (see
 *  SkillSectionConfigModal). The section works with no config at all —
 *  this modal is for trimming, not for setup. */
export function openSkillsConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const modal = new SkillSectionConfigModal(
		host.app,
		column?.skillsConfig,
		(config) => { void host.sync.updateSectionConfig(colName, 'skillsConfig', config); },
		host.plugin,
	);
	modal.open();
}

/** Pipeline sections: stages, skill buttons and the status field. The modal
 *  seeds sensible defaults when the section was just created. */
export function openPipelineConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const modal = new PipelineConfigModal(
		host.app,
		column?.pipelineConfig,
		(config) => {
			void (async () => {
				await host.sync.updateSectionConfig(colName, 'pipelineConfig', config);
				// Remember valid skill names per agent so the pickers
				// offer them next time (see skill-registry).
				for (const agent of new Set(config.skills.map(skill => skill.agent))) {
					await rememberSkillNames(host.plugin, agent, config.skills.filter(skill => skill.agent === agent && skill.skillName).map(skill => skill.skillName));
				}
			})();
		},
		host.plugin,
	);
	modal.open();
}

export function openPmConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const modal = new PmConfigModal(
		host.app,
		column?.pmConfig,
		(config) => {
			void (async () => {
				await host.sync.updateSectionConfig(colName, 'pmConfig', config);
				for (const agent of new Set((config.skills ?? []).map(skill => skill.agent))) {
					await rememberSkillNames(host.plugin, agent, (config.skills ?? []).filter(skill => skill.agent === agent && skill.skillName).map(skill => skill.skillName));
				}
			})();
		},
		host.plugin,
	);
	modal.open();
}

/** Images/videos sections: the config currently manages the excluded-folder
 *  set, persisted via the column's libraryConfig. */
export function openMediaConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const modal = new MediaConfigModal(
		host.app,
		column?.libraryConfig,
		(config) => { void host.sync.updateSectionConfig(colName, 'libraryConfig', config); },
	);
	modal.open();
}

export function openWereadConfigModal(host: ConfigModalHost, colName: string): void {
	const column = host.data?.columns.find(col => col.name === colName);
	const existing = column?.wereadConfig ?? { widgets: [{ id: 'w1', view: 'shelf' as const, groupBy: 'readingState' as const }] };
	const modal = new WereadConfigModal(
		host.app,
		existing,
		(config) => { void host.sync.updateSectionConfig(colName, 'wereadConfig', config); },
	);
	modal.open();
}
