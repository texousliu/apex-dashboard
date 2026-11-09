/**
 * Verifies the shared section refresh bus (src/section-refresh.ts) — the ONE
 * registry that answers "which live sections should re-run right now?",
 * replacing dataview's private dvSectionHandles and calendar's
 * sectionReloaders WeakMap.
 *
 * 1. Channel filter: 'note-edited' entries fire on refreshSectionsForPath,
 *    'vault'-only entries do NOT (dataview cards stay off the vault flow by
 *    design — the policy the channels exist to encode).
 * 2. Path scoping: a null-paths entry ('everything') always fires; a
 *    path-set entry fires only when it shows the edited note.
 * 3. Container scoping: refreshSectionsIn only fires entries mounted under
 *    the container, and only for the requested channel.
 * 4. Dead DOM is pruned permanently; re-registering the same element
 *    replaces instead of stacking.
 *
 * Run: `npm run test:section-refresh`
 */
import { strict as assert } from 'node:assert';
import { refreshSectionsForPath, refreshSectionsIn, registerSectionRefresh, type SectionRefreshEntry } from '../src/section-refresh';
import { El } from './mini-dom';

type Reloadable = { entry: SectionRefreshEntry; reloads: () => number };

function countingEntry(el: unknown, channels: SectionRefreshEntry['channels'], paths: string[] | null): Reloadable {
	let n = 0;
	return {
		entry: {
			el: el as HTMLElement,
			channels,
			paths: () => (paths === null ? null : new Set(paths)),
			reload: () => { n++; },
		},
		reloads: () => n,
	};
}

/** Plain fake element reporting a chosen connection state. */
const fakeEl = (connected: boolean): HTMLElement => ({ isConnected: connected } as unknown as HTMLElement);

/** A real El tree rooted at a stub <body>, so isConnected walks true. */
function boardWithHosts(): { body: El; board: El; host: () => El } {
	const body = new El('body');
	const board = body.createDiv({ cls: 'board' });
	return { body, board, host: () => board.createDiv({ cls: 'section-host' }) };
}

/* --------------------------- 1. channel filtering --------------------------- */

{
	const dv = countingEntry(fakeEl(true), ['note-edited'], ['a.md']);
	const cal = countingEntry(fakeEl(true), ['vault'], null);
	registerSectionRefresh(dv.entry);
	registerSectionRefresh(cal.entry);

	refreshSectionsForPath('a.md');
	assert.equal(dv.reloads(), 1, '1: a note-edited entry showing the note fires');
	assert.equal(cal.reloads(), 0, '1: a vault-only entry (calendar) is NOT fired by the popover channel');
}

/* ---------------------------- 2. path scoping ---------------------------- */

{
	const everything = countingEntry(fakeEl(true), ['note-edited'], null);
	const scoped = countingEntry(fakeEl(true), ['note-edited'], ['01-日记/today.md']);
	registerSectionRefresh(everything.entry);
	registerSectionRefresh(scoped.entry);

	refreshSectionsForPath('01-日记/today.md');
	assert.equal(everything.reloads(), 1, '2: a null-paths entry fires for any note');
	assert.equal(scoped.reloads(), 1, '2: a scoped entry fires for a note it shows');

	refreshSectionsForPath('02-项目/其他.md');
	assert.equal(everything.reloads(), 2, '2: null-paths keeps firing');
	assert.equal(scoped.reloads(), 1, '2: the scoped entry is left alone');
}

/* --------------------------- 3. container scoping --------------------------- */

{
	const { body, board, host } = boardWithHosts();
	const otherBoard = body.createDiv({ cls: 'other-board' });
	const otherHost = (): El => otherBoard.createDiv({ cls: 'section-host' });

	const inside = countingEntry(host(), ['vault'], null);
	const outside = countingEntry(otherHost(), ['vault'], null);
	const dvOnBoard = countingEntry(host(), ['note-edited'], null);
	registerSectionRefresh(inside.entry);
	registerSectionRefresh(outside.entry);
	registerSectionRefresh(dvOnBoard.entry);

	const fired = refreshSectionsIn(board as unknown as ParentNode, 'vault');
	assert.equal(inside.reloads(), 1, '3: an entry under the container fires');
	assert.equal(outside.reloads(), 0, '3: an entry elsewhere does not');
	assert.equal(dvOnBoard.reloads(), 0, '3: a note-edited-only entry is not caught by the vault channel');
	assert.equal(fired, 1, '3: the fired count matches');
}

/* ------------------------ 4. prune + replace semantics ------------------------ */

{
	const { board, host } = boardWithHosts();
	const deadEl = host();
	const dead = countingEntry(deadEl, ['note-edited'], ['x.md']);
	registerSectionRefresh(dead.entry);
	// A re-render discards the section element — detach it from the tree.
	board.removeChild(deadEl);
	refreshSectionsForPath('x.md');
	assert.equal(dead.reloads(), 0, '4: a section whose DOM is gone never fires');

	const el = host();
	const first = countingEntry(el, ['note-edited'], ['y.md']);
	const second = countingEntry(el, ['note-edited'], ['y.md']);
	registerSectionRefresh(first.entry);
	registerSectionRefresh(second.entry);
	refreshSectionsForPath('y.md');
	assert.equal(first.reloads(), 0, '4: the superseded entry is replaced, not kept');
	assert.equal(second.reloads(), 1, '4: the section reloads once, not twice');
}

console.log('section refresh bus: all scenarios OK');
