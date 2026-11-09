/**
 * Verifies the sidebar widget in-place refresh (`src/view/widget-refresh.ts`).
 *
 * These handlers run on service events from OTHER surfaces (a habit toggle in
 * an overlay, a focus re-sync merging another device's pomodoro records, the
 * holiday map landing after first paint). They must repaint the widget without
 * disturbing anything around it, so the interesting parts are the swap
 * mechanics rather than the widget contents:
 *
 * 1. the fresh mount lands in the OLD widget's exact slot (siblings keep their
 *    order) and inherits the identity the stacked/immersive grids size and
 *    place by (`data-widget-key`, `--db-widget-span`, `data-imm-id` +
 *    grid-column/row/min-height);
 * 2. the replaced widget's internal scroll (habit list, music playlist)
 *    survives the swap;
 * 3. nothing happens when the widget is gone (detached, or filtered out of the
 *    current layout) — no stray mount at the end of the sidebar;
 * 4. the mobile panel is repainted ONLY when it is the expanded one, and it is
 *    emptied first (nested widgets would break the tab strip's enumeration).
 *
 * Run: `npm run test:widget-refresh`
 */
import { strict as assert } from 'node:assert';
import { El, findByClass } from './mini-dom';
import { refreshDataWidget, refreshMobileWidgetPanel, refreshPomodoroInPlace, type WidgetRefreshHost } from '../src/view/widget-refresh';
import type { DashboardData, DashboardSettings, ImmersiveItem } from '../src/types';

// The bare global createDiv() the swap mount is built with (Node lacks it).
(globalThis as Record<string, unknown>).createDiv = (o?: { cls?: string }): El => {
	const el = new El('div');
	if (o?.cls) el.addClass(...o.cls.split(/\s+/));
	return el;
};

const asEl = (el: El): HTMLElement => el as unknown as HTMLElement;

interface Rig {
	body: El;
	root: El;
	host: WidgetRefreshHost;
	commits: ImmersiveItem[][];
	removed: string[];
	backgrounds: unknown[];
	bannerRefreshes: number;
}

/** A view root attached to a synthetic <body> (mini-dom's isConnected only
 *  reports true for a subtree of a BODY root). */
function makeRig(opts: { expanded?: 'habit' | 'expense' | 'pomodoro' | 'lunar' | 'reading' | 'calendar' | null; layoutMode?: string } = {}): Rig {
	const body = new El('body');
	const root = new El('div');
	root.addClass('dashboard-view-content');
	body.appendChild(root);
	const rig = {
		body,
		root,
		commits: [] as ImmersiveItem[][],
		removed: [] as string[],
		backgrounds: [] as unknown[],
		bannerRefreshes: 0,
	} as Rig;
	rig.host = {
		app: {} as WidgetRefreshHost['app'],
		root: () => asEl(root),
		settings: () => ({ layoutMode: opts.layoutMode ?? 'sidebar' }) as DashboardSettings,
		data: () => null as DashboardData | null,
		holiday: () => ({}),
		expandedMobileWidget: () => opts.expanded ?? null,
		immItems: () => [],
		commitImmersiveItems: next => { rig.commits.push(next); },
		removeImmersiveItem: id => { rig.removed.push(id); },
		applyPomodoroBackground: bg => { rig.backgrounds.push(bg); },
		refreshBannerStats: () => { rig.bannerRefreshes += 1; },
	};
	return rig;
}

/** A sidebar widget of `key` sitting between two siblings, so slot
 *  preservation is observable. */
function addWidget(rig: Rig, key: string, cls: string): { before: El; widget: El; after: El } {
	const before = new El('div');
	before.addClass('dashboard-sidebar-widget');
	rig.root.appendChild(before);
	const widget = new El('div');
	widget.addClass(`dashboard-sidebar-widget ${cls}`);
	widget.dataset.widgetKey = key;
	rig.root.appendChild(widget);
	const after = new El('div');
	after.addClass('dashboard-sidebar-widget');
	rig.root.appendChild(after);
	return { before, widget, after };
}

function main(): void {
	// 1. Slot + identity carry: the mount takes the old widget's exact place,
	//    inherits the key/span the grids size by, and the render target IS the
	//    mount (rendering into the old node would leave it detached).
	{
		const rig = makeRig();
		const { before, widget, after } = addWidget(rig, 'habit', 'dashboard-sidebar-habit');
		widget.style.setProperty('--db-widget-span', '2');
		let renderedInto: HTMLElement | null = null;
		refreshDataWidget(rig.host, '.dashboard-sidebar-habit', (container) => {
			renderedInto = container;
			container.createDiv({ cls: 'dashboard-habit-inner' });
		});
		const kids = rig.root.children;
		assert.equal(kids.length, 3, '1: one node swapped, not added');
		assert.equal(kids[0], before, '1: previous sibling keeps its slot');
		assert.equal(kids[2], after, '1: next sibling keeps its slot');
		const mount = kids[1]!;
		assert.ok(mount.hasClass('dashboard-sidebar-widget-mount'), '1: replacement is a mount wrapper');
		assert.equal(mount.dataset.widgetKey, 'habit', '1: stacked grid keys off the mount');
		assert.equal(mount.style.getPropertyValue('--db-widget-span'), '2', '1: span carries over');
		assert.equal(renderedInto, asEl(mount), '1: rendered INTO the mount');
		assert.equal(widget.isConnected, false, '1: old widget detached');
		assert.equal(findByClass(rig.root, 'dashboard-sidebar-habit').length, 0, '1: no stale old node');
		assert.equal(findByClass(mount, 'dashboard-habit-inner').length, 1, '1: fresh content present');
	}

	// 2. Internal scroll survives: swapping the node must not yank the habit
	//    list / music playlist back to the top.
	{
		const rig = makeRig();
		const { widget } = addWidget(rig, 'habit', 'dashboard-sidebar-habit');
		const scroller = widget.createDiv({ cls: 'dashboard-habit-scroll' });
		(scroller as unknown as { scrollTop: number; scrollLeft: number }).scrollTop = 42;
		refreshDataWidget(rig.host, '.dashboard-sidebar-habit', (container) => {
			const next = container.createDiv({ cls: 'dashboard-habit-scroll' });
			(next as unknown as { scrollTop: number }).scrollTop = 0;
		});
		const mount = rig.root.children[1]!;
		const restored = findByClass(mount, 'dashboard-habit-scroll')[0]! as unknown as { scrollTop: number };
		assert.equal(restored.scrollTop, 42, '2: scroll replayed onto the new node');
	}

	// 3. Immersive identity carries even when the board is NOT immersive right
	//    now (the tile may be re-shown after a layout switch): id + inline
	//    placement move to the mount, and no grip is attached off-immersive.
	{
		const rig = makeRig({ layoutMode: 'sidebar' });
		const { widget } = addWidget(rig, 'pomodoro', 'dashboard-sidebar-pomodoro');
		widget.dataset.immId = 'widget:pomodoro';
		widget.style.gridColumn = '3 / span 2';
		widget.style.gridRow = '2';
		widget.style.minHeight = '180px';
		refreshDataWidget(rig.host, '.dashboard-sidebar-pomodoro', (container) => {
			container.createDiv({ cls: 'dashboard-pomodoro-inner' });
		});
		const mount = rig.root.children[1]!;
		assert.equal(mount.dataset.immId, 'widget:pomodoro', '3: tile id carries');
		assert.equal(mount.style.gridColumn, '3 / span 2', '3: column placement carries');
		assert.equal(mount.style.gridRow, '2', '3: row placement carries');
		assert.equal(mount.style.minHeight, '180px', '3: min height carries');
		assert.equal(mount.children.length, 1, '3: off-immersive adds no grip/hover delete');
	}

	// 4. No-op when the widget is not on the board: a detached node (already
	//    replaced) and a missing selector both leave the tree untouched — the
	//    old bug shape here is appending the mount at the end of the sidebar.
	{
		const rig = makeRig();
		const detached = new El('div');
		detached.addClass('dashboard-sidebar-habit');
		let calls = 0;
		refreshDataWidget(rig.host, '.dashboard-sidebar-habit', () => { calls += 1; });
		assert.equal(calls, 0, '4: missing selector renders nothing');
		assert.equal(rig.root.children.length, 0, '4: missing selector appends nothing');

		rig.root.appendChild(detached);
		detached.remove();
		refreshDataWidget(rig.host, '.dashboard-sidebar-habit', () => { calls += 1; });
		assert.equal(calls, 0, '4: detached widget renders nothing');
		assert.equal(rig.root.children.length, 0, '4: detached widget appends nothing');
	}

	// 5. Mobile panel repaints only when it is the expanded one, and is emptied
	//    first (a nested second widget would break the tab strip walk).
	{
		const rig = makeRig({ expanded: 'expense' });
		const panel = rig.root.createDiv({ cls: 'dashboard-mobile-widget-panel' });
		panel.createDiv({ cls: 'stale-widget' });
		const seen: HTMLElement[] = [];
		refreshMobileWidgetPanel(rig.host, 'habit', (container) => {
			seen.push(container);
			container.createDiv({ cls: 'habit-panel' });
		});
		assert.equal(seen.length, 0, '5: other expanded panel untouched');
		assert.equal(findByClass(panel, 'stale-widget').length, 1, '5: other panel keeps its content');

		const habitRig = makeRig({ expanded: 'habit' });
		const habitPanel = habitRig.root.createDiv({ cls: 'dashboard-mobile-widget-panel' });
		habitPanel.createDiv({ cls: 'stale-widget' });
		refreshMobileWidgetPanel(habitRig.host, 'habit', (container) => {
			seen.push(container);
			container.createDiv({ cls: 'habit-panel' });
		});
		assert.equal(seen.length, 1, '5: expanded panel repaints');
		assert.equal(seen[0], asEl(habitPanel), '5: repaint targets the panel itself');
		assert.equal(findByClass(habitPanel, 'stale-widget').length, 0, '5: panel emptied before render');
		assert.equal(findByClass(habitPanel, 'habit-panel').length, 1, '5: fresh panel content present');

		// No panel in the tree (desktop, or the strip is not mounted): silent.
		const desktop = makeRig({ expanded: 'habit' });
		refreshMobileWidgetPanel(desktop.host, 'habit', () => { throw new Error('5: must not render without a panel'); });
	}

	// 6. Service guards: before the pomodoro service exists (init order) the
	//    event must stay silent instead of rendering a half widget.
	{
		const rig = makeRig();
		addWidget(rig, 'pomodoro', 'dashboard-sidebar-pomodoro');
		refreshPomodoroInPlace(rig.host, null);
		const widget = findByClass(rig.root, 'dashboard-sidebar-pomodoro')[0]!;
		assert.equal(widget.parent, rig.root, '6: widget left in place');
		assert.equal(widget.isConnected, true, '6: widget untouched');
	}

	console.log('verify-widget-refresh: ok');
}

main();
