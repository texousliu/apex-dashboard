/**
 * Guards the test harness itself (`scripts/obsidian-stub.ts` + the clock helper).
 *
 * The bug this exists for: the stub's `moment()` used a bare `new Date()`. That
 * constructor reads the system clock directly and ignores a frozen `Date.now`,
 * so the two daily-note cases in `verify-task-writes` asserted against a
 * fixture path computed from the *real* date while pinning `Date.now` to
 * something else. They passed on the day they were written and failed the next
 * morning — a suite that is green only on one calendar day.
 *
 * 1. **A frozen clock reaches `moment()`.** Pinned to a sentinel instant, not
 *    "today", so a broken freeze cannot accidentally produce the expected value.
 * 2. **The clock is restored afterwards** — a frozen clock must not leak into
 *    the next case (or, here, into the next assertion).
 * 3. **Date-only strings parse as local midnight.** `new Date('2026-11-09')` is
 *    UTC; in any timezone east of Greenwich that is already the previous day
 *    locally, which shifts a daily-note path by one. The stub pins this down.
 * 4. **Epoch input passes through untouched.**
 * 5. **An unfrozen `moment()` follows the real clock.** Otherwise a hardcoded
 *    constant would satisfy group 1 and nothing would notice.
 *
 * Run: `npm run test:obsidian-stub`
 */
import { strict as assert } from 'node:assert';
import { moment } from 'obsidian';
import { SENTINEL_NOW, withFrozenNow } from './test-clock';

/** True when the sentinel instant is NOT what the harness reports. */
function assertNotFrozen(why: string): void {
	assert.notStrictEqual(
		Date.now(),
		new Date(SENTINEL_NOW).getTime(),
		`${why}: ambient Date.now is still the sentinel`,
	);
	assert.notStrictEqual(
		moment().format('YYYY-MM-DD'),
		SENTINEL_NOW.slice(0, 10),
		`${why}: moment() still reports the sentinel date`,
	);
}

async function main() {
	// 1. Frozen clock is what moment() reports.
	await withFrozenNow(SENTINEL_NOW, () => {
		assert.equal(moment().format('YYYY-MM-DD'), '1999-12-31', '1: frozen date');
		assert.equal(moment().format('HH:mm'), '10:00', '1: frozen time of day');
	});

	// 2. Restored once the helper returns.
	assertNotFrozen('2: after withFrozenNow');

	// 3. Date-only input is local midnight, not UTC midnight.
	assert.equal(
		moment('2026-11-09').valueOf(),
		new Date(2026, 10, 9).getTime(),
		'3: date-only string parses as local midnight',
	);
	assert.equal(moment('2026-11-09').format('YYYY-MM-DD'), '2026-11-09', '3: no day shift');

	// 4. Epoch input is passed straight through.
	assert.equal(moment(1_700_000_000_000).valueOf(), 1_700_000_000_000, '4: epoch passthrough');

	// 5. A throwing case still restores the clock (the `finally` in the helper).
	await assert.rejects(
		withFrozenNow(SENTINEL_NOW, () => {
			throw new Error('boom');
		}),
		/boom/,
		'5: error propagates',
	);
	assertNotFrozen('5: after a throwing case');

	// 6. Unfrozen: moment() tracks the same clock the code under test reads.
	assert.ok(
		Math.abs(moment().valueOf() - Date.now()) < 2000,
		'6: moment() reads Date.now(), not a hardcoded instant',
	);
}

main().then(
	() => console.log('verify-obsidian-stub: ok'),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
