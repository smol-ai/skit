/** One string syntax for both a trigger combo and the caps a row displays.
 * Tokens join with "+": modifiers first, then one key. "mod" is ⌘ on a Mac
 * and Ctrl elsewhere. Pre-formatted caps ("⌘K", "⌘⇧P") display as-is, one
 * cap per glyph. Ported from upstream's command-menu shortcut helpers. */
export interface ParsedShortcut {
  readonly mod: boolean;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Lowercase `KeyboardEvent.key` ("k", "/", "escape"). */
  readonly key: string;
}
type Modifier = Exclude<keyof ParsedShortcut, 'key'>;
const modifierTokens: Readonly<Record<string, Modifier>> = {
  mod: 'mod',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  super: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};
const keyAliases: Readonly<Record<string, string>> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  plus: '+',
};
/** Splits a combo on "+", keeping a trailing "+" as the key itself. */
function tokens(shortcut: string): string[] {
  const trimmed = shortcut.trim();
  if (trimmed === '') return [];
  const parts = trimmed.split('+').map((part) => part.trim());
  const out: string[] = [];
  parts.forEach((part, i) => {
    if (part === '' && i > 0) {
      if (out.at(-1) !== '+') out.push('+');
    } else if (part !== '') out.push(part);
  });
  return out;
}
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parsed = { mod: false, meta: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const token of tokens(shortcut)) {
    const lower = token.toLowerCase();
    const modifier = modifierTokens[lower];
    if (modifier) parsed[modifier] = true;
    else parsed.key = keyAliases[lower] ?? lower;
  }
  return parsed;
}
/** Whether a keydown is the combo. The physical key stands in for non-Latin
 * layouts and whenever ⌥ is held; without ⌥ a Latin letter is taken at face
 * value, so Dvorak and AZERTY keep their own letters. */
export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  parsed: ParsedShortcut,
): boolean {
  if (parsed.key === '') return false;
  const key = event.key.toLowerCase();
  const byCode =
    parsed.key.length === 1 &&
    /[a-z0-9]/.test(parsed.key) &&
    (event.altKey || !/^[a-z0-9]$/i.test(event.key)) &&
    event.code.toLowerCase() ===
      (/[a-z]/.test(parsed.key) ? `key${parsed.key}` : `digit${parsed.key}`);
  if (key !== parsed.key && !byCode) return false;
  if (parsed.mod) {
    if (!event.metaKey && !event.ctrlKey) return false;
  } else if (event.metaKey !== parsed.meta || event.ctrlKey !== parsed.ctrl) return false;
  if (event.altKey !== parsed.alt) return false;
  return !parsed.shift || event.shiftKey;
}
/** A combo with a modifier is safe to fire while typing in a field. */
export const hasModifier = (parsed: ParsedShortcut): boolean =>
  parsed.mod || parsed.meta || parsed.ctrl || parsed.alt;
const capLabels: Readonly<Record<string, { readonly mac: string; readonly other: string }>> = {
  mod: { mac: '⌘', other: 'Ctrl' },
  meta: { mac: '⌘', other: 'Win' },
  ctrl: { mac: '⌃', other: 'Ctrl' },
  alt: { mac: '⌥', other: 'Alt' },
  shift: { mac: '⇧', other: 'Shift' },
  enter: { mac: '↵', other: 'Enter' },
  escape: { mac: 'Esc', other: 'Esc' },
  backspace: { mac: '⌫', other: 'Backspace' },
  delete: { mac: '⌦', other: 'Del' },
  tab: { mac: '⇥', other: 'Tab' },
  ' ': { mac: 'Space', other: 'Space' },
  arrowup: { mac: '↑', other: '↑' },
  arrowdown: { mac: '↓', other: '↓' },
  arrowleft: { mac: '←', other: '←' },
  arrowright: { mac: '→', other: '→' },
};
const preformatted = /^[⌘⌃⌥⇧↵⌫⌦⇥↑↓←→]+[A-Za-z0-9]?$/;
/** The caps a shortcut displays: symbols on a Mac, words elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string[] {
  const caps: string[] = [];
  for (const token of tokens(shortcut)) {
    if (preformatted.test(token)) {
      caps.push(...Array.from(token));
      continue;
    }
    const lower = token.toLowerCase();
    const name = modifierTokens[lower] ?? keyAliases[lower] ?? lower;
    const cap = capLabels[name];
    if (cap) caps.push(mac ? cap.mac : cap.other);
    else if (name.length === 1) caps.push(name.toUpperCase());
    else caps.push(name.charAt(0).toUpperCase() + name.slice(1));
  }
  return caps;
}
/** Whether the page runs on a Mac, the platform that draws ⌘ and ⌥. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? '');
}
