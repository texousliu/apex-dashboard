/**
 * One-time config for the section header's "new skill" button: which agent
 * runs the creator skill, the skill's name (picker-fed), an optional prompt
 * template, and a direct-send opt-out (off by default — Rae: the confirm
 * dialog stays unless explicitly skipped). Saving hands the config back;
 * the caller (view.ts) persists it and fires the first run.
 */

import type { App } from 'obsidian';
import type { AgentTarget, SkillCreateConfig } from './types';
import { t } from './i18n';
import { SectionConfigModal } from './section/config-modal';
import { agentPickerOption, agentTargets, isValidSkillName } from './agent-dispatch';
import { attachSkillPicker } from './skill-registry';
import type DashboardPlugin from './main';

export class SkillCreateConfigModal extends SectionConfigModal {
	private agent: AgentTarget;
	private skillName: string;
	private promptTemplate: string;
	private directSend: boolean;
	private validationEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly plugin: DashboardPlugin,
		existing: SkillCreateConfig | undefined,
		private readonly onSave: (config: SkillCreateConfig) => void,
	) {
		super(app);
		this.agent = existing?.agent ?? 'claudian';
		this.skillName = existing?.skillName ?? 'skill-creator';
		this.promptTemplate = existing?.promptTemplate ?? '';
		this.directSend = existing?.directSend ?? false;
	}

	protected contentClass(): string {
		return 'dashboard-skillsec-createcfg-modal';
	}

	protected frameClass(): string {
		return 'dashboard-skillsec-createcfg';
	}

	protected title(): string {
		return t('skills.createCfgTitle');
	}

	protected renderBody(body: HTMLElement): void {
		body.createDiv({ cls: 'dashboard-library-config-hint', text: t('skills.createCfgHint') });

		const agentRow = body.createDiv({ cls: 'dashboard-skillsec-createcfg-row' });
		agentRow.createSpan({ cls: 'dashboard-skillsec-createcfg-label', text: t('skills.createCfgAgent') });
		const agentSel = agentRow.createEl('select', { cls: 'dashboard-library-filter-property' });
		for (const target of agentTargets()) {
			const pick = agentPickerOption(target);
			const opt = agentSel.createEl('option', { text: pick.label, attr: { value: target } });
			opt.disabled = pick.disabled;
			opt.selected = target === this.agent;
		}
		agentSel.addEventListener('change', () => {
			this.agent = agentSel.value as AgentTarget;
		});

		const nameRow = body.createDiv({ cls: 'dashboard-skillsec-createcfg-row' });
		nameRow.createSpan({ cls: 'dashboard-skillsec-createcfg-label', text: t('skills.createCfgSkill') });
		const nameWrap = nameRow.createDiv({ cls: 'dashboard-skillsec-createcfg-namewrap' });
		const nameInput = nameWrap.createEl('input', {
			cls: 'dashboard-modal-input',
			attr: { type: 'text', placeholder: 'skill-creator' },
		});
		nameInput.value = this.skillName;
		nameInput.addEventListener('input', () => {
			this.skillName = nameInput.value.trim();
			this.validate();
		});
		attachSkillPicker(nameWrap, nameInput, this.app, {
			plugin: this.plugin,
			getAgent: () => this.agent,
		}, name => {
			this.skillName = name;
			this.validate();
		});

		const tplSection = body.createDiv({ cls: 'dashboard-library-config-section' });
		tplSection.createDiv({ cls: 'dashboard-library-config-section-title', text: t('skills.createCfgTemplate') });
		const tplInput = tplSection.createEl('input', {
			cls: 'dashboard-modal-input',
			attr: { type: 'text', placeholder: t('skills.createCfgTemplatePh') },
		});
		tplInput.value = this.promptTemplate;
		tplInput.addEventListener('input', () => {
			this.promptTemplate = tplInput.value;
		});

		const sendRow = body.createDiv({ cls: 'dashboard-skillsec-createcfg-row' });
		const dsLabel = sendRow.createEl('label', { cls: 'dashboard-skillsec-createcfg-ds' });
		const dsCb = dsLabel.createEl('input', { attr: { type: 'checkbox' } });
		dsCb.checked = this.directSend;
		dsCb.addEventListener('change', () => {
			this.directSend = dsCb.checked;
		});
		dsLabel.createSpan({ text: t('skills.createCfgDirectSend') });

		this.validationEl = body.createDiv({ cls: 'dashboard-dataview-validation' });
		this.validate();
	}

	private validate(): boolean {
		const ok = isValidSkillName(this.skillName);
		if (this.validationEl) {
			this.validationEl.setText(ok ? '' : t('agent.invalidSkill'));
		}
		if (this.confirmBtn) this.confirmBtn.disabled = !ok;
		return ok;
	}

	protected submit(): void {
		if (!this.validate() || !this.skillName) return;
		this.onSave({
			agent: this.agent,
			skillName: this.skillName,
			promptTemplate: this.promptTemplate,
			// Only persist the opt-in (round-trip cleanliness).
			...(this.directSend ? { directSend: true } : {}),
		});
		this.close();
	}
}
