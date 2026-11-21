/**
 * Parser for the small YAML subset accepted as a site-template source.
 *
 * Pure TypeScript that pulls in no Node module: the admin editor bundles it for the browser.
 * `parseTemplateYaml` never throws: a document is either a plain value (objects, arrays,
 * strings, safe integers, booleans, null) or a single positioned error.
 *
 * Deliberately not YAML: no anchors, aliases, tags, merge keys, block scalars, complex
 * keys, directives or second documents, no scalar spread over several lines, and a
 * minimal scalar typing (only `null`, booleans and safe integers; `8.4`, `yes`, `0123`
 * and `1e3` stay strings). Size, depth, node and key-length limits bound the work.
 */

export const TEMPLATE_SOURCE_MAX_BYTES = 65_536;
/** The root collection is depth 1; a 17th nested collection fails. */
export const YAML_MAX_DEPTH = 16;
/** Every value (collections included) and every mapping key counts 1. */
export const YAML_MAX_NODES = 4096;
export const YAML_MAX_KEY_LENGTH = 128;

export const YAML_ERROR_CODES = [
  "TOO_LARGE",
  "CONTROL_CHARACTER",
  "TAB_INDENT",
  "BAD_INDENT",
  "MULTI_DOCUMENT",
  "DIRECTIVE",
  "ANCHOR",
  "ALIAS",
  "TAG",
  "BLOCK_SCALAR",
  "COMPLEX_KEY",
  "MERGE_KEY",
  "FORBIDDEN_KEY",
  "DUPLICATE_KEY",
  "KEY_TOO_LONG",
  "TOO_DEEP",
  "TOO_MANY_NODES",
  "UNTERMINATED_STRING",
  "INVALID_ESCAPE",
  "UNEXPECTED_CHARACTER",
  "TRAILING_CONTENT",
  "NESTED_MAPPING",
  "MULTILINE_SCALAR",
  "FLOW_SYNTAX",
  "UNSUPPORTED_SYNTAX",
] as const;
export type YamlErrorCode = (typeof YAML_ERROR_CODES)[number];

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };
export type TemplatePath = readonly (string | number)[];

/** 1-based; the column counts UTF-16 units of the line after CRLF/CR normalisation. */
export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}
export interface YamlSyntaxError extends SourceLocation {
  readonly code: YamlErrorCode;
  readonly message: string;
}
/**
 * "key": the mapping key token (an array item: its `-` or first token). "value": the start of
 * the value token (a collection: its first key or `-`). An unknown path falls back to the
 * nearest known ancestor.
 */
export type TemplateLocator = (path: TemplatePath, part?: "key" | "value") => SourceLocation | null;
export type ParseTemplateYamlResult =
  | { readonly ok: true; readonly value: YamlValue; readonly locate: TemplateLocator }
  | { readonly ok: false; readonly errors: readonly [YamlSyntaxError] };

/** `["services","app","environment",0]` -> `services.app.environment[0]`; a key outside [A-Za-z0-9_-] -> `["a.b"]`. */
export function formatTemplatePath(path: TemplatePath): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z0-9_-]+$/.test(segment)) out += out === "" ? segment : `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

export function parseTemplateYaml(source: string): ParseTemplateYamlResult {
  try {
    if (source.length > TEMPLATE_SOURCE_MAX_BYTES || new TextEncoder().encode(source).length > TEMPLATE_SOURCE_MAX_BYTES) {
      return failure({
        code: "TOO_LARGE",
        line: 1,
        column: 1,
        message: `the template is larger than ${TEMPLATE_SOURCE_MAX_BYTES} bytes`,
      });
    }
    const text = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).replace(/\r\n?/g, "\n");
    return { ok: true, ...new Parser(text).parse() };
  } catch (error) {
    return failure(
      error instanceof Failure
        ? error.error
        : { code: "UNSUPPORTED_SYNTAX", line: 1, column: 1, message: "the template could not be parsed" },
    );
  }
}

function failure(error: YamlSyntaxError): ParseTemplateYamlResult {
  return { ok: false, errors: [error] };
}

class Failure {
  constructor(readonly error: YamlSyntaxError) {}
}

type Path = (string | number)[];
type YamlMap = { [key: string]: YamlValue };
/** plain: an unquoted block scalar; scalar: a quoted scalar, a flow value or an empty value; block: a block collection. */
type Kind = "plain" | "scalar" | "block";
/** `at` is the offset of the value token, `endLine` the last (0-based) line the value occupies. */
interface Item {
  readonly value: YamlValue;
  readonly at: number;
  readonly endLine: number;
  readonly kind: Kind;
}
interface KeyScan {
  readonly key: string;
  readonly at: number;
  readonly valueCol: number;
}
interface Content {
  readonly line: number;
  readonly indent: number;
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t";
const isEnd = (c: string | undefined): boolean => c === undefined || c === "\n" || isWs(c);
const isDash = (line: string, col: number): boolean => line[col] === "-" && isEnd(line[col + 1]);

const BLOCK_SCALAR_MESSAGE = "block scalars are not supported; use a double-quoted string with \\n";
const MULTILINE_MESSAGE = "a plain scalar must fit on one line; use a double-quoted string";
/** First characters that can never start a plain scalar, whatever follows. */
const PLAIN_START_ERRORS = new Map<string, readonly [YamlErrorCode, string]>([
  ["&", ["ANCHOR", "anchors are not supported"]],
  ["*", ["ALIAS", "aliases are not supported"]],
  ["!", ["TAG", "tags are not supported"]],
  ["|", ["BLOCK_SCALAR", BLOCK_SCALAR_MESSAGE]],
  [">", ["BLOCK_SCALAR", BLOCK_SCALAR_MESSAGE]],
  ["@", ["UNEXPECTED_CHARACTER", "'@' cannot start an unquoted value; quote it"]],
  ["`", ["UNEXPECTED_CHARACTER", "'`' cannot start an unquoted value; quote it"]],
  ["%", ["UNEXPECTED_CHARACTER", "'%' cannot start an unquoted value; quote it"]],
  ["#", ["UNEXPECTED_CHARACTER", "a comment needs a space before the '#'"]],
]);

function typePlain(text: string): YamlScalar {
  switch (text) {
    case "":
    case "null":
    case "Null":
    case "NULL":
    case "~":
      return null;
    case "true":
    case "True":
    case "TRUE":
      return true;
    case "false":
    case "False":
    case "FALSE":
      return false;
  }
  if (/^(?:0|-?[1-9][0-9]*)$/.test(text)) {
    const number = Number(text);
    if (Number.isSafeInteger(number)) return number;
  }
  return text;
}

function hex4(text: string): number | null {
  return /^[0-9a-fA-F]{4}$/.test(text) ? parseInt(text, 16) : null;
}

/** `---` or `...` at column 0 alone on its line (bare) or followed by something else. */
function markerOf(line: string): { kind: "---" | "..."; bare: boolean } | null {
  const kind = line.startsWith("---") ? "---" : line.startsWith("...") ? "..." : null;
  if (kind === null || !isEnd(line[3])) return null;
  let i = 3;
  while (isWs(line[i])) i++;
  return { kind, bare: i >= line.length || (i > 3 && line[i] === "#") };
}

class Parser {
  private readonly lines: string[];
  private readonly starts: number[] = [];
  private readonly path: Path = [];
  private readonly index = new Map<string, { key: number; value: number }>();
  private nodes = 0;
  private depth = 0;

  constructor(private readonly text: string) {
    this.lines = text.split("\n");
    let offset = 0;
    for (const line of this.lines) {
      this.starts.push(offset);
      offset += line.length + 1;
    }
  }

  parse(): { value: YamlValue; locate: TemplateLocator } {
    this.rejectControlCharacters();
    let first = this.nextContent(0, true);
    if (first && markerOf(this.lines[first.line]!)) first = this.nextContent(first.line + 1);
    let root: Item = { value: null, at: 0, endLine: 0, kind: "scalar" };
    if (first) {
      root = this.block(first.line, first.indent);
      const rest = this.nextContent(root.endLine + 1);
      if (rest) {
        const at = this.off(rest.line, rest.indent);
        if (root.kind === "plain") this.fail("MULTILINE_SCALAR", at, MULTILINE_MESSAGE);
        if (root.kind === "block") this.fail("BAD_INDENT", at, "this line is not aligned with the document");
        this.fail("TRAILING_CONTENT", at, "unexpected content after the value");
      }
    }
    this.record(root.at, root.at);
    return { value: root.value, locate: this.locator() };
  }

  // ---- positions, limits, index -------------------------------------------------

  private off(line: number, col: number): number {
    return this.starts[line]! + col;
  }

  private locationOf(offset: number): SourceLocation {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.starts[lo]! + 1 };
  }

  private fail(code: YamlErrorCode, offset: number, message: string): never {
    throw new Failure({ code, ...this.locationOf(offset), message });
  }

  private bump(at: number): void {
    if (++this.nodes > YAML_MAX_NODES) this.fail("TOO_MANY_NODES", at, `more than ${YAML_MAX_NODES} values and keys`);
  }

  private enter(at: number): void {
    if (++this.depth > YAML_MAX_DEPTH) this.fail("TOO_DEEP", at, `nested more than ${YAML_MAX_DEPTH} levels deep`);
    this.bump(at);
  }

  private record(key: number, value: number): void {
    this.index.set(JSON.stringify(this.path), { key, value });
  }

  private locator(): TemplateLocator {
    return (path, part = "value") => {
      for (let n = path.length; n >= 0; n--) {
        const hit = this.index.get(JSON.stringify(path.slice(0, n)));
        if (hit) return this.locationOf(hit[part]);
      }
      return null;
    };
  }

  private rejectControlCharacters(): void {
    const { text } = this;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c < 0x20 && c !== 9 && c !== 10) || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) {
        this.fail("CONTROL_CHARACTER", i, `control character U+${c.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
  }

  // ---- lines --------------------------------------------------------------------

  /** The next line holding content from `from` on, or null. `allowStart` lets a bare leading `---` through. */
  private nextContent(from: number, allowStart = false): Content | null {
    for (let i = from; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      let indent = 0;
      while (line[indent] === " ") indent++;
      const c = line[indent];
      if (c === undefined || c === "#") continue;
      if (c === "\t") {
        let m = indent;
        while (isWs(line[m])) m++;
        if (line[m] === undefined || line[m] === "#") continue;
        this.fail("TAB_INDENT", this.off(i, indent), "indent with spaces, not tabs");
      }
      if (indent === 0) {
        if (c === "%") this.fail("DIRECTIVE", this.off(i, 0), "directives are not supported");
        const marker = markerOf(line);
        if (marker && !(allowStart && marker.kind === "---" && marker.bare)) {
          if (marker.bare) this.fail("MULTI_DOCUMENT", this.off(i, 0), "only one document is allowed");
          this.fail("UNSUPPORTED_SYNTAX", this.off(i, 0), "content after a document marker is not supported");
        }
      }
      return { line: i, indent };
    }
    return null;
  }

  // ---- block structure ----------------------------------------------------------

  private block(line: number, col: number): Item {
    if (isDash(this.lines[line]!, col)) return this.sequence(line, col);
    if (this.scanKey(line, col)) return this.mapping(line, col);
    return this.inline(line, col);
  }

  /** The block under a `key:` or `-` with nothing after it, or null when the next content is not nested deeper. */
  private nested(parentIndent: number, fromLine: number, allowSameIndentSequence: boolean): Item | null {
    const next = this.nextContent(fromLine);
    if (!next) return null;
    const sequenceAtParentIndent =
      allowSameIndentSequence && next.indent === parentIndent && isDash(this.lines[next.line]!, next.indent);
    return next.indent > parentIndent || sequenceAtParentIndent ? this.block(next.line, next.indent) : null;
  }

  /** The next entry of the collection at `indent` after `item`, or null when the collection ends. */
  private continues(item: Item, indent: number, isSequence: boolean): Content | null {
    const next = this.nextContent(item.endLine + 1);
    if (!next || next.indent < indent) return null;
    if (next.indent > indent) {
      const at = this.off(next.line, next.indent);
      if (item.kind === "plain") this.fail("MULTILINE_SCALAR", at, MULTILINE_MESSAGE);
      this.fail("BAD_INDENT", at, "this line is not aligned with its siblings");
    }
    return isDash(this.lines[next.line]!, indent) === isSequence ? next : null;
  }

  private mapping(line: number, indent: number): Item {
    const at = this.off(line, indent);
    this.enter(at);
    const map: YamlMap = {};
    const firstLines = new Map<string, number>();
    let current: Content | null = { line, indent };
    let end = line;
    while (current) {
      const row = current.line;
      const text = this.lines[row]!;
      const scan = this.scanKey(row, indent);
      if (!scan) this.fail("UNEXPECTED_CHARACTER", this.off(row, indent), "expected a \"key: value\" entry (a space is needed after ':')");
      this.bump(scan.at);
      this.checkKey(scan.key, scan.at, firstLines);
      this.path.push(scan.key);
      let col = scan.valueCol;
      while (isWs(text[col])) col++;
      const empty = text[col] === undefined || text[col] === "#";
      const item =
        (empty ? this.nested(indent, row + 1, true) : this.inline(row, col)) ?? { value: null, at: scan.at, endLine: row, kind: "scalar" as const };
      this.record(scan.at, item.at);
      this.path.pop();
      map[scan.key] = item.value;
      end = item.endLine;
      current = this.continues(item, indent, false);
    }
    this.depth--;
    return { value: map, at, endLine: end, kind: "block" };
  }

  private sequence(line: number, indent: number): Item {
    const at = this.off(line, indent);
    this.enter(at);
    const list: YamlValue[] = [];
    let current: Content | null = { line, indent };
    let end = line;
    while (current) {
      const row = current.line;
      const text = this.lines[row]!;
      const dash = this.off(row, indent);
      let col = indent + 1;
      while (isWs(text[col])) col++;
      this.path.push(list.length);
      let item: Item | null;
      if (text[col] === undefined || text[col] === "#") item = this.nested(indent, row + 1, false);
      else if (isDash(text, col)) this.fail("UNSUPPORTED_SYNTAX", this.off(row, col), "nested sequence entries on one line are not supported");
      else if (this.scanKey(row, col)) item = this.mapping(row, col);
      else item = this.inline(row, col);
      item ??= { value: null, at: dash, endLine: row, kind: "scalar" };
      this.record(dash, item.at);
      this.path.pop();
      list.push(item.value);
      end = item.endLine;
      current = this.continues(item, indent, true);
    }
    this.depth--;
    return { value: list, at, endLine: end, kind: "block" };
  }

  private checkKey(key: string, at: number, firstLines: Map<string, number>): void {
    if (key.length > YAML_MAX_KEY_LENGTH) this.fail("KEY_TOO_LONG", at, `a key is at most ${YAML_MAX_KEY_LENGTH} characters long`);
    if (key === "<<") this.fail("MERGE_KEY", at, "merge keys are not supported");
    if (key === "__proto__") this.fail("FORBIDDEN_KEY", at, "this key name is not allowed");
    const first = firstLines.get(key);
    if (first !== undefined) this.fail("DUPLICATE_KEY", at, `duplicate key "${key}" (first defined on line ${first})`);
    firstLines.set(key, this.locationOf(at).line);
  }

  /** The `key:` at (line, col), or null when the text there is not a key. Throws on a malformed quoted key. */
  private scanKey(line: number, col: number): KeyScan | null {
    const text = this.lines[line]!;
    const c = text[col];
    if (c === "[" || c === "{") return null;
    const at = this.off(line, col);
    if (c === '"' || c === "'") {
      const key = this.quoted(at);
      let p = key.end - this.starts[line]!;
      while (isWs(text[p])) p++;
      return text[p] === ":" && isEnd(text[p + 1]) ? { key: key.value, at, valueCol: p + 1 } : null;
    }
    this.checkPlainStart(c!, text[col + 1], at, false);
    for (let i = col; i < text.length; i++) {
      if (text[i] === ":" && isEnd(text[i + 1])) {
        let end = i;
        while (end > col && isWs(text[end - 1])) end--;
        return { key: text.slice(col, end), at, valueCol: i + 1 };
      }
      if (text[i] === "#" && i > col && isWs(text[i - 1])) return null;
    }
    return null;
  }

  // ---- scalars and flow collections ---------------------------------------------

  /** A value that starts at (line, col) and ends on the same line, except flow collections. */
  private inline(line: number, col: number): Item {
    const at = this.off(line, col);
    const c = this.text[at]!;
    if (c === "[" || c === "{") {
      const flow = this.flowCollection(at);
      this.checkRest(flow.end, true);
      return { value: flow.value, at, endLine: this.locationOf(flow.end - 1).line - 1, kind: "scalar" };
    }
    if (c === '"' || c === "'") {
      const quoted = this.quoted(at);
      this.bump(at);
      this.checkRest(quoted.end, false);
      return { value: quoted.value, at, endLine: line, kind: "scalar" };
    }
    this.checkPlainStart(c, this.text[at + 1], at, false);
    const text = this.lines[line]!;
    let end = text.length;
    for (let i = col + 1; i < text.length; i++) {
      if (text[i] === "#" && isWs(text[i - 1])) {
        end = i;
        break;
      }
    }
    while (end > col && isWs(text[end - 1])) end--;
    const scalar = text.slice(col, end);
    for (let i = 0; i < scalar.length; i++) {
      if (scalar[i] === ":" && isEnd(scalar[i + 1])) {
        this.fail("NESTED_MAPPING", this.off(line, col + i), "a mapping cannot start inside a value; put it on its own lines");
      }
    }
    this.bump(at);
    return { value: typePlain(scalar), at, endLine: line, kind: "plain" };
  }

  /** After a value that ended at `end`: only spaces and a comment may follow on that line. */
  private checkRest(end: number, flow: boolean): void {
    let p = end;
    const spaced = isWs(this.text[p]);
    while (isWs(this.text[p])) p++;
    const c = this.text[p];
    if (c === undefined || c === "\n" || (c === "#" && spaced)) return;
    if (flow && c === ":" && isEnd(this.text[p + 1])) this.fail("FLOW_SYNTAX", p, "a flow collection cannot be a mapping key");
    this.fail("TRAILING_CONTENT", p, "unexpected content after the value");
  }

  private checkPlainStart(c: string, next: string | undefined, at: number, flow: boolean): void {
    const hit = PLAIN_START_ERRORS.get(c);
    if (hit) this.fail(hit[0], at, hit[1]);
    if (c === "?" && isEnd(next)) this.fail("COMPLEX_KEY", at, "complex keys are not supported");
    if (c === "-" && isEnd(next)) this.fail("UNSUPPORTED_SYNTAX", at, "a sequence entry is not allowed here");
    if ((c === ":" && isEnd(next)) || c === "," || c === "]" || c === "}") {
      this.fail(flow ? "FLOW_SYNTAX" : "UNEXPECTED_CHARACTER", at, `unexpected '${c}'`);
    }
  }

  private quoted(start: number): { value: string; end: number } {
    const { text } = this;
    const quote = text[start];
    let value = "";
    let p = start + 1;
    for (;;) {
      const c = text[p];
      if (c === undefined || c === "\n") this.fail("UNTERMINATED_STRING", start, "the string is not closed on its line");
      if (c === quote) {
        if (quote === "'" && text[p + 1] === "'") {
          value += "'";
          p += 2;
          continue;
        }
        return { value, end: p + 1 };
      }
      if (quote === "'" || c !== "\\") {
        value += c;
        p++;
        continue;
      }
      const e = text[p + 1];
      const simple = e === undefined ? undefined : ESCAPES[e];
      if (simple !== undefined) {
        value += simple;
        p += 2;
        continue;
      }
      const code = e === "u" ? hex4(text.slice(p + 2, p + 6)) : null;
      if (code === null) this.fail("INVALID_ESCAPE", p, "unsupported escape sequence");
      if (code === 0) this.fail("CONTROL_CHARACTER", p, "a NUL character is not allowed");
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text[p + 6] === "\\" && text[p + 7] === "u" ? hex4(text.slice(p + 8, p + 12)) : null;
        if (low === null || low < 0xdc00 || low > 0xdfff) this.fail("INVALID_ESCAPE", p, "a surrogate escape must be paired");
        value += String.fromCharCode(code, low);
        p += 12;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        this.fail("INVALID_ESCAPE", p, "a surrogate escape must be paired");
      } else {
        value += String.fromCharCode(code);
        p += 6;
      }
    }
  }

  private skipFlowSpace(from: number): number {
    const { text } = this;
    let p = from;
    for (;;) {
      const c = text[p];
      if (c === " " || c === "\t" || c === "\n") p++;
      else if (c === "#" && p > 0 && isEnd(text[p - 1])) {
        while (p < text.length && text[p] !== "\n") p++;
      } else return p;
    }
  }

  /** The entries between `[`/`{` at `open` and the matching closer; `entry` parses one and returns where it ended. */
  private flowEntries(open: number, closer: string, entry: (at: number) => number): number {
    this.enter(open);
    let p = open + 1;
    for (;;) {
      p = this.skipFlowSpace(p);
      const c = this.text[p];
      if (c === undefined) this.fail("FLOW_SYNTAX", open, `unterminated flow collection: expected '${closer}'`);
      if (c === closer) break;
      if (c === ",") this.fail("FLOW_SYNTAX", p, "unexpected ','");
      p = this.skipFlowSpace(entry(p));
      if (this.text[p] === ",") {
        p++;
        continue;
      }
      if (this.text[p] === closer) break;
      this.fail("FLOW_SYNTAX", this.text[p] === undefined ? open : p, `expected ',' or '${closer}'`);
    }
    this.depth--;
    return p + 1;
  }

  private flowCollection(open: number): { value: YamlValue; end: number } {
    if (this.text[open] === "[") {
      const list: YamlValue[] = [];
      const end = this.flowEntries(open, "]", (at) => {
        this.path.push(list.length);
        const item = this.flowValue(at);
        this.record(at, at);
        this.path.pop();
        list.push(item.value);
        return item.end;
      });
      return { value: list, end };
    }
    const map: YamlMap = {};
    const firstLines = new Map<string, number>();
    const end = this.flowEntries(open, "}", (at) => {
      const c = this.text[at];
      if (c === "[" || c === "{") this.fail("FLOW_SYNTAX", at, "a flow collection cannot be a mapping key");
      const key = c === '"' || c === "'" ? this.quoted(at) : this.flowPlain(at);
      this.bump(at);
      this.checkKey(key.value, at, firstLines);
      let p = this.skipFlowSpace(key.end);
      if (this.text[p] !== ":") this.fail("FLOW_SYNTAX", at, "a mapping key needs a value (write 'key: value')");
      p = this.skipFlowSpace(p + 1);
      this.path.push(key.value);
      const empty = this.text[p] === "," || this.text[p] === "}";
      const value = empty ? { value: null, end: p } : this.flowValue(p);
      this.record(at, empty ? at : p);
      this.path.pop();
      map[key.value] = value.value;
      return value.end;
    });
    return { value: map, end };
  }

  private flowValue(at: number): { value: YamlValue; end: number } {
    const c = this.text[at]!;
    if (c === "[" || c === "{") return this.flowCollection(at);
    if (c === '"' || c === "'") {
      this.bump(at);
      return this.quoted(at);
    }
    this.bump(at);
    const plain = this.flowPlain(at);
    return { value: typePlain(plain.value), end: plain.end };
  }

  /** An unquoted flow scalar: it ends at `, ] }`, at `:` or `#` followed/preceded by a space, or at the line end. */
  private flowPlain(at: number): { value: string; end: number } {
    const { text } = this;
    this.checkPlainStart(text[at]!, text[at + 1], at, true);
    let end = at;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === "\n" || c === "," || c === "]" || c === "}") break;
      if (c === ":" && isEnd(text[end + 1])) break;
      if (c === "#" && isWs(text[end - 1])) break;
    }
    let trimmed = end;
    while (trimmed > at && isWs(text[trimmed - 1])) trimmed--;
    return { value: text.slice(at, trimmed), end };
  }
}

const ESCAPES: Readonly<Record<string, string | undefined>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
