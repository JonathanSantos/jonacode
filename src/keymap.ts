import type { Editor } from './editor.ts'

/** A command returns `true` when it handled the key (the default action is then prevented). */
export type Command = (editor: Editor) => boolean

/**
 * A key binding. Keys are written like `Mod-Shift-z`, `Alt-ArrowUp`, `Enter`.
 * `Mod` is Cmd on macOS and Ctrl elsewhere.
 */
export interface KeyBinding {
  key?: string
  /** Platform specific overrides of `key`. */
  mac?: string
  win?: string
  linux?: string
  run?: Command
  /** Command for the same key with Shift held (e.g. extend the selection). */
  shift?: Command
}

const nav = typeof navigator !== 'undefined' ? navigator : null
export const isMac = !!nav && /mac|iphone|ipad|ipod/i.test(
  (nav as { userAgentData?: { platform?: string } }).userAgentData?.platform || nav.platform || nav.userAgent,
)
const isWin = !!nav && /win/i.test((nav as { userAgentData?: { platform?: string } }).userAgentData?.platform || nav.platform || nav.userAgent)

function modifiers(alt: boolean, ctrl: boolean, meta: boolean, shift: boolean): string {
  return (alt ? 'Alt-' : '') + (ctrl ? 'Ctrl-' : '') + (meta ? 'Meta-' : '') + (shift ? 'Shift-' : '')
}

/** Normalizes a binding like `Mod-Shift-Z` to the canonical form used for lookups. */
export function normalizeKey(name: string, mac = isMac): string {
  const parts = name.split(/-(?!$)/)
  let key = parts.pop()!
  if (key === 'Space') key = ' '
  if (key.length === 1) key = key.toLowerCase()
  let alt = false, ctrl = false, meta = false, shift = false
  for (const mod of parts) {
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true
    else if (/^a(lt)?$|^option$/i.test(mod)) alt = true
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true
    else if (/^s(hift)?$/i.test(mod)) shift = true
    else if (/^mod$/i.test(mod)) mac ? (meta = true) : (ctrl = true)
    else throw new Error(`[jonacode] Unknown modifier "${mod}" in key "${name}"`)
  }
  return modifiers(alt, ctrl, meta, shift) + key
}

const CODE_KEYS: Record<string, string> = {
  Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.',
  Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Backquote: '`',
}

/** Candidate binding names for a keyboard event, most specific first. */
export function eventKeyNames(e: KeyboardEvent): string[] {
  let key = e.key
  const hasMod = e.altKey || e.ctrlKey || e.metaKey
  const fromCode = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? /^Digit(\d)$/.exec(e.code)?.[1] ?? CODE_KEYS[e.code]
  // With Alt (macOS) or on some layouts, `key` is a special char: fall back to the physical key.
  if (hasMod && fromCode && (key.length !== 1 || key.charCodeAt(0) > 126)) key = fromCode
  if (key.length === 1) key = key.toLowerCase()
  const base = modifiers(e.altKey, e.ctrlKey, e.metaKey, false)
  const names = [base + (e.shiftKey ? 'Shift-' : '') + key]
  // Shifted symbols (`{`, `?`…) can be bound without the Shift modifier.
  if (e.shiftKey && key.length === 1 && !/[a-z]/.test(key)) names.push(base + key)
  if (hasMod && fromCode && fromCode !== key) names.push(base + (e.shiftKey ? 'Shift-' : '') + fromCode)
  return names
}

export type CompiledKeymap = Map<string, Command[]>

export function compileKeymap(bindings: readonly KeyBinding[]): CompiledKeymap {
  const map: CompiledKeymap = new Map()
  const add = (name: string, cmd: Command) => {
    const list = map.get(name)
    if (list) list.push(cmd)
    else map.set(name, [cmd])
  }
  for (const b of bindings) {
    const key = (isMac ? b.mac : isWin ? b.win : b.linux) ?? b.key
    if (!key) continue
    const name = normalizeKey(key)
    if (b.run) add(name, b.run)
    if (b.shift) add(normalizeKey('Shift-' + key), b.shift)
  }
  return map
}

export function runKeymap(map: CompiledKeymap, names: readonly string[], editor: Editor): boolean {
  for (const name of names) {
    const cmds = map.get(name)
    if (cmds) for (const cmd of cmds) if (cmd(editor)) return true
  }
  return false
}
