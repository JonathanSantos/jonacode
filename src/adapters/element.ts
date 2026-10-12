/**
 * `<jona-code>` custom element. Works anywhere: plain HTML, Angular, Svelte,
 * Vue, Solid… Nothing is registered until you call `defineJonacodeElement()`.
 *
 * ```html
 * <form>
 *   <label for="code">Código</label>
 *   <jona-code id="code" name="code" language="javascript" required lazy>
 *     const answer = 42
 *   </jona-code>
 * </form>
 * <script type="module">
 *   import { defineJonacodeElement, basicSetup } from 'jonacode/element'
 *   import { javascript } from 'jonacode/languages/javascript'
 *   defineJonacodeElement({ languages: [javascript], extensions: basicSetup() })
 * </script>
 * ```
 *
 * It's a form-associated element: with a `name` it's submitted with its form,
 * `form.reset()` restores the initial content, `required` takes part in
 * validation, a disabled `<fieldset>` makes it read-only and `<label for>`
 * focuses it. With `lazy` it shows a static highlight until the first click,
 * tap or focus (`lazy="visible"`: when it scrolls into view).
 */
import { Editor, type EditorOptions, type Extension } from '../editor.ts'
import { findLanguage, type Language } from '../language/language.ts'
import { lazyEditor, type LazyEditor } from '../lazy.ts'
import type { Theme } from '../theme/theme.ts'

export { basicSetup } from '../extensions/basic-setup.ts'

export interface ElementConfig {
  /** Tag name. Default `jona-code`. */
  tagName?: string
  /** Languages selectable with the `language` attribute (by name or alias). */
  languages?: readonly Language[]
  /** Themes selectable with the `theme` attribute (by name). */
  themes?: readonly Theme[]
  /** Default extensions of every element. */
  extensions?: Extension
  /** Default options of every element. */
  options?: Omit<EditorOptions, 'value' | 'extensions'>
}

export interface JonacodeElement extends HTMLElement {
  /** The editor instance (null until connected, or until a `lazy` element is activated). */
  readonly editor: Editor | null
  value: string
  /** The initial content, restored by `form.reset()`. */
  defaultValue: string
  language: Language | undefined
  theme: Theme | undefined
  extensions: Extension
  readOnly: boolean
  name: string
  required: boolean
  readonly form: HTMLFormElement | null
  readonly validity: ValidityState | undefined
  readonly validationMessage: string
  readonly willValidate: boolean
  checkValidity(): boolean
  reportValidity(): boolean
  setCustomValidity(message: string): void
}

const OBSERVED = ['language', 'theme', 'readonly', 'line-wrapping', 'placeholder', 'tab-size', 'font-size', 'min-lines', 'max-lines', 'required']
/** Documents at least this long refresh their form value lazily (a full `getValue()` per keystroke adds up). */
const BIG_DOC = 20000

/** Registers the custom element. Returns its class. */
export function defineJonacodeElement(config: ElementConfig = {}): CustomElementConstructor {
  const tag = config.tagName ?? 'jona-code'
  const existing = customElements.get(tag)
  if (existing) return existing

  const findLang = (name: string | null) => (name && config.languages ? findLanguage(config.languages, name) : undefined)
  const findTheme = (name: string | null) => (name ? config.themes?.find((t) => t.name === name) : undefined)

  class JonacodeEditorElement extends HTMLElement implements JonacodeElement {
    static observedAttributes = OBSERVED
    static formAssociated = true
    private _editor: Editor | null = null
    private _lazy: LazyEditor | null = null
    private _value: string | null = null
    private _default: string | null = null
    private _language: Language | undefined
    private _theme: Theme | undefined
    private _extensions: Extension = config.extensions
    private _readOnly: boolean | undefined
    private _disabled = false
    private _custom = ''
    private _internals: ElementInternals | null
    private _formTimer: ReturnType<typeof setTimeout> | null = null

    constructor() {
      super()
      this._internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null
    }

    get editor(): Editor | null {
      return this._editor
    }

    get value(): string {
      return this._editor ? this._editor.getValue() : (this._value ?? (this.isConnected ? readInitialContent(this) : ''))
    }

    set value(v: string) {
      if (this._editor) this._editor.setValue(v)
      else {
        this._value = v
        this.syncForm()
      }
    }

    get defaultValue(): string {
      return this._default ?? readInitialContent(this)
    }

    set defaultValue(v: string) {
      this._default = v
    }

    get language(): Language | undefined {
      return this._language ?? findLang(this.getAttribute('language'))
    }

    set language(lang: Language | undefined) {
      this._language = lang
      this._editor?.setOptions({ language: lang })
    }

    get theme(): Theme | undefined {
      return this._theme ?? findTheme(this.getAttribute('theme'))
    }

    set theme(theme: Theme | undefined) {
      this._theme = theme
      if (theme) this._editor?.setOptions({ theme })
    }

    get extensions(): Extension {
      return this._extensions
    }

    set extensions(ext: Extension) {
      this._extensions = ext
      this._editor?.setExtensions(ext)
    }

    get readOnly(): boolean {
      return this._readOnly ?? this.hasAttribute('readonly')
    }

    set readOnly(v: boolean) {
      this._readOnly = v
      this._editor?.setOptions({ readOnly: v || this._disabled })
    }

    // ------------------------------------------------------------------ form association

    get name(): string {
      return this.getAttribute('name') ?? ''
    }

    set name(v: string) {
      this.setAttribute('name', v)
    }

    get required(): boolean {
      return this.hasAttribute('required')
    }

    set required(v: boolean) {
      this.toggleAttribute('required', v)
    }

    get form(): HTMLFormElement | null {
      return this._internals?.form ?? null
    }

    get validity(): ValidityState | undefined {
      return this._internals?.validity
    }

    get validationMessage(): string {
      return this._internals?.validationMessage ?? ''
    }

    get willValidate(): boolean {
      return this._internals?.willValidate ?? false
    }

    checkValidity(): boolean {
      return this._internals?.checkValidity() ?? true
    }

    reportValidity(): boolean {
      return this._internals?.reportValidity() ?? true
    }

    setCustomValidity(message: string): void {
      this._custom = message
      this.syncValidity()
    }

    formResetCallback(): void {
      this.value = this.defaultValue
    }

    formDisabledCallback(disabled: boolean): void {
      this._disabled = disabled
      this.toggleAttribute('aria-disabled', disabled)
      this._editor?.setOptions({ readOnly: disabled || this.readOnly })
    }

    formStateRestoreCallback(state: string | File | FormData | null): void {
      if (typeof state === 'string') this.value = state
    }

    private isEmpty(): boolean {
      const doc = this._editor?.doc
      return doc ? doc.lineCount === 1 && !doc.line(0) : !this.value
    }

    private syncValidity(): void {
      const internals = this._internals
      if (!internals) return
      const anchor = this._editor?.inputDOM
      if (this._custom) internals.setValidity({ customError: true }, this._custom, anchor)
      else if (this.required && this.isEmpty()) {
        internals.setValidity({ valueMissing: true }, this._editor?.phrase('Please fill out this field.') ?? 'Please fill out this field.', anchor)
      } else internals.setValidity({})
    }

    /** Pushes the value to the form (lazily for huge documents) and revalidates. */
    private syncForm(): void {
      const internals = this._internals
      if (!internals) return
      if (this._formTimer) clearTimeout(this._formTimer)
      this._formTimer = null
      if ((this._editor?.doc.lineCount ?? 0) < BIG_DOC) internals.setFormValue(this.value)
      else this._formTimer = setTimeout(() => internals.setFormValue(this.value), 300)
      this.syncValidity()
    }

    // ------------------------------------------------------------------ lifecycle

    connectedCallback(): void {
      if (this._editor || this._lazy) return
      if (this._default == null) this._default = readInitialContent(this)
      const root = this.shadowRoot ?? this.attachShadow({ mode: 'open', delegatesFocus: true })
      root.innerHTML = '<style>:host{display:block;position:relative;overflow:hidden}.host{height:100%}</style>'
      const container = document.createElement('div')
      container.className = 'host'
      root.appendChild(container)
      const tabSize = this.getAttribute('tab-size')
      const fontSize = this.getAttribute('font-size')
      const minLines = this.getAttribute('min-lines')
      const maxLines = this.getAttribute('max-lines')
      // A <label for> names the editor for screen readers.
      const label = this.getAttribute('aria-label') ?? [...(this._internals?.labels ?? [])].map((l) => l.textContent?.trim()).filter(Boolean).join(' ')
      const options: EditorOptions = {
        ...config.options,
        value: this._value ?? this._default,
        language: this.language ?? config.options?.language,
        theme: this.theme ?? config.options?.theme,
        readOnly: this.readOnly || this._disabled,
        lineWrapping: this.hasAttribute('line-wrapping') || config.options?.lineWrapping,
        placeholder: this.getAttribute('placeholder') ?? config.options?.placeholder,
        tabSize: tabSize ? Number(tabSize) : config.options?.tabSize,
        fontSize: fontSize ? Number(fontSize) || fontSize : config.options?.fontSize,
        minLines: minLines ? Number(minLines) : config.options?.minLines,
        maxLines: maxLines ? Number(maxLines) : config.options?.maxLines,
        ariaLabel: label || config.options?.ariaLabel,
        extensions: this._extensions,
      }
      this.syncForm()
      const lazy = this.getAttribute('lazy')
      if (lazy != null) {
        this._lazy = lazyEditor(container, { ...options, on: lazy === 'visible' ? 'visible' : lazy === 'idle' ? 'idle' : 'interaction' })
        this._lazy.ready.then((editor) => this.attach(editor))
      } else this.attach(new Editor(container, options))
    }

    private attach(editor: Editor): void {
      this._editor = editor
      this._lazy = null
      editor.on('change', (event) => {
        const onChange = config.options?.onChange
        if (onChange) onChange(editor.getValue(), event)
        this.syncForm()
        // `detail.value` is computed on demand: huge documents don't pay for it on every keystroke.
        const detail = { event, get value() { return editor.getValue() } }
        this.dispatchEvent(new CustomEvent('change', { detail, bubbles: true, composed: true }))
      })
      this.syncValidity()
      this.dispatchEvent(new CustomEvent('ready', { detail: { editor }, bubbles: true, composed: true }))
    }

    disconnectedCallback(): void {
      // Keep the content if the element is moved around the DOM.
      if (this._editor) {
        this._value = this._editor.getValue()
        this._editor.destroy()
        this._editor = null
      }
      this._lazy?.destroy()
      this._lazy = null
      if (this._formTimer) clearTimeout(this._formTimer)
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
      if (name === 'required') return this.syncValidity()
      const ed = this._editor
      if (!ed) return
      if (name === 'language' && !this._language) ed.setOptions({ language: findLang(value) })
      else if (name === 'theme' && !this._theme) {
        const theme = findTheme(value)
        if (theme) ed.setOptions({ theme })
      } else if (name === 'readonly' && this._readOnly == null) ed.setOptions({ readOnly: value != null || this._disabled })
      else if (name === 'line-wrapping') ed.setOptions({ lineWrapping: value != null })
      else if (name === 'placeholder') ed.setOptions({ placeholder: value ?? '' })
      else if (name === 'tab-size' && value) ed.setOptions({ tabSize: Number(value) })
      else if (name === 'font-size' && value) ed.setOptions({ fontSize: Number(value) || value })
      else if (name === 'min-lines' || name === 'max-lines') ed.setOptions({ [name === 'min-lines' ? 'minLines' : 'maxLines']: Number(value) || 0 })
    }

    override focus(options?: FocusOptions): void {
      if (this._lazy) this._lazy.activate()
      if (this._editor) this._editor.focus()
      else super.focus(options)
    }
  }

  customElements.define(tag, JonacodeEditorElement)
  return JonacodeEditorElement
}

/** Initial content from a `<template>`/`<script type="text/plain">` child or the text content, dedented. */
function readInitialContent(el: HTMLElement): string {
  const tpl = el.querySelector('template, script[type="text/plain"]')
  let raw = el.textContent ?? ''
  if (tpl instanceof HTMLTemplateElement) {
    // Serialize back to markup, then decode entities (`a &lt; b` → `a < b`).
    const decoder = document.createElement('textarea')
    decoder.innerHTML = tpl.innerHTML
    raw = decoder.value
  } else if (tpl) raw = tpl.textContent ?? ''
  const lines = raw.replace(/^\s*\n/, '').replace(/\n\s*$/, '').split('\n')
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length))
  return (Number.isFinite(indent) && indent > 0 ? lines.map((l) => l.slice(indent)) : lines).join('\n')
}
