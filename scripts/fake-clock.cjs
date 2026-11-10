/**
 * Preloaded with NODE_OPTIONS to prove that no verify script depends on the
 * real date.
 *
 * Why: two daily-note cases once passed every day except the one they were
 * written on, because the stub's `moment()` called `new Date()` (the system
 * clock) while the test froze `Date.now`. Nothing in the suite noticed. Run the
 * whole suite under a sentinel clock and every "today"-dependent assumption
 * turns red at once:
 *
 *   node scripts/run-all-tests.mjs --clock-audit     # see run-all-tests.mjs
 *
 * A test that computes its expectation from the same clock it feeds to the code
 * under test still passes here; only a hardcoded "today" fails. That is exactly
 * the set we want to find.
 */
const at = Date.parse(process.env.FAKE_NOW || '2031-06-15T09:00:00');
if (Number.isNaN(at)) {
	throw new Error(`fake-clock: cannot parse FAKE_NOW="${process.env.FAKE_NOW}"`);
}

const RealDate = Date;

class FakeDate extends RealDate {
	constructor(...args) {
		if (args.length === 0) super(at);
		else if (args.length === 1) super(args[0]);
		else super(...args);
	}

	static now() {
		return at;
	}
}

FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
globalThis.Date = FakeDate;
