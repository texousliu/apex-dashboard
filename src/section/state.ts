import { setIcon } from 'obsidian';

/**
 * Section states — one renderer for "nothing to show yet", "still scanning"
 * and "the query blew up".
 *
 * Before this, every section hand-rolled its own empty markup: 34 different
 * class names, three different child structures, and CSS that had to be
 * tweaked file by file whenever the visual language changed. The shape is the
 * same everywhere — optional icon, one line of text, an optional hint, an
 * optional button that opens the section's config — so it lives here.
 *
 * Legacy class names still ride along on the root element (`legacyClass`) so
 * existing rules keep contributing things this renderer does not own, such as
 * grid placement (`.dashboard-skillsec-empty` spans the grid) or flex growth
 * (`.dashboard-pipeline-empty` fills a fixed-height row).
 */

export type SectionStateKind = 'empty' | 'loading' | 'error';

export interface SectionStateOptions {
	/** Defaults to `empty`. */
	kind?: SectionStateKind;
	/** Lucide icon name; omit for a text-only state. */
	icon?: string | null;
	text: string;
	hint?: string;
	/** Primary button — usually the "configure me" jump. */
	action?: { label: string; onClick: () => void; cls?: string };
	/** Additional class kept for pre-existing CSS (placement, flex). */
	legacyClass?: string;
	/** Tight variant for states nested in a grid/list (matches the old 18px
	 *  padding the skill cards used). */
	compact?: boolean;
	/** Emphasise the text line: the "this card needs configuring" title used to
	 *  be bold and body-coloured above a muted hint. */
	strongText?: boolean;
}

/** Draw a state block into `parent` and return its root element. */
export function renderSectionState(parent: HTMLElement, opts: SectionStateOptions): HTMLElement {
	const kind = opts.kind ?? 'empty';
	const root = parent.createDiv({
		cls: [
			'dashboard-section-state',
			`dashboard-section-state--${kind}`,
			opts.compact ? 'dashboard-section-state--compact' : '',
			opts.strongText ? 'dashboard-section-state--strong' : '',
			opts.legacyClass ?? '',
		].filter(Boolean).join(' '),
	});

	if (opts.icon) {
		const icon = root.createDiv({ cls: 'dashboard-section-state-icon' });
		setIcon(icon, opts.icon);
	}
	root.createDiv({ cls: 'dashboard-section-state-text', text: opts.text });
	if (opts.hint) {
		root.createDiv({ cls: 'dashboard-section-state-hint', text: opts.hint });
	}
	if (opts.action) {
		const btn = root.createEl('button', {
			cls: 'dashboard-section-state-action' + (opts.action.cls ? ` ${opts.action.cls}` : ''),
			text: opts.action.label,
			attr: { type: 'button' },
		});
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			opts.action?.onClick();
		});
	}
	return root;
}

/** The single "open this section's config" action. Bubbles the same event the
 *  header gear uses, so a state button and the gear always route identically;
 *  `sectionType` lets the view skip re-deriving a legacy type. */
export function configureStateAction(opts: {
	label: string;
	/** Element the event bubbles from (the section row). */
	from: HTMLElement;
	columnName: string;
	sectionType?: string;
	cls?: string;
}): NonNullable<SectionStateOptions['action']> {
	return {
		label: opts.label,
		cls: opts.cls,
		onClick: () => {
			opts.from.dispatchEvent(new CustomEvent('dashboard-library-config', {
				detail: { columnName: opts.columnName, sectionType: opts.sectionType },
				bubbles: true,
			}));
		},
	};
}
