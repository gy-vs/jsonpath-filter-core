/**
 * JSONPath engine with three-state filter evaluation.
 *
 * Three states for every expression result:
 *   - concrete value (including `null`, `false`, `0`, `''`)
 *   - missing       (the property/index does not exist)
 *
 * `null` is a concrete value and never collapses into "missing".
 * Existence testing (`exists`) and truth conversion (`truthy`) are
 * deliberately separate operations.
 */

// ---------------------------------------------------------------------------
// Three-state primitives
// ---------------------------------------------------------------------------

/** Sentinel representing a missing property or index. */
export const MISSING: unique symbol = Symbol.for('jsonpath.MISSING');
export type Missing = typeof MISSING;

/** Sentinel returned from an updater to delete a value. */
export const REMOVE: unique symbol = Symbol.for('jsonpath.REMOVE');
export type Remove = typeof REMOVE;

/** A tri-state value: either the MISSING sentinel or a concrete JSON value. */
export type Tri = unknown;

export function isMissing(value: Tri): value is Missing {
  return (value as unknown) === MISSING;
}

/** Existence test: `null`, `false`, `0` and `''` all exist. */
export function exists(result: EvalResult): boolean {
  return result.state === 'value';
}

/**
 * Truth conversion (only meaningful for concrete values):
 *   boolean -> itself
 *   number  -> every number except 0 and NaN
 *   string  -> non-empty
 *   null    -> false
 *   object/array -> true
 */
export function truthy(result: EvalResult): boolean {
  if (result.state === 'missing') return false;
  return asTruth(result.value);
}

export function asTruth(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  return true; // objects and arrays
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface EvalResult {
  /** 'value' means a concrete value was found (it may be null). */
  state: 'missing' | 'value';
  /** Concrete value; only meaningful when state === 'value'. */
  value: unknown;
  /** Source text of the expression node that produced this result. */
  expr: string;
  /** Start offset of that node inside the filter expression. */
  offset: number;
  /** End offset (exclusive). */
  end: number;
  /** Keys/indexes traversed while resolving a path expression. */
  resolvedPath?: (string | number)[];
  /**
   * True when `value` is the expanded node list of a wildcard path
   * (e.g. `@.tags[*]`). Such values use membership semantics in
   * comparisons instead of being treated as a plain array literal.
   */
  nodelist?: boolean;
}

export interface ExpressionErrorDetails {
  resolvedPath?: (string | number)[];
  leftPath?: (string | number)[];
  rightPath?: (string | number)[];
}

/** Thrown on type-incompatible operations or malformed expressions. */
export class ExpressionError extends Error {
  override readonly name = 'ExpressionError';
  constructor(
    message: string,
    readonly expression: string,
    readonly offset: number,
    readonly end: number,
    readonly details?: ExpressionErrorDetails,
  ) {
    const location =
      offset >= 0 ? ` (at offset ${offset}: "${expression.slice(offset, end)}")` : '';
    super(`${message}${location}`);
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ---------------------------------------------------------------------------
// Expression AST
// ---------------------------------------------------------------------------

type PathPart =
  | { type: 'field'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' };

interface NodeBase {
  pos: number;
  end: number;
}

export type Expr =
  | (NodeBase & { kind: 'path'; root: '$' | '@'; parts: PathPart[] })
  | (NodeBase & { kind: 'literal'; value: unknown })
  | (NodeBase & { kind: 'array'; items: Expr[] })
  | (NodeBase & { kind: 'object'; entries: { key: string; value: Expr }[] })
  | (NodeBase & { kind: 'unary'; op: '!' | '-'; arg: Expr })
  | (NodeBase & { kind: 'call'; name: string; args: Expr[] })
  | (NodeBase & { kind: 'binary'; op: string; left: Expr; right: Expr });

// ---------------------------------------------------------------------------
// Expression tokenizer
// ---------------------------------------------------------------------------

type RawTokenKind =
  | 'path'
  | 'number'
  | 'string'
  | 'ident'
  | 'op'
  | 'punct';

interface RawToken {
  kind: RawTokenKind;
  text: string;
  pos: number;
  end: number;
  value?: unknown; // number / string / parsed path parts
  root?: '$' | '@';
}

const IDENT_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;

function unescapeString(raw: string, offset: number): string {
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const e = raw[++i];
    switch (e) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '/': out += '/'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case 'u': {
        const hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new ExpressionError('invalid unicode escape', raw, offset, offset + raw.length);
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new ExpressionError(`invalid escape \\${e}`, raw, offset, offset + raw.length);
    }
  }
  return out;
}

function tokenizeExpression(src: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;

  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  /** Scan a path starting at '@' or '$'. */
  const scanPath = (): RawToken => {
    const start = i;
    const root = src[i] as '$' | '@';
    i++;
    const parts: PathPart[] = [];
    for (;;) {
      skipWs();
      if (src[i] === '.') {
        i++;
        skipWs();
        IDENT_RE.lastIndex = i;
        const m = IDENT_RE.exec(src);
        if (!m) throw new ExpressionError('expected field name after "."', src, i, i + 1);
        parts.push({ type: 'field', name: m[0] });
        i += m[0].length;
      } else if (src[i] === '[') {
        const open = i;
        i++;
        skipWs();
        if (src[i] === '*') {
          parts.push({ type: 'wildcard' });
          i++;
          skipWs();
        } else if (src[i] === "'" || src[i] === '"') {
          const q = src[i];
          const sStart = i;
          i++;
          while (i < src.length && src[i] !== q) {
            if (src[i] === '\\') i++;
            i++;
          }
          if (i >= src.length) {
            throw new ExpressionError('unterminated string in path', src, sStart, i);
          }
          const raw = src.slice(sStart, i + 1);
          i++;
          parts.push({ type: 'field', name: unescapeString(raw, sStart) });
          skipWs();
        } else {
          const numStart = i;
          if (src[i] === '-' || src[i] === '+') i++;
          const digits = /\d+/y;
          digits.lastIndex = i;
          const dm = digits.exec(src);
          if (!dm) throw new ExpressionError('invalid index in path bracket', src, open, i + 1);
          i += dm[0].length;
          skipWs();
          const index = Number(src.slice(numStart, i));
          if (!Number.isInteger(index)) {
            throw new ExpressionError('invalid index in path bracket', src, open, i + 1);
          }
          parts.push({ type: 'index', index });
        }
        if (src[i] !== ']') {
          throw new ExpressionError('expected "]" in path', src, i, i + 1);
        }
        i++;
      } else {
        break;
      }
    }
    return { kind: 'path', text: src.slice(start, i), pos: start, end: i, value: parts, root };
  };

  const scanString = (): RawToken => {
    const start = i;
    const q = src[i];
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') i++;
      i++;
    }
    if (i >= src.length) {
      throw new ExpressionError('unterminated string literal', src, start, i);
    }
    const raw = src.slice(start, i + 1);
    i++;
    return { kind: 'string', text: raw, pos: start, end: i, value: unescapeString(raw, start) };
  };

  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    const ch = src[i];

    if (ch === '@' || ch === '$') {
      tokens.push(scanPath());
      continue;
    }
    if (ch === "'" || ch === '"') {
      tokens.push(scanString());
      continue;
    }
    NUMBER_RE.lastIndex = i;
    const nm = NUMBER_RE.exec(src);
    if (nm) {
      const text = nm[0];
      tokens.push({ kind: 'number', text, pos: i, end: i + text.length, value: Number(text) });
      i += text.length;
      continue;
    }
    IDENT_RE.lastIndex = i;
    const im = IDENT_RE.exec(src);
    if (im) {
      tokens.push({ kind: 'ident', text: im[0], pos: i, end: i + im[0].length });
      i += im[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ kind: 'op', text: two, pos: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ('<>!-+'.includes(ch)) {
      tokens.push({ kind: 'op', text: ch, pos: i, end: i + 1 });
      i++;
      continue;
    }
    if ('()[]{},:'.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch, pos: i, end: i + 1 });
      i++;
      continue;
    }
    throw new ExpressionError(`unexpected character "${ch}"`, src, i, i + 1);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Expression parser (recursive descent)
//
//   orExpr   := andExpr ('||' andExpr)*
//   andExpr  := cmpExpr ('&&' cmpExpr)*
//   cmpExpr  := unary (CMP unary)*
//   unary    := ('!' | '-') unary | primary
//   primary  := path | literal | '(' orExpr ')' | arrayLit | objectLit
// ---------------------------------------------------------------------------

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

class ExpressionParser {
  private pos = 0;

  constructor(private readonly tokens: RawToken[], private readonly src: string) {}

  parse(): Expr {
    const expr = this.parseOr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new ExpressionError(`unexpected token "${t.text}"`, this.src, t.pos, t.end);
    }
    return expr;
  }

  private peek(): RawToken | undefined {
    return this.tokens[this.pos];
  }

  private take(text?: string): RawToken {
    const t = this.tokens[this.pos];
    if (!t || (text !== undefined && t.text !== text)) {
      const at = t ?? { pos: this.src.length, end: this.src.length, text: '<end>' };
      throw new ExpressionError(
        `expected ${text ? `"${text}"` : 'token'} but found "${at.text}"`,
        this.src,
        at.pos,
        at.end,
      );
    }
    this.pos++;
    return t;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek()?.text === '||') {
      this.take();
      const right = this.parseAnd();
      left = { kind: 'binary', op: '||', left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.peek()?.text === '&&') {
      this.take();
      const right = this.parseCmp();
      left = { kind: 'binary', op: '&&', left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private parseCmp(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || !COMPARISONS.has(t.text)) break;
      this.pos++;
      const right = this.parseUnary();
      left = { kind: 'binary', op: t.text, left, right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t && t.kind === 'op' && (t.text === '!' || t.text === '-')) {
      this.pos++;
      const arg = this.parseUnary();
      return { kind: 'unary', op: t.text as '!' | '-', arg, pos: t.pos, end: arg.end };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (!t) {
      throw new ExpressionError('expected expression', this.src, this.src.length, this.src.length);
    }

    if (t.kind === 'path') {
      this.pos++;
      return { kind: 'path', root: t.root!, parts: (t.value as PathPart[]) ?? [], pos: t.pos, end: t.end };
    }
    if (t.kind === 'number') {
      this.pos++;
      return { kind: 'literal', value: t.value, pos: t.pos, end: t.end };
    }
    if (t.kind === 'string') {
      this.pos++;
      return { kind: 'literal', value: t.value, pos: t.pos, end: t.end };
    }
    if (t.kind === 'ident') {
      this.pos++;
      switch (t.text) {
        case 'true': return { kind: 'literal', value: true, pos: t.pos, end: t.end };
        case 'false': return { kind: 'literal', value: false, pos: t.pos, end: t.end };
        case 'null': return { kind: 'literal', value: null, pos: t.pos, end: t.end };
        case 'NaN': return { kind: 'literal', value: NaN, pos: t.pos, end: t.end };
        default:
          if (this.peek()?.text === '(') {
            return this.parseCall(t.text, t.pos);
          }
          throw new ExpressionError(`unknown identifier "${t.text}"`, this.src, t.pos, t.end);
      }
    }
    if (t.text === '(') {
      this.take('(');
      const inner = this.parseOr();
      this.take(')');
      return inner;
    }
    if (t.text === '[') return this.parseArray();
    if (t.text === '{') return this.parseObject();

    throw new ExpressionError(`unexpected token "${t.text}"`, this.src, t.pos, t.end);
  }

  private parseCall(name: string, namePos: number): Expr {
    this.take('(');
    const args: Expr[] = [];
    if (this.peek()?.text !== ')') {
      args.push(this.parseOr());
      while (this.peek()?.text === ',') {
        this.take(',');
        args.push(this.parseOr());
      }
    }
    const close = this.take(')');
    return { kind: 'call', name, args, pos: namePos, end: close.end };
  }

  private parseArray(): Expr {
    const open = this.take('[');
    const items: Expr[] = [];
    if (this.peek()?.text !== ']') {
      items.push(this.parseOr());
      while (this.peek()?.text === ',') {
        this.take(',');
        items.push(this.parseOr());
      }
    }
    const close = this.take(']');
    return { kind: 'array', items, pos: open.pos, end: close.end };
  }

  private parseObject(): Expr {
    const open = this.take('{');
    const entries: { key: string; value: Expr }[] = [];
    if (this.peek()?.text !== '}') {
      for (;;) {
        const keyTok = this.take();
        let key: string;
        if (keyTok.kind === 'string') key = keyTok.value as string;
        else if (keyTok.kind === 'ident') key = keyTok.text;
        else throw new ExpressionError('expected object key', this.src, keyTok.pos, keyTok.end);
        this.take(':');
        const value = this.parseOr();
        entries.push({ key, value });
        if (this.peek()?.text !== ',') break;
        this.take(',');
      }
    }
    const close = this.take('}');
    return { kind: 'object', entries, pos: open.pos, end: close.end };
  }
}

export function parseExpression(expression: string): Expr {
  const tokens = tokenizeExpression(expression);
  if (tokens.length === 0) {
    throw new ExpressionError('empty expression', expression, 0, expression.length);
  }
  const ast = new ExpressionParser(tokens, expression).parse();
  EXPRESSION_SOURCES.set(ast, expression);
  return ast;
}

/** Source text for a root AST, when it came from parseExpression. */
const EXPRESSION_SOURCES = new WeakMap<Expr, string>();

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

interface EvalContext {
  current: unknown;
  root: unknown;
  source: string;
}

function resultOf(ast: Expr, state: 'missing' | 'value', value: unknown, ctx: EvalContext,
  resolvedPath?: (string | number)[], nodelist = false): EvalResult {
  return {
    state,
    value: state === 'missing' ? undefined : value,
    expr: ctx.source.slice(ast.pos, ast.end),
    offset: ast.pos,
    end: ast.end,
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(nodelist ? { nodelist: true } : {}),
  };
}

function fail(ast: Expr, message: string, ctx: EvalContext,
  details?: ExpressionErrorDetails): never {
  throw new ExpressionError(
    message,
    ctx.source,
    ast.pos,
    ast.end,
    details,
  );
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function evalPath(ast: Extract<Expr, { kind: 'path' }>, ctx: EvalContext): EvalResult {
  const resolved: (string | number)[] = [];
  let nodes: { value: unknown }[] = [{ value: ast.root === '$' ? ctx.root : ctx.current }];

  for (const part of ast.parts) {
    const next: { value: unknown }[] = [];
    for (const node of nodes) {
      const base = node.value;
      if (base === null || typeof base !== 'object') continue; // missing
      if (part.type === 'wildcard') {
        if (Array.isArray(base)) {
          for (const v of base) next.push({ value: v });
        } else {
          for (const key of Object.keys(base)) next.push({ value: (base as Record<string, unknown>)[key] });
        }
      } else if (part.type === 'field') {
        if (!Array.isArray(base) && hasOwn(base, part.name)) {
          next.push({ value: (base as Record<string, unknown>)[part.name] });
        }
      } else {
        // index
        if (Array.isArray(base)) {
          const len = base.length;
          const idx = part.index < 0 ? part.index + len : part.index;
          if (Number.isInteger(idx) && idx >= 0 && idx < len) next.push({ value: base[idx] });
        } else if (hasOwn(base, String(part.index))) {
          next.push({ value: (base as Record<string, unknown>)[String(part.index)] });
        }
      }
    }
    resolved.push(part.type === 'field' ? part.name : part.type === 'index' ? part.index : '*');
    nodes = next;
  }

  if (nodes.length === 0) return resultOf(ast, 'missing', undefined, ctx, resolved);
  if (ast.parts.some((p) => p.type === 'wildcard')) {
    return resultOf(ast, 'value', nodes.map((n) => n.value), ctx, resolved, true);
  }
  return resultOf(ast, 'value', nodes[0].value, ctx, resolved);
}

/**
 * Structural equality with no implicit coercion.
 * Returns true/false, or 'incompatible' when the values (or any nested
 * pair) have types that cannot be compared. Type incompatibility never
 * silently becomes false; the caller raises an ExpressionError.
 *
 * NaN strategy: equality follows SameValue semantics, so NaN == NaN.
 */
function samePrimitive(a: unknown, b: unknown): boolean {
  // SameValue except -0 and +0 are considered equal; NaN equals NaN.
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  return Object.is(a, b);
}

function structuralEqual(a: unknown, b: unknown): boolean | 'incompatible' {
  if (samePrimitive(a, b)) return true;
  if (a === null || b === null) return 'incompatible';
  if (typeof a !== typeof b) return 'incompatible';
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return 'incompatible';
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const r = structuralEqual(a[i], b[i]);
      if (r === 'incompatible') return 'incompatible';
      if (!r) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
      if (!hasOwn(b as object, key)) return false;
      const r = structuralEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      );
      if (r === 'incompatible') return 'incompatible';
      if (!r) return false;
    }
    return true;
  }
  return false; // primitives of the same type that were not equal
}

function evalComposite(ast: Extract<Expr, { kind: 'array' | 'object' }>, ctx: EvalContext): EvalResult {
  if (ast.kind === 'array') {
    const values: unknown[] = [];
    for (const item of ast.items) {
      const r = evalAst(item, ctx);
      if (r.state === 'missing') return resultOf(ast, 'missing', undefined, ctx);
      values.push(r.value);
    }
    return resultOf(ast, 'value', values, ctx);
  }
  const obj: Record<string, unknown> = {};
  for (const { key, value } of ast.entries) {
    const r = evalAst(value, ctx);
    if (r.state === 'missing') return resultOf(ast, 'missing', undefined, ctx);
    obj[key] = r.value;
  }
  return resultOf(ast, 'value', obj, ctx);
}

function evalCall(ast: Extract<Expr, { kind: 'call' }>, ctx: EvalContext): EvalResult {
  const args = ast.args.map((a) => evalAst(a, ctx));

  const arityError = (n: number): never =>
    fail(ast, `function ${ast.name}() expects ${n} argument(s), got ${args.length}`, ctx);

  const out = (value: boolean): EvalResult => resultOf(ast, 'value', value, ctx);

  switch (ast.name) {
    case 'isnull':
    case 'is_null': {
      if (args.length !== 1) arityError(1);
      return out(args[0].state === 'value' && args[0].value === null);
    }
    case 'ismissing':
    case 'is_missing': {
      if (args.length !== 1) arityError(1);
      return out(args[0].state === 'missing');
    }
    case 'exists': {
      if (args.length !== 1) arityError(1);
      return out(args[0].state === 'value');
    }
    case 'istrue': {
      if (args.length !== 1) arityError(1);
      return out(args[0].state === 'value' && asTruth(args[0].value));
    }
    case 'isfalse': {
      if (args.length !== 1) arityError(1);
      // "not truthy": a missing value is also non-true.
      return out(args[0].state === 'missing' || !asTruth(args[0].value));
    }
    case 'type': {
      if (args.length !== 1) arityError(1);
      if (args[0].state === 'missing') return resultOf(ast, 'value', 'missing', ctx);
      return resultOf(ast, 'value', typeName(args[0].value), ctx);
    }
    default:
      fail(ast, `unknown function "${ast.name}()"`, ctx);
  }
}

function evalAst(ast: Expr, ctx: EvalContext): EvalResult {
  switch (ast.kind) {
    case 'path':
      return evalPath(ast, ctx);

    case 'literal':
      return resultOf(ast, 'value', ast.value, ctx);

    case 'array':
    case 'object':
      return evalComposite(ast, ctx);

    case 'call':
      return evalCall(ast, ctx);

    case 'unary': {
      const inner = evalAst(ast.arg, ctx);
      if (inner.state === 'missing') return resultOf(ast, 'missing', undefined, ctx);
      if (ast.op === '!') {
        return resultOf(ast, 'value', !asTruth(inner.value), ctx);
      }
      // unary minus: numbers only; null/string/object are errors, not 0/NaN
      if (typeof inner.value !== 'number') {
        fail(ast, `unary "-" requires a number, got ${typeName(inner.value)}`, ctx, {
          resolvedPath: inner.resolvedPath,
        });
      }
      return resultOf(ast, 'value', -inner.value, ctx);
    }

    case 'binary': {
      const op = ast.op;

      if (op === '&&' || op === '||') {
        // Three-state short circuit (Kleene strong logic):
        //   false && x  -> false   (right side not evaluated)
        //   true  || x  -> true    (right side not evaluated)
        //   true  && x  -> truth(x); missing && x -> missing if x is missing
        //   false || x  -> truth(x); missing || x -> missing if x is missing
        // The right side is still evaluated whenever the left does not
        // decide the answer, so its type errors are never swallowed.
        const left = evalAst(ast.left, ctx);
        if (left.state !== 'missing') {
          const leftTruth = asTruth(left.value);
          if (op === '&&' && !leftTruth) return resultOf(ast, 'value', false, ctx);
          if (op === '||' && leftTruth) return resultOf(ast, 'value', true, ctx);
        }
        const right = evalAst(ast.right, ctx);
        const states = [left.state, right.state] as const;
        if (op === '&&') {
          // false dominates, then missing, then true.
          if (states.includes('value') &&
            ((left.state === 'value' && !asTruth(left.value)) ||
             (right.state === 'value' && !asTruth(right.value)))) {
            return resultOf(ast, 'value', false, ctx);
          }
          if (states.includes('missing')) return resultOf(ast, 'missing', undefined, ctx);
          return resultOf(ast, 'value', true, ctx);
        }
        // true dominates, then missing, then false.
        if (states.includes('value') &&
          ((left.state === 'value' && asTruth(left.value)) ||
           (right.state === 'value' && asTruth(right.value)))) {
          return resultOf(ast, 'value', true, ctx);
        }
        if (states.includes('missing')) return resultOf(ast, 'missing', undefined, ctx);
        return resultOf(ast, 'value', false, ctx);
      }

      const left = evalAst(ast.left, ctx);
      const right = evalAst(ast.right, ctx);

      // A missing operand makes the comparison false (rather than throwing);
      // the missing state is still visible from evaluateExpression, and
      // testFilter treats it as non-matching. null is concrete, so it never
      // reaches this branch and is compared normally.
      if (left.state === 'missing' || right.state === 'missing') {
        return resultOf(ast, 'missing', undefined, ctx);
      }

      const details: ExpressionErrorDetails = {
        leftPath: left.resolvedPath,
        rightPath: right.resolvedPath,
      };

      // Wildcard paths yield node lists. A list is compared element-wise
      // against the other operand (existence quantification), and pairwise
      // type incompatibilities raise an error rather than collapsing to
      // false. A plain array literal is NOT a node list and is compared
      // structurally.
      const leftList = left.nodelist ? (left.value as unknown[]) : null;
      const rightList = right.nodelist ? (right.value as unknown[]) : null;
      const leftItems = leftList ?? [left.value];
      const rightItems = rightList ?? [right.value];
      const listMode = leftList !== null || rightList !== null;

      if (op === '==' || op === '!=') {
        // Scalar case: a single incompatible pair is a type error.
        // Node-list case (RFC 9535): == is "any equal pair", != is
        // "any unequal comparable pair"; both can be true for a list, and
        // the comparison only throws when no pair is type-comparable.
        let equalPair = false;
        let unequalPair = false;
        for (const x of leftItems) {
          for (const y of rightItems) {
            const eq = structuralEqual(x, y);
            if (eq === 'incompatible') continue;
            if (eq) equalPair = true;
            else unequalPair = true;
          }
        }
        if (!equalPair && !unequalPair) {
          fail(
            ast,
            `cannot compare ${leftList ? 'node list of ' : ''}${typeName(left.value)} and ` +
              `${rightList ? 'node list of ' : ''}${typeName(right.value)} with ${op}: ` +
              'no type-compatible pair (no implicit coercion)',
            ctx,
            details,
          );
        }
        const outcome = op === '==' ? equalPair : unequalPair;
        return resultOf(ast, 'value', outcome, ctx);
      }

      // Ordering: numbers and strings only, same type on both sides.
      // NaN cannot be ordered. In list mode the comparison is existential
      // over all cross pairs, and only same-type pairs participate.
      let cmp = false;
      let orderable = false;
      let sawNaN = false;
      outer: for (const x of leftItems) {
        for (const y of rightItems) {
          if (typeof x !== 'number' && typeof x !== 'string') {
            if (!listMode) fail(ast, `cannot order value of type ${typeName(x)}`, ctx, details);
            continue;
          }
          if (typeof y !== 'number' && typeof y !== 'string') {
            if (!listMode) fail(ast, `cannot order value of type ${typeName(y)}`, ctx, details);
            continue;
          }
          if (typeof x !== typeof y) {
            if (!listMode) {
              fail(
                ast,
                `cannot order ${typeName(x)} against ${typeName(y)}: types are incompatible`,
                ctx,
                details,
              );
            }
            continue;
          }
          if (typeof x === 'number' && (Number.isNaN(x) || Number.isNaN(y as number))) {
            sawNaN = true;
            continue;
          }
          orderable = true;
          const ok =
            op === '<' ? (x as number) < (y as number)
            : op === '<=' ? (x as number) <= (y as number)
            : op === '>' ? (x as number) > (y as number)
            : (x as number) >= (y as number);
          if (ok) {
            cmp = true;
            break outer;
          }
        }
      }
      if (!orderable) {
        const reason = sawNaN
          ? `NaN cannot be ordered with "${op}" (NaN comparisons are only allowed via ==/!=, where NaN == NaN)`
          : listMode
            ? `cannot order ${typeName(left.value)} against ${typeName(right.value)} with "${op}": no type-compatible pair`
            : `cannot order ${typeName(left.value)} against ${typeName(right.value)} with "${op}"`;
        fail(ast, reason, ctx, details);
      }
      return resultOf(ast, 'value', cmp, ctx);
    }
  }
}

/**
 * Evaluate a filter expression against `current` (the `@` binding).
 * `root` (the `$` binding) defaults to `current`.
 */
export function evaluateExpression(
  expression: string | Expr,
  current: unknown,
  root: unknown = current,
): EvalResult {
  const source = typeof expression === 'string' ? expression : (EXPRESSION_SOURCES.get(expression) ?? '');
  const ast = typeof expression === 'string' ? parseExpression(expression) : expression;
  return evalAst(ast, { current, root, source });
}

/**
 * Decide whether a candidate matches a filter expression.
 *
 * A bare path is an EXISTENCE test: concrete values match, including
 * false, 0, '' and null; only missing values do not.
 * Any computed expression (literals, comparisons, logic) is truth-converted;
 * a missing propagated result means "no match" rather than an error.
 */
export function testFilter(
  expression: string | Expr,
  current: unknown,
  root: unknown = current,
): boolean {
  const ast = typeof expression === 'string' ? parseExpression(expression) : expression;
  const result = evaluateExpression(ast, current, root);
  if (result.state === 'missing') return false;
  if (ast.kind === 'path') return true; // path: existence, not truth
  return asTruth(result.value);
}

// ---------------------------------------------------------------------------
// Path parser
// ---------------------------------------------------------------------------

export type Segment =
  | { kind: 'root' }
  | { kind: 'field'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'filter'; expression: string; ast: Expr };

/** Backward-compatible alias. */
export type PathToken = Segment;
/** @deprecated use Segment */
export type Token = Segment;

const FIELD_IDENT_RE = /[A-Za-z_$][\w$]*/y;

export function parse(path: string): Segment[] {
  if (!path.startsWith('$')) {
    throw new Error(`JSONPath must start with "$", got: ${path}`);
  }
  const segments: Segment[] = [{ kind: 'root' }];
  let i = 1;

  const scanBracket = (): string => {
    // Called with i pointing at '['; returns inner text and consumes ']'.
    const start = i;
    let depth = 0;
    for (; i < path.length; i++) {
      const ch = path[i];
      if (ch === "'" || ch === '"') {
        const q = ch;
        i++;
        while (i < path.length && path[i] !== q) {
          if (path[i] === '\\') i++;
          i++;
        }
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) return path.slice(start + 1, i);
      }
    }
    throw new Error(`unterminated "[" in path: ${path}`);
  };

  while (i < path.length) {
    const ch = path[i];

    if (ch === '.') {
      i++;
      if (path[i] === '*') {
        segments.push({ kind: 'wildcard' });
        i++;
        continue;
      }
      FIELD_IDENT_RE.lastIndex = i;
      const m = FIELD_IDENT_RE.exec(path);
      if (!m) throw new Error(`expected field name after "." in: ${path}`);
      segments.push({ kind: 'field', name: m[0] });
      i += m[0].length;
      continue;
    }

    if (ch === '[') {
      const inner = scanBracket().trim();
      i++; // consume ']'
      if (inner.startsWith('?')) {
        const expression = inner.slice(1).trim();
        segments.push({ kind: 'filter', expression, ast: parseExpression(expression) });
      } else if (inner === '*') {
        segments.push({ kind: 'wildcard' });
      } else if (inner[0] === "'" || inner[0] === '"') {
        segments.push({ kind: 'field', name: unescapeString(inner, 0) });
      } else {
        const idx = Number(inner);
        if (!Number.isInteger(idx)) throw new Error(`invalid index "[${inner}]" in: ${path}`);
        segments.push({ kind: 'index', index: idx });
      }
      continue;
    }

    throw new Error(`unexpected character "${ch}" in path: ${path}`);
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Shared traversal (used identically by query and update)
// ---------------------------------------------------------------------------

export interface NodeRef {
  value: unknown;
  parent: Record<string, unknown> | unknown[] | null;
  key: string | number | null;
  /** Absolute data path from the root document. */
  path: (string | number)[];
}

function traverse(root: unknown, segments: Segment[]): NodeRef[] {
  let refs: NodeRef[] = [{ value: root, parent: null, key: null, path: [] }];

  for (const segment of segments.slice(1)) {
    const next: NodeRef[] = [];

    for (const ref of refs) {
      const value = ref.value;

      if (segment.kind === 'field') {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)
          && hasOwn(value, segment.name)) {
          next.push({
            value: (value as Record<string, unknown>)[segment.name],
            parent: value as Record<string, unknown>,
            key: segment.name,
            path: [...ref.path, segment.name],
          });
        }
        continue;
      }

      if (segment.kind === 'index') {
        if (Array.isArray(value)) {
          const idx = segment.index < 0 ? segment.index + value.length : segment.index;
          if (idx >= 0 && idx < value.length) {
            next.push({ value: value[idx], parent: value, key: idx, path: [...ref.path, idx] });
          }
        } else if (value !== null && typeof value === 'object'
          && hasOwn(value, String(segment.index))) {
          next.push({
            value: (value as Record<string, unknown>)[String(segment.index)],
            parent: value as Record<string, unknown>,
            key: String(segment.index),
            path: [...ref.path, String(segment.index)],
          });
        }
        continue;
      }

      if (segment.kind === 'wildcard') {
        if (Array.isArray(value)) {
          value.forEach((v, idx) => {
            next.push({ value: v, parent: value, key: idx, path: [...ref.path, idx] });
          });
        } else if (value !== null && typeof value === 'object') {
          for (const key of Object.keys(value)) {
            next.push({
              value: (value as Record<string, unknown>)[key],
              parent: value as Record<string, unknown>,
              key,
              path: [...ref.path, key],
            });
          }
        }
        continue;
      }

      // filter: same evaluator for query and update
      if (segment.kind !== 'filter') continue;
      if (Array.isArray(value)) {
        value.forEach((item, idx) => {
          if (testFilter(segment.ast, item, root)) {
            next.push({ value: item, parent: value, key: idx, path: [...ref.path, idx] });
          }
        });
      } else if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) {
          const item = (value as Record<string, unknown>)[key];
          if (testFilter(segment.ast, item, root)) {
            next.push({
              value: item,
              parent: value as Record<string, unknown>,
              key,
              path: [...ref.path, key],
            });
          }
        }
      }
    }

    refs = next;
  }

  return refs;
}

export function queryNodes(root: unknown, path: string | Segment[]): NodeRef[] {
  const segments = typeof path === 'string' ? parse(path) : path;
  return traverse(root, segments);
}

export function query(root: unknown, path: string | Segment[]): unknown[] {
  return queryNodes(root, path).map((ref) => ref.value);
}

// ---------------------------------------------------------------------------
// Update (reuses the same traversal / evaluator)
// ---------------------------------------------------------------------------

export interface Change {
  path: (string | number)[];
  type: 'set' | 'remove';
  oldValue: unknown;
  newValue?: unknown;
}

export type Updater = (
  value: unknown,
  ref: NodeRef,
) => unknown | Remove;

export function update(
  root: unknown,
  path: string | Segment[],
  updater: Updater,
): Change[] {
  const refs = queryNodes(root, path);
  const changes: Change[] = [];

  interface Removal {
    parent: Record<string, unknown> | unknown[];
    key: string | number;
  }
  const removals: Removal[] = [];

  for (const ref of refs) {
    if (ref.parent === null) {
      throw new Error('cannot replace the root document in place');
    }
    const outcome = updater(ref.value, ref);
    if ((outcome as unknown) === REMOVE) {
      removals.push({ parent: ref.parent, key: ref.key! });
      changes.push({ path: ref.path, type: 'remove', oldValue: ref.value });
      continue;
    }
    if (outcome !== ref.value) {
      (ref.parent as Record<string | number, unknown>)[ref.key!] = outcome;
      changes.push({ path: ref.path, type: 'set', oldValue: ref.value, newValue: outcome });
    }
  }

  // Apply array removals grouped per array, highest index first.
  const byArray = new Map<unknown[], number[]>();
  for (const r of removals) {
    if (Array.isArray(r.parent)) {
      const list = byArray.get(r.parent) ?? [];
      list.push(r.key as number);
      byArray.set(r.parent, list);
    } else {
      delete (r.parent as Record<string, unknown>)[r.key as string];
    }
  }
  for (const [arr, keys] of byArray) {
    for (const key of [...new Set(keys)].sort((a, b) => b - a)) {
      arr.splice(key, 1);
    }
  }

  return changes;
}
