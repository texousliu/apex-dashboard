/**
 * Every section-internal event that bubbles up to the board host, and what it
 * writes.
 *
 * Extracted from `view.ts` (Phase 5). The board is a plain DOM subtree, so
 * sections talk to the view by dispatching `dashboard-*` CustomEvents on it;
 * this is the one place that decides what each event means. Read as a table it
 * answers "who can change section config, and what do they refresh afterwards"
 * — a question that used to require grepping the whole view class.
 *
 * Almost every listener has the same shape: resolve the column from the event
 * detail, merge a partial config, persist through the sync engine, then
 * refresh that one section in place (cheap, keeps filter/sort/scroll state).
 * Deviations are noted where they happen (PM writes through to notes, TickTick
 * suppresses the render the config write would otherwise trigger).
 */
import type { App } from 'obsidian';
import type DashboardPlugin from '../main';
import type { SyncEngine } from '../sync';
import type { DashboardData, SkillCreateConfig } from '../types';
import { rememberSkillNames } from '../skill-registry';
import { getSkillLibraryStore } from '../skill-store';
import { SkillCreateConfigModal } from '../skill-create-config-modal';
import { SkillImportModal } from '../skill-import-modal';
import { PmNewModal } from '../pm-new-modal';
import { PmArchiveModal } from '../pm-archive-modal';
import { mergeManualStageOrder, reorderSkillSubset } from '../pipeline-model';

/** What the board's event table needs from the view. */
export interface BoardEventHost {
	app: App;
	/** Fresh board data per event: listeners read configs and write them back. */
	data(): DashboardData | null;
	sync(): SyncEngine;
	plugin(): DashboardPlugin;
	/** The config-modal launchers (see view/config-modals). On the host rather
	 *  than imported so the whole routing table stays assertable in tests. */
	openLibraryConfigModal(columnName: string): void;
	openDataviewConfigModal(columnName: string): void;
	openWebConfigModal(columnName: string): void;
	openRssConfigModal(columnName: string): void;
	openSkillsConfigModal(columnName: string): void;
	openPipelineConfigModal(columnName: string): void;
	openPmConfigModal(columnName: string): void;
	openMediaConfigModal(columnName: string): void;
	openWereadConfigModal(columnName: string): void;
	dispatchSkillCreate(cfg: SkillCreateConfig): void;
	/** Rebuild one section in place (returns false when it is not on screen). */
	refreshSectionInPlace(columnName: string): boolean;
	openFolderConfigModal(columnName: string): void;
	openNotesSectionConfigModal(columnName: string): void;
	/** Fire-and-forget: the whole prompt → create → open chain is async,
	 *  and an event listener cannot await it. */
	handleLibraryNewNote(columnName: string, pos?: { x: number; y: number }): void;
	openTickTickFilterModal(columnName: string): void;
	/** TickTick view/resize write config without a full re-render, so the
	 *  subscription-driven render is swallowed once. */
	suppressNextRender(): void;
}

export function attachBoardEventDelegation(host: BoardEventHost, board: HTMLElement): void {
	// Library config event delegation
	board.addEventListener('dashboard-library-config', ((e: CustomEvent) => {
		// The gear ships the canonical type from the section registry, so a
		// legacy column (e.g. sectionType: notes) routes like its modern
		// equivalent instead of falling into the library fallback.
		const { columnName, sectionType } = e.detail as { columnName: string; sectionType?: string };
		const col = host.data()?.columns.find(c => c.name === columnName);
		const type = sectionType ?? col?.sectionType;
		if (type === 'folder') {
			host.openFolderConfigModal(columnName);
		} else if (type === 'weread') {
			host.openWereadConfigModal(columnName);
		} else if (type === 'dataview') {
			host.openDataviewConfigModal(columnName);
		} else if (type === 'web') {
			host.openWebConfigModal(columnName);
		} else if (type === 'rss') {
			host.openRssConfigModal(columnName);
		} else if (type === 'pipeline') {
			host.openPipelineConfigModal(columnName);
		} else if (type === 'skills') {
			host.openSkillsConfigModal(columnName);
		} else if (type === 'pm') {
			host.openPmConfigModal(columnName);
		} else if (type === 'images' || type === 'videos') {
			host.openMediaConfigModal(columnName);
		} else if (type === 'projects') {
			host.openNotesSectionConfigModal(columnName);
		} else {
			host.openLibraryConfigModal(columnName);
		}
	}) as EventListener);

	// RSS page-size change — dispatched from the section toolbar select.
	board.addEventListener('dashboard-rss-page-size', ((e: CustomEvent) => {
		const { columnName, pageSize } = e.detail as { columnName: string; pageSize: number };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (col?.rssConfig && typeof pageSize === 'number') {
			const next = { ...col.rssConfig, pageSize };
			void host.sync().updateSectionConfig(columnName, 'rssConfig', next).then(() => {
				host.refreshSectionInPlace(columnName);
			});
		}
	}) as EventListener);

	// Skills section view prefs (sort / page size / pinned) — the section
	// dispatches partial prefs; they merge into skillsConfig and the
	// section rebuilds in place with the new order.
	board.addEventListener('dashboard-skills-prefs', ((e: CustomEvent) => {
		const { columnName, prefs } = e.detail as { columnName: string; prefs: Partial<import('../types').SkillsSectionConfig> };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col || col.sectionType !== 'skills' || !prefs) return;
		const next = { ...col.skillsConfig, ...prefs };
		// Undefined values from the section (back-to-default picks) must
		// drop the key entirely so serialize stays idempotent.
		for (const key of Object.keys(next) as Array<keyof typeof next>) {
			if (next[key] === undefined) delete next[key];
		}
		void host.sync().updateSectionConfig(columnName, 'skillsConfig', next).then(() => {
			host.refreshSectionInPlace(columnName);
		});
	}) as EventListener);

	// Skills "new skill" button: the first click configures the creator
	// skill (agent + name + template), later clicks go straight to the
	// confirm dialog (directSend is an explicit opt-out).
	board.addEventListener('dashboard-skills-create', ((e: CustomEvent) => {
		const { columnName } = e.detail as { columnName: string };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col || col.sectionType !== 'skills') return;
		const cfg = col.skillsConfig?.createSkill;
		if (cfg) {
			host.dispatchSkillCreate(cfg);
			return;
		}
		new SkillCreateConfigModal(host.app, host.plugin(), undefined, saved => {
			const fresh = host.data()?.columns.find(c => c.name === columnName);
			void (async () => {
				await host.sync().updateSectionConfig(columnName, 'skillsConfig', { ...fresh?.skillsConfig, createSkill: saved });
				await rememberSkillNames(host.plugin(), saved.agent, [saved.skillName]);
				host.dispatchSkillCreate(saved);
			})();
		}).open();
	}) as EventListener);

	// Skills import — the modal needs the plugin (custom folders CSV,
	// remember-registry); the section only signals the intent.
	board.addEventListener('dashboard-skills-import', ((e: CustomEvent) => {
		const { columnName } = e.detail as { columnName: string };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col || col.sectionType !== 'skills') return;
		new SkillImportModal(host.app, {
			foldersCsv: host.plugin().settings.skillSourceFolders ?? '',
			defaultTargets: col.skillsConfig?.importTargets ?? [],
			onSaveTargets: ids => {
				// Fresh lookup: prefs may have changed while the modal was open.
				const fresh = host.data()?.columns.find(c => c.name === columnName);
				void host.sync().updateSectionConfig(columnName, 'skillsConfig', { ...fresh?.skillsConfig, importTargets: ids });
			},
			onImported: (name, agents) => {
				// Fresh skills surface immediately: rescan on next render
				// and offer the name in every targeted agent's picker.
				getSkillLibraryStore(host.app).markDirty();
				for (const agent of agents) void rememberSkillNames(host.plugin(), agent, [name]);
				host.refreshSectionInPlace(columnName);
			},
		}).open();
	}) as EventListener);

	// Pipeline value-filter rail pick — persists into the section config
	// and refreshes in place (the config change also busts the signature).
	board.addEventListener('dashboard-pipeline-filter', ((e: CustomEvent) => {
		const { columnName, filter } = e.detail as { columnName: string; filter?: { dim: string; value?: string } };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col?.pipelineConfig) return;
		const next = { ...col.pipelineConfig, filter };
		void host.sync().updateSectionConfig(columnName, 'pipelineConfig', next).then(() => {
			host.refreshSectionInPlace(columnName);
		});
	}) as EventListener);

	// Pipeline card sort — native-menu pick persists and refreshes in place.
	board.addEventListener('dashboard-pipeline-sort', ((e: CustomEvent) => {
		const { columnName, sortBy } = e.detail as { columnName: string; sortBy?: 'ctime' | 'platform' | 'name' | 'manual' };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col?.pipelineConfig) return;
		const next = { ...col.pipelineConfig, sortBy };
		void host.sync().updateSectionConfig(columnName, 'pipelineConfig', next).then(() => {
			host.refreshSectionInPlace(columnName);
		});
	}) as EventListener);

	board.addEventListener('dashboard-pipeline-manual-order', ((e: CustomEvent) => {
		const { columnName, stageValue, orderedPaths } = e.detail as { columnName: string; stageValue: string; orderedPaths: string[] };
		const col = host.data()?.columns.find(c => c.name === columnName);
		const config = col?.pipelineConfig;
		if (!config || config.sortBy !== 'manual' || !Array.isArray(orderedPaths) || orderedPaths.length === 0) return;
		// Slot-replacement merge: cards outside the emitted slice (filtered
		// out by the rail or below the render limit) keep their saved slots
		// instead of being demoted past the reordered ones.
		const stageOrder = { ...config.stageOrder, [stageValue]: mergeManualStageOrder(config.stageOrder?.[stageValue] ?? [], orderedPaths) };
		void host.sync().updateSectionConfig(columnName, 'pipelineConfig', { ...config, stageOrder }).then(() => host.refreshSectionInPlace(columnName));
	}) as EventListener);

	// Pipeline column width — dragged column edge persists per stage.
	board.addEventListener('dashboard-pipeline-col-width', ((e: CustomEvent) => {
		const { columnName, stageValue, width } = e.detail as { columnName: string; stageValue: string; width: number };
		const col = host.data()?.columns.find(c => c.name === columnName);
		const config = col?.pipelineConfig;
		if (!config || typeof width !== 'number') return;
		const next = {
			...config,
			stages: config.stages.map(stage => stage.value === stageValue ? { ...stage, width } : stage),
		};
		void host.sync().updateSectionConfig(columnName, 'pipelineConfig', next);
	}) as EventListener);

	// Pipeline skill-button reorder (dragged on a card's foot): persist the
	// new arrangement into pipelineConfig.skills and refresh in place so
	// every card's foot row picks it up together.
	board.addEventListener('dashboard-pipeline-skill-order', ((e: CustomEvent) => {
		const { columnName, stageValue, scope, orderedIds } = e.detail as {
			columnName: string;
			stageValue: string;
			scope: 'stage' | 'card';
			orderedIds: string[];
		};
		const col = host.data()?.columns.find(c => c.name === columnName);
		const config = col?.pipelineConfig;
		if (!config || !Array.isArray(orderedIds)) return;
		const next = {
			...config,
			skills: reorderSkillSubset(config.skills, stageValue, scope, orderedIds),
		};
		void host.sync().updateSectionConfig(columnName, 'pipelineConfig', next).then(() => {
			host.refreshSectionInPlace(columnName);
		});
	}) as EventListener);

	// PM board edits land straight on the project note — refresh every pm
	// section in place (the vault-event path is debounced; this is the
	// instant feedback the board modal's write-through wants).
	board.addEventListener('dashboard-pm-updated', (() => {
		const data = host.data();
		if (!data) return;
		for (const col of data.columns) {
			if (col.sectionType === 'pm') host.refreshSectionInPlace(col.name);
		}
	}));

	// PM card pin toggle: the full pinned path list arrives — persist and
	// refresh in place (pinned cards jump to the front).
	board.addEventListener('dashboard-pm-pin', ((e: CustomEvent) => {
		const { columnName, pinned } = e.detail as { columnName: string; pinned: string[] };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col || col.sectionType !== 'pm' || !col.pmConfig || !Array.isArray(pinned)) return;
		void host.sync().updateSectionConfig(columnName, 'pmConfig', { ...col.pmConfig, pinned }).then(() => {
			host.refreshSectionInPlace(columnName);
		});
	}) as EventListener);

	// PM view prefs (sort mode / grouped view) — merge into pmConfig.
	board.addEventListener('dashboard-pm-prefs', ((e: CustomEvent) => {
		const { columnName, prefs } = e.detail as { columnName: string; prefs: { sortMode?: 'name' | 'milestone' | 'keyDate'; groupView?: 'blocks' | 'kanban' } };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col || col.sectionType !== 'pm' || !col.pmConfig || !prefs) return;
		const next = { ...col.pmConfig, ...prefs };
		for (const key of Object.keys(next) as Array<keyof typeof next>) {
			if (next[key] === undefined) delete next[key];
		}
		void host.sync().updateSectionConfig(columnName, 'pmConfig', next).then(() => {
			host.refreshSectionInPlace(columnName);
		});
	}) as EventListener);

	// PM card drag reorder: the card list arrived in display order —
	// persist it as pmConfig.order and refresh in place.
	board.addEventListener('dashboard-pm-order', ((e: CustomEvent) => {
		const { columnName, order } = e.detail as { columnName: string; order: string[] };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (!col || col.sectionType !== 'pm' || !col.pmConfig || !Array.isArray(order)) return;
		void host.sync().updateSectionConfig(columnName, 'pmConfig', { ...col.pmConfig, order }).then(() => {
			host.refreshSectionInPlace(columnName);
		});
	}) as EventListener);

	// PM section header's + button: open the new-project form for that
	// column's config.
	board.addEventListener('dashboard-pm-new', ((e: CustomEvent) => {
		const { columnName } = e.detail as { columnName: string };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (col?.sectionType === 'pm' && col.pmConfig) {
			new PmNewModal(host.app, col.pmConfig).open();
		}
	}) as EventListener);

	// PM section header's archive button: the archived-projects viewer.
	board.addEventListener('dashboard-pm-archive', ((e: CustomEvent) => {
		const { columnName } = e.detail as { columnName: string };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (col?.sectionType === 'pm' && col.pmConfig) {
			new PmArchiveModal(host.app, col.pmConfig).open();
		}
	}) as EventListener);

	// Library/folder "new note" button — dispatched from the section toolbar.
	board.addEventListener('dashboard-library-new-note', ((e: CustomEvent) => {
		const { columnName, x, y } = e.detail as { columnName: string; x?: number; y?: number };
		const pos = (typeof x === 'number' && typeof y === 'number') ? { x, y } : undefined;
		void host.handleLibraryNewNote(columnName, pos);
	}) as EventListener);

	// TickTick view toggle (today/lists) — dispatched from header buttons.
	board.addEventListener('dashboard-ticktick-view', ((e: CustomEvent) => {
		const { columnName, view } = e.detail as { columnName: string; view: 'today' | 'lists' };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (col) {
			const config = col.ticktickConfig ?? { view: 'today' as const };
			host.suppressNextRender();
			void host.sync().updateSectionConfig(columnName, 'ticktickConfig', { ...config, view }).then(() => {
				host.refreshSectionInPlace(columnName);
			});
		}
	}) as EventListener);

	// TickTick project filter (lists view).
	board.addEventListener('dashboard-ticktick-filter', ((e: CustomEvent) => {
		const { columnName } = e.detail as { columnName: string };
		void host.openTickTickFilterModal(columnName);
	}) as EventListener);

	// TickTick project card resize (lists view).
	board.addEventListener('dashboard-ticktick-resize', ((e: CustomEvent) => {
		const { columnName, projectWidths } = e.detail as { columnName: string; projectWidths: Record<string, number> };
		const col = host.data()?.columns.find(c => c.name === columnName);
		if (col?.ticktickConfig) {
			host.suppressNextRender();
			void host.sync().updateSectionConfig(columnName, 'ticktickConfig', { ...col.ticktickConfig, projectWidths }).then(() => {
				host.refreshSectionInPlace(columnName);
			});
		}
	}) as EventListener);
}
