import { setIcon } from 'obsidian';
import type { App, HoverParent, TFile } from 'obsidian';
import { t } from '../i18n';
import type { DashboardColumn, DashboardData, DashboardSettings, RenderCallbacks } from '../types';

/**
 * Section registry — one place that answers "what is this section type and how
 * does it draw itself".
 *
 * Before this, adding a section type meant editing seven unrelated spots:
 * the name→type table and the render if-chain in renderer.ts, the type chooser,
 * the parser's card-less skip list, the config event route in view.ts, and the
 * sync/getSectionType call sites. A missed one surfaced as "the gear does
 * nothing" or "the card never refreshes". A section now registers once and the
 * chooser, the routing and the header buttons all read from that entry.
 */

/** One entry in the "add a section" chooser. A definition can offer several
 *  (images and videos share their render body but are two picks). `order` is
 *  the position in the chooser grid — definitions live in domain files, so the
 *  picker order cannot ride on registration order. */
export interface SectionPickerEntry {
	readonly type: string;
	readonly icon: string;
	readonly labelKey: string;
	readonly order: number;
}

/** Standard header buttons. Every section builds its actions through these so
 *  the icon, class, aria-label and event route stay identical across cards. */
export interface SectionButtons {
	/** Escape hatch for section-specific buttons. */
	add(opts: { icon: string; label: string; cls?: string; onClick: (e: MouseEvent) => void }): HTMLButtonElement;
	/** Gear: bubbles `dashboard-library-config`, which view.ts routes back to
	 *  the section definition's `configure`. */
	config(labelKey: string): HTMLButtonElement;
	/** Refresh: the section calls `ctx.setReload` once its renderer hands back
	 *  a repaint function. */
	refresh(labelKey: string): HTMLButtonElement;
	/** Trash: the red-tinted delete button. */
	remove(): HTMLButtonElement;
	/** Plus: adds a generic card to the section. */
	addCard(): HTMLButtonElement;
}

/** Everything a section needs to draw itself. Property values are the ones the
 *  render pass already resolved (hover parent, openers, settings), so no
 *  section has to reach for module-level render state. */
export interface SectionContext {
	/** The `.dashboard-section-row` element (header already inside). */
	readonly el: HTMLElement;
	readonly header: HTMLElement;
	readonly actions: HTMLElement;
	readonly column: DashboardColumn;
	/** Canonical type id — for a definition registered under several types
	 *  this is the concrete one being rendered (e.g. `images` vs `videos`). */
	readonly type: string;
	readonly app: App;
	readonly data?: DashboardData;
	readonly settings?: DashboardSettings;
	readonly callbacks: RenderCallbacks;
	readonly hoverParent: HoverParent | null;
	readonly openNoteInPopover: ((file: TFile, subpath?: string) => void) | null;
	readonly buttons: SectionButtons;
	/** Hand the header refresh button its repaint function. */
	setReload(reload: () => void): void;
	/** Draw the plain card list (sticky / notes / dashboard sections). */
	renderCards(): void;
}

/** How a section keeps itself up to date when the vault changes.
 *  `files` — rescans notes, so an edit inside its scope must rebuild it;
 *  `media` — reacts to media files only;
 *  `none`  — never rescanned (it renders board data, not vault contents). */
export type SectionScan = 'files' | 'media' | 'none';

export interface SectionDefinition {
	/** Canonical type ids this definition handles. */
	readonly types: readonly string[];
	/** What the vault watcher must re-scan for this section (default 'none').
	 *  Declared here so "which sections rescan the vault" is answered by the
	 *  same entry that says how to draw them — it used to be two Sets living in
	 *  the refresh module, which meant a new scanning section type had to be
	 *  added in two places or it would silently never refresh. */
	readonly scan?: SectionScan;
	/** Retired ids that normalize to the first canonical type. */
	readonly aliases?: readonly string[];
	/** Offered in the "add a section" chooser, in registration order. */
	readonly picker?: readonly SectionPickerEntry[];
	/** Render a header that the row needs before the body exists (e.g. web
	 *  sections have a fixed frame height). */
	readonly fixedHeight?: boolean;
	/** Extra header buttons, left to right, rendered before `remove()`. */
	headerActions?(ctx: SectionContext): void;
	render(ctx: SectionContext): void;
}

const definitions: SectionDefinition[] = [];
const byType = new Map<string, SectionDefinition>();

export function registerSection(def: SectionDefinition): void {
	for (const type of [...def.types, ...(def.aliases ?? [])]) {
		const existing = byType.get(type);
		if (existing) {
			throw new Error(`[Dashboard] section type "${type}" registered twice`);
		}
		byType.set(type, def);
	}
	definitions.push(def);
}

/** What the vault watcher must re-scan for `type` (unknown types never do). */
export function sectionScan(type: string): SectionScan {
	return byType.get(type)?.scan ?? 'none';
}

/** The definition for a canonical type (or an alias). */
export function resolveSection(type: string): SectionDefinition | undefined {
	return byType.get(type);
}

/** True when `name` is a known section type — lets getSectionType() drop its
 *  hand-maintained name table. */
export function hasSectionType(name: string): boolean {
	return byType.has(name);
}

/** Canonical id for a stored one: aliases fold into their definition's first
 *  type (e.g. `memo` / `todo` → `sticky`). */
export function canonicalSectionType(type: string): string {
	const def = byType.get(type);
	if (!def) return type;
	return def.types.includes(type) ? type : def.types[0]!;
}

/** Root definition of the fallback section (`projects`), used when a column
 *  carries an unknown type. */
export function fallbackSection(): SectionDefinition {
	const def = byType.get('projects');
	if (!def) throw new Error('[Dashboard] no fallback section registered');
	return def;
}

/** The "add a section" chooser, in `order` (the tray grid reads row-major). */
export function sectionPickerOptions(): Array<{ value: string; icon: string; labelKey: string }> {
	const picks = definitions
		.flatMap(def => def.picker ?? [])
		.sort((a, b) => a.order - b.order);
	return picks.map(p => ({ value: p.type, icon: p.icon, labelKey: p.labelKey }));
}

/** Every registered definition (diagnostics + contract tests). */
export function registeredSections(): readonly SectionDefinition[] {
	return definitions;
}

/** Per-section repaint slot. The refresh button and the renderer both point at
 *  the same object, so a section can register its repaint after the header has
 *  already been built (the header comes first in the DOM). */
export interface ReloadSlot {
	fn: (() => void) | null;
}

/** Build the standard button set for one section render. */
export function createSectionButtons(ctx: {
	el: HTMLElement;
	column: DashboardColumn;
	actions: HTMLElement;
	callbacks: RenderCallbacks;
	/** Canonical type, sent with the config event so the view does not have to
	 *  re-derive it from a possibly-legacy sectionType string. */
	type: string;
	index: number;
	reload: ReloadSlot;
}): SectionButtons {
	const add: SectionButtons['add'] = ({ icon, label, cls, onClick }) => {
		const btn = ctx.actions.createEl('button', {
			cls: 'dashboard-section-add-btn' + (cls ? ` ${cls}` : ''),
			attr: { 'aria-label': label },
		});
		setIcon(btn, icon);
		btn.addEventListener('click', onClick);
		return btn;
	};

	const dispatch = (name: string, detail: Record<string, unknown>) => {
		ctx.el.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
	};

	return {
		add,
		config: (labelKey) => add({
			icon: 'settings',
			label: t(labelKey),
			onClick: () => dispatch('dashboard-library-config', { columnName: ctx.column.name, sectionType: ctx.type }),
		}),
		refresh: (labelKey) => add({
			icon: 'refresh-cw',
			label: t(labelKey),
			onClick: () => ctx.reload.fn?.(),
		}),
		remove: () => add({
			icon: 'trash-2',
			label: t('renderer.deleteSection', { column: ctx.column.name }),
			cls: 'dashboard-section-delete-btn',
			onClick: (e) => {
				e.stopPropagation();
				ctx.callbacks.onColumnDelete(ctx.column.name, ctx.index);
			},
		}),
		addCard: () => add({
			icon: 'plus',
			label: t('renderer.addCardTo', { column: ctx.column.name }),
			onClick: () => ctx.callbacks.onCardAdd(ctx.column.name),
		}),
	};
}
