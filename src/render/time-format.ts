/**
 * `mm:ss`, or `hh:mm:ss` once the duration passes an hour.
 *
 * Shared by the pomodoro widget and the reading tracker — both show a running
 * clock, so the two must not drift apart on zero padding or rollover.
 */
export function formatTime(seconds: number): string {
	if (seconds >= 3600) {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
