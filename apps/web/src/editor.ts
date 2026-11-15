import { Annotation, EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";

const LINK = /\[\[([^\[\]\n|]+?)(\|[^\[\]\n]*)?\]\]/g;
const TAG = /(^|[\s(])#([^\s#\[\](),.、。!?！？]+)/gu;
const IMAGE_LINE = /^(\s*)!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const hidden = Decoration.replace({});

export interface LinkHandlers {
  open: (title: string) => void;
  exists: (title: string) => boolean;
  /** 画像パス（../assets/x.png）を表示用 URL にする */
  resolve?: (src: string) => string;
  /** 貼り付け・ドロップされた画像を保存し、ページに書くパスを返す（無ければ画像は貼れない） */
  upload?: (file: File) => Promise<string>;
  onUploadError?: (message: string) => void;
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-lim-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    return img;
  }
}

/** 外から本文を差し替えたことを示す（保存のきっかけにしない） */
export const remoteChange = Annotation.define<boolean>();

/** 本文を差し替える。前後の共通部分は残すので、カーソル位置がずれにくい */
export function replaceText(view: EditorView, next: string): void {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let a = 0;
  while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  view.dispatch({
    changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) },
    annotations: remoteChange.of(true),
  });
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
        const img = !isActive && line.text.match(IMAGE_LINE);
        if (img) {
          const src = h.resolve ? h.resolve(img[3]) : img[3];
          decos.push({ from: line.from, to: line.to, value: Decoration.replace({ widget: new ImageWidget(src, img[2]) }) });
          pos = line.to + 1;
          continue;
        }
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
  ".cm-lim-image": { display: "block", maxWidth: "100%", maxHeight: "480px", border: "1px solid #BFBFBF", margin: "4px 0" },
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
          paste(e, view) {
            const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!files.length || !handlers.upload) return false;
            e.preventDefault();
            void insertImages(view, files, handlers, view.state.selection.main.head);
            return true;
          },
          drop(e, view) {
            const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!files.length || !handlers.upload) return false;
            e.preventDefault();
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
            void insertImages(view, files, handlers, pos);
            return true;
          },
          mousedown(e) {
            const el = (e.target as HTMLElement).closest<HTMLElement>("[data-title]");
            if (!el?.dataset.title) return false;
            e.preventDefault();
            handlers.open(el.dataset.title);
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((t) => t.annotation(remoteChange))) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
}

/** 画像を保存して、pos の行の下に 1 枚 1 行で書き込む */
async function insertImages(view: EditorView, files: File[], h: LinkHandlers, pos: number): Promise<void> {
  const lines: string[] = [];
  for (const f of files) {
    try {
      lines.push(`![](${await h.upload!(f)})`);
    } catch (e) {
      h.onUploadError?.(e instanceof Error ? e.message : String(e));
    }
  }
  if (!lines.length) return;
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  const empty = line.text.trim() === "";
  const insert = empty ? lines.join("\n") : "\n" + lines.join("\n");
  const from = empty ? line.from : line.to;
  view.dispatch({ changes: { from, to: empty ? line.to : line.to, insert }, selection: { anchor: from + insert.length } });
  view.focus();
}
