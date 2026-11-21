"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface CodeEditorMarker {
  line: number;
  message: string;
}

// YAML forbids tabs, so the Tab key writes two spaces.
const INDENT = "  ";
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);
// Named because the admin copy scan of ui-copy.test.ts reads `}` ... `Map<` as JSX text.
type MessagesByLine = Map<number, string[]>;

/** 1..n, n = number of "\n" + 1 ("" → [1]); "\r\n" counts once. */
export function lineNumbers(text: string): number[] {
  let count = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) count++;
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** line → messages, lines < 1 dropped, lines > n clamped to n. */
export function markersByLine(markers: readonly CodeEditorMarker[], lineCount: number): MessagesByLine {
  const byLine: MessagesByLine = new Map();
  for (const marker of markers) {
    const line = Math.min(Math.floor(marker.line), lineCount);
    if (!(line >= 1)) continue;
    byLine.set(line, [...(byLine.get(line) ?? []), marker.message]);
  }
  return byLine;
}

/**
 * Tab / Shift+Tab on the selection. Without one, Tab writes two spaces at the caret and Shift+Tab takes up to two
 * leading spaces off the caret's line. With one, every line it touches (a selection ending at column 0 does not touch
 * that last line) gets the same, and the returned selection covers those lines.
 */
export function indentSelection(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
): { value: string; start: number; end: number } {
  const lineStart = value.slice(0, start).lastIndexOf("\n") + 1;
  const leading = (line: string) => /^ {0,2}/.exec(line)?.[0].length ?? 0;
  if (start === end) {
    if (!outdent) {
      const caret = start + INDENT.length;
      return { value: value.slice(0, start) + INDENT + value.slice(end), start: caret, end: caret };
    }
    const removed = leading(value.slice(lineStart));
    const caret = start - Math.min(removed, start - lineStart);
    return { value: value.slice(0, lineStart) + value.slice(lineStart + removed), start: caret, end: caret };
  }
  const stop = value[end - 1] === "\n" ? end - 1 : end;
  const found = value.indexOf("\n", stop);
  const lineEnd = found < 0 ? value.length : found;
  const block = value
    .slice(lineStart, lineEnd)
    .split("\n")
    .map((line) => (outdent ? line.slice(leading(line)) : INDENT + line))
    .join("\n");
  return {
    value: value.slice(0, lineStart) + block + value.slice(lineEnd),
    start: lineStart,
    end: lineStart + block.length + (end - stop),
  };
}

/** A plain text editor with a line-number gutter; the lines in `markers` are flagged in the gutter. */
export function CodeEditor({
  id,
  value,
  onChange,
  markers = [],
  label,
  describedBy,
  rows = 24,
  readOnly,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  markers?: readonly CodeEditorMarker[];
  /** The accessible name of the text area. */
  label: string;
  /** The id of the element that describes the editor (its keyboard hint). */
  describedBy?: string;
  rows?: number;
  readOnly?: boolean;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Escape releases the next Tab to the browser, so the keyboard is never trapped in the editor.
  const releaseRef = useRef(false);
  const numbers = lineNumbers(value);
  const marked = markersByLine(markers, numbers.length);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      releaseRef.current = true;
      return;
    }
    if (MODIFIERS.has(e.key)) return;
    const released = releaseRef.current;
    releaseRef.current = false;
    if (e.key !== "Tab" || released || readOnly) return;
    e.preventDefault();
    const { value: text, selectionStart, selectionEnd } = e.currentTarget;
    const next = indentSelection(text, selectionStart, selectionEnd, e.shiftKey);
    onChange(next.value);
    // The re-render moves the caret to the end; put the selection back once the new value is in.
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.start, next.end));
  }

  return (
    <div className="flex max-h-[36rem] overflow-hidden rounded-md border bg-background font-mono text-xs leading-5">
      {/* The extra bottom padding lets the gutter scroll as far as a text area with a horizontal scroll bar. */}
      <div
        ref={gutterRef}
        aria-hidden
        className="select-none overflow-hidden border-r bg-muted/40 pb-6 pt-2 text-right text-muted-foreground"
      >
        {numbers.map((n) => {
          const messages = marked.get(n);
          return (
            <div
              key={n}
              className={cn("px-2", messages && "bg-destructive/15 font-semibold text-destructive")}
              title={messages?.join("\n")}
              data-error-line={messages ? n : undefined}
            >
              {n}
            </div>
          );
        })}
      </div>
      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        wrap="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={markers.length > 0 || undefined}
        rows={rows}
        readOnly={readOnly}
        className="flex-1 resize-y overflow-auto whitespace-pre bg-transparent p-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
