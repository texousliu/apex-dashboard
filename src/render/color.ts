/**
 * Theme colour probes: reading CSS custom properties off the dashboard root,
 * and deciding whether white or dark text reads better on a given colour.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). Both the
 * accent-on-accent text decisions and the tracker charts need them, and
 * neither owns the other.
 */
export function getCSSVar(name: string): string {
	const el = activeDocument.querySelector('.apex-dashboard-root');
	if (!el) return '';
	return getComputedStyle(el).getPropertyValue(name).trim();
}

// Determine whether the dashboard accent is light enough that white text on it
// would be unreadable (e.g. the mono/墨白 and onyx themes).
export function isAccentLight(): boolean {
	const el = activeDocument.querySelector('.apex-dashboard-root');
	if (!el) return false;
	return isLightColor(getComputedStyle(el).getPropertyValue('--db-accent').trim());
}

// Accepts "#rgb", "#rrggbb", "rgb(...)" or "rgba(...)"; returns true when the
// color is bright enough that dark text reads better than white.
export function isLightColor(color: string): boolean {
	const value = color.trim();
	if (value.startsWith('rgb')) {
		const nums = value.match(/[\d.]+/g);
		if (!nums || nums.length < 3) return false;
		return relativeLuminance(Number(nums[0]), Number(nums[1]), Number(nums[2])) > 0.6;
	}
	const hex = value.replace(/^#/, '');
	if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
	const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
	if (full.length !== 6) return false;
	return relativeLuminance(
		parseInt(full.slice(0, 2), 16),
		parseInt(full.slice(2, 4), 16),
		parseInt(full.slice(4, 6), 16),
	) > 0.6;
}

// WCAG relative luminance (0..1).
export function relativeLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
