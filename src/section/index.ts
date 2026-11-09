/**
 * Built-in section definitions. Importing this module registers them, so
 * anything that renders a section (renderer.ts, tests) only needs to import
 * from `./section`.
 *
 * Each defs module owns one domain; the chooser order comes from the entries'
 * own `order` field, not from import order.
 */
import './defs/cards';
import './defs/media';
import './defs/data';
import './defs/tasks';
import './defs/boards';

export * from './registry';
