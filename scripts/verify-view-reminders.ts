/**
 * Verifies the reminder scan (`src/view/reminders.ts`), the module extracted
 * from view.ts in Phase 5.
 *
 * The regression this pins: the countdown pass used to be nested inside the
 * PM-columns loop, so countdown reminders never fired on a board without a PM
 * section. Case 1 is exactly that board.
 *
 * 1. A due countdown raises a Notice on a board with no PM section.
 * 2. The same scan twice raises it once (the fired-key set gates it).
 * 3. A due task reminder opens the reminder modal; dismiss clears it, snooze
 *    pushes it an hour out — both through the host write-back.
 *
 * Run: `npm run test:view-reminders`
 */
import { strict as assert } from 'node:assert';
import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { checkReminders } from '../src/view/reminders';

// The obsidian alias resolves to scripts/obsidian-stub.ts at bundle time, so
// the runtime classes carry the harness hooks the types do not declare.
const NoticeStub = Notice as unknown as { messages: string[] };
const ModalStub = Modal as unknown as { last: unknown };
import type { DashboardData, DashboardSettings } from '../src/types';

const app = {
	vault: { getMarkdownFiles: () => [] },
	metadataCache: { getFileCache: () => null },
	fileManager: { processFrontMatter: async () => {} },
} as unknown as App;

function makeHost(data: DashboardData | null, settings: DashboardSettings, fired = new Set<string>()) {
	const writes: Array<{ cardId: string; taskPath: number[]; reminder: string | undefined }> = [];
	return {
		writes,
		fired,
		host: {
			app,
			data,
			settings,
			fired,
			editTaskReminder: (cardId: string, taskPath: number[], reminder: string | undefined) => {
				writes.push({ cardId, taskPath, reminder });
			},
		},
	};
}

function boardWith(columns: unknown[]): DashboardData {
	return { columns } as unknown as DashboardData;
}

function inDays(days: number): string {
	const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 1 + 2. Countdown reminder on a board with NO pm section.
{
	NoticeStub.messages = [];
	const settings = {
		countdownEnabled: true,
		countdowns: [{ id: 'c1', label: 'DDL', targetDate: inDays(2), reminderDays: 3 }],
		anniversaryEnabled: false,
	} as unknown as DashboardSettings;
	// A library column only — no `sectionType: 'pm'` anywhere.
	const data = boardWith([{ name: 'Library', sectionType: 'library', cards: [] }]);
	const { host, fired } = makeHost(data, settings);

	checkReminders(host);
	assert.equal(NoticeStub.messages.length, 1,
		'1: a due countdown fires even though the board has no PM section');
	assert.ok(NoticeStub.messages[0]!.includes('DDL'),
		`1: the notice names the countdown (got ${JSON.stringify(NoticeStub.messages[0])})`);
	assert.ok(fired.has('countdown-remind-c1'), '1: the fired-key is recorded');

	checkReminders(host);
	assert.equal(NoticeStub.messages.length, 1, '2: the second scan does not repeat the notice');
}

// A countdown still outside its window stays quiet.
{
	NoticeStub.messages = [];
	const settings = {
		countdownEnabled: true,
		countdowns: [{ id: 'c2', label: 'Far', targetDate: inDays(30), reminderDays: 3 }],
		anniversaryEnabled: false,
	} as unknown as DashboardSettings;
	checkReminders(makeHost(boardWith([]), settings).host);
	assert.equal(NoticeStub.messages.length, 0, '3: a countdown 30 days out is outside its 3-day window');
}

// 4 + 5. Task reminder: dismiss clears, snooze re-arms an hour out.
{
	NoticeStub.messages = [];
	ModalStub.last = null;
	const settings = { countdownEnabled: false, anniversaryEnabled: false } as unknown as DashboardSettings;
	const data = boardWith([{
		name: 'Todo',
		sectionType: 'sticky',
		cards: [{
			id: 'card-1',
			type: 'task',
			title: 'Todo',
			tasks: [{ text: 'Pay the bill', checked: false, reminder: '2020-01-01 09:00' }],
		}],
	}]);
	const { host, fired, writes } = makeHost(data, settings);

	checkReminders(host);
	assert.ok(ModalStub.last, '4: a due task reminder opens the reminder modal');
	assert.ok(fired.has('card-1-[0]'), '4: the task reminder is marked fired');

	const modal = ModalStub.last as unknown as { onDismiss: () => void; onSnooze: () => void };
	modal.onDismiss();
	assert.equal(writes.length, 1, '4: dismiss writes back once');
	assert.equal(writes[0]!.cardId, 'card-1', '4: dismiss targets the card');
	assert.deepEqual(writes[0]!.taskPath, [0], '4: dismiss targets the task path');
	assert.equal(writes[0]!.reminder, undefined, '4: dismiss clears the reminder');

	// Snooze: fire the same reminder again (render() clears the set), then snooze.
	fired.clear();
	ModalStub.last = null;
	checkReminders(host);
	const snoozeModal = ModalStub.last as unknown as { onSnooze: () => void };
	snoozeModal.onSnooze();
	assert.equal(writes.length, 2, '5: snooze writes back');
	const snoozed = writes[1]!.reminder;
	assert.ok(typeof snoozed === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(snoozed),
		`5: snooze writes a full date-time (got ${String(snoozed)})`);
	const delta = new Date(snoozed!.replace(' ', 'T')).getTime() - Date.now();
	assert.ok(delta > 55 * 60 * 1000 && delta <= 61 * 60 * 1000,
		`5: snooze is ~one hour out (got ${Math.round(delta / 60000)} min)`);
	assert.ok(!fired.has('card-1-[0]'), '5: snooze re-arms the key so the next scan can fire it');
}

console.log('view-reminders: ok');
