/**
 * `jonacode/collab`: collaborative editing. `collab(adapter, options)` keeps
 * the editor in sync with a shared text and shows who else is there:
 * cursors and selections with names and colors, an avatar bar (click to
 * follow someone), a flash on what others type, and undo that only undoes
 * your own changes. The backend is an adapter: `yjs()` is ready (any Yjs
 * provider), and your own server fits by implementing `CollabAdapter`.
 *
 * ```ts
 * import * as Y from 'yjs'
 * import { WebsocketProvider } from 'y-websocket'
 * import { collab, yjs } from 'jonacode/collab'
 *
 * const doc = new Y.Doc()
 * const provider = new WebsocketProvider('wss://meu-servidor', 'sala-42', doc)
 * createEditor(el, {
 *   extensions: [basicSetup(), collab(yjs({ Y, text: doc.getText('codigo'), awareness: provider.awareness }), { user: { name: 'Ana' } })],
 * })
 * ```
 */
import { setDecorations } from '../decorations.ts'
import type { Editor, Extension } from '../editor.ts'
import { LineOffsets } from '../state/offsets.ts'
import { cmpPos, mapPos, type ChangeSpec, type Pos } from '../state/text.ts'
import { injectStyle } from '../view/style.ts'
import { OwnHistory } from './history.ts'
import type { CollabAdapter, PeerState, TextDelta, TextOp } from './types.ts'

export type { CollabAdapter, LocalPresence, PeerState, RemoteOrigin, TextDelta, TextOp } from './types.ts'
export { yjs, type YjsOptions, type YModule, type YText, type YDoc, type YAwareness, type YUndoManager } from './yjs.ts'
export { OwnHistory } from './history.ts'

export interface CollabUser {
  name?: string
  /** CSS color of your cursor for the others (default: picked from your name). */
  color?: string
  /** Anything else to share (avatar URL, role…): the others get it in `Peer.data`. */
  data?: Record<string, unknown>
}

export interface CollabOptions {
  user?: CollabUser
  /** Show the others' cursors and selections (default true). */
  cursors?: boolean
  /** Names on the cursors: always, for a moment after they move or type (default), on mouse hover, or never. */
  labels?: 'always' | 'activity' | 'hover' | 'never'
  /** How long a name stays up after activity (ms, default 2000). */
  labelTime?: number
  /** The avatars of the others at the top right; click one to follow them (default true). */
  avatars?: boolean
  /** Briefly highlight what the others type (default true). */
  flash?: boolean
  /** Dim people who haven't moved for this long (ms, default 60000). */
  idleAfter?: number
  /**
   * When the editor and the shared text differ at start: take the shared
   * text (default), or publish the editor's text (for a brand new room only —
   * otherwise both versions would merge).
   */
  initial?: 'shared' | 'local'
  /** Called when the others join, leave, move or type. */
  onPeers?: (peers: readonly Peer[], editor: Editor) => void
}

/** Someone else in the document. */
export interface Peer {
  id: string | number
  name: string
  color: string
  /** Their selection here (null when they have no cursor in this text). */
  anchor: Pos | null
  head: Pos | null
  /** When they last moved or typed (`Date.now()`). */
  active: number
  data: Record<string, unknown>
}

/** Colors that read well on dark and light themes. */
export const PEER_COLORS: readonly string[] = ['#e06c75', '#61afef', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#d19a66', '#ff7ab2']

/** A stable color for a name or id. */
export function peerColor(key: string | number): string {
  let h = 0
  for (const ch of String(key)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length]!
}

interface Session {
  editor: Editor
  adapter: CollabAdapter
  options: CollabOptions
  offsets: LineOffsets
  user: { name: string; color: string; data?: Record<string, unknown> }
  peers: Map<string | number, Peer>
  /** Until when each name label stays up. */
  labels: Map<string | number, number>
  follow: string | number | null
  /** Changes being applied from the backend (not sent back). */
  applying: boolean
  presenceTimer: ReturnType<typeof setTimeout> | undefined
  labelTimer: ReturnType<typeof setTimeout> | undefined
  flashTimer: ReturnType<typeof setTimeout> | undefined
  carets: Map<string | number, HTMLElement>
  avatars: HTMLElement | null
}

const sessions = new WeakMap<Editor, Session>()
const samePos = (a: Pos | null, b: Pos | null) => (a && b ? cmpPos(a, b) === 0 : a === b)

/** A delta (over the text before it) → specs in the current document, last first (so one dispatch applies them). */
function deltaToChanges(delta: TextDelta, offsets: LineOffsets): { changes: ChangeSpec[]; inserted: { at: number; length: number }[] } {
  const specs: { at: number; end: number; insert: string }[] = []
  let at = 0
  for (const op of delta) {
    if ('retain' in op) at += op.retain
    else {
      const last = specs[specs.length - 1]
      const removing = 'delete' in op ? op.delete : 0
      const insert = 'insert' in op ? op.insert : ''
      // A delete followed by an insert at the same place is one replacement.
      if (last && last.end === at) {
        last.end += removing
        last.insert += insert
      } else specs.push({ at, end: at + removing, insert })
      at += removing
    }
  }
  // Where the inserted text ends up (for the flash), in the text after the change.
  const inserted: { at: number; length: number }[] = []
  let shift = 0
  for (const s of specs) {
    if (s.insert) inserted.push({ at: s.at + shift, length: s.insert.length })
    shift += s.insert.length - (s.end - s.at)
  }
  const changes = specs.map((s) => ({ from: offsets.pos(s.at), to: offsets.pos(s.end), insert: s.insert })).reverse()
  return { changes, inserted }
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1]![0] : '')).toUpperCase()
}

function sendPresence(s: Session): void {
  s.presenceTimer = undefined
  const sel = s.editor.selection
  s.adapter.setPresence?.({ ...s.user, anchor: s.offsets.offset(sel.anchor), head: s.offsets.offset(sel.head) })
}

function schedulePresence(s: Session): void {
  s.presenceTimer ??= setTimeout(() => sendPresence(s), 50)
}

/** Label visibility changes over time: re-render when the next one expires. */
function scheduleLabels(s: Session): void {
  clearTimeout(s.labelTimer)
  const now = Date.now()
  const next = Math.min(...[...s.labels.values()].filter((t) => t > now))
  if (Number.isFinite(next)) s.labelTimer = setTimeout(() => s.editor.requestRender(), next - now + 20)
}

function showLabel(s: Session, id: string | number): void {
  s.labels.set(id, Date.now() + (s.options.labelTime ?? 2000))
  scheduleLabels(s)
}

function updatePeers(s: Session, list: readonly PeerState[]): void {
  const { editor, options } = s
  const now = Date.now()
  const next = new Map<string | number, Peer>()
  for (const p of list) {
    const old = s.peers.get(p.id)
    const anchor = p.anchor == null ? null : s.offsets.pos(p.anchor)
    const head = p.head == null ? null : s.offsets.pos(p.head)
    const moved = !old || !samePos(old.head, head) || !samePos(old.anchor, anchor)
    const name = p.name || editor.phrase('Anonymous')
    next.set(p.id, { id: p.id, name, color: p.color || peerColor(name + p.id), anchor, head, active: moved ? now : old.active, data: p.data ?? {} })
    if (moved && head) {
      if (options.labels !== 'always' && options.labels !== 'never' && options.labels !== 'hover') showLabel(s, p.id)
      if (s.follow === p.id) editor.scrollIntoView(head, true)
    }
  }
  for (const id of s.peers.keys()) {
    if (!next.has(id)) {
      s.carets.get(id)?.remove()
      s.carets.delete(id)
      s.labels.delete(id)
      if (s.follow === id) s.follow = null
    }
  }
  s.peers = next
  renderAvatars(s)
  editor.requestRender()
  options.onPeers?.([...next.values()], editor)
}

function renderAvatars(s: Session): void {
  if (s.options.avatars === false || !s.editor.dom) return
  const { editor } = s
  if (!s.avatars) {
    s.avatars = editor.dom.ownerDocument.createElement('div')
    s.avatars.className = 'jc-collab-avatars'
    s.avatars.setAttribute('role', 'toolbar')
    s.avatars.setAttribute('aria-label', editor.phrase('People editing'))
    s.avatars.addEventListener('mousedown', (e) => e.preventDefault())
    s.avatars.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('button[data-peer]')
      if (!b) return
      const peer = [...s.peers.values()].find((p) => String(p.id) === b.dataset.peer)
      if (peer) followPeer(editor, s.follow === peer.id ? null : peer.id)
    })
    editor.dom.appendChild(s.avatars)
  }
  const idle = s.options.idleAfter ?? 60000
  const now = Date.now()
  const peers = [...s.peers.values()]
  const shown = peers.slice(0, 5)
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  s.avatars.innerHTML = shown.map((p) => {
    const following = s.follow === p.id
    const label = editor.phrase(following ? 'Stop following {name}' : 'Follow {name}').replace('{name}', p.name)
    return `<button type="button" data-peer="${esc(String(p.id))}" class="${following ? 'jc-following' : ''}${now - p.active > idle ? ' jc-peer-idle' : ''}" style="--jc-peer:${esc(p.color)}" title="${esc(p.name)}" aria-label="${esc(label)}" aria-pressed="${following}">${esc(initials(p.name))}</button>`
  }).join('') + (peers.length > shown.length ? `<span class="jc-collab-more">+${peers.length - shown.length}</span>` : '')
  s.avatars.hidden = !peers.length
}

/** The others' selections, behind the text. */
function drawSelections(s: Session, dom: HTMLElement): void {
  const { editor } = s
  const { from, to } = editor.visibleRange
  let html = ''
  for (const p of s.peers.values()) {
    if (!p.anchor || !p.head || samePos(p.anchor, p.head)) continue
    const [a, b] = cmpPos(p.anchor, p.head) < 0 ? [p.anchor, p.head] : [p.head, p.anchor]
    if (b.line < from || a.line > to) continue
    for (const r of editor.rangeRects(a, b)) {
      html += `<div class="jc-peer-sel" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;--jc-peer:${p.color}"></div>`
    }
  }
  if (dom.innerHTML !== html) dom.innerHTML = html
}

/** The others' cursors, with their names. */
function drawCarets(s: Session, dom: HTMLElement): void {
  const { editor, options } = s
  const { from, to } = editor.visibleRange
  const now = Date.now()
  const idle = options.idleAfter ?? 60000
  for (const p of s.peers.values()) {
    let el = s.carets.get(p.id)
    const head = p.head
    const visible = !!head && head.line >= from && head.line <= to && !editor.isLineHidden(head.line)
    if (!visible) {
      if (el) el.style.display = 'none'
      continue
    }
    if (!el) {
      el = editor.dom.ownerDocument.createElement('div')
      el.className = 'jc-peer-caret'
      el.appendChild(editor.dom.ownerDocument.createElement('span')).className = 'jc-peer-label'
      s.carets.set(p.id, el)
    }
    if (el.parentNode !== dom) dom.appendChild(el)
    const c = editor.coordsAtPos(head!)
    el.style.display = ''
    el.style.transform = `translate(${c.x}px,${c.top}px)`
    el.style.setProperty('--jc-peer', p.color)
    el.firstChild!.textContent = p.name
    const label = options.labels === 'always' || (options.labels !== 'never' && (s.labels.get(p.id) ?? 0) > now)
    el.classList.toggle('jc-peer-show', label)
    el.classList.toggle('jc-peer-below', head!.line === 0)
    el.classList.toggle('jc-peer-idle', now - p.active > idle)
  }
}

/** Highlights what the others just typed (it fades out). */
function flash(s: Session, inserted: { at: number; length: number }[]): void {
  const { editor } = s
  if (!editor.dom || !inserted.length) return
  setDecorations(editor, 'collab-flash', inserted.map((r) => ({ from: s.offsets.pos(r.at), to: s.offsets.pos(r.at + r.length), class: 'jc-collab-flash' })))
  clearTimeout(s.flashTimer)
  s.flashTimer = setTimeout(() => setDecorations(editor, 'collab-flash', []), 1300)
}

/**
 * Collaborative editing over a backend adapter (`yjs(...)`, or your own
 * `CollabAdapter`). The editor takes the shared text, sends your edits,
 * applies everyone else's, and shows who's there.
 */
export function collab(adapter: CollabAdapter, options: CollabOptions = {}): Extension {
  return (editor) => {
    const name = options.user?.name || editor.phrase('Anonymous')
    const s: Session = {
      editor, adapter, options, offsets: new LineOffsets(editor.doc.lines),
      user: { name, color: options.user?.color || peerColor(name), data: options.user?.data },
      peers: new Map(), labels: new Map(), follow: null, applying: false,
      presenceTimer: undefined, labelTimer: undefined, flashTimer: undefined, carets: new Map(), avatars: null,
    }
    sessions.set(editor, s)
    if (editor.dom) injectStyle(editor.dom, 'collab', COLLAB_CSS)

    // Start from the same text.
    const shared = adapter.text()
    if (shared !== editor.getValue()) {
      if (options.initial === 'local') adapter.send([{ at: 0, remove: shared.length, insert: editor.getValue() }])
      else {
        s.applying = true
        editor.setValue(shared)
        s.applying = false
        s.offsets = new LineOffsets(editor.doc.lines)
      }
    }

    const history = adapter.undo ? null : new OwnHistory(editor)
    editor.setUndoProvider(history ?? {
      undo: () => adapter.undo!(),
      redo: () => adapter.redo?.() ?? false,
      canUndo: () => adapter.canUndo?.() ?? true,
      canRedo: () => adapter.canRedo?.() ?? true,
    })

    const offChange = editor.on('change', (event) => {
      const ops: TextOp[] = []
      for (const c of event.changes) {
        const e = s.offsets.apply(c)
        ops.push({ at: e.startIndex, remove: e.oldEndIndex - e.startIndex, insert: c.inserted.join('\n') })
      }
      const remote = s.applying
      history?.track(event, remote)
      // The others' cursors follow the edit until the backend reports them again.
      for (const p of s.peers.values()) {
        for (const c of event.changes) {
          if (p.anchor) p.anchor = mapPos(p.anchor, c, -1)
          if (p.head) p.head = mapPos(p.head, c, -1)
        }
      }
      if (!remote) {
        adapter.send(ops)
        schedulePresence(s)
      }
    })

    const offReceive = adapter.receive((delta, origin) => {
      const { changes, inserted } = deltaToChanges(delta, s.offsets)
      if (!changes.length) return
      const version = editor.version
      s.applying = true
      try {
        editor.dispatch({ changes, origin, scrollIntoView: origin !== 'remote' })
      } finally {
        s.applying = false
      }
      if (editor.version === version) {
        // Something vetoed it (a change filter): the editor must not drift away from the shared text.
        console.warn('[jonacode] collab: a change from the others was rejected; reloading the shared text')
        s.applying = true
        editor.setValue(adapter.text())
        s.applying = false
        s.offsets = new LineOffsets(editor.doc.lines)
        return
      }
      if (origin === 'remote' && options.flash !== false) flash(s, inserted)
    })

    const offPeers = adapter.peers?.((list) => updatePeers(s, list))
    const offSelection = editor.on('selection', () => schedulePresence(s))
    sendPresence(s)

    const disposers: (() => void)[] = []
    if (options.cursors !== false && editor.dom) {
      disposers.push(
        editor.addLayer({ className: 'jc-collab-selections', order: 0.5, render: (dom) => drawSelections(s, dom) }),
        editor.addLayer({ className: 'jc-collab-carets', above: true, order: 5, render: (dom) => drawCarets(s, dom) }),
      )
      if (options.labels === 'hover') {
        const onMove = (e: PointerEvent) => {
          const at = editor.posAtClient(e.clientX, e.clientY)
          for (const p of s.peers.values()) if (p.head && p.head.line === at.line && Math.abs(p.head.col - at.col) <= 2) showLabel(s, p.id)
          editor.requestRender()
        }
        editor.scrollDOM.addEventListener('pointermove', onMove)
        disposers.push(() => editor.scrollDOM.removeEventListener('pointermove', onMove))
      }
    }
    // Your own keys, clicks or wheel stop following someone (not the avatar bar: it toggles it).
    const stopFollowing = (e: Event) => {
      if (s.follow != null && !(e.target as Element).closest?.('.jc-collab-avatars')) followPeer(editor, null)
    }
    if (editor.dom) {
      for (const type of ['keydown', 'mousedown', 'wheel'] as const) {
        editor.dom.addEventListener(type, stopFollowing, { passive: true })
        disposers.push(() => editor.dom.removeEventListener(type, stopFollowing))
      }
    }

    return () => {
      offChange()
      offReceive()
      offPeers?.()
      offSelection()
      for (const d of disposers) d()
      clearTimeout(s.presenceTimer)
      clearTimeout(s.labelTimer)
      clearTimeout(s.flashTimer)
      s.avatars?.remove()
      for (const el of s.carets.values()) el.remove()
      editor.setUndoProvider(null)
      adapter.setPresence?.(null)
      adapter.destroy?.()
      sessions.delete(editor)
    }
  }
}

/** The others in the document, with their selections here. */
export function getPeers(editor: Editor): Peer[] {
  return [...(sessions.get(editor)?.peers.values() ?? [])]
}

/** Follows someone: the view goes where their cursor goes (until you type, click or scroll). null stops. */
export function followPeer(editor: Editor, id: string | number | null): void {
  const s = sessions.get(editor)
  if (!s) return
  s.follow = id
  const head = id == null ? null : s.peers.get(id)?.head
  if (head) editor.scrollIntoView(head, true)
  renderAvatars(s)
}

/** Who is being followed (null: nobody). */
export function followedPeer(editor: Editor): string | number | null {
  return sessions.get(editor)?.follow ?? null
}

/** Changes your name, color or shared data for the others. */
export function setCollabUser(editor: Editor, user: CollabUser): void {
  const s = sessions.get(editor)
  if (!s) return
  s.user = { name: user.name || s.user.name, color: user.color || (user.name ? peerColor(user.name) : s.user.color), data: user.data ?? s.user.data }
  sendPresence(s)
}

const COLLAB_CSS = `
.jc-peer-sel{position:absolute;border-radius:2px;background:color-mix(in srgb,var(--jc-peer) 24%,transparent)}
.jc-peer-caret{position:absolute;left:0;top:0;width:2px;height:var(--jc-lh);margin-left:-1px;background:var(--jc-peer);transition:opacity .3s}
.jc-peer-caret::before{content:'';position:absolute;top:-3px;left:-2px;width:6px;height:6px;border-radius:50%;background:var(--jc-peer)}
.jc-peer-label{position:absolute;bottom:100%;left:-1px;margin-bottom:2px;padding:1px 6px;border-radius:4px 4px 4px 0;background:var(--jc-peer);color:#1b1d23;font:600 11px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;white-space:nowrap;opacity:0;transform:translateY(3px);transition:opacity .15s,transform .15s}
.jc-peer-show .jc-peer-label{opacity:1;transform:none}
.jc-peer-below .jc-peer-label{bottom:auto;top:100%;margin:2px 0 0;border-radius:0 4px 4px 4px}
.jc-peer-idle{opacity:.45}
.jc-collab-flash{border-radius:2px;background:color-mix(in srgb,var(--jc-caret) 32%,transparent);animation:jc-collab-flash 1.2s ease-out forwards}
@keyframes jc-collab-flash{to{background:transparent}}
.jc-collab-avatars{position:absolute;top:8px;right:18px;z-index:6;display:flex;align-items:center;gap:0;opacity:.6;transition:opacity .15s}
.jc-collab-avatars:hover,.jc-collab-avatars:focus-within{opacity:1}
.jc-collab-avatars button{width:26px;height:26px;margin-left:-5px;border-radius:50%;border:2px solid var(--jc-bg);padding:0;background:var(--jc-peer);color:#1b1d23;font:700 10px/1 system-ui,-apple-system,sans-serif;cursor:pointer;transition:transform .15s}
.jc-collab-avatars button:hover,.jc-collab-avatars button:focus-visible{transform:translateY(-2px);z-index:1}
.jc-collab-avatars .jc-following{box-shadow:0 0 0 2px var(--jc-peer)}
.jc-collab-avatars .jc-peer-idle{opacity:.5}
.jc-collab-more{margin-left:6px;font:600 11px/1 system-ui,sans-serif;color:var(--jc-fg);opacity:.7}
@media (prefers-reduced-motion:reduce){.jc-collab-flash{animation:none;background:none}.jc-peer-label,.jc-collab-avatars button{transition:none}}
@media (forced-colors:active){.jc-peer-caret,.jc-peer-caret::before{forced-color-adjust:none;background:Highlight}}
`
