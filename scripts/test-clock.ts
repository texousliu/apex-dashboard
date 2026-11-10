/**
 * Freezing "now" for verify scripts that assert on date-derived output.
 *
 * Two rules, both learned the expensive way:
 *
 * 1. **The pinned instant must never look like a plausible "today".** If you
 *    pin `2026-11-09` and the clock is *actually* 2026-11-09, a broken freeze
 *    still produces the expected path and the test passes for the wrong
 *    reason. `SENTINEL_NOW` is deliberately far in the past so that "the freeze
 *    silently stopped working" can never coincide with a correct answer.
 * 2. **Restore in `finally`.** `Date.now` is process-global; a case that throws
 *    mid-way must not hand a frozen clock to the next case.
 *
 * The stub's `moment()` reads `Date.now()` (not `new Date()`), which is what
 * makes this work at all — see `scripts/obsidian-stub.ts` and the guard in
 * `verify-obsidian-stub.ts`.
 */

/** 1999-12-31 10:00 — far enough back that it cannot be mistaken for today. */
export const SENTINEL_NOW = '1999-12-31T10:00:00';

/** Pin `Date.now`; returns the restore function. Prefer `withFrozenNow`. */
export function freezeNow(iso: string): () => void {
	const at = new Date(iso).getTime();
	if (Number.isNaN(at)) throw new Error(`freezeNow: cannot parse "${iso}"`);
	const realNow = Date.now;
	Date.now = () => at;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		Date.now = realNow;
	};
}

/** Run `fn` with `Date.now` pinned to `iso`, restoring even when it throws. */
export async function withFrozenNow<T>(iso: string, fn: () => Promise<T> | T): Promise<T> {
	const restore = freezeNow(iso);
	try {
		return await fn();
	} finally {
		restore();
	}
}
