import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEditor, indentSelection, lineNumbers, markersByLine } from "@/components/admin/code-editor";

describe("lineNumbers", () => {
  it("counts the lines of the text, the empty text being one line", () => {
    expect(lineNumbers("")).toEqual([1]);
    expect(lineNumbers("a")).toEqual([1]);
    expect(lineNumbers("a\n")).toEqual([1, 2]);
    expect(lineNumbers("a\nb\nc")).toEqual([1, 2, 3]);
  });

  it("counts a CRLF once", () => {
    expect(lineNumbers("a\r\nb")).toEqual([1, 2]);
    expect(lineNumbers("a\r\nb\r\n")).toEqual([1, 2, 3]);
  });

  it("numbers a thousand lines", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const numbers = lineNumbers(text);
    expect(numbers).toHaveLength(1000);
    expect([numbers[0], numbers[999]]).toEqual([1, 1000]);
    expect(lineNumbers(`${text}\n`)).toHaveLength(1001);
  });
});

describe("markersByLine", () => {
  const entries = (m: Map<number, string[]>) => [...m].sort(([a], [b]) => a - b);

  it("groups the messages of a line, in order", () => {
    const markers = [
      { line: 2, message: "first" },
      { line: 1, message: "other" },
      { line: 2, message: "second" },
    ];
    expect(entries(markersByLine(markers, 3))).toEqual([
      [1, ["other"]],
      [2, ["first", "second"]],
    ]);
  });

  it("drops the lines before the first", () => {
    const markers = [0, -3, Number.NaN].map((line) => ({ line, message: "m" }));
    expect(markersByLine(markers, 3).size).toBe(0);
  });

  it("clamps the lines past the end to the last line", () => {
    const markers = [
      { line: 9, message: "past" },
      { line: 3, message: "last" },
    ];
    expect(entries(markersByLine(markers, 3))).toEqual([[3, ["past", "last"]]]);
  });

  it("puts a fractional line on the line it falls in, and answers nothing for no markers", () => {
    expect(entries(markersByLine([{ line: 2.7, message: "m" }], 3))).toEqual([[2, ["m"]]]);
    expect(markersByLine([], 3).size).toBe(0);
  });
});

describe("indentSelection", () => {
  const indent = (value: string, start: number, end = start) => indentSelection(value, start, end, false);
  const outdent = (value: string, start: number, end = start) => indentSelection(value, start, end, true);

  it("inserts two spaces at the caret", () => {
    expect(indent("ab", 1)).toEqual({ value: "a  b", start: 3, end: 3 });
    expect(indent("", 0)).toEqual({ value: "  ", start: 2, end: 2 });
    expect(indent("a\nb", 3)).toEqual({ value: "a\nb  ", start: 5, end: 5 });
  });

  it("removes up to two leading spaces of the caret's line", () => {
    expect(outdent("a: 1", 2)).toEqual({ value: "a: 1", start: 2, end: 2 });
    expect(outdent(" a", 2)).toEqual({ value: "a", start: 1, end: 1 });
    expect(outdent("  a", 3)).toEqual({ value: "a", start: 1, end: 1 });
    expect(outdent("   a", 4)).toEqual({ value: " a", start: 2, end: 2 });
  });

  it("keeps the caret in the line when it sits inside the spaces taken away", () => {
    expect(outdent("    a", 1)).toEqual({ value: "  a", start: 0, end: 0 });
  });

  it("outdents only the line of the caret", () => {
    expect(outdent("  a\n  b\n  c", 6)).toEqual({ value: "  a\nb\n  c", start: 4, end: 4 });
  });

  it("does not take the line before for the first line, even when it is empty", () => {
    expect(outdent("\nabc", 0)).toEqual({ value: "\nabc", start: 0, end: 0 });
  });

  it("indents every line a selection touches and selects those lines", () => {
    expect(indent("a\nb\nc", 0, 5)).toEqual({ value: "  a\n  b\n  c", start: 0, end: 11 });
    // From the middle of the first line to the middle of the last one.
    expect(indent("aa\nbb\ncc", 1, 4)).toEqual({ value: "  aa\n  bb\ncc", start: 0, end: 9 });
  });

  it("indents the line of a selection inside one line instead of replacing the text", () => {
    expect(indent("a\nbcd\nc", 3, 4)).toEqual({ value: "a\n  bcd\nc", start: 2, end: 7 });
  });

  it("outdents every line a selection touches, even when it ends inside the spaces", () => {
    expect(outdent("    a\n  b\nc", 1, 8)).toEqual({ value: "  a\nb\nc", start: 0, end: 5 });
    expect(outdent("   a\n b\nc", 0, 6)).toEqual({ value: " a\nb\nc", start: 0, end: 4 });
    // Ends one character into the last line's three spaces: the line still loses two.
    expect(outdent("  a\n   b", 0, 5)).toEqual({ value: "a\n b", start: 0, end: 4 });
  });

  it("leaves the last line alone when the selection ends at its column 0", () => {
    expect(indent("a\nb\nc", 0, 2)).toEqual({ value: "  a\nb\nc", start: 0, end: 4 });
    expect(indent("a\nb\nc", 0, 4)).toEqual({ value: "  a\n  b\nc", start: 0, end: 8 });
    expect(outdent("  a\n  b", 0, 4)).toEqual({ value: "a\n  b", start: 0, end: 2 });
  });

  it("never touches a line outside the selection, and outdent undoes indent", () => {
    const value = "one\ntwo\n  three\nfour\nfive";
    const start = value.indexOf("two");
    const end = value.indexOf("four") + 2;
    const indented = indent(value, start, end);
    expect(indented.value).toBe("one\n  two\n    three\n  four\nfive");
    expect(indented.value.split("\n")[0]).toBe("one");
    expect(indented.value.split("\n")[4]).toBe("five");
    expect(outdent(indented.value, indented.start, indented.end)).toEqual({
      value,
      start: value.indexOf("two"),
      end: value.indexOf("four") + "four".length,
    });
  });
});

describe("CodeEditor render", () => {
  const render = (props: Partial<Parameters<typeof CodeEditor>[0]> = {}) =>
    renderToStaticMarkup(createElement(CodeEditor, { id: "src", value: "a\nb\nc", onChange: () => {}, label: "Source", ...props }));
  const rows = (html: string) => html.match(/<div class="px-2[^"]*"/g) ?? [];

  it("draws a gutter row per line and a textarea that does not wrap or check spelling", () => {
    const html = render();
    expect(rows(html)).toHaveLength(3);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('id="src"');
    expect(html).toContain('aria-label="Source"');
    expect(html).toContain('wrap="off"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('rows="24"');
    expect(html).toContain(">a\nb\nc</textarea>");
    expect(render({ rows: 8 })).toContain('rows="8"');
    expect(rows(render({ value: "" }))).toHaveLength(1);
  });

  it("marks the lines with a message: data-error-line, the messages in the title, aria-invalid on the textarea", () => {
    const html = render({
      markers: [
        { line: 2, message: "bad indent" },
        { line: 2, message: "again" },
        { line: 9, message: "past the end" },
      ],
    });
    expect(html.match(/data-error-line="\d+"/g)).toEqual(['data-error-line="2"', 'data-error-line="3"']);
    expect(html).toContain('title="bad indent\nagain"');
    expect(html).toContain('title="past the end"');
    expect(html).toContain('aria-invalid="true"');
    expect(rows(html).filter((r) => r.includes("text-destructive"))).toHaveLength(2);
  });

  it("without markers: no error row, no aria-invalid, no title", () => {
    for (const html of [render(), render({ markers: [] })]) {
      expect(html).not.toContain("data-error-line");
      expect(html).not.toContain("aria-invalid");
      expect(html).not.toContain("title=");
    }
  });

  it("passes aria-describedby and readOnly through, and only when given", () => {
    expect(render()).not.toContain("aria-describedby");
    expect(render()).not.toContain("readOnly");
    const html = render({ describedBy: "editor-hint", readOnly: true });
    expect(html).toContain('aria-describedby="editor-hint"');
    expect(html).toContain('readOnly=""');
  });
});

// Calls the component once with stand-in refs, so its key handler can be run without a DOM.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
type El = ReactElement<Record<string, unknown>>;
const find = (node: ReactNode, tag: string): El | undefined => {
  if (Array.isArray(node)) return node.map((n) => find(n, tag)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const el = node as El;
  return el.type === tag ? el : find(el.props.children as ReactNode, tag);
};

describe("CodeEditor keyboard", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mount(props: Partial<Parameters<typeof CodeEditor>[0]> = {}) {
    const onChange = vi.fn();
    const setSelectionRange = vi.fn();
    const gutter = { current: { scrollTop: 0 } };
    const refs = [gutter, { current: { setSelectionRange } }, { current: false }];
    let r = 0;
    const prev = internals.H;
    internals.H = { useRef: () => refs[r++] };
    let tree: ReactNode;
    try {
      tree = (CodeEditor as (p: unknown) => ReactNode)({ id: "src", value: "a\nb", onChange, label: "Source", ...props });
    } finally {
      internals.H = prev;
    }
    const area = find(tree, "textarea")!.props as { onKeyDown: (e: unknown) => void; onScroll: (e: unknown) => void };
    const press = (key: string, extra: { shiftKey?: boolean; start?: number; end?: number; value?: string } = {}) => {
      const preventDefault = vi.fn();
      const value = extra.value ?? "a\nb";
      area.onKeyDown({
        key,
        shiftKey: extra.shiftKey ?? false,
        preventDefault,
        currentTarget: { value, selectionStart: extra.start ?? 0, selectionEnd: extra.end ?? extra.start ?? 0 },
      });
      return preventDefault;
    };
    return { press, onChange, setSelectionRange, gutter, area };
  }

  it("Tab indents and puts the selection back after the re-render", () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
    const { press, onChange, setSelectionRange } = mount();
    expect(press("Tab", { start: 1 })).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("a  \nb");
    expect(setSelectionRange).not.toHaveBeenCalled();
    frames.forEach((f) => f());
    expect(setSelectionRange).toHaveBeenCalledWith(3, 3);
  });

  it("Shift+Tab outdents", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => cb());
    const { press, onChange, setSelectionRange } = mount();
    press("Tab", { shiftKey: true, start: 3, value: "  a" });
    expect(onChange).toHaveBeenCalledWith("a");
    expect(setSelectionRange).toHaveBeenCalledWith(1, 1);
  });

  it("is not a keyboard trap: after Escape the next Tab moves the focus on, then Tab indents again", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => cb());
    const { press, onChange } = mount();
    expect(press("Escape")).not.toHaveBeenCalled();
    expect(press("Shift")).not.toHaveBeenCalled(); // a modifier on the way to Shift+Tab keeps the release
    expect(press("Tab", { shiftKey: true })).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(press("Tab")).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("any other key cancels the release", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => cb());
    const { press, onChange } = mount();
    press("Escape");
    press("a");
    expect(press("Tab")).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("leaves Tab to the browser when the editor is read-only", () => {
    const { press, onChange } = mount({ readOnly: true });
    expect(press("Tab")).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("scrolls the gutter with the text", () => {
    const { area, gutter } = mount();
    area.onScroll({ currentTarget: { scrollTop: 120 } });
    expect(gutter.current.scrollTop).toBe(120);
  });
});
