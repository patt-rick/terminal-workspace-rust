import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Theme } from '../themes'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { markdown } from '@codemirror/lang-markdown'

const MONO =
  '"MesloLGS NF", "JetBrainsMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export function languageForPath(path: string): Extension | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true })
    case 'ts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'html':
    case 'htm':
      return html()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'py':
      return python()
    case 'rs':
      return rust()
    case 'go':
      return go()
    case 'sql':
      return sql()
    case 'xml':
    case 'svg':
      return xml()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'md':
    case 'markdown':
      return markdown()
    default:
      return null
  }
}

/**
 * A CodeMirror theme + syntax highlight derived from the active theme object.
 * Reads colors from the theme directly (not the DOM) so the editor always
 * matches the rest of the UI on a theme switch.
 */
export function editorTheme(theme: Theme): Extension {
  const { chrome, syntax, terminal } = theme
  const dark = theme.meta.appearance === 'dark'

  const view = EditorView.theme(
    {
      '&': { color: chrome.foreground, backgroundColor: chrome.background, height: '100%' },
      '.cm-scroller': { fontFamily: MONO, fontSize: '13px', lineHeight: '1.5' },
      '.cm-content': { caretColor: chrome.accent },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: chrome.accent },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: terminal.selection,
      },
      '.cm-gutters': { backgroundColor: chrome.background, color: chrome.muted, border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(127,127,127,0.08)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: chrome.foreground },
      '.cm-selectionMatch': { backgroundColor: 'rgba(127,127,127,0.18)' },
    },
    { dark }
  )

  const highlight = HighlightStyle.define([
    { tag: t.comment, color: syntax.comment, fontStyle: 'italic' },
    { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: syntax.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: syntax.string },
    { tag: [t.number, t.bool, t.null, t.atom], color: syntax.number },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: syntax.function },
    { tag: [t.variableName, t.propertyName], color: syntax.variable },
    { tag: [t.typeName, t.className, t.namespace], color: syntax.type },
    { tag: [t.constant(t.variableName)], color: syntax.constant },
    { tag: [t.operator, t.punctuation, t.separator], color: syntax.operator },
    { tag: [t.tagName], color: syntax.tag },
    { tag: [t.attributeName], color: syntax.attribute },
    { tag: [t.heading], color: syntax.heading, fontWeight: 'bold' },
    { tag: [t.link, t.url], color: syntax.link, textDecoration: 'underline' },
  ])

  return [view, syntaxHighlighting(highlight)]
}
