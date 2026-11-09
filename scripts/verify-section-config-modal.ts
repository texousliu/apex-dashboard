/**
 * Verifies the shared config-modal shell (src/section/config-modal.ts).
 *
 * Every section config modal used to hand-write the same eleven lines of
 * chrome (clear, four container classes, theme, frame, title, body, footer,
 * Cancel/Save wiring, close cleanup). Twenty-two copies meant a missed theme
 * call or bg class was one careless copy-paste away, and a shell tweak had to
 * be repeated everywhere.
 *
 * 1. Shell — classes, title, body, footer, no duplicate DOM across re-opens.
 * 2. Wiring — Save runs `submit` once; Cancel closes without saving.
 * 3. Ordering — the footer exists before the body paints, so validation can
 *    gate the Save button on the first render.
 * 4. Variants — a subclass can change size / content class and add footer
 *    buttons without losing the shared ones.
 * 5. No drift — migrated modals no longer build the shell by hand.
 *
 * Run: `npm run test:section-config-modal`
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { App } from 'obsidian';
import { El, findByClass, findTag } from './mini-dom';
import { SectionConfigModal } from '../src/section/config-modal';
import { setLanguage } from '../src/i18n';

(globalThis as { window?: unknown }).window = globalThis;
// applyModalTheme reads the dashboard root off activeDocument.
(globalThis as { activeDocument?: unknown }).activeDocument = {
	querySelector: () => null,
	querySelectorAll: () => [],
};
setLanguage('zh');

const app = {} as App;

/* ------------------------------- test modal -------------------------------- */

class ProbeModal extends SectionConfigModal {
	saved = 0;
	closed = 0;
	extraButtons: string[] = [];
	bodyPainted = false;
	confirmVisibleFromBody = false;
	override close(): void { this.closed += 1; }

	protected title(): string { return '探针配置'; }

	protected renderBody(body: HTMLElement): void {
		this.bodyPainted = true;
		// Ordering contract: the Save button already exists here.
		this.confirmVisibleFromBody = this.confirmBtn !== null;
		body.createDiv({ cls: 'probe-field', text: '字段' });
	}

	protected submit(): void { this.saved += 1; }

	protected buildFooter(footer: HTMLElement): void {
		super.buildFooter(footer);
		for (const label of this.extraButtons) {
			footer.createEl('button', { cls: 'probe-extra', text: label, attr: { type: 'button' } });
		}
	}
}

/* --------------------------------- 1. shell -------------------------------- */

{
	const modal = new ProbeModal(app);
	modal.onOpen();
	const content = modal.contentEl as unknown as El;
	const container = modal.containerEl as unknown as El;

	assert.ok(content.hasClass('dashboard-library-config-modal'), '1: contentEl scoped class');
	assert.ok(container.hasClass('modal--dashboard'), '1: dashboard modal class');
	assert.equal(findByClass(content, 'dashboard-modal').length, 1, '1: one frame');
	assert.equal(findByClass(content, 'dashboard-modal--compact').length, 1, '1: compact by default');
	assert.equal(findByClass(content, 'dashboard-modal-title')[0]!.textContent, '探针配置', '1: title from the subclass');
	assert.equal(findByClass(content, 'dashboard-modal-body').length, 1, '1: body slot');
	assert.equal(findByClass(content, 'probe-field').length, 1, '1: subclass painted the body');
	assert.equal(findByClass(content, 'dashboard-modal-footer').length, 1, '1: footer slot');
	assert.equal(findByClass(content, 'dashboard-modal-btn--cancel').length, 1, '1: cancel button');
	assert.equal(findByClass(content, 'dashboard-modal-btn--confirm').length, 1, '1: save button');

	// DOM order: header, body, footer.
	const frame = findByClass(content, 'dashboard-modal')[0]!;
	assert.deepEqual(
		frame.children.map(c => c.className.split(/\s+/)[0]),
		['dashboard-modal-header', 'dashboard-modal-body', 'dashboard-modal-footer'],
		'1: header → body → footer',
	);

	// Re-opening rebuilds from scratch instead of stacking a second frame.
	modal.onOpen();
	assert.equal(findByClass(content, 'dashboard-modal').length, 1, '1: re-open does not duplicate the shell');
	assert.equal(findByClass(content, 'probe-field').length, 1, '1: re-open does not duplicate fields');
}

/* -------------------------------- 2. wiring -------------------------------- */

{
	const modal = new ProbeModal(app);
	modal.onOpen();
	const content = modal.contentEl as unknown as El;
	findByClass(content, 'dashboard-modal-btn--confirm')[0]!.click();
	assert.equal(modal.saved, 1, '2: save runs submit exactly once');
	assert.equal(modal.closed, 0, '2: the shell does not force-close (submit decides)');

	findByClass(content, 'dashboard-modal-btn--cancel')[0]!.click();
	assert.equal(modal.closed, 1, '2: cancel closes');
	assert.equal(modal.saved, 1, '2: cancel never saves');

	modal.onClose();
	assert.equal(findByClass(content, 'dashboard-modal').length, 0, '2: close empties the content element');
}

/* ------------------------------- 3. ordering ------------------------------- */

{
	const modal = new ProbeModal(app);
	modal.onOpen();
	assert.equal(modal.bodyPainted, true, '3: body painted on open');
	assert.equal(modal.confirmVisibleFromBody, true, '3: save button exists while the body paints');
}

/* ------------------------------- 4. variants ------------------------------- */

{
	class WideModal extends ProbeModal {
		protected sizeClass(): string { return 'dashboard-modal--wide'; }
		protected contentClass(): string { return 'dashboard-library-config-modal probe-wide'; }
		protected frameClass(): string { return 'probe-frame'; }
		protected saveLabel(): string { return '应用'; }
	}
	const modal = new WideModal(app);
	modal.onOpen();
	const content = modal.contentEl as unknown as El;
	assert.equal(findByClass(content, 'dashboard-modal--wide').length, 1, '4: size variant applies');
	assert.equal(findByClass(content, 'probe-frame').length, 1, '4: extra frame class applies');
	assert.ok(content.hasClass('probe-wide'), '4: extra content class applies');
	const confirm = findByClass(content, 'dashboard-modal-btn--confirm')[0]!;
	assert.equal(confirm.textContent, '应用', '4: save label overridable');
	assert.equal(findTag(content, 'button').length, 2, '4: cancel + save still exactly once each');
}

{
	const modal = new ProbeModal(app);
	modal.extraButtons = ['重置'];
	modal.onOpen();
	const content = modal.contentEl as unknown as El;
	const footerButtons = findTag(findByClass(content, 'dashboard-modal-footer')[0]!, 'button');
	assert.deepEqual(
		footerButtons.map(b => b.textContent),
		['取消', '保存', '重置'],
		'4: subclass extras sit after the shared pair',
	);
}

/* -------------------------------- 5. no drift ------------------------------ */

const SHELL_MARKERS = [
	"contentEl.addClass('dashboard-library-config-modal')",
	"containerEl.addClass('modal--dashboard')",
	"applyModalTheme(containerEl)",
];

/**
 * Files that must ride the shared shell. Every modal in these files — config
 * forms and the pickers that stack over them (folder multi-select, command
 * search) — goes through the base class.
 */
const MIGRATED = [
	{ file: 'src/web-config-modal.ts' },
	{ file: 'src/rss-config-modal.ts' },
	{ file: 'src/media-config-modal.ts' },
	{ file: 'src/dataview-config-modal.ts' },
	{ file: 'src/notes-config-modal.ts' },
	{ file: 'src/library-config-modal.ts' },
	{ file: 'src/folder-config-modal.ts' },
	{ file: 'src/material-config-modal.ts' },
	{ file: 'src/pipeline-config-modal.ts' },
	{ file: 'src/pm-config-modal.ts' },
	{ file: 'src/weread-config-modal.ts' },
	{ file: 'src/skill-section-config-modal.ts' },
	{ file: 'src/skill-create-config-modal.ts' },
	{ file: 'src/skill-widget-config-modal.ts' },
	{ file: 'src/task-card-config-modal.ts' },
	{ file: 'src/tracker-config-modal.ts' },
	{ file: 'src/weather-config-modal.ts' },
	{ file: 'src/quick-note-config-modal.ts' },
];

for (const { file } of MIGRATED) {
	const src = readFileSync(file, 'utf8');
	assert.ok(src.includes('extends SectionConfigModal'), `5: ${file} uses the shared shell`);
	for (const marker of SHELL_MARKERS) {
		assert.ok(!src.includes(marker), `5: ${file} no longer hand-writes ${marker}`);
	}
	assert.ok(!src.includes("createDiv({ cls: 'dashboard-modal-footer' })"), `5: ${file} does not build its own footer`);
	// Either inherit the cleanup outright, or override it for real teardown
	// (the weather modal cancels its debounce) and delegate to the base.
	if (src.includes('onClose(): void')) {
		assert.ok(src.includes('super.onClose()'), `5: ${file} delegates cleanup to the base`);
	}
}

console.log('section config modal: all scenarios OK');
