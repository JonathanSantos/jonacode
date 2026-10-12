/**
 * Static analysis of a regex source: which ASCII chars can start a match?
 * Lets the tokenizer skip rules that cannot match at the current char,
 * instead of running every regex of the state. Returns null when unsure
 * (the rule is then always tried), so the result is always safe.
 */

/** Index right after the atom starting at `i`. */
function atomEnd(src: string, i: number): number {
  const c = src[i]
  if (c === '\\') {
    const n = src[i + 1]
    if ((n === 'u' || n === 'p' || n === 'P' || n === 'k') && (src[i + 2] === '{' || src[i + 2] === '<')) {
      return src.indexOf(src[i + 2] === '{' ? '}' : '>', i) + 1
    }
    if (n === 'u') return i + 6
    if (n === 'x') return i + 4
    if (n === 'c') return i + 3
    return i + 2
  }
  if (c === '[') {
    let j = i + 1
    if (src[j] === '^') j++
    if (src[j] === ']') j++
    for (; j < src.length; j++) {
      if (src[j] === '\\') j++
      else if (src[j] === ']') return j + 1
    }
    return src.length
  }
  if (c === '(') return groupEnd(src, i) + 1
  const code = src.charCodeAt(i)
  return code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1
}

/** Index of the `)` closing the group opened at `i`. */
function groupEnd(src: string, i: number): number {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') j++
    else if (c === '[') j = atomEnd(src, j) - 1
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return src.length
}

function splitAlternatives(src: string): string[] {
  const out: string[] = []
  let start = 0
  let depth = 0
  for (let j = 0; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') j++
    else if (c === '[') j = atomEnd(src, j) - 1
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '|' && depth === 0) {
      out.push(src.slice(start, j))
      start = j + 1
    }
  }
  out.push(src.slice(start))
  return out
}

function firstOfSequence(seq: string, flags: string): Uint8Array | null {
  let i = 0
  // Zero-width assertions at the start don't consume a char.
  for (;;) {
    if (seq[i] === '^') i++
    else if (seq.startsWith('\\b', i) || seq.startsWith('\\B', i)) i += 2
    else if (seq.startsWith('(?<=', i) || seq.startsWith('(?<!', i)) i = groupEnd(seq, i) + 1
    else break
  }
  if (i >= seq.length) return null
  const end = atomEnd(seq, i)
  const atom = seq.slice(i, end)
  const q = seq[end]
  if (q === '?' || q === '*' || (q === '{' && /^\{0\s*[,}]/.test(seq.slice(end)))) return null // optional
  if (atom === '$' || atom === '.' || /^\\[1-9k]/.test(atom)) return null
  if (atom.startsWith('(')) {
    if (atom.startsWith('(?=') || atom.startsWith('(?!')) return null
    const inner = atom.startsWith('(?:') ? atom.slice(3, -1)
      : atom.startsWith('(?<') ? atom.slice(atom.indexOf('>') + 1, -1)
      : atom.slice(1, -1)
    return firstChars(inner, flags)
  }
  let test: RegExp
  try {
    test = new RegExp(`^(?:${atom})$`, flags.replace(/[gyd]/g, ''))
  } catch {
    return null
  }
  const set = new Uint8Array(128)
  for (let c = 0; c < 128; c++) if (test.test(String.fromCharCode(c))) set[c] = 1
  return set
}

export function firstChars(source: string, flags: string): Uint8Array | null {
  const set = new Uint8Array(128)
  for (const alt of splitAlternatives(source)) {
    const part = firstOfSequence(alt, flags)
    if (!part) return null
    for (let c = 0; c < 128; c++) if (part[c]) set[c] = 1
  }
  return set
}
