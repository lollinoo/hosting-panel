export const TERMINAL_LINE_MAX = 1000;
export const TERMINAL_LINES_KEPT = 2000;
const SEQ_MAX = 256;

/** What the console shows: finished lines (key of lines[i] is base + i), the line in progress and its cursor. */
export interface TerminalText {
  lines: string[];
  base: number;
  current: string;
  col: number;
  /** An escape sequence cut by the end of a read, finished by the next one. */
  pending: string;
  dropped: boolean;
}

export const emptyText = (): TerminalText => ({ lines: [], base: 0, current: "", col: 0, pending: "", dropped: false });

const STRING_C1 = [0x90, 0x98, 0x9d, 0x9e, 0x9f]; // DCS, SOS, OSC, PM, APC
// Direction overrides, isolates and marks: they could make a line read as something else.
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;

/** Index after the escape sequence that starts at i; -1 when the text ends before it does. */
function seqEnd(chars: string[], i: number): number {
  const first = chars[i]!.codePointAt(0)!;
  let j = i + 1;
  let kind: "csi" | "str" | "esc";
  if (first === 0x1b) {
    if (j >= chars.length) return -1;
    const next = chars[j]!;
    if (next === "[") kind = "csi";
    else if ("]PX^_".includes(next)) kind = "str";
    else kind = "esc";
    if (kind !== "esc") j++;
  } else if (first === 0x9b) kind = "csi";
  else if (STRING_C1.includes(first)) kind = "str";
  else return i + 1;
  const limit = Math.min(chars.length, i + SEQ_MAX);
  for (; j < limit; j++) {
    const k = chars[j]!.codePointAt(0)!;
    if (kind === "csi") {
      if (k >= 0x20 && k <= 0x3f) continue;
      return k >= 0x40 && k <= 0x7e ? j + 1 : j;
    }
    if (kind === "esc") {
      if (k >= 0x20 && k <= 0x2f) continue;
      return k >= 0x30 && k <= 0x7e ? j + 1 : j;
    }
    if (k === 0x07 || k === 0x9c) return j + 1;
    if (k === 0x1b) {
      if (j + 1 >= chars.length) return -1;
      return chars[j + 1] === "\\" ? j + 2 : j;
    }
  }
  // Too long without an end: drop what was read and show what follows.
  return chars.length < i + SEQ_MAX ? -1 : i + SEQ_MAX;
}

/** Applies one read's output to the console text; pure. */
export function feed(prev: TerminalText, output: string, serverDropped = false): TerminalText {
  if (output === "" && !serverDropped) return prev;
  const chars = Array.from(prev.pending + output);
  const lines = prev.lines.slice();
  let base = prev.base;
  let line = Array.from(prev.current);
  let col = prev.col;
  let dropped = prev.dropped || serverDropped;
  let pending = "";
  const endLine = () => {
    lines.push(line.join(""));
    line = [];
    col = 0;
  };
  for (let i = 0; i < chars.length; ) {
    const ch = chars[i]!;
    const code = ch.codePointAt(0)!;
    if (code === 0x1b || (code >= 0x80 && code <= 0x9f)) {
      const end = seqEnd(chars, i);
      if (end === -1) {
        pending = chars.slice(i).join("");
        break;
      }
      i = end;
      continue;
    }
    i++;
    if (ch === "\r") col = 0;
    else if (ch === "\n") endLine();
    else if (ch === "\b") col = Math.max(0, col - 1);
    else if (ch === "\t") col = Math.min(TERMINAL_LINE_MAX, (Math.floor(col / 8) + 1) * 8);
    else if (code >= 0x20 && code !== 0x7f && !BIDI.test(ch)) {
      if (col >= TERMINAL_LINE_MAX) endLine();
      while (line.length < col) line.push(" ");
      line[col++] = ch;
    }
  }
  if (lines.length > TERMINAL_LINES_KEPT) {
    const over = lines.length - TERMINAL_LINES_KEPT;
    lines.splice(0, over);
    base += over;
    dropped = true;
  }
  return { lines, base, current: line.join(""), col, pending, dropped };
}
