/**
 * The section frame: per-section collapse persistence, the resize handles
 * (section width + paired-column split), `getSectionType` resolution, and
 * `renderSection` — the header, the gear, and the card list it delegates to
 * `render/card.ts`.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). What is
 * left in renderer.ts is the board entry point (`renderDashboard`) and the
 * public re-exports, so importers did not have to change.
 */
import { App, Platform, setIcon } from 'obsidian';
import type { DashboardData, DashboardColumn, RenderCallbacks, DashboardSettings } from '../types';
import { t } from '../i18n';
import { canonicalSectionType, createSectionButtons, fallbackSection, hasSectionType, resolveSection, type ReloadSlot, type SectionContext } from '../section';
import { partnerIndexOf } from '../column-pairs';
import { startGuardedDrag } from '../drag-guard';
import { isImmersiveLayout } from './widget-mount';
import { renderCard } from './card';
import { linkContext } from './link-context';

const COLLAPSED_KEY = 'apex-dashboard-collapsed';

function getCollapsedSections(app: App): Set<string> {
	try {
		const raw = app.loadLocalStorage(COLLAPSED_KEY) as string | null;
		if (!raw) return new Set();
		return new Set(JSON.parse(raw) as string[]);
	} catch {
		return new Set();
	}
}

function saveCollapsedSections(app: App, collapsed: Set<string>): void {
	app.saveLocalStorage(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

function attachSectionResizeHandle(el: HTMLElement, column: DashboardColumn, callbacks: RenderCallbacks): void {
	if (Platform.isMobile) return;
	// Web sections are driven by a fixed CSS height, so the drag must
	// write inline height as well; other types are content-sized rows where
	// max-height can only clamp (shrink), never grow.
	const isFixedHeight = getSectionType(column) === 'web';
	const handle = el.createDiv({ cls: 'dashboard-section-resize-handle' });
	handle.addEventListener('pointerdown', (e) => {
		if (!el.parentElement) return;
		const startY = e.clientY;
		const startHeight = el.offsetHeight;
		el.addClass('dashboard-section-row--resizing');
		// Guarded drag (pointer capture + viewport shield, see drag-guard):
		// keeps the move/up stream whole across embedded frames and Windows
		// webview surface overflow. frames-muted stays for hover calm.
		const shieldHost = el.closest('.apex-dashboard-root') ?? el.parentElement;
		shieldHost?.addClass('dashboard-frames-muted');

		startGuardedDrag(e, {
			cursor: 'ns-resize',
			onMove: (ev) => {
				// The row can be torn down mid-drag by a re-render; resizing a
				// detached element is stale work, so stop touching it.
				if (!el.isConnected) {
					el.removeClass('dashboard-section-row--resizing');
					shieldHost?.removeClass('dashboard-frames-muted');
					return;
				}
				const delta = ev.clientY - startY;
				const newHeight = Math.max(160, Math.min(2000, startHeight + delta));
				el.style.maxHeight = `${newHeight}px`;
				if (isFixedHeight) el.style.height = `${newHeight}px`;
			},
			onUp: (ev) => {
				el.removeClass('dashboard-section-row--resizing');
				shieldHost?.removeClass('dashboard-frames-muted');
				const finalHeight = Math.max(160, Math.min(2000, startHeight + (ev.clientY - startY)));
				if (finalHeight !== column.height) {
					callbacks.onColumnHeightChange(column.name, finalHeight);
				}
			},
		});
	});
}

/** Sanitize a stored pair split: left member's share in percent, 50 default.
 *  Out-of-range/garbage values (hand-edited files) fall back to the default. */
function clampPairWidth(width: unknown): number {
	return typeof width === 'number' && Number.isFinite(width)
		? Math.max(20, Math.min(80, Math.round(width)))
		: 50;
}

/** Pair split rendering: the LEFT member of a pair owns the split (its
 *  `width`, left share %) and mounts the col-resize divider over the board
 *  gutter; the RIGHT member mirrors the complement. Both write --db-pair-basis,
 *  which the half-row basis consumes (calc basis minus half the gutter,
 *  defaulting to the historical 50%). Exported for the verify script. */
export function applyPairWidth(el: HTMLElement, column: DashboardColumn, data: DashboardData | undefined, callbacks: RenderCallbacks): void {
	if (!data) return;
	const idx = data.columns.indexOf(column);
	if (idx < 0) return;
	const partner = partnerIndexOf(data.columns, idx);
	if (partner === idx + 1) {
		el.addClass('dashboard-section-row--pair-left');
		el.style.setProperty('--db-pair-basis', `${clampPairWidth(column.width)}%`);
		attachPairWidthHandle(el, column, callbacks);
	} else if (partner === idx - 1) {
		const left = data.columns[partner]!;
		el.style.setProperty('--db-pair-basis', `${100 - clampPairWidth(left.width)}%`);
	}
}

/** Drag the pair divider: live-writes --db-pair-basis on both halves, then
 *  persists the rounded split on mouseup (the same write-nothing-mid-drag
 *  discipline as the height handle). Same drag-shield treatment for embedded
 *  frames. Desktop only (only ever attached from a rendered pair). */
function attachPairWidthHandle(el: HTMLElement, column: DashboardColumn, callbacks: RenderCallbacks): void {
	const handle = el.createDiv({ cls: 'dashboard-pair-width-handle' });
	handle.setAttribute('aria-label', t('renderer.pairWidthHint'));
	handle.setAttribute('aria-label', t('renderer.pairWidthHint'));
	handle.addEventListener('pointerdown', (e) => {
		const board = el.parentElement;
		const partnerEl = el.nextElementSibling;
		if (!board || !(partnerEl instanceof HTMLElement)
			|| !partnerEl.hasClass('dashboard-section-row--half')) return;
		// Split math runs against the draggable span (line minus the one
		// gutter between the halves), reading the gutter from the board's own
		// --db-kanban-gap so a future CSS retune keeps the drag calibrated.
		const gutter = parseFloat(getComputedStyle(board).getPropertyValue('--db-kanban-gap')) || 10;
		const usable = board.clientWidth - gutter;
		if (usable <= 0) return;
		const startX = e.clientX;
		const startPct = clampPairWidth(column.width);
		let lastPct = startPct;
		el.addClass('dashboard-section-row--resizing');
		// Guarded drag (pointer capture + viewport shield, see drag-guard):
		// the pair divider shares a gutter-adjacent strip with everything the
		// board hosts, and on Windows a webview surface can overflow onto the
		// strip mid-drag — capture keeps the stream on this document.
		const shieldHost = el.closest('.apex-dashboard-root') ?? board;
		shieldHost.addClass('dashboard-frames-muted');
		startGuardedDrag(e, {
			cursor: 'col-resize',
			onMove: (ev) => {
				// The row can be torn down mid-drag by a re-render; stop rather
				// than resize a detached element.
				if (!el.isConnected) {
					el.removeClass('dashboard-section-row--resizing');
					shieldHost.removeClass('dashboard-frames-muted');
					return;
				}
				lastPct = Math.max(20, Math.min(80, startPct + ((ev.clientX - startX) / usable) * 100));
				el.style.setProperty('--db-pair-basis', `${lastPct}%`);
				partnerEl.style.setProperty('--db-pair-basis', `${100 - lastPct}%`);
			},
			onUp: () => {
				el.removeClass('dashboard-section-row--resizing');
				shieldHost.removeClass('dashboard-frames-muted');
				const rounded = Math.round(lastPct);
				// Snap BOTH inline bases to the rounded value: the live drag wrote
				// un-rounded percentages, and any update path that refreshes only
				// one half in place would otherwise leave a stale mate whose basis
				// sums past 100% and wraps the pair.
				el.style.setProperty('--db-pair-basis', `${rounded}%`);
				partnerEl.style.setProperty('--db-pair-basis', `${100 - rounded}%`);
				if (rounded !== Math.round(startPct)) {
					callbacks.onColumnWidthChange(column.name, rounded);
				}
			},
		});
	});
}

export function getSectionType(column: DashboardColumn): string {
	// Retired memo/todo ids fold into sticky wherever they come from (parse
	// migrates; the registry aliases also cover hand-built legacy columns).
	if (column.sectionType) return canonicalSectionType(column.sectionType);
	// Columns created before sectionType was stored carry the type in the name.
	// A name that is not a registered type falls through to card inference.
	const lower = column.name.toLowerCase();
	if (hasSectionType(lower)) return canonicalSectionType(lower);
	if (column.cards.length > 0) {
		const types = new Set(column.cards.map(c => c.type));
		const dashboardTypes = new Set(['chart', 'weather', 'tracker']);
		if ([...types].every(t => dashboardTypes.has(t)) && types.size > 0) return 'dashboard';
		// Mixed/standalone memo & todo card sets both map to sticky, matching
		// the parse-time migration of the retired memo/todo section types.
		if (types.has('task') && types.size === 1) return 'sticky';
		if (types.has('task') && !types.has('project')) return 'sticky';
		if (types.has('project') && types.size === 1) return 'projects';
		if (types.has('generic') && !types.has('project') && !types.has('task')) return 'sticky';
	}
	return 'projects';
}

export function renderSection(column: DashboardColumn, callbacks: RenderCallbacks, app: App, data?: DashboardData, settings?: DashboardSettings): HTMLElement {
	const el = createDiv();
	el.addClass('dashboard-section-row');
	el.dataset.column = column.name;
	const sectionType = getSectionType(column);
	el.dataset.sectionType = sectionType;

	// Immersive boards have no collapsed sections: the toggle is hidden and
	// every tile renders expanded (a saved collapsed state from another
	// layout must not strand a tile).
	const immersive = !!settings && isImmersiveLayout(settings, data);
	const collapsed = getCollapsedSections(app);
	if (!immersive && collapsed.has(column.name)) {
		el.addClass('dashboard-section-row--collapsed');
	}

	// The immersive grid owns all geometry: the tile's span sets width/height
	// (CSS makes the row fill the tile and scroll inside), so the dragged
	// height, the half-pairing and their handles are all suspended there.
	// `half`/`width` stay untouched in the file and come back on layout
	// switch-back.
	// (immersive computed above, before the collapse check)

	// Apply user-dragged height (desktop). Overrides the per-type max-height.
	// Desktop-only: the resize handle that sets it never runs on mobile, and a px
	// value tuned on a big screen would clamp phone rows far below the mobile
	// CSS sizing (50vh-family), shrinking card bodies to a sliver.
	if (!immersive && !Platform.isMobile && typeof column.height === 'number' && column.height > 0) {
		el.style.maxHeight = `${column.height}px`;
		// Web (the frame fills the row) sections have a fixed CSS height, so
		// max-height alone can only shrink them. Write the inline height too so
		// the drag-resized value can also grow the section past the default.
		if (resolveSection(sectionType)?.fixedHeight) {
			el.style.height = `${column.height}px`;
		}
	}

	// Side-by-side pairing (desktop only): mobile keeps full-width stacking —
	// the class never renders there, so the mobile CSS sizing is untouched.
	if (!immersive && !Platform.isMobile && column.half) {
		el.addClass('dashboard-section-row--half');
		applyPairWidth(el, column, data, callbacks);
	}

	if (!immersive) {
		attachSectionResizeHandle(el, column, callbacks);
	}

	const header = el.createDiv({ cls: 'dashboard-section-header' });

	// Drag handle to reorder sections (desktop only).
	const titleWrap = header.createDiv({ cls: 'dashboard-section-title-wrap' });

	// Drag handle sits at the far left, grouped with the title so the header's
	// space-between layout keeps the title left-aligned (not centered).
	if (!Platform.isMobile) {
		const grip = titleWrap.createDiv({ cls: 'dashboard-section-grip' });
		grip.setAttribute('draggable', 'true');
		grip.setAttribute('aria-label', t('renderer.dragSection'));
		setIcon(grip, 'grip-vertical');
	}

	const titleEl = titleWrap.createEl('h3', { text: column.name, cls: 'dashboard-section-title' });

	titleEl.addEventListener('dblclick', (e) => {
		e.stopPropagation();
		const currentName = titleEl.getText();
		titleEl.empty();
		const input = titleEl.createEl('input', {
			cls: 'dashboard-section-rename-input',
			attr: { type: 'text', value: currentName },
		});
		input.focus();
		input.select();

		const finish = (save: boolean) => {
			const newName = input.value.trim();
			if (save && newName && newName !== currentName) {
				callbacks.onColumnRename(currentName, newName, data ? data.columns.indexOf(column) : -1);
			} else {
				titleEl.empty();
				titleEl.setText(currentName);
			}
		};

		input.addEventListener('keydown', (ke: KeyboardEvent) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				finish(true);
			} else if (ke.key === 'Escape') {
				ke.preventDefault();
				finish(false);
			}
		});

		input.addEventListener('blur', () => {
			finish(true);
		});
	});
	titleEl.setCssProps({ cursor: 'pointer' });

	// Collapse toggle sits right after the title (keeps it out of the header
	// actions group, whose button count varies per section type).
	const toggle = titleWrap.createDiv({ cls: 'dashboard-section-toggle' });
	toggle.setAttribute('role', 'button');
	toggle.setAttribute('aria-label', t('renderer.toggleSection'));
	toggle.addEventListener('click', (e) => {
		e.stopPropagation();
		const isNowCollapsed = el.hasClass('dashboard-section-row--collapsed');
		if (isNowCollapsed) {
			el.removeClass('dashboard-section-row--collapsed');
			collapsed.delete(column.name);
		} else {
			el.addClass('dashboard-section-row--collapsed');
			collapsed.add(column.name);
		}
		saveCollapsedSections(app, collapsed);
	});

		const headerActions = header.createDiv({ cls: 'dashboard-section-header-actions' });

	// Section-specific header buttons and body. Shared chrome (row, header,
	// title rename, collapse toggle) is built above; the definition registered
	// in src/section/defs/* decides everything below.
	const reloadSlot: ReloadSlot = { fn: null };
	const ctx: SectionContext = {
		el,
		header,
		actions: headerActions,
		column,
		type: sectionType,
		app,
		data,
		settings,
		callbacks,
		hoverParent: linkContext.hoverParent,
		openNoteInPopover: linkContext.noteOpener,
		buttons: createSectionButtons({
			el,
			column,
			actions: headerActions,
			callbacks,
			type: sectionType,
			index: data ? data.columns.indexOf(column) : -1,
			reload: reloadSlot,
		}),
		setReload: (fn) => { reloadSlot.fn = fn; },
		renderCards: () => renderSectionCards(el, column, sectionType, callbacks, app, data, settings),
	};

	const def = resolveSection(sectionType) ?? fallbackSection();
	def.headerActions?.(ctx);
	def.render(ctx);
	return el;
}

/** Draw the plain card list of a section that holds generic cards. */
function renderSectionCards(
	el: HTMLElement,
	column: DashboardColumn,
	sectionType: string,
	callbacks: RenderCallbacks,
	app: App,
	data?: DashboardData,
	settings?: DashboardSettings,
): void {
	const cardsContainer = el.createDiv({ cls: 'dashboard-section-cards' });

	for (const card of column.cards) {
		try {
			const cardEl = renderCard(card, column.name, sectionType, callbacks, app, data, settings, column.showCover !== false);
			cardsContainer.appendChild(cardEl);
		} catch (err) {
			console.error('[Dashboard] renderCard error:', card.id, card.type, err);
		}
	}
}
/** Render one dashboard card (memo note, todo list, project, ...). Used by
 *  the section pipelines AND by the immersive board, which dissolves sticky
 *  sections into standalone card tiles (a memo card / todo card are card
 *  TYPES there — no section container). */
