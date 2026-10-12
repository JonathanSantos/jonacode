/**
 * Vue 3 component.
 *
 * ```vue
 * <script setup>
 * import { ref } from 'vue'
 * import { CodeEditor } from 'jonacode/vue'
 * import { basicSetup } from 'jonacode'
 * import { javascript } from 'jonacode/languages/javascript'
 * const code = ref('const a = 1')
 * const extensions = basicSetup()
 * </script>
 *
 * <template>
 *   <CodeEditor v-model="code" :language="javascript" :extensions="extensions" style="height: 400px" />
 * </template>
 * ```
 */
import { defineComponent, h, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch, type PropType } from 'vue'
import { Editor, type EditorOptions, type Extension } from '../editor.ts'
import type { Language } from '../language/language.ts'
import type { Theme } from '../theme/theme.ts'

export const CodeEditor = defineComponent({
  name: 'JonacodeEditor',
  props: {
    modelValue: { type: String, default: undefined },
    language: { type: Object as PropType<Language>, default: undefined },
    theme: { type: Object as PropType<Theme>, default: undefined },
    extensions: { type: [Array, Function] as PropType<Extension>, default: undefined },
    readOnly: { type: Boolean, default: false },
    lineWrapping: { type: Boolean, default: false },
    tabSize: { type: Number, default: undefined },
    insertSpaces: { type: Boolean, default: true },
    placeholder: { type: String, default: undefined },
    minLines: { type: Number, default: undefined },
    maxLines: { type: Number, default: undefined },
    fontSize: { type: [Number, String], default: undefined },
    fontFamily: { type: String, default: undefined },
    lineHeight: { type: [Number, String], default: undefined },
    autofocus: { type: Boolean, default: false },
    /** Any other editor option. */
    options: { type: Object as PropType<Omit<EditorOptions, 'value' | 'onChange'>>, default: undefined },
  },
  emits: {
    'update:modelValue': (_value: string) => true,
    change: (_value: string) => true,
    ready: (_editor: Editor) => true,
  },
  setup(props, { emit, expose }) {
    const host = ref<HTMLDivElement>()
    const editor = shallowRef<Editor | null>(null)
    let lastValue: string | undefined

    const syncedOptions = () => ({
      language: props.language,
      theme: props.theme,
      readOnly: props.readOnly,
      lineWrapping: props.lineWrapping,
      tabSize: props.tabSize,
      insertSpaces: props.insertSpaces,
      placeholder: props.placeholder,
      minLines: props.minLines,
      maxLines: props.maxLines,
      fontSize: props.fontSize,
      fontFamily: props.fontFamily,
      lineHeight: props.lineHeight,
    })

    onMounted(() => {
      lastValue = props.modelValue ?? ''
      const instance = markRaw(new Editor(host.value!, {
        ...props.options,
        ...syncedOptions(),
        value: lastValue,
        autofocus: props.autofocus,
        extensions: props.extensions,
        onChange: (value, event) => {
          if (event.origin === 'setValue') return
          lastValue = value
          emit('update:modelValue', value)
          emit('change', value)
        },
      }))
      editor.value = instance
      emit('ready', instance)
    })

    onBeforeUnmount(() => {
      editor.value?.destroy()
      editor.value = null
    })

    watch(() => props.modelValue, (value) => {
      if (editor.value && value !== undefined && value !== lastValue) {
        lastValue = value
        if (value !== editor.value.getValue()) editor.value.setValue(value)
      }
    })
    watch(syncedOptions, (opts) => editor.value?.setOptions(opts))
    watch(() => props.extensions, (ext) => editor.value?.setExtensions(ext))

    expose({ editor })
    return () => h('div', { ref: host, style: { height: '100%' } })
  },
})

export default CodeEditor
