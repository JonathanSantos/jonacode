/**
 * Line widgets from a provider (what "code lens" is made of): a function says
 * which zones the document should have — a bar above each test function, a
 * note under each TODO — and this keeps the editor in sync with it: after each
 * edit (debounced) the function runs again, and zones are created, updated or
 * removed by comparing `key`s. A zone whose key is still there is the same
 * zone, with the same elements: only what changed is touched.
 *
 * ```ts
 * lineWidgets((doc) => findTests(doc).map((t) => ({
 *   key: t.name,
 *   line: t.line,
 *   actions: [{ label: '▶ Rodar', run: () => runTest(t.name), disabled: running.has(t.name) }],
 *   status: results[t.name] && { text: results[t.name].summary },
 * })))
 * refreshLineWidgets(editor)   // something outside the document changed (a result arrived)
 * ```
 */
import type { Editor, Extension } from '../editor.ts'
import type { TextDocument } from '../state/text.ts'
import { addZone, type Zone, type ZoneAction, type ZoneSpec } from '../widgets.ts'

export interface LineWidget extends ZoneSpec {
  /**
   * Identity from one round to the next: the same key is the same zone. Change
   * it to get a new one (a `content` or `gutter` given as a function is built
   * once per key).
   */
  key: string
}

/** Says which widgets the document should have now. */
export type LineWidgetSource = (doc: TextDocument, editor: Editor) => readonly LineWidget[]

export interface LineWidgetsOptions {
  /** Wait this long (ms) after the last edit before asking the source again. Default 250. */
  delay?: number
}

const PLAIN = ['side', 'height', 'lines', 'indent', 'cover', 'scroll', 'class', 'order', 'separator', 'keepFocus'] as const

const sameActions = (a: readonly ZoneAction[] = [], b: readonly ZoneAction[] = []) =>
  a.length === b.length && a.every((x, i) => {
    const y = b[i]!
    return x.label === y.label && x.title === y.title && !x.disabled === !y.disabled && x.class === y.class
  })

/** Functions are built once per key; strings and elements are compared. */
const sameContent = (a: ZoneSpec['content'], b: ZoneSpec['content']) => a === b || (typeof a === 'function' && typeof b === 'function')

/**
 * What to change in the zone of `prev` for it to show `next` (empty: nothing).
 * The line is compared by the caller, against where the zone is now: zones
 * follow edits on their own. Callbacks (`run`, `onHeight`) aren't here: the
 * zone always calls the latest ones.
 */
export function widgetPatch(prev: LineWidget, next: LineWidget): Partial<ZoneSpec> {
  const patch: Partial<ZoneSpec> = {}
  for (const k of PLAIN) if (prev[k] !== next[k]) (patch as Record<string, unknown>)[k] = next[k]
  if (!sameContent(prev.content, next.content)) patch.content = next.content
  if (!sameContent(prev.gutter, next.gutter)) patch.gutter = next.gutter
  if (!sameActions(prev.actions, next.actions)) patch.actions = next.actions
  if (prev.status?.text !== next.status?.text || prev.status?.class !== next.status?.class) patch.status = next.status
  return patch
}

interface Entry { zone: Zone; spec: LineWidget }

const refreshers = new WeakMap<Editor, Set<() => void>>()

/** Zones kept in sync with what `source` returns. See {@link LineWidget}. */
export function lineWidgets(source: LineWidgetSource, options: LineWidgetsOptions = {}): Extension {
  return (editor) => {
    const entries = new Map<string, Entry>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let alive = true

    /** The zone's version of a widget: callbacks go through the entry, so they are always the latest. */
    const zoneSpec = (w: LineWidget, patch: Partial<ZoneSpec>): Partial<ZoneSpec> => {
      const out = { ...patch }
      if (out.actions) out.actions = out.actions.map((a, i) => ({ ...a, run: (ed, zone) => entries.get(w.key)?.spec.actions?.[i]?.run(ed, zone) }))
      return out
    }

    const sync = () => {
      clearTimeout(timer)
      let list: readonly LineWidget[]
      try {
        list = source(editor.doc, editor)
      } catch (err) {
        console.error('[jonacode] lineWidgets source failed', err)
        return
      }
      const seen = new Set<string>()
      for (const w of list) {
        // Two widgets with one key: the first one wins.
        if (seen.has(w.key)) continue
        seen.add(w.key)
        const entry = entries.get(w.key)
        if (!entry) {
          const { key, ...spec } = w
          const zone = addZone(editor, { ...zoneSpec(w, spec), line: w.line, onHeight: (h, z) => entries.get(key)?.spec.onHeight?.(h, z) })
          entries.set(key, { zone, spec: w })
          continue
        }
        const patch = widgetPatch(entry.spec, w)
        if (entry.zone.line !== w.line) patch.line = w.line
        entry.spec = w
        if (Object.keys(patch).length) entry.zone.update(zoneSpec(w, patch))
      }
      for (const [key, entry] of entries) {
        if (seen.has(key)) continue
        entry.zone.remove()
        entries.delete(key)
      }
    }

    let set = refreshers.get(editor)
    if (!set) refreshers.set(editor, (set = new Set()))
    set.add(sync)
    const off = editor.on('change', ({ origin }) => {
      clearTimeout(timer)
      // Another document (`setValue`, `setState`): now, once everyone has seen the change, not after the delay.
      if (origin === 'setValue') queueMicrotask(() => alive && sync())
      else timer = setTimeout(sync, options.delay ?? 250)
    })
    sync()
    return () => {
      alive = false
      off()
      clearTimeout(timer)
      set.delete(sync)
      for (const entry of entries.values()) entry.zone.remove()
      entries.clear()
    }
  }
}

/** Asks the sources of `lineWidgets()` again now: something they depend on, outside the document, changed. */
export function refreshLineWidgets(editor: Editor): void {
  for (const sync of [...(refreshers.get(editor) ?? [])]) sync()
}
