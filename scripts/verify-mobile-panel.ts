/**
 * Verifies the phone chrome (`src/view/mobile-panel.ts`): the widget bar, the
 * two banner buttons, and the drawers behind them.
 *
 * Everything here is invisible on desktop, which is exactly why it rots
 * quietly. The rules that actually matter are state rules, not layout:
 *
 * 1. a full render always starts with the bar closed (no stale expanded panel
 *    behind hidden tabs);
 * 2. collapsing the strip drops the expanded widget with it — otherwise the
 *    panel stays open while its tab row is gone;
 * 3. one panel, one widget: the panel is emptied before a render, so switching
 *    tabs never nests a second widget inside the previous one;
 * 4. settings gate the tab list (calendar / habit / expense) and the order is
 *    fixed — lunar is always first, reading always last;
 * 5. the drawer is a singleton anchored under the first section row, and the
 *    backdrop closes it;
 * 6. the banner's right-half tap reveals the edit button (left half does not).
 *
 * The lunar widget is used as the observable renderer: it needs no service, so
 * the panel content can be asserted without standing up habit/expense/pomodoro.
 *
 * Run: `npm run test:mobile-panel`
 */
import { strict as assert } from 'node:assert';
import { El, findByClass } from './mini-dom';
import {
	closeMobileDrawer,
	createMobilePanelState,
	openMobileDrawer,
	renderMobileActions,
	renderMobileWidgetBar,
	syncMobileWidgetPanel,
	type MobilePanelHost,
	type MobilePanelState,
} from '../src/view/mobile-panel';
import { t } from '../src/i18n';
import type { DashboardData, DashboardSettings } from '../src/types';

// Node lacks the two globals the chrome touches.
(globalThis as Record<string, unknown>).createDiv = (o?: { cls?: string }): El => {
	const el = new El('div');
	if (o?.cls) el.addClass(...o.cls.split(/\s+/));
	return el;
};
(globalThis as Record<string, unknown>).window = {
	requestAnimationFrame: (fn: () => void): void => fn(),
	innerWidth: 800,
};

const asEl = (el: El): HTMLElement => el as unknown as HTMLElement;

interface Rig {
	body: El;
	root: El;
	state: MobilePanelState;
	host: MobilePanelHost;
	applied: unknown[];
	executed: unknown[];
	navigated: string[];
	addActionOpened: number;
}

/** A view root under a synthetic <body>. `root()` is what the drawers measure
 *  and append to, so it is the only structure these tests need. */
function makeRig(opts: {
	settings?: Partial<DashboardSettings>;
	data?: Partial<DashboardData> | null;
	withServices?: boolean;
	noRoot?: boolean;
} = {}): Rig {
	const body = new El('body');
	const root = new El('div');
	root.addClass('dashboard-view-content');
	body.appendChild(root);

	const settings = {
		widgetCalendarEnabled: true,
		widgetHabitEnabled: true,
		widgetExpenseEnabled: true,
		recentDocCount: 8,
		...opts.settings,
	} as DashboardSettings;

	const data = opts.data === null
		? null
		: ({
			quickActions: [],
			quickActionOrder: [],
			hiddenPresets: [],
			...opts.data,
		} as unknown as DashboardData);

	const rig = {
		body,
		root,
		state: createMobilePanelState(),
		applied: [] as unknown[],
		executed: [] as unknown[],
		navigated: [] as string[],
		addActionOpened: 0,
	} as Rig;

	rig.host = {
		app: {
			vault: { getMarkdownFiles: () => [] },
		} as unknown as MobilePanelHost['app'],
		state: rig.state,
		settings: () => settings,
		data: () => data,
		root: () => (opts.noRoot ? undefined : asEl(root)),
		holiday: () => ({}),
		// Services stay null: the panel then renders nothing for those tabs,
		// which is what keeps the panel content observable.
		pomodoro: () => null,
		reading: () => null,
		sync: () => ({
			removeQuickAction: () => { rig.executed.push('remove'); },
			removeQuickActionByKey: () => { rig.executed.push('removeKey'); },
			reorderQuickActions: () => { rig.executed.push('reorder'); },
		}) as unknown as ReturnType<MobilePanelHost['sync']>,
		openNote: () => {},
		executeAction: action => { rig.executed.push(action); },
		navigateToPath: path => { rig.navigated.push(path); },
		openAddActionModal: () => { rig.addActionOpened += 1; },
		applyPomodoroBackground: bg => { rig.applied.push(bg); },
	} as MobilePanelHost;
	return rig;
}

const barOf = (root: El): El => findByClass(root, 'dashboard-mobile-widget-bar')[0]!;
const stripOf = (bar: El): El => findByClass(bar, 'dashboard-mobile-widget-strip')[0]!;
const tabsOf = (bar: El): El => findByClass(bar, 'dashboard-mobile-widget-tabs')[0]!;
const panelOf = (bar: El): El => findByClass(bar, 'dashboard-mobile-widget-panel')[0]!;

/** Tab buttons in DOM order, as their widget keys. */
const tabKeys = (bar: El): string[] =>
	findByClass(bar, 'dashboard-mobile-widget-btn').map(b => b.dataset.widgetKey ?? '');

function tab(bar: El, key: string): El {
	const found = findByClass(bar, 'dashboard-mobile-widget-btn').find(b => b.dataset.widgetKey === key);
	assert.ok(found, `tab ${key} exists`);
	return found!;
}

function main(): void {
	// 1. A fresh bar is closed, and every full render says so again.
	{
		const rig = makeRig();
		renderMobileWidgetBar(rig.host, asEl(rig.root));
		const bar = barOf(rig.root);
		assert.equal(rig.state.tabsOpen, false, '1: tabs start closed');
		assert.equal(rig.state.expanded, null, '1: nothing expanded');
		assert.equal(stripOf(bar).hasClass('dashboard-mobile-widget-strip--active'), false, '1: strip not active');
		assert.equal(tabsOf(bar).hasClass('dashboard-mobile-widget-tabs--open'), false, '1: tab row hidden');
		assert.equal(panelOf(bar).hasClass('dashboard-mobile-widget-panel--open'), false, '1: panel closed');

		// Expand something, then render again: the new bar must not inherit it.
		tab(bar, 'lunar').click();
		assert.equal(rig.state.expanded, 'lunar', '1: pre-state expanded');
		renderMobileWidgetBar(rig.host, asEl(rig.root));
		assert.equal(rig.state.tabsOpen, false, '1: re-render closes tabs');
		assert.equal(rig.state.expanded, null, '1: re-render drops the expanded widget');
		const fresh = findByClass(rig.root, 'dashboard-mobile-widget-panel')[1]!;
		assert.equal(fresh.hasClass('dashboard-mobile-widget-panel--open'), false, '1: fresh panel closed');
		assert.equal(findByClass(fresh, 'dashboard-sidebar-widget').length, 0, '1: fresh panel empty');
	}

	// 2. The strip toggles the tab row, and collapsing it drops the widget.
	{
		const rig = makeRig();
		renderMobileWidgetBar(rig.host, asEl(rig.root));
		const bar = barOf(rig.root);

		stripOf(bar).click();
		assert.equal(rig.state.tabsOpen, true, '2: strip opens tabs');
		assert.equal(stripOf(bar).hasClass('dashboard-mobile-widget-strip--active'), true, '2: strip marked active');
		assert.equal(tabsOf(bar).hasClass('dashboard-mobile-widget-tabs--open'), true, '2: tab row shown');

		tab(bar, 'lunar').click();
		assert.equal(rig.state.expanded, 'lunar', '2: tab expands');
		assert.equal(panelOf(bar).hasClass('dashboard-mobile-widget-panel--open'), true, '2: panel shown');

		stripOf(bar).click();
		assert.equal(rig.state.tabsOpen, false, '2: strip closes tabs');
		assert.equal(rig.state.expanded, null, '2: collapsing drops the expanded widget');
		assert.equal(panelOf(bar).hasClass('dashboard-mobile-widget-panel--open'), false, '2: panel hidden again');
		assert.equal(findByClass(panelOf(bar), 'dashboard-sidebar-widget').length, 0, '2: panel emptied on collapse');
	}

	// 3. One panel, one widget — and the active mark follows the state.
	{
		const rig = makeRig();
		renderMobileWidgetBar(rig.host, asEl(rig.root));
		const bar = barOf(rig.root);
		stripOf(bar).click();

		tab(bar, 'lunar').click();
		const panel = panelOf(bar);
		assert.equal(findByClass(panel, 'dashboard-sidebar-lunar').length, 1, '3: lunar widget rendered');
		assert.equal(tab(bar, 'lunar').hasClass('active'), true, '3: lunar tab active');
		assert.equal(tab(bar, 'pomodoro').hasClass('active'), false, '3: others inactive');

		// Switching tabs must empty the panel first: pomodoro has no service
		// here, so the expected end state is "open, no widget inside".
		tab(bar, 'pomodoro').click();
		assert.equal(rig.state.expanded, 'pomodoro', '3: switched to pomodoro');
		assert.equal(findByClass(panel, 'dashboard-sidebar-lunar').length, 0, '3: previous widget dropped');
		assert.equal(findByClass(panel, 'dashboard-sidebar-widget').length, 0, '3: nothing rendered without a service');
		assert.equal(tab(bar, 'lunar').hasClass('active'), false, '3: old tab deactivated');

		// Tapping the open tab closes it.
		tab(bar, 'pomodoro').click();
		assert.equal(rig.state.expanded, null, '3: re-tap collapses');
		assert.equal(panel.hasClass('dashboard-mobile-widget-panel--open'), false, '3: panel closed');

		// syncMobileWidgetPanel is a no-op when the bar is not in the tree.
		const orphan = new El('div');
		syncMobileWidgetPanel(rig.host, asEl(orphan));
	}

	// 4. Settings gate the tab list; the order is fixed.
	{
		const all = makeRig();
		renderMobileWidgetBar(all.host, asEl(all.root));
		assert.deepEqual(tabKeys(barOf(all.root)), ['lunar', 'calendar', 'pomodoro', 'habit', 'expense', 'reading'], '4: full tab order');

		const bare = makeRig({ settings: { widgetCalendarEnabled: false, widgetHabitEnabled: false, widgetExpenseEnabled: false } });
		renderMobileWidgetBar(bare.host, asEl(bare.root));
		assert.deepEqual(tabKeys(barOf(bare.root)), ['lunar', 'pomodoro', 'reading'], '4: disabled widgets drop out');
	}

	// 5. Drawers: singleton, anchored under the first section row, backdrop closes.
	{
		const rig = makeRig();
		const sectionRow = rig.root.createDiv({ cls: 'dashboard-section-row' });
		sectionRow.getBoundingClientRect = () => ({ top: 120, right: 0, bottom: 0, left: 0, width: 0, height: 0 });

		openMobileDrawer(rig.host, 'quickActions');
		const drawers = findByClass(rig.root, 'dashboard-mobile-drawer');
		assert.equal(drawers.length, 1, '5: one drawer');
		assert.equal(drawers[0]!.style.top, '120px', '5: anchored under the first section');
		const titles = findByClass(drawers[0]!, 'dashboard-mobile-drawer-title');
		assert.equal(titles.length, 1, '5: one title');
		assert.equal(titles[0]!.textContent, t('mobile.quickActions'), '5: quick-actions title');

		// Opening the other one replaces rather than stacks.
		openMobileDrawer(rig.host, 'recent');
		assert.equal(findByClass(rig.root, 'dashboard-mobile-drawer').length, 1, '5: still one drawer');
		assert.equal(
			findByClass(rig.root, 'dashboard-mobile-drawer-title')[0]!.textContent,
			t('mobile.recent'),
			'5: recent title',
		);

		// Backdrop tap closes it.
		const backdrop = findByClass(rig.root, 'dashboard-mobile-drawer-backdrop')[0]!;
		backdrop.click();
		assert.equal(findByClass(rig.root, 'dashboard-mobile-drawer').length, 0, '5: backdrop closes');

		// closeMobileDrawer is safe when nothing is open.
		closeMobileDrawer(rig.host);
		assert.equal(findByClass(rig.root, 'dashboard-mobile-drawer').length, 0, '5: close is idempotent');

		// No root (view torn down mid-gesture): silent no-op.
		const gone = makeRig({ noRoot: true });
		openMobileDrawer(gone.host, 'quickActions');
		closeMobileDrawer(gone.host);
	}

	// 6. The banner buttons open the matching drawer; the right-half tap
	//    reveals the edit button (the left half does not).
	{
		const rig = makeRig();
		const banner = rig.root.createDiv({ cls: 'dashboard-banner' });
		const overlay = banner.createDiv({ cls: 'dashboard-banner-overlay' });
		const editBtn = overlay.createDiv({ cls: 'dashboard-banner-edit-btn' });
		overlay.getBoundingClientRect = () => ({ top: 0, right: 0, bottom: 0, left: 0, width: 100, height: 40 });

		renderMobileActions(rig.host, asEl(banner));
		const buttons = findByClass(banner, 'dashboard-mobile-action-btn');
		assert.equal(buttons.length, 2, '6: two banner buttons');

		buttons[0]!.click();
		assert.equal(
			findByClass(rig.root, 'dashboard-mobile-drawer-title')[0]!.textContent,
			t('mobile.quickActions'),
			'6: first button opens quick actions',
		);
		buttons[1]!.click();
		assert.equal(
			findByClass(rig.root, 'dashboard-mobile-drawer-title')[0]!.textContent,
			t('mobile.recent'),
			'6: second button opens recent docs',
		);

		// Left half: the edit button stays hidden.
		overlay.dispatchEvent({ type: 'click', target: overlay, clientX: 10 });
		assert.equal(editBtn.hasClass('dashboard-banner-edit-btn--mobile-visible'), false, '6: left half does not reveal edit');

		// Right half: revealed.
		overlay.dispatchEvent({ type: 'click', target: overlay, clientX: 80 });
		assert.equal(editBtn.hasClass('dashboard-banner-edit-btn--mobile-visible'), true, '6: right half reveals edit');
	}

	console.log('verify-mobile-panel: ok');
}

main();
