/**
 * JSONPath engine with three-state filter evaluation.
 *
 * Every resolved value is one of:
 *   - MISSING  : the property / index does not exist (Nothing)
 *   - NULL     : JSON null exists
 *   - concrete : any actual JS/JSON value (false, 0, "", [], NaN, ...)
 *
 * Existence testing (exists) and truthiness conversion (truthy) are separate:
 * a filter node like [?(@.enabled)] tests EXISTENCE, so false / 0 / "" / []
 * all match; only MISSING is excluded. null exists and therefore matches too.
 */

// ---------------------------------------------------------------------------
// Three-state values
// ---------------------------------------------------------------------------

export interface Missing {
    readonly state: 'missing';
}
export interface NullValue {
    readonly state: 'null';
}
export interface Concrete<T = unknown> {
    readonly state: 'concrete';
    readonly value: T;
}
export type Tri<T = unknown> = Missing | NullValue | Concrete<T>;

export const MISSING: Missing = { state: 'missing' };
export const NULL: NullValue = { state: 'null' };

/** Box a plain JS value into the three-state representation. */
export function concrete<T>(value: T): Concrete<T> {
    return { state: 'concrete', value };
}

/** Box an untrusted JS value. `undefined` is treated as MISSING. */
export function box(value: unknown): Tri {
    if (value === undefined) return MISSING;
    if (value === null) return NULL;
    return { state: 'concrete', value };
}

/** True for null and concrete; false only for MISSING. */
export function exists(v: Tri): boolean {
    return v.state !== 'missing';
}

/**
 * Truthiness conversion. Kept deliberately separate from existence:
 * MISSING and null are falsy; concrete values follow JS truthiness,
 * so false / 0 / "" are falsy while [] and NaN are truthy.
 */
export function truthy(v: Tri): boolean {
    return v.state === 'concrete' && Boolean(v.value);
}

// ---------------------------------------------------------------------------
// Errors (carry expression-path diagnostics)
// ---------------------------------------------------------------------------

export type ErrorCode = 'EPARSE' | 'ETYPE' | 'ENAN';

export class JsonPathError extends Error {
    readonly code: ErrorCode;
    /** Full filter expression being evaluated when the error occurred. */
    readonly expression: string | undefined;
    /** Source text of the offending sub-expression. */
    readonly offending: string | undefined;
    /** Resolved JSONPath (segments) at which the error occurred. */
    readonly path: (string | number)[];
    readonly detail: string | undefined;

    constructor(
        code: ErrorCode,
        message: string,
        info: {
            expression?: string;
            offending?: string;
            path?: (string | number)[];
            detail?: string;
        } = {},
    ) {
        super(message);
        this.name = 'JsonPathError';
        this.code = code;
        this.expression = info.expression;
        this.offending = info.offending;
        this.path = info.path ?? [];
        this.detail = info.detail;
    }
}

// ---------------------------------------------------------------------------
// Path / filter AST
// ---------------------------------------------------------------------------

export interface FieldStep {
    kind: 'field';
    value: string;
}
export interface IndexStep {
    kind: 'index';
    value: number;
}
export interface WildcardStep {
    kind: 'wildcard';
}
export type PathStep = FieldStep | IndexStep | WildcardStep;

interface NodeRange {
    s: number;
    e: number;
}
export type Expr =
    | ({ t: 'path'; root: 'current' | 'root'; steps: PathStep[] } & NodeRange)
    | ({ t: 'lit'; tri: Tri } & NodeRange)
    | ({ t: 'not'; sub: Expr } & NodeRange)
    | ({ t: 'cmp'; op: CmpOp; l: Expr; r: Expr } & NodeRange)
    | ({ t: 'log'; op: '&&' | '||'; l: Expr; r: Expr } & NodeRange)
    | ({ t: 'paren'; sub: Expr } & NodeRange);

export type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type Token =
    | { kind: 'root' }
    | { kind: 'field'; value: string }
    | { kind: 'index'; value: number }
    | { kind: 'wildcard' }
    | { kind: 'filter'; expr: string; ast: Expr };

// ---------------------------------------------------------------------------
// Filter expression parser
// ---------------------------------------------------------------------------

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$-]/;
const DIGIT = /[0-9]/;

function unescapeString(raw: string): string {
    const body = raw.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== '\\') {
            out += c;
            continue;
        }
        const n = body[++i];
        if (n === 'u') {
            out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
            i += 4;
        } else if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else out += n ?? '';
    }
    return out;
}

function parseFilter(src: string): Expr {
    let p = 0;

    const ws = () => {
        while (p < src.length && /\s/.test(src[p])) p++;
    };
    const fail = (msg: string, at = p): never => {
        throw new JsonPathError('EPARSE', msg, {
            expression: src,
            offending: src.slice(at, Math.min(at + 16, src.length)),
            detail: `offset ${at}`,
        });
    };

    function readQuoted(open: number): { value: string; end: number } {
        let i = open + 1;
        while (i < src.length) {
            if (src[i] === '\\') i += 2;
            else if (src[i] === src[open]) return { value: unescapeString(src.slice(open, i + 1)), end: i + 1 };
            else i++;
        }
        return fail('unterminated string', open);
    }

    function readIdent(at: number): string {
        let i = at;
        while (i < src.length && IDENT_PART.test(src[i])) i++;
        return src.slice(at, i);
    }

    /** Parse @... / $... path beginning at the @ or $. */
    function readPath(at: number): Expr {
        const root = src[at] === '@' ? 'current' : 'root';
        let i = at + 1;
        const steps: PathStep[] = [];
        for (;;) {
            if (src[i] === '.') {
                i++;
                if (src[i] === '*') {
                    steps.push({ kind: 'wildcard' });
                    i++;
                } else if (IDENT_START.test(src[i] ?? '')) {
                    const name = readIdent(i);
                    i += name.length;
                    steps.push({ kind: 'field', value: name });
                } else {
                    fail('expected name after "."', i);
                }
            } else if (src[i] === '[') {
                let depth = 1;
                let j = i + 1;
                let quote = '';
                while (j < src.length && depth > 0) {
                    const c = src[j];
                    if (quote) {
                        if (c === '\\') j++;
                        else if (c === quote) quote = '';
                    } else if (c === '"' || c === "'") quote = c;
                    else if (c === '[') depth++;
                    else if (c === ']') depth--;
                    j++;
                }
                if (depth !== 0) fail('unterminated bracket', i);
                const inner = src.slice(i + 1, j - 1).trim();
                if (inner === '*') steps.push({ kind: 'wildcard' });
                else if (/^-?\d+$/.test(inner)) steps.push({ kind: 'index', value: Number(inner) });
                else if (
                    (inner.startsWith("'") || inner.startsWith('"')) &&
                    inner.endsWith(inner[0]) &&
                    inner.length >= 2
                ) {
                    steps.push({ kind: 'field', value: unescapeString(inner) });
                } else fail(`unsupported bracket segment [${inner}]`, i);
                i = j;
            } else break;
        }
        return { t: 'path', root, steps, s: at, e: i };
    }

    function readNumber(at: number): Expr {
        const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(at));
        if (!m) return fail('invalid number', at);
        const text = m[0];
        p = at + text.length;
        return { t: 'lit', tri: concrete(Number(text)), s: at, e: p };
    }

    function parsePrimary(): Expr {
        ws();
        const start = p;
        const c = src[p];
        if (c === '@' || c === '$') {
            const path = readPath(p);
            p = path.e;
            return path;
        }
        if (c === "'" || c === '"') {
            const r = readQuoted(p);
            p = r.end;
            return { t: 'lit', tri: concrete(r.value), s: start, e: p };
        }
        if (c === '-' || DIGIT.test(c ?? '')) return readNumber(p);
        if (c === '(') {
            p++;
            const inner = parseOr();
            ws();
            if (src[p] !== ')') fail("expected ')'", p);
            p++;
            return { t: 'paren', sub: inner, s: start, e: p };
        }
        if (IDENT_START.test(c ?? '')) {
            const word = readIdent(p);
            p += word.length;
            if (word === 'true') return { t: 'lit', tri: concrete(true), s: start, e: p };
            if (word === 'false') return { t: 'lit', tri: concrete(false), s: start, e: p };
            if (word === 'null') return { t: 'lit', tri: NULL, s: start, e: p };
            return fail(`unknown identifier '${word}'`, start);
        }
        return fail('expected expression');
    }

    function parseUnary(): Expr {
        ws();
        const start = p;
        if (src[p] === '!' && src[p + 1] !== '=') {
            p++;
            const sub = parseUnary();
            return { t: 'not', sub, s: start, e: p };
        }
        return parsePrimary();
    }

    const CMP_OPS: CmpOp[] = ['==', '!=', '<=', '>=', '<', '>'];
    function parseCmp(): Expr {
        const l = parseUnary();
        ws();
        const op = CMP_OPS.find((o) => src.startsWith(o, p));
        if (!op) return l;
        p += op.length;
        const r = parseUnary();
        return { t: 'cmp', op, l, r, s: l.s, e: r.e };
    }

    function parseAnd(): Expr {
        let l = parseCmp();
        for (;;) {
            ws();
            if (src.startsWith('&&', p)) {
                p += 2;
                const r = parseCmp();
                l = { t: 'log', op: '&&', l, r, s: l.s, e: r.e };
            } else return l;
        }
    }

    function parseOr(): Expr {
        let l = parseAnd();
        for (;;) {
            ws();
            if (src.startsWith('||', p)) {
                p += 2;
                const r = parseAnd();
                l = { t: 'log', op: '||', l, r, s: l.s, e: r.e };
            } else return l;
        }
    }

    const ast = parseOr();
    ws();
    if (p !== src.length) fail('unexpected trailing input', p);
    return ast;
}

// ---------------------------------------------------------------------------
// JSONPath parser
// ---------------------------------------------------------------------------

export function parse(path: string): Token[] {
    if (!path.startsWith('$')) {
        throw new JsonPathError('EPARSE', "JSONPath must start with '$'", { expression: path, offending: path });
    }
    const out: Token[] = [{ kind: 'root' }];
    let i = 1;

    const readIdent = (at: number) => {
        let j = at;
        while (j < path.length && IDENT_PART.test(path[j])) j++;
        return path.slice(at, j);
    };

    while (i < path.length) {
        const c = path[i];
        if (c === '.') {
            i++;
            if (path[i] === '*') {
                out.push({ kind: 'wildcard' });
                i++;
            } else if (IDENT_START.test(path[i] ?? '')) {
                const name = readIdent(i);
                i += name.length;
                out.push({ kind: 'field', value: name });
            } else {
                throw new JsonPathError('EPARSE', 'expected name after "."', {
                    expression: path,
                    offending: path.slice(i, i + 1),
                    detail: `offset ${i}`,
                });
            }
        } else if (c === '[') {
            // Find the matching ']', aware of strings and nested brackets
            // (filters may themselves contain bracketed paths).
            let depth = 1;
            let j = i + 1;
            let quote = '';
            while (j < path.length && depth > 0) {
                const ch = path[j];
                if (quote) {
                    if (ch === '\\') j++;
                    else if (ch === quote) quote = '';
                } else if (ch === '"' || ch === "'") quote = ch;
                else if (ch === '[' || ch === '(') depth++;
                else if (ch === ']' || ch === ')') depth--;
                j++;
            }
            if (depth !== 0) {
                throw new JsonPathError('EPARSE', 'unterminated bracket', {
                    expression: path,
                    offending: path.slice(i),
                    detail: `offset ${i}`,
                });
            }
            const inner = path.slice(i + 1, j - 1);
            i = j;

            if (inner.startsWith('?(')) {
                if (!inner.endsWith(')')) {
                    throw new JsonPathError('EPARSE', 'malformed filter expression', {
                        expression: path,
                        offending: inner,
                    });
                }
                const expr = inner.slice(2, -1);
                out.push({ kind: 'filter', expr, ast: parseFilter(expr) });
            } else if (inner.trim() === '*') {
                out.push({ kind: 'wildcard' });
            } else if (
                (inner.startsWith("'") || inner.startsWith('"')) &&
                inner.endsWith(inner[0]) &&
                inner.length >= 2
            ) {
                out.push({ kind: 'field', value: unescapeString(inner) });
            } else if (/^-?\d+$/.test(inner.trim())) {
                out.push({ kind: 'index', value: Number(inner.trim()) });
            } else if (IDENT_START.test(inner[0] ?? '')) {
                out.push({ kind: 'field', value: inner });
            } else {
                throw new JsonPathError('EPARSE', `unsupported bracket segment [${inner}]`, {
                    expression: path,
                    offending: inner,
                });
            }
        } else {
            throw new JsonPathError('EPARSE', `unexpected character '${c}'`, {
                expression: path,
                offending: c,
                detail: `offset ${i}`,
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Shared evaluator
// ---------------------------------------------------------------------------

export interface FilterContext {
    root: unknown;
    current?: unknown;
}

interface ResolvedNode {
    tri: Tri;
    loc: (string | number)[];
}

interface EvalState {
    source: string | undefined;
    root: Tri;
    current: Tri;
    /** Path of the @ node inside the enclosing selection (empty for standalone). */
    baseLoc: (string | number)[];
}

function evalState(ctx: {
    source?: string;
    root: Tri;
    current: Tri;
    baseLoc: (string | number)[];
}): EvalState {
    return {
        source: ctx.source,
        root: ctx.root,
        current: ctx.current,
        baseLoc: ctx.baseLoc,
    };
}

function isArrayLikeObject(v: unknown): v is unknown[] {
    return Array.isArray(v);
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Apply one path step. Shared by selection and by in-expression paths.
 *
 * Navigation semantics:
 *   MISSING + field/index          -> MISSING (propagated)
 *   null    + field/index          -> MISSING
 *   null/MISSING + wildcard        -> no nodes
 *   primitive + field/index        -> ETYPE error (never silently missing)
 *   primitive + wildcard           -> no nodes
 *   array  + named field           -> MISSING
 *   object + numeric index         -> reads the matching string key
 */
function applyStep(node: ResolvedNode, step: PathStep, st: EvalState, exprNode?: NodeRange): ResolvedNode[] {
    const tri = node.tri;
    if (tri.state === 'missing') {
        if (step.kind === 'wildcard') return [];
        return [{ tri: MISSING, loc: [...node.loc, step.value] }];
    }
    if (tri.state === 'null') {
        if (step.kind === 'wildcard') return [];
        return [{ tri: MISSING, loc: [...node.loc, step.value] }];
    }

    const v = tri.value;

    if (step.kind === 'wildcard') {
        if (isArrayLikeObject(v)) {
            return v.map((item, i) => ({ tri: box(item), loc: [...node.loc, i] }));
        }
        if (isPlainObject(v)) {
            return Object.keys(v).map((k) => ({ tri: box(v[k]), loc: [...node.loc, k] }));
        }
        return [];
    }

    const key: string | number = step.kind === 'field' ? step.value : step.value;

    if (step.kind === 'field') {
        if (isArrayLikeObject(v)) return [{ tri: MISSING, loc: [...node.loc, key] }];
        if (!isPlainObject(v)) {
            throw typeError(
                `cannot read field '${step.value}' from ${describeTri(tri)}`,
                st,
                node.loc,
                exprNode,
            );
        }
        const next = Object.prototype.hasOwnProperty.call(v, step.value) ? box(v[step.value]) : MISSING;
        return [{ tri: next, loc: [...node.loc, key] }];
    }

    // index. On objects a numeric index selects the matching string key
    // (e.g. obj[0] reads obj["0"]); negative / out-of-range -> MISSING.
    if (isPlainObject(v)) {
        const name = String(step.value);
        const next = Object.prototype.hasOwnProperty.call(v, name) ? box(v[name]) : MISSING;
        return [{ tri: next, loc: [...node.loc, name] }];
    }
    if (!isArrayLikeObject(v)) {
        throw typeError(`cannot index ${describeTri(tri)}`, st, node.loc, exprNode);
    }
    const idx = step.value;
    if (Number.isInteger(idx) && idx >= 0 && idx < v.length) {
        return [{ tri: box(v[idx]), loc: [...node.loc, idx] }];
    }
    return [{ tri: MISSING, loc: [...node.loc, idx] }];
}

function describeTri(tri: Tri): string {
    if (tri.state === 'missing') return 'missing';
    if (tri.state === 'null') return 'null';
    const v = tri.value;
    if (Array.isArray(v)) return 'array';
    if (v === null) return 'null';
    return typeof v;
}

function typeError(
    message: string,
    st: EvalState,
    loc: (string | number)[],
    node?: NodeRange,
): JsonPathError {
    return new JsonPathError('ETYPE', message, {
        expression: st.source,
        offending: node && st.source ? st.source.slice(node.s, node.e) : undefined,
        path: diagPath(st, loc),
    });
}

function evalPath(path: Extract<Expr, { t: 'path' }>, st: EvalState): ResolvedNode[] {
    // Both @ and $ paths start at their own root. loc is relative to that
    // root; diagnostics join it with the enclosing selection location.
    const start: ResolvedNode =
        path.root === 'root'
            ? { tri: st.root, loc: [] }
            : { tri: st.current, loc: [] };
    let nodes = [start];
    for (const step of path.steps) {
        nodes = nodes.flatMap((n) => applyStep(n, step, st, path));
    }
    return nodes;
}

// --- three-state comparison -------------------------------------------------

function triEq(a: Tri, b: Tri): boolean {
    if (a.state === 'missing' || b.state === 'missing') {
        return a.state === 'missing' && b.state === 'missing';
    }
    if (a.state === 'null' || b.state === 'null') {
        return a.state === 'null' && b.state === 'null';
    }
    const x = a.value;
    const y = b.value;
    if (typeof x === 'number' && typeof y === 'number') {
        // SameValue: NaN equals NaN, +0 equals -0. This is the documented
        // NaN strategy for equality (ordering with NaN is an error).
        return Object.is(x, y);
    }
    if (typeof x !== typeof y) return false;
    if (typeof x === 'object') return x === y;
    return x === y;
}

/**
 * Ordering result. Only concrete same-typed numbers/strings are orderable.
 *   - null on either side yields Nothing (the test is simply not satisfied),
 *     mirroring the three-state model rather than collapsing onto false.
 *   - NaN is an explicit ENaN error.
 *   - any other type mismatch is an explicit ETYPE error.
 * Errors never silently become false.
 */
function diagPath(st: EvalState, loc: (string | number)[] = []): (string | number)[] {
    return [...st.baseLoc, ...loc];
}

function triCompare(
    op: '<' | '<=' | '>' | '>=',
    a: Tri,
    b: Tri,
    st: EvalState,
    node: NodeRange,
): 'nothing' | boolean {
    if (a.state === 'null' || b.state === 'null') {
        return 'nothing';
    }
    // Callers filter MISSING before ordering; keep the guard for safety.
    if (a.state === 'missing' || b.state === 'missing') {
        return 'nothing';
    }
    const x = a.value;
    const y = b.value;
    if (typeof x === 'number' && typeof y === 'number') {
        if (Number.isNaN(x) || Number.isNaN(y)) {
            throw new JsonPathError('ENAN', 'NaN cannot be ordered', {
                expression: st.source,
                offending: st.source?.slice(node.s, node.e),
                path: diagPath(st),
            });
        }
        return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
    }
    if (typeof x === 'string' && typeof y === 'string') {
        return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
    }
    throw new JsonPathError('ETYPE', `cannot compare ${typeof x} and ${typeof y} with ${op}`, {
        expression: st.source,
        offending: st.source?.slice(node.s, node.e),
        path: diagPath(st),
    });
}

// --- expression evaluation --------------------------------------------------

function operandNodes(e: Expr, st: EvalState): ResolvedNode[] {
    if (e.t === 'path') return evalPath(e, st);
    if (e.t === 'paren') return operandNodes(e.sub, st);
    // literal / computed expression collapses to one value
    return [{ tri: evalTri(e, st), loc: [] }];
}

function evalComparison(node: Extract<Expr, { t: 'cmp' }>, st: EvalState): boolean {
    const ln = operandNodes(node.l, st);
    const rn = operandNodes(node.r, st);
    if (node.op === '==' || node.op === '!=') {
        // Equality is defined over the three states. For !=, a missing
        // operand (a path that selects nothing) propagates Nothing rather
        // than negating into true: missing must not collapse onto null or
        // concrete values.
        const le = ln.filter((n) => n.tri.state !== 'missing');
        const re = rn.filter((n) => n.tri.state !== 'missing');
        if (node.op === '!=' && le.length + re.length !== ln.length + rn.length) {
            return false;
        }
        let hit = false;
        for (const a of ln) {
            for (const b of rn) {
                if (triEq(a.tri, b.tri)) {
                    hit = true;
                    break;
                }
            }
            if (hit) break;
        }
        return node.op === '==' ? hit : !hit;
    }
    // Ordering. Missing operands propagate Nothing (the comparison is not
    // applied); null operands also yield Nothing at the pair level. NaN and
    // type-incompatible concrete operands are explicit errors that never
    // silently become false.
    const le = ln.filter((n) => n.tri.state !== 'missing');
    const re = rn.filter((n) => n.tri.state !== 'missing');
    if (le.length !== ln.length || re.length !== rn.length) return false;
    // All-Nothing pairs (missing / null operands) simply do not satisfy the
    // ordering; NaN and incompatible concrete types still throw above.
    for (const a of le) {
        for (const b of re) {
            const r = triCompare(node.op, a.tri, b.tri, st, node);
            if (r !== 'nothing' && r) return true;
        }
    }
    return false;
}

function evalTri(e: Expr, st: EvalState): Tri {
    switch (e.t) {
        case 'lit':
            return e.tri;
        case 'path': {
            const nodes = evalPath(e, st);
            return nodes.length ? nodes[0].tri : MISSING;
        }
        case 'paren':
            return evalTri(e.sub, st);
        case 'not':
            return concrete(!testExpr(e.sub, st));
        case 'cmp':
            return concrete(evalComparison(e, st));
        case 'log':
            return concrete(testExpr(e, st));
    }
}

/**
 * Boolean test of a filter sub-expression.
 *
 * Paths test EXISTENCE (false / 0 / "" / [] / null all match when present);
 * literals and computed booleans go through truthiness conversion.
 * && and || short-circuit and only evaluate the branches they need.
 */
function testExpr(e: Expr, st: EvalState): boolean {
    switch (e.t) {
        case 'path':
            return evalPath(e, st).some((n) => exists(n.tri));
        case 'lit':
            return truthy(e.tri);
        case 'paren':
            return testExpr(e.sub, st);
        case 'not':
            return !testExpr(e.sub, st);
        case 'cmp':
            return evalComparison(e, st);
        case 'log': {
            const lv = testExpr(e.l, st);
            if (e.op === '&&') return lv && testExpr(e.r, st);
            return lv || testExpr(e.r, st);
        }
    }
}

// ---------------------------------------------------------------------------
// Public filter API
// ---------------------------------------------------------------------------

export type TriResult = Tri & {
    /** Expression text that produced this value. */
    expression: string;
};

/** Evaluate a filter expression, returning the raw three-state value. */
export function evalFilter(expression: string, ctx: FilterContext): TriResult {
    const ast = parseFilter(expression);
    const st = evalState({
        source: expression,
        root: box(ctx.root),
        current: box(ctx.current),
        baseLoc: [],
    });
    const tri = evalTri(ast, st);
    return { ...tri, expression };
}

/** Boolean test of a filter expression (existence semantics for bare paths). */
export function testFilter(expression: string, ctx: FilterContext): boolean {
    const ast = parseFilter(expression);
    const st = evalState({
        source: expression,
        root: box(ctx.root),
        current: box(ctx.current),
        baseLoc: [],
    });
    return testExpr(ast, st);
}

// ---------------------------------------------------------------------------
// Selection (shared by query and update)
// ---------------------------------------------------------------------------

export interface Match {
    value: unknown;
    /** true when the match exists; false means a missing (Nothing) result. */
    present: boolean;
    path: (string | number)[];
}

interface WalkNode {
    tri: Tri;
    loc: (string | number)[];
}

function toPathStep(tok: Token): PathStep | undefined {
    if (tok.kind === 'field') return { kind: 'field', value: tok.value };
    if (tok.kind === 'index') return { kind: 'index', value: tok.value };
    if (tok.kind === 'wildcard') return { kind: 'wildcard' };
    return undefined;
}

export function select(root: unknown, path: string | Token[]): Match[] {
    const tokens = typeof path === 'string' ? parse(path) : path;
    let nodes: WalkNode[] = [{ tri: box(root), loc: [] }];

    for (const tok of tokens.slice(1)) {
        if (tok.kind === 'filter') {
            // A filter is a bracket selector. On an array it tests each
            // element; on every other node type (object, null, primitive)
            // it tests that single node itself. A MISSING node produces
            // nothing. Filtering object members is not part of this grammar.
            nodes = nodes.flatMap((n) => {
                const tri = n.tri;
                if (tri.state === 'missing') return [];
                let candidates: WalkNode[];
                const cv = tri.state === 'concrete' ? tri.value : undefined;
                if (Array.isArray(cv)) {
                    candidates = cv.map((item, i) => ({
                        tri: box(item),
                        loc: [...n.loc, i],
                    }));
                } else {
                    candidates = [n];
                }
                return candidates.filter((c) =>
                    testExpr(
                        tok.ast,
                        evalState({
                            source: tok.expr,
                            root: box(root),
                            current: c.tri,
                            baseLoc: c.loc,
                        }),
                    ),
                );
            });
        } else {
            const step = toPathStep(tok);
            if (step) {
                nodes = nodes.flatMap((n) =>
                    applyStep(
                        n,
                        step,
                        evalState({ root: box(root), current: MISSING, baseLoc: [] }),
                    ),
                );
            }
        }
    }

    return nodes.map((n) => ({
        value:
            n.tri.state === 'concrete'
                ? n.tri.value
                : n.tri.state === 'null'
                  ? null
                  : undefined,
        present: n.tri.state !== 'missing',
        path: n.loc,
    }));
}

/** Return the concrete values selected by `path` (missing results dropped). */
export function query(root: unknown, path: string | Token[]): unknown[] {
    return select(root, path)
        .filter((m) => m.present)
        .map((m) => m.value);
}

// ---------------------------------------------------------------------------
// Update (uses the exact same evaluator as query)
// ---------------------------------------------------------------------------

export interface Change {
    path: (string | number)[];
    oldValue: unknown;
    newValue: unknown;
}

export interface UpdateResult {
    root: unknown;
    changes: Change[];
}

/**
 * Replace every value selected by `path`. The replacer receives the current
 * value and its segment path; returning `undefined` deletes the member
 * (object key) or splices the array element out.
 *
 * Selection goes through the same `select` evaluator as `query`, so query
 * and update always agree on which nodes match.
 */
export function update(
    root: unknown,
    path: string | Token[],
    replacer: (value: unknown, path: (string | number)[]) => unknown,
): UpdateResult {
    // select() is the exact same evaluator used by query(), so query and
    // update always agree on which nodes match.
    const matches = select(root, path).filter((m) => m.present);
    const changes: Change[] = [];
    let nextRoot = root;

    interface Pending {
        match: Match;
        newValue: unknown;
    }
    const replacements: Pending[] = [];
    // Array deletions grouped by parent location; indices deleted in
    // descending order so earlier splices don't shift pending indices.
    const deletions = new Map<string, { loc: (string | number)[]; keys: Set<number | string> }>();

    for (const m of matches) {
        const newValue = replacer(m.value, m.path);
        changes.push({ path: m.path, oldValue: m.value, newValue });
        if (newValue === undefined && m.path.length > 0) {
            const loc = m.path.slice(0, -1);
            const key = m.path[m.path.length - 1];
            const id = loc.join('/');
            let g = deletions.get(id);
            if (!g) {
                g = { loc, keys: new Set() };
                deletions.set(id, g);
            }
            g.keys.add(key);
        } else {
            replacements.push({ match: m, newValue });
        }
    }

    // Replacements happen first in selection (document) order.
    for (const { match, newValue } of replacements) {
        if (match.path.length === 0) {
            nextRoot = newValue;
            continue;
        }
        const parentLoc = match.path.slice(0, -1);
        const key = match.path[match.path.length - 1];
        let parent: unknown = nextRoot;
        for (const seg of parentLoc) parent = (parent as Record<string | number, unknown>)[seg];
        (parent as Record<string | number, unknown>)[key] = newValue;
    }

    // Then deletions; numeric array indices descending, keys unordered.
    for (const g of deletions.values()) {
        let parent: unknown = nextRoot;
        for (const seg of g.loc) parent = (parent as Record<string | number, unknown>)[seg];
        const keys = [...g.keys];
        const numeric = keys.filter((k): k is number => typeof k === 'number').sort((a, b) => b - a);
        const named = keys.filter((k): k is string => typeof k === 'string');
        if (Array.isArray(parent)) {
            for (const i of numeric) parent.splice(i, 1);
        } else {
            for (const k of [...numeric, ...named]) {
                delete (parent as Record<string, unknown>)[String(k)];
            }
        }
    }

    return { root: nextRoot, changes };
}
