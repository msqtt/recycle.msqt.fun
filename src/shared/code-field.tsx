import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import type { CompletionSource } from '@codemirror/autocomplete';

const neoTheme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: '#fff' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: '#FFF9E6', borderRight: '2px solid #111', color: '#111' },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 222, 89, 0.25)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 222, 89, 0.6)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(125, 211, 252, 0.5) !important' },
  '.cm-tooltip': { border: '2px solid #111', backgroundColor: '#fff', boxShadow: '3px 3px 0 #111' },
  '.cm-tooltip-autocomplete': { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#B8F53D', color: '#111' },
});

/** JSON / JS 代码输入：语法高亮 + context 变量补全（JSON 在 {{ 后触发，JS 在 context./inputs. 前缀触发） */
export function CodeField({ value, onChange, language = 'json', contextPaths = [], rows = 6, error }: {
  value: string;
  onChange: (text: string) => void;
  language?: 'json' | 'js';
  contextPaths?: string[];
  rows?: number;
  error?: boolean;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pathsRef = useRef(contextPaths);
  pathsRef.current = contextPaths;

  useEffect(() => {
    const completion: CompletionSource = (ctx) => {
      const paths = pathsRef.current;
      if (language === 'json') {
        const m = ctx.matchBefore(/\{\{[\w.]*/);
        if (!m) return null;
        const prefix = m.text.slice(2);
        const options = paths
          .filter((p) => p.startsWith(prefix))
          .map((p) => ({ label: p, type: 'variable', apply: `${p}}}` }));
        return options.length ? { from: m.from + 2, options, validFor: /^[\w.]*$/ } : null;
      }
      const m = ctx.matchBefore(/[\w$.]+/);
      if (!m) return null;
      const t = m.text;
      const relevant = t.startsWith('context') || t.startsWith('inputs')
        || 'context'.startsWith(t) || 'inputs'.startsWith(t);
      if (!relevant) return null;
      const options = paths.filter((p) => p.startsWith(t)).map((p) => ({ label: p, type: 'variable' }));
      return options.length ? { from: m.from, options, validFor: /^[\w$.]*$/ } : null;
    };
    const lang = language === 'json' ? json() : javascript();
    const view = new EditorView({
      parent: holder.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          lang,
          lang.language.data.of({ autocomplete: completion }),
          neoTheme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'data-codefield': language }),
          EditorView.theme({
            '&': { minHeight: `${rows * 19 + 8}px`, maxHeight: '360px' },
            '.cm-scroller': { overflow: 'auto' },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, rows]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={holder} className={`border-2 ${error ? 'border-punch' : 'border-ink'} bg-white [&_.cm-editor]:min-h-full`} />;
}