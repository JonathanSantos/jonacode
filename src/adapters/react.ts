/**
 * React component.
 *
 * ```tsx
 * import { CodeEditor } from 'jonacode/react'
 * import { basicSetup } from 'jonacode'
 * import { javascript } from 'jonacode/languages/javascript'
 *
 * const extensions = basicSetup()
 *
 * function App() {
 *   const [code, setCode] = useState('const a = 1')
 *   return <CodeEditor value={code} onChange={setCode} language={javascript} extensions={extensions} style={{ height: 400 }} />
 * }
 * ```
 */
import {
  createElement, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef,
  type CSSProperties, type ForwardedRef, type ReactElement, type RefAttributes,
} from 'react'
import { Editor, type ChangeEvent, type EditorOptions } from '../editor.ts'

export interface CodeEditorProps extends Omit<EditorOptions, 'value' | 'onChange' | 'className'> {
  /** Controlled value. */
  value?: string
  /** Initial value when uncontrolled. */
  defaultValue?: string
  onChange?: (value: string, event: ChangeEvent) => void
  /** Called once the editor is created. */
  onReady?: (editor: Editor) => void
  className?: string
  style?: CSSProperties
}

function CodeEditorImpl(props: CodeEditorProps, ref: ForwardedRef<Editor | null>): ReactElement {
  const { value, defaultValue, onChange, onReady, className, style, extensions, ...options } = props
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const lastValue = useRef<string | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useImperativeHandle(ref, () => editorRef.current!, [])

  useLayoutEffect(() => {
    const initial = value ?? defaultValue ?? ''
    lastValue.current = initial
    const editor = new Editor(host.current!, {
      ...options,
      value: initial,
      extensions,
      onChange: (v, event) => {
        if (event.origin === 'setValue') return
        lastValue.current = v
        onChangeRef.current?.(v, event)
      },
    })
    editorRef.current = editor
    onReady?.(editor)
    return () => {
      editor.destroy()
      editorRef.current = null
    }
    // The editor is created once; props are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (editor && value !== undefined && value !== lastValue.current) {
      lastValue.current = value
      if (value !== editor.getValue()) editor.setValue(value)
    }
  }, [value])

  const { language, theme, readOnly, lineWrapping, tabSize, insertSpaces, placeholder, fontSize, fontFamily, lineHeight, minLines, maxLines } = options
  useEffect(() => {
    editorRef.current?.setOptions({ language, theme, readOnly, lineWrapping, tabSize, insertSpaces, placeholder, fontSize, fontFamily, lineHeight, minLines, maxLines })
  }, [language, theme, readOnly, lineWrapping, tabSize, insertSpaces, placeholder, fontSize, fontFamily, lineHeight, minLines, maxLines])

  const firstExtensions = useRef(true)
  useEffect(() => {
    if (firstExtensions.current) {
      firstExtensions.current = false
      return
    }
    editorRef.current?.setExtensions(extensions)
  }, [extensions])

  return createElement('div', { ref: host, className, style: { height: '100%', ...style } })
}

/**
 * Tip: keep `extensions` stable (define them outside the component or with
 * `useMemo`): a new array reinstalls them.
 */
export const CodeEditor = forwardRef(CodeEditorImpl) as (
  props: CodeEditorProps & RefAttributes<Editor | null>,
) => ReactElement
