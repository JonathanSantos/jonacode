/**
 * Collaboration over Yjs: pass `Y` (the module), a `Y.Text` and, for
 * presence, the provider's `awareness`. Works with any Yjs provider
 * (y-websocket, Hocuspocus, y-webrtc, Liveblocks, PartyKit…), and the
 * cursors are compatible with y-codemirror / y-monaco (same `user` and
 * `cursor` fields). Undo uses `Y.UndoManager`, so it only undoes your
 * changes. Jonacode never imports Yjs: these are structural types.
 *
 * ```ts
 * import * as Y from 'yjs'
 * import { WebsocketProvider } from 'y-websocket'
 *
 * const doc = new Y.Doc()
 * const provider = new WebsocketProvider(url, 'sala', doc)
 * collab(yjs({ Y, text: doc.getText('codigo'), awareness: provider.awareness }), { user: { name: 'Ana' } })
 * ```
 */
import type { CollabAdapter, LocalPresence, PeerState, RemoteOrigin, TextDelta, TextOp } from './types.ts'

export interface YDoc {
  transact(fn: () => void, origin?: unknown): void
}

/** An op of a Yjs delta (inserts are strings for text; embeds are ignored). */
export interface YDeltaOp {
  insert?: unknown
  delete?: number
  retain?: number
}

export interface YText {
  readonly doc: YDoc | null
  readonly length: number
  toString(): string
  insert(index: number, text: string): void
  delete(index: number, length: number): void
  observe(fn: (event: { delta: YDeltaOp[] }, transaction: { origin: unknown }) => void): void
  unobserve(fn: (event: { delta: YDeltaOp[] }, transaction: { origin: unknown }) => void): void
}

export interface YUndoManager {
  undo(): unknown
  redo(): unknown
  undoStack: readonly unknown[]
  redoStack: readonly unknown[]
  undoing?: boolean
  redoing?: boolean
  destroy(): void
}

/**
 * The parts of the `yjs` module used here (`import * as Y from 'yjs'`). The
 * parameters are loose on purpose: Yjs' own types (AbstractType, Doc…) must fit.
 */
export interface YModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UndoManager: new (type: any, options?: any) => YUndoManager
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRelativePositionFromTypeIndex(type: any, index: number, assoc?: number): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRelativePositionFromJSON(json: any): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createAbsolutePositionFromRelativePosition(rel: any, doc: any): { type: unknown; index: number } | null
}

/** y-protocols' Awareness (e.g. `provider.awareness`). */
export interface YAwareness {
  readonly clientID: number
  getLocalState(): Record<string, unknown> | null
  setLocalStateField(field: string, value: unknown): void
  getStates(): Map<number, Record<string, unknown>>
  on(event: 'change', fn: () => void): void
  off(event: 'change', fn: () => void): void
}

export interface YjsOptions {
  /** `import * as Y from 'yjs'`. */
  Y: YModule
  /** The shared text of this editor (`doc.getText('name')`); one per file for several files. */
  text: YText
  /** Presence (cursors, names): the provider's `awareness`. */
  awareness?: YAwareness
  /** Undo only your changes with `Y.UndoManager` (default true); a number sets how long typing merges into one step (ms). */
  undo?: boolean | number
}

/** Lighter color for selections, like y-codemirror's `colorLight`. */
const light = (color: string) => (/^#[\da-f]{6}$/i.test(color) ? color + '33' : color)

export function yjs(options: YjsOptions): CollabAdapter {
  const { Y, text, awareness } = options
  const doc = text.doc
  if (!doc) throw new Error('[jonacode] yjs(): the Y.Text must belong to a Y.Doc')
  /** Marks the local transactions (their echoes are ignored, and the undo manager tracks only them). */
  const origin = {}
  const undo = options.undo === false ? null : new Y.UndoManager(text, {
    trackedOrigins: new Set([origin]),
    captureTimeout: typeof options.undo === 'number' ? options.undo : 600,
  })
  const peerListeners = new Set<(peers: readonly PeerState[]) => void>()

  const absolute = (rel: unknown): number | null => {
    if (!rel) return null
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc)
    return abs && abs.type === text ? abs.index : null
  }
  const peers = (): PeerState[] => {
    if (!awareness) return []
    const out: PeerState[] = []
    for (const [id, state] of awareness.getStates()) {
      if (id === awareness.clientID || !state) continue
      const user = (state.user ?? {}) as { name?: string; color?: string; [key: string]: unknown }
      const cursor = state.cursor as { anchor?: unknown; head?: unknown } | null | undefined
      const { name, color, colorLight: _light, ...data } = user
      out.push({ id, name, color, anchor: absolute(cursor?.anchor), head: absolute(cursor?.head), data })
    }
    return out
  }
  const emitPeers = () => {
    if (!peerListeners.size) return
    const list = peers()
    for (const fn of peerListeners) fn(list)
  }
  awareness?.on('change', emitPeers)

  return {
    text: () => text.toString(),
    send(ops: readonly TextOp[]) {
      doc.transact(() => {
        for (const op of ops) {
          if (op.remove) text.delete(op.at, op.remove)
          if (op.insert) text.insert(op.at, op.insert)
        }
      }, origin)
      // Relative positions of the others resolve differently now.
      emitPeers()
    },
    receive(listener: (delta: TextDelta, origin: RemoteOrigin) => void) {
      const observer = (event: { delta: YDeltaOp[] }, tr: { origin: unknown }) => {
        if (tr.origin === origin) return
        const delta: TextDelta = event.delta.map((op) =>
          op.retain != null ? { retain: op.retain } : op.delete != null ? { delete: op.delete } : { insert: typeof op.insert === 'string' ? op.insert : '' })
        listener(delta, tr.origin === undo && undo ? (undo.redoing ? 'redo' : 'undo') : 'remote')
        emitPeers()
      }
      text.observe(observer)
      return () => text.unobserve(observer)
    },
    setPresence(p: LocalPresence | null) {
      if (!awareness) return
      if (!p) return void awareness.setLocalStateField('cursor', null)
      awareness.setLocalStateField('user', { name: p.name, color: p.color, colorLight: light(p.color), ...p.data })
      awareness.setLocalStateField('cursor', {
        anchor: Y.createRelativePositionFromTypeIndex(text, p.anchor),
        head: Y.createRelativePositionFromTypeIndex(text, p.head),
      })
    },
    peers(listener) {
      peerListeners.add(listener)
      listener(peers())
      return () => peerListeners.delete(listener)
    },
    ...(undo && {
      undo: () => undo.undo() != null,
      redo: () => undo.redo() != null,
      canUndo: () => undo.undoStack.length > 0,
      canRedo: () => undo.redoStack.length > 0,
    }),
    destroy() {
      awareness?.off('change', emitPeers)
      if (awareness) awareness.setLocalStateField('cursor', null)
      undo?.destroy()
    },
  }
}
