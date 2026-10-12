/**
 * The parts of `web-tree-sitter` (0.25+) this module uses, as structural
 * types: Jonacode never imports it, so it stays free of dependencies and works
 * with whatever copy (and version) the app loads.
 */

export interface TSPoint {
  row: number
  column: number
}

export interface TSRange {
  startIndex: number
  endIndex: number
  startPosition: TSPoint
  endPosition: TSPoint
}

export interface TSEdit {
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
  startPosition: TSPoint
  oldEndPosition: TSPoint
  newEndPosition: TSPoint
}

export interface TSNode {
  readonly type: string
  readonly text: string
  readonly isNamed: boolean
  readonly isError: boolean
  readonly isMissing: boolean
  readonly hasError: boolean
  readonly startIndex: number
  readonly endIndex: number
  readonly startPosition: TSPoint
  readonly endPosition: TSPoint
  readonly parent: TSNode | null
  readonly children: (TSNode | null)[]
  readonly childCount: number
  child(index: number): TSNode | null
  descendantForPosition(start: TSPoint, end?: TSPoint): TSNode | null
  descendantsOfType(types: string | string[], start?: TSPoint, end?: TSPoint): (TSNode | null)[]
}

export interface TSTree {
  readonly rootNode: TSNode
  edit(edit: TSEdit): void
  delete(): void
}

export interface TSLanguage {
  readonly name?: string | null
}

export interface TSParseOptions {
  includedRanges?: TSRange[]
  progressCallback?: (state: { currentOffset: number; hasError: boolean }) => boolean | void
}

export interface TSParser {
  setLanguage(language: TSLanguage | null): unknown
  parse(input: string | ((index: number, position: TSPoint) => string | null | undefined), oldTree?: TSTree | null, options?: TSParseOptions): TSTree | null
  reset(): void
  delete(): void
}

/** What `import('web-tree-sitter')` gives. */
export interface TreeSitterModule {
  Parser: {
    new (): TSParser
    init(options?: { locateFile?: (file: string, prefix: string) => string }): Promise<void>
  }
  Language: {
    load(input: string | URL | Uint8Array): Promise<TSLanguage>
  }
}
