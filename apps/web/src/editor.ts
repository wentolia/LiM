import { EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";

const LINK = /\[\[([^\[\]\n|]+?)(\|[^\[\]\n]*)?\]\]/g;
const TAG = /(^|[\s(])#([^\s#\[\](),.、。!?！？]+)/gu;
const hidden = Decoration.replace({});

export interface LinkHandlers {
  open: (title: string) => void;
  exists: (title: string) => boolean;
}

/**
 * Cosense 風のライブプレビュー。カーソルのない行では [[ ]] を隠してリンクとして見せ、
 * カーソル行だけ記法をそのまま見せる。
 */
function livePreview(h: LinkHandlers): Extension {
  const build = (view: EditorView): DecorationSet => {
    const active = new Set<number>();
    // フォーカスがない時はすべての行をプレビュー表示にする
    for (const r of view.hasFocus ? view.state.selection.ranges : []) {
      const a = view.state.doc.lineAt(r.from).number;
      const b = view.state.doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) active.add(n);
    }
    const decos: { from: number; to: number; value: Decoration }[] = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = view.state.doc.lineAt(pos);
        const isActive = active.has(line.number);
        for (const m of line.text.matchAll(LINK)) {
          const start = line.from + m.index!;
          const name = m[1];
          const end = start + m[0].length;
          if (isActive) {
            decos.push({ from: start, to: end, value: Decoration.mark({ class: "cm-lim-raw" }) });
            continue;
          }
          const cls = h.exists(name.trim()) ? "cm-lim-link" : "cm-lim-link cm-lim-missing";
          decos.push({ from: start, to: start + 2, value: hidden });
          decos.push({
            from: start + 2,
            to: start + 2 + name.length,
            value: Decoration.mark({ class: cls, attributes: { "data-title": name.trim() } }),
          });
          decos.push({ from: start + 2 + name.length, to: end, value: hidden });
        }
        if (!isActive) {
          for (const m of line.text.matchAll(TAG)) {
            const start = line.from + m.index! + m[1].length;
            decos.push({
              from: start,
              to: start + 1 + m[2].length,
              value: Decoration.mark({ class: "cm-lim-tag", attributes: { "data-title": m[2] } }),
            });
          }
        }
        pos = line.to + 1;
      }
    }
    decos.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(decos.map((d) => d.value.range(d.from, d.to)), true);
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

const theme = EditorView.theme({
  "&": { fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "'BIZ UDGothic', sans-serif", lineHeight: "1.85", padding: "0" },
  ".cm-line": { padding: "0 4px" },
  ".cm-activeLine": { backgroundColor: "#EDEFEE" },
  ".cm-cursor": { borderLeftColor: "#111111", borderLeftWidth: "2px" },
  ".cm-lim-link": { color: "#0B4F8A", textDecoration: "underline", cursor: "pointer" },
  ".cm-lim-missing": { color: "#9A3412", textDecorationStyle: "dashed" },
  ".cm-lim-tag": { color: "#0B4F8A", cursor: "pointer" },
  ".cm-lim-raw": { fontFamily: "'IBM Plex Mono', 'BIZ UDGothic', monospace", fontSize: "13px" },
});

export function createEditor(
  parent: HTMLElement,
  doc: string,
  onChange: (text: string) => void,
  handlers: LinkHandlers,
): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([
          { key: "Tab", run: indentMore },
          { key: "Shift-Tab", run: indentLess },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        livePreview(handlers),
        theme,
        EditorView.domEventHandlers({
          mousedown(e) {
            const el = (e.target as HTMLElement).closest<HTMLElement>("[data-title]");
            if (!el?.dataset.title) return false;
            e.preventDefault();
            handlers.open(el.dataset.title);
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
}
