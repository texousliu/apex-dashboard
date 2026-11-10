/**
 * New-task prefix / suffix templates (todo card → gear → "New task prefix /
 * suffix").
 *
 * The feature is small but has four independent failure modes, so each gets its
 * own group:
 *
 * 1. applyTaskAffixes — the join rules. One space between pieces, {{text}}
 *    decides where the body goes (prefix wins when both claim it), unknown
 *    placeholders survive verbatim, date/time are LOCAL.
 * 2. Parser round-trip — `taskPrefix:` / `taskSuffix:` survive
 *    serialize → parse with tags, wikilinks and inner spaces intact, and stay
 *    unpersisted when empty.
 * 3. sync.addTask — decoration happens at STORAGE time, so the stored task,
 *    the daily-note mirror and the markdown all agree; an edit must not
 *    re-apply it.
 * 4. Config dialog — both fields render with the saved values, save trimmed
 *    values, and the help block documents every token in
 *    TASK_AFFIX_PLACEHOLDERS (a placeholder added without a translation would
 *    otherwise be undiscoverable).
 *
 * Run: `npm run test:task-affixes`
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { App, Modal, TFile } from 'obsidian';
import {
	TASK_AFFIX_PLACEHOLDERS,
	applyTaskAffixes,
	affixDate,
	affixTime,
} from '../src/task-affixes';
import { parse, serialize } from '../src/parser';
import { SyncEngine } from '../src/sync';
import { TaskCardConfigModal } from '../src/task-card-config-modal';
import type { DashboardCard, DashboardData, DashboardSettings, TaskCardConfig } from '../src/types';
import { El, findByClass, findTag } from './mini-dom';

(globalThis as Record<string, unknown>).createDiv = (o?: { cls?: string; text?: string }): El => {
	const el = new El('div');
	if (o?.cls) el.addClass(...o.cls.split(/\s+/));
	if (o?.text !== undefined) el.textContent = o.text;
	return el;
};
(globalThis as { activeDocument?: unknown }).activeDocument = { querySelector: (): null => null };
(globalThis as { window?: unknown }).window = globalThis;

/** Local noon, so a UTC/local mix-up cannot shift the day. */
const AT = new Date(2026, 10, 10, 9, 5, 0);

async function main(): Promise<void> {
	// ---------- 1. applyTaskAffixes ----------

	// No config / empty templates: the text passes through untouched, only trimmed.
	{
		assert.equal(applyTaskAffixes('  买牛奶  ', undefined, AT), '买牛奶', 'no config trims and returns');
		assert.equal(applyTaskAffixes('买牛奶', {}, AT), '买牛奶', 'empty config is a no-op');
		assert.equal(applyTaskAffixes('买牛奶', { prefix: '   ', suffix: '  ' }, AT), '买牛奶', 'blank templates are no-ops');
		assert.equal(applyTaskAffixes('   ', { prefix: '#todo' }, AT), '', 'blank text stays blank');
	}

	// Prefix only / suffix only: one space separates the pieces, the user does not
	// have to guess how many trailing spaces to type.
	{
		assert.equal(applyTaskAffixes('买牛奶', { prefix: '#todo' }, AT), '#todo 买牛奶', 'prefix joined with one space');
		assert.equal(
			applyTaskAffixes('买牛奶', { suffix: '@{{date}}' }, AT),
			'买牛奶 @2026-11-10',
			'suffix joined with one space',
		);
		assert.equal(
			applyTaskAffixes('买牛奶', { prefix: '#todo', suffix: '@{{date}}' }, AT),
			'#todo 买牛奶 @2026-11-10',
			'both sides',
		);
	}

	// {{text}} owns the body: the other template must NOT repeat it, and no extra
	// body is inserted between the pieces.
	{
		assert.equal(
			applyTaskAffixes('买牛奶', { prefix: '#todo {{text}}', suffix: '@{{date}}' }, AT),
			'#todo 买牛奶 @2026-11-10',
			'{{text}} in the prefix places the body there once',
		);
		assert.equal(
			applyTaskAffixes('买牛奶', { prefix: '{{date}}', suffix: '— {{text}}' }, AT),
			'2026-11-10 — 买牛奶',
			'{{text}} in the suffix owns the body',
		);
		// Both claim it: the head wins, the tail's token renders empty. The body
		// still appears exactly once.
		assert.equal(
			applyTaskAffixes('买牛奶', { prefix: '[{{text}}]', suffix: '({{text}})' }, AT),
			'[买牛奶] ()',
			'prefix wins when both templates carry {{text}}',
		);
	}

	// {{title}} and unknown placeholders.
	{
		assert.equal(
			applyTaskAffixes('买牛奶', { prefix: '#todo', suffix: '· {{title}}', title: '今日待办' }, AT),
			'#todo 买牛奶 · 今日待办',
			'{{title}} resolves to the card title',
		);
		assert.equal(
			applyTaskAffixes('买牛奶', { suffix: '{{foo}}' }, AT),
			'买牛奶 {{foo}}',
			'unknown placeholders survive verbatim',
		);
		// An empty card title collapses instead of leaving a dangling separator.
		assert.equal(
			applyTaskAffixes('买牛奶', { suffix: '{{title}}' }, AT),
			'买牛奶',
			'an empty {{title}} contributes nothing (no trailing space)',
		);
	}

	// Date / time are local and zero-padded.
	{
		assert.equal(affixDate(new Date(2026, 0, 5, 23, 30)), '2026-01-05', 'local date, zero-padded');
		assert.equal(affixDate(new Date(2026, 11, 31, 23, 59)), '2026-12-31', 'never rolls over early');
		assert.equal(affixTime(new Date(2026, 0, 5, 9, 5)), '09:05', 'time zero-padded');
	}

	console.log('applyTaskAffixes: PASS');

	// ---------- 2. Parser round-trip ----------

	{
		const md = [
			'## C',
			'',
			'### 今日待办',
			'',
			'id: c1',
			'type: task',
			'taskPrefix: #todo #inbox',
			'taskSuffix: @{{date}} [[日记]]',
			'',
			'- [ ] 已经存在的任务',
			'',
		].join('\n');
		const data = parse(md);
		const card = data.columns[0]!.cards[0]!;
		assert.equal(card.taskPrefix, '#todo #inbox', 'prefix parses with tags and inner spaces');
		assert.equal(card.taskSuffix, '@{{date}} [[日记]]', 'suffix parses with a wikilink');

		const round = parse(serialize({ ...data, columns: data.columns })).columns[0]!.cards[0]!;
		assert.equal(round.taskPrefix, card.taskPrefix, 'prefix survives a round-trip');
		assert.equal(round.taskSuffix, card.taskSuffix, 'suffix survives a round-trip');
		assert.equal(round.tasks.length, 1, 'the task line is still a task, not metadata');
		assert.equal(round.tasks[0]!.text, '已经存在的任务', 'existing tasks are untouched');
	}

	// Empty affixes stay unpersisted (no `taskPrefix: ` line, no regression for
	// boards written before the feature existed).
	{
		const md = ['## C', '', '### 普通卡片', '', 'id: c2', 'type: task', '', '- [ ] a', ''].join('\n');
		const data = parse(md);
		const card = data.columns[0]!.cards[0]!;
		assert.equal(card.taskPrefix, undefined, 'missing prefix key → undefined');
		assert.equal(card.taskSuffix, undefined, 'missing suffix key → undefined');

		const out = serialize({ ...data, columns: data.columns });
		assert.ok(!/^taskPrefix:/m.test(out), 'no empty taskPrefix line is written');
		assert.ok(!/^taskSuffix:/m.test(out), 'no empty taskSuffix line is written');
	}

	console.log('parser round-trip: PASS');

	// ---------- 3. sync.addTask applies the templates ----------

	async function addTaskOnCard(card: Partial<DashboardCard>, text: string): Promise<string> {
		const file = Object.assign(new TFile(), { path: 'board.md', basename: 'board', extension: 'md' });
		const app = {
			vault: {
				read: async () => '',
				modify: async () => {},
				adapter: {
					exists: async () => true,
					mkdir: async () => {},
					write: async () => {},
					list: async () => ({ files: [], folders: [] }),
					remove: async () => {},
				},
			},
		} as unknown as App;
		// Start from a real parse so every field serialize() needs is present;
		// then patch in the affix config under test.
		const data = parse(['## C', '', '### 今日待办', '', 'id: c1', 'type: task', '', '- [ ] seed', ''].join('\n'));
		const target = data.columns[0]!.cards[0]!;
		Object.assign(target, card);
		target.tasks = [];
		const engine = new SyncEngine(app, {} as DashboardSettings);
		(engine as unknown as { data: DashboardData }).data = data;
		(engine as unknown as { file: TFile }).file = file;
		await engine.addTask('c1', text);
		const stored = engine.getData()!.columns[0]!.cards[0]!.tasks;
		return stored[0]!.text;
	}

	{
		assert.equal(
			await addTaskOnCard({}, '买牛奶'),
			'买牛奶',
			'a card without affixes stores the text as typed',
		);
		assert.equal(
			await addTaskOnCard({ taskPrefix: '#todo' }, '买牛奶'),
			'#todo 买牛奶',
			'the prefix is applied when the task is stored',
		);
		const dated = await addTaskOnCard({ taskSuffix: '@{{date}}' }, '买牛奶');
		assert.match(dated, /^买牛奶 @\d{4}-\d{2}-\d{2}$/, 'the suffix resolves {{date}} at add time');
		assert.equal(
			await addTaskOnCard({ taskPrefix: '#todo', taskSuffix: '· {{title}}' }, '买牛奶'),
			'#todo 买牛奶 · 今日待办',
			'both affixes plus {{title}}',
		);
	}

	// Decoration must happen once: only addTask touches the templates, so editing a
	// task's text later cannot stack a second prefix.
	{
		const src = readFileSync('src/sync.ts', 'utf8');
		const uses = src.split('applyTaskAffixes').length - 1;
		assert.equal(uses, 2, 'applyTaskAffixes appears once (import) + once (addTask), not in editTask');
	}

	console.log('sync.addTask affixes: PASS');

	// ---------- 4. Config dialog ----------

	{
		const saved: TaskCardConfig[] = [];
		const card = { id: 'c1', title: '今日待办', type: 'task', taskPrefix: ' #todo ', taskSuffix: '@{{date}}' } as unknown as DashboardCard;
		const modal = new TaskCardConfigModal({} as App, card, cfg => saved.push(cfg));
		modal.onOpen();
		const root = modal.contentEl as unknown as El;

		// Two text inputs (the behavior/heading fields are selects, the daily-source
		// toggle is a checkbox).
		const textInputs = findTag(root, 'input').filter(i => i.getAttribute('type') === 'text');
		assert.equal(textInputs.length, 2, 'one input per affix');
		const [prefixInput, suffixInput] = textInputs as unknown as Array<El & { value: string }>;
		assert.equal(prefixInput!.value, ' #todo ', 'saved prefix renders as stored (trim happens on save)');
		assert.equal(suffixInput!.value, '@{{date}}', 'saved suffix renders as stored');

		// The help block documents every supported placeholder.
		const helpText = root.textContent;
		for (const name of TASK_AFFIX_PLACEHOLDERS) {
			assert.ok(helpText.includes(`{{${name}}}`), `the dialog documents {{${name}}}`);
		}
		const list = findByClass(root, 'dashboard-task-affix-placeholders')[0];
		assert.ok(list, 'the placeholder list rendered');
		assert.equal(
			list!.children.length,
			TASK_AFFIX_PLACEHOLDERS.length,
			'one list row per placeholder (a new token without a translation goes red here)',
		);

		// Typing + saving emits trimmed values alongside the untouched fields.
		prefixInput!.value = '  #inbox  ';
		prefixInput!.dispatchEvent({ type: 'input' });
		suffixInput!.value = '   ';
		suffixInput!.dispatchEvent({ type: 'input' });
		const saveBtn = findTag(root, 'button')
			.filter(b => b.hasClass('dashboard-modal-btn--confirm'))
			.pop() as unknown as El;
		assert.ok(saveBtn, 'the footer save button rendered');
		saveBtn.click();

		assert.equal(saved.length, 1, 'save emits one config');
		assert.equal(saved[0]!.taskPrefix, '#inbox', 'prefix is trimmed');
		assert.equal(saved[0]!.taskSuffix, '', 'a cleared suffix saves as the empty string');
		assert.equal(saved[0]!.taskCompleteBehavior, 'end', 'the other fields keep their defaults');
	}

	// Every dictionary carries the placeholder help (a key present only in English
	// leaves ten languages showing raw key names).
	{
		const files = [
			'src/i18n.ts',
			'src/locales/de/part-1.ts', 'src/locales/es/part-1.ts', 'src/locales/fr/part-1.ts',
			'src/locales/ja/part-1.ts', 'src/locales/ko/part-1.ts', 'src/locales/pt-BR/part-1.ts',
			'src/locales/ru/part-1.ts', 'src/locales/th/part-1.ts',
		];
		for (const file of files) {
			const src = readFileSync(file, 'utf8');
			for (const name of TASK_AFFIX_PLACEHOLDERS) {
				const key = `taskConfig.affixPh${name.charAt(0).toUpperCase()}${name.slice(1)}`;
				assert.ok(src.includes(key), `${file} carries ${key}`);
				assert.ok(src.includes(`{{${name}}}`), `${file} documents {{${name}}}`);
			}
		}
	}

	console.log('config dialog: PASS');

	// ---------- 5. view wiring ----------

	{
		const src = readFileSync('src/view.ts', 'utf8');
		assert.ok(
			/taskPrefix: config\.taskPrefix\.trim\(\) \|\| undefined/.test(src),
			'applyTaskCardConfig persists the trimmed prefix, empty → undefined',
		);
		assert.ok(
			/taskSuffix: config\.taskSuffix\.trim\(\) \|\| undefined/.test(src),
			'applyTaskCardConfig persists the trimmed suffix, empty → undefined',
		);
	}

	console.log('view wiring: PASS');
	console.log('verify-task-affixes: ok');
}

void main();
