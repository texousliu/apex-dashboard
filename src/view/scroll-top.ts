/**
 * The floating "back to top" button pinned to the bottom-right corner.
 *
 * Extracted from `view.ts` (Phase 5). It is the one piece of board chrome that
 * has to guess which element scrolls, and that guess is layout-dependent, so it
 * reads better on its own than buried at the bottom of the view class.
 */
import { setIcon } from 'obsidian';
import { t } from '../i18n';

/**
 * Mount the button into `container` and wire its listeners.
 *
 * The active scroll element differs by layout: on desktop the inner
 * `.dashboard-kanban` scrolls; on mobile (<=640px) the `.apex-dashboard-root`
 * itself scrolls; in stacked/immersive layouts the shared
 * `.dashboard-scroll-region` is the scroller. We listen on every candidate and
 * pick the right one per event, which is cheap and also covers desktop↔mobile
 * resizes without re-binding.
 *
 * `registerCleanup` receives the teardown so the host can run it on re-render
 * or close; the button is removed as part of it.
 */
export function renderScrollToTop(container: HTMLElement, registerCleanup: (fn: () => void) => void): void {
	const btn = container.createEl('button', {
		cls: 'dashboard-scroll-top',
		attr: { 'aria-label': t('renderer.scrollToTop'), type: 'button' },
	});
	setIcon(btn, 'arrow-up');

	// Pick the element that actually scrolls in the current layout.
	const root = container;
	const kanbanEl = container.querySelector('.dashboard-kanban');
	const regionEl = container.querySelector('.dashboard-scroll-region');
	const pickScroller = (): HTMLElement => {
		if (window.innerWidth <= 640) return root;
		// Stacked layout: the shared region scrolls (widgets + sections);
		// the kanban itself is a static pass-through there.
		return (regionEl as HTMLElement) ?? (kanbanEl as HTMLElement) ?? root;
	};

	const updateVisibility = (): void => {
		const scroller = pickScroller();
		const threshold = Math.max(160, scroller.clientHeight * 0.3);
		if (scroller.scrollTop > threshold) {
			btn.addClass('dashboard-scroll-top--visible');
		} else {
			btn.removeClass('dashboard-scroll-top--visible');
		}
	};

	btn.addEventListener('click', () => {
		const scroller = pickScroller();
		scroller.scrollTo({ top: 0, behavior: 'smooth' });
	});

	// Listen on all candidates: cheap, and covers desktop↔mobile resizes.
	// The region listener matters for stacked AND immersive (the region is
	// the scroller in both; scroll events do not bubble up from it).
	const onKanbanScroll = (): void => updateVisibility();
	const onRootScroll = (): void => updateVisibility();
	const onResize = (): void => updateVisibility();
	if (kanbanEl) kanbanEl.addEventListener('scroll', onKanbanScroll, { passive: true });
	if (regionEl) regionEl.addEventListener('scroll', onRootScroll, { passive: true });
	root.addEventListener('scroll', onRootScroll, { passive: true });
	window.addEventListener('resize', onResize);

	registerCleanup(() => {
		btn.remove();
		if (kanbanEl) kanbanEl.removeEventListener('scroll', onKanbanScroll);
		if (regionEl) regionEl.removeEventListener('scroll', onRootScroll);
		root.removeEventListener('scroll', onRootScroll);
		window.removeEventListener('resize', onResize);
	});

	updateVisibility();
}
