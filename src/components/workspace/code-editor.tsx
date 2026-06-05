import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { languageForPath, editorTheme } from '../../lib/codemirror'
import { useActiveTheme } from '../../themes/theme-provider'

interface Props {
  /** initial content; the editor rebuilds when the file/settings change */
  value: string
  path: string
  fontSize: number
  tabSize: number
  wordWrap: boolean
  showLineNumbers: boolean
  onChange: (value: string) => void
  onSave: () => void
}

export function CodeEditor({
  value,
  path,
  fontSize,
  tabSize,
  wordWrap,
  showLineNumbers,
  onChange,
  onSave,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const theme = useActiveTheme()
  const themeRef = useRef(theme)
  themeRef.current = theme

  useEffect(() => {
    if (!hostRef.current) return
    const lang = languageForPath(path)
    const indent = ' '.repeat(Math.max(1, tabSize))
    const state = EditorState.create({
      doc: value,
      extensions: [
        ...(showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
        history(),
        drawSelection(),
        indentOnInput(),
        indentUnit.of(indent),
        EditorState.tabSize.of(tabSize),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        ...(wordWrap ? [EditorView.lineWrapping] : []),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (onSaveRef.current(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        ...(lang ? [lang] : []),
        editorTheme(themeRef.current),
        EditorView.theme({ '.cm-scroller': { fontSize: `${fontSize}px` } }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    view.focus()
    return () => view.destroy()
    // value is read fresh on each rebuild; the parent keys this by file + theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, fontSize, tabSize, wordWrap, showLineNumbers])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}
