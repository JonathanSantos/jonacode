/**
 * What a collaboration backend has to provide. Yjs has an adapter ready
 * (`yjs()`); your own server (OT, a CRDT, a relay) fits by implementing this.
 * Texts are one string with `\n` line breaks; offsets count UTF-16 units.
 */

/** A local change: replace `remove` chars at `at` with `insert`. A list is applied in order (each in the text the previous left). */
export interface TextOp {
  at: number
  remove: number
  insert: string
}

/** Remote changes as a delta over the text before them, left to right (the Yjs and Quill format). */
export type TextDelta = readonly ({ retain: number } | { insert: string } | { delete: number })[]

/** Where the change came from: someone else, or the backend's own undo / redo of local changes. */
export type RemoteOrigin = 'remote' | 'undo' | 'redo'

/** Another person in the document, as the backend reports it. */
export interface PeerState {
  id: string | number
  name?: string
  color?: string
  /** Selection in offsets; null when they have no cursor in this text (another file, or only watching). */
  anchor: number | null
  head: number | null
  /** Anything else they share (avatar, role…). */
  data?: Record<string, unknown>
}

/** The local user and selection, sent to the others. */
export interface LocalPresence {
  name: string
  color: string
  anchor: number
  head: number
  data?: Record<string, unknown>
}

export interface CollabAdapter {
  /** The shared text now. */
  text(): string
  /** Sends local changes. */
  send(ops: readonly TextOp[]): void
  /** Listens to changes made elsewhere. Returns a function that stops listening. */
  receive(listener: (delta: TextDelta, origin: RemoteOrigin) => void): () => void
  /** Publishes the local user and selection (null: gone). Optional: without it there's no presence. */
  setPresence?(presence: LocalPresence | null): void
  /** Listens to the others' presence. */
  peers?(listener: (peers: readonly PeerState[]) => void): () => void
  /** Undo / redo of the local user's changes, when the backend keeps that history (Yjs' UndoManager). */
  undo?(): boolean
  redo?(): boolean
  canUndo?(): boolean
  canRedo?(): boolean
  destroy?(): void
}
