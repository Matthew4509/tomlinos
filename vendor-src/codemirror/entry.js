// Everything Notepad Pro takes from CodeMirror 6 (MIT, Marijn Haverbeke and others), in one module.
export { EditorState, Compartment, StateField, StateEffect, EditorSelection, RangeSet, RangeSetBuilder } from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightWhitespace, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, gutter, GutterMarker, Decoration, ViewPlugin,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll } from '@codemirror/commands';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel, SearchQuery, setSearchQuery, gotoLine, findNext, findPrevious, replaceAll } from '@codemirror/search';
export { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, StreamLanguage, indentUnit } from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { tags } from '@lezer/highlight';
export { javascript } from '@codemirror/lang-javascript';
export { json } from '@codemirror/lang-json';
export { html } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { markdown } from '@codemirror/lang-markdown';
export { python } from '@codemirror/lang-python';
export { php } from '@codemirror/lang-php';
export { sql } from '@codemirror/lang-sql';
export { xml } from '@codemirror/lang-xml';
export { yaml } from '@codemirror/lang-yaml';
export { gas } from '@codemirror/legacy-modes/mode/gas';
export { shell } from '@codemirror/legacy-modes/mode/shell';
export { properties } from '@codemirror/legacy-modes/mode/properties';
export { parser as markdownParser, GFM } from '@lezer/markdown';
