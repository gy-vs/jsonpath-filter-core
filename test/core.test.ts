import { describe, expect, it } from 'vitest';
import {
  asTruth,
  evaluateExpression,
  evaluateExpression as evalExpr,
  exists,
  ExpressionError,
  isMissing,
  MISSING,
  parse,
  parseExpression,
  query,
  queryNodes,
  REMOVE,
  testFilter,
  truthy,
  update,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures: deliberately include false, 0, '', null and missing side by side
// ---------------------------------------------------------------------------

const ITEMS = [
  { id: 1, enabled: false, count: 0, label: '', note: null, tags: ['x', 'y'], rank: 3 },
  { id: 2, enabled: true, count: 5, label: 'on', note: 'a', tags: [], rank: 1, nan: NaN },
  { id: 3, enabled: null, count: null, label: null, tags: ['z'], rank: 2 },
  { id: 4, meta: { nested: { enabled: false, zero: 0, blank: '', nil: null } } },
];

const ids = (rows: unknown[]) => (rows as { id?: number }[]).map((r) => r.id);

// ---------------------------------------------------------------------------
// Three-state primitives
// ---------------------------------------------------------------------------

describe('three-state evaluation: missing / null / concrete', () => {
  it('keeps false, 0 and empty string as concrete values', () => {
    for (const [field, expected] of [
      ['enabled', false],
      ['count', 0],
      ['label', ''],
    ] as const) {
      const result = evalExpr(`@.${field}`, ITEMS[0]);
      expect(result.state).toBe('value');
      expect(result.value).toBe(expected);
    }
  });

  it('keeps null distinct from missing', () => {
    const present = evalExpr('@.note', ITEMS[0]);
    const absent = evalExpr('@.missing', ITEMS[0]);

    expect(present.state).toBe('value');
    expect(present.value).toBeNull();

    expect(absent.state).toBe('missing');
    expect(absent.value).toBeUndefined();
  });

  it('exposes the MISSING sentinel and isMissing guard', () => {
    expect(isMissing(MISSING)).toBe(true);
    expect(isMissing(null)).toBe(false);
    expect(isMissing(0)).toBe(false);
    expect(isMissing('')).toBe(false);
    expect(isMissing(false)).toBe(false);
  });
});

describe('existence is separate from truth conversion', () => {
  const item = ITEMS[0];

  it('existence accepts every concrete value, including falsy ones', () => {
    for (const field of ['enabled', 'count', 'label', 'note']) {
      expect(exists(evalExpr(`@.${field}`, item))).toBe(true);
      expect(testFilter(`@.${field}`, item)).toBe(true);
    }
    expect(exists(evalExpr('@.absent', item))).toBe(false);
    expect(testFilter('@.absent', item)).toBe(false);
  });

  it('truth conversion rejects the JS-falsy concrete values', () => {
    expect(truthy(evalExpr('@.enabled', item))).toBe(false); // boolean false
    expect(truthy(evalExpr('@.count', item))).toBe(false);   // 0
    expect(truthy(evalExpr('@.label', item))).toBe(false);   // ''
    expect(truthy(evalExpr('@.note', item))).toBe(false);    // null
    expect(truthy(evalExpr('@.id', item))).toBe(true);
    expect(truthy(evalExpr('@.tags', item))).toBe(true);     // arrays are truthy
  });

  it('missing is falsy without being conflated with null', () => {
    const absent = evalExpr('@.absent', item);
    expect(truthy(absent)).toBe(false);
    expect(exists(absent)).toBe(false);
  });

  it('asTruth rules directly', () => {
    expect(asTruth(false)).toBe(false);
    expect(asTruth(0)).toBe(false);
    expect(asTruth(NaN)).toBe(false);
    expect(asTruth('')).toBe(false);
    expect(asTruth(null)).toBe(false);
    expect(asTruth(true)).toBe(true);
    expect(asTruth(-1)).toBe(true);
    expect(asTruth('x')).toBe(true);
    expect(asTruth([])).toBe(true);
    expect(asTruth({})).toBe(true);
  });

  it('the original bug: bare [?(@.x)] is an EXISTENCE test, not a truth test', () => {
    // enabled values: false, true, null, (missing)
    // existence keeps false AND null; only the row without the key drops.
    const rows = query(ITEMS, '$[?(@.enabled)]');
    expect(ids(rows)).toEqual([1, 2, 3]);
    // truth-based filtering must be written explicitly with a type guard,
    // because comparing null with true is a type error rather than false.
    expect(ids(query(ITEMS, '$[?(istrue(@.enabled))]'))).toEqual([2]);
    // same separation for 0 and ''
    expect(ids(query(ITEMS, '$[?(@.count)]'))).toEqual([1, 2, 3]); // 0, 5, null exist
    expect(ids(query(ITEMS, '$[?(@.label)]'))).toEqual([1, 2, 3]); // '', 'on', null exist
    expect(ids(query(ITEMS, '$[?(@.note)]'))).toEqual([1, 2]); // null and 'a' exist
    // on a numeric-only collection, comparison needs no type guard:
    const numeric = [{ id: 10, count: 0 }, { id: 20, count: 5 }];
    expect(ids(query(numeric, '$[?(@.count == 5)]'))).toEqual([20]);
    expect(ids(query(numeric, '$[?(@.count)]'))).toEqual([10, 20]); // 0 exists
  });
});

// ---------------------------------------------------------------------------
// null vs missing comparisons
// ---------------------------------------------------------------------------

describe('null never compares equal to missing', () => {
  const withNull = ITEMS[0];   // note: null
  const withoutNote = ITEMS[3]; // no `note` key

  it('null == null is true', () => {
    expect(testFilter('@.note == null', withNull)).toBe(true);
  });

  it('missing == null is false (no match), not an error', () => {
    expect(testFilter('@.note == null', withoutNote)).toBe(false);
  });

  it('null != null is false', () => {
    expect(testFilter('@.note != null', withNull)).toBe(false);
  });

  it('missing != null is false (existence must be expressed explicitly)', () => {
    // RFC-style: comparison with an empty nodelist is false both ways.
    expect(testFilter('@.note != null', withoutNote)).toBe(false);
    expect(testFilter('@.note', withoutNote)).toBe(false); // existence filter
  });

  it('evaluateExpression preserves the missing outcome of a comparison', () => {
    const r = evalExpr('@.note == null', withoutNote);
    expect(r.state).toBe('missing');
  });

  it('literal null filtering behaves the same in query', () => {
    // Only id 1 has note:null; id 2 has note:'a' (type-incompatible, so
    // `== null` raises), id 3 is *missing* the note key. isnull() lets the
    // heterogeneous collection be filtered without an error.
    expect(ids(query(ITEMS, '$[?(isnull(@.note))]'))).toEqual([1]);
    expect(ids(query(ITEMS, '$[?(ismissing(@.note))]'))).toEqual([3, 4]);
    expect(ids(query(ITEMS, '$[?(@.note)]'))).toEqual([1, 2]); // existence
    // And direct null comparisons still throw on the incompatible row:
    expect(() => query(ITEMS, '$[?(@.note == null)]')).toThrowError(ExpressionError);
  });
});

// ---------------------------------------------------------------------------
// Comparisons: no implicit coercion
// ---------------------------------------------------------------------------

describe('comparisons use strict types with no implicit coercion', () => {
  it('numbers compare numerically', () => {
    expect(testFilter('@.count == 0', ITEMS[0])).toBe(true);
    expect(testFilter('@.count == 5', ITEMS[1])).toBe(true);
    expect(testFilter('@.count < 10', ITEMS[1])).toBe(true);
    expect(testFilter('@.count >= 5', ITEMS[1])).toBe(true);
  });

  it('string "0" compared with number 0 is a type error, never coerced', () => {
    const obj = { code: '0' };
    expect(() => testFilter('@.code == 0', obj)).toThrowError(ExpressionError);
    expect(testFilter('@.code == "0"', obj)).toBe(true);
  });

  it('incompatible equality throws instead of becoming false', () => {
    const attempt = () => testFilter('@.note == 5', ITEMS[0]); // null vs number
    expect(attempt).toThrowError(ExpressionError);
  });

  it('ordering incompatible types throws instead of becoming false', () => {
    expect(() => testFilter('@.note < 5', ITEMS[0])).toThrowError(ExpressionError);
    expect(() => testFilter('@.label < 5', ITEMS[1])).toThrowError(ExpressionError);
    expect(() => testFilter('5 < @.tags', ITEMS[0])).toThrowError(ExpressionError);
  });

  it('comparing a missing path returns missing, not an error', () => {
    const r = evaluateExpression('@.absent < 5', ITEMS[0]);
    expect(r.state).toBe('missing');
    expect(testFilter('@.absent < 5', ITEMS[0])).toBe(false);
  });

  it('structural equality for arrays and objects', () => {
    const obj = { pair: [1, 2], rec: { a: 1 } };
    expect(testFilter('@.pair == [1, 2]', obj)).toBe(true);
    expect(testFilter('@.pair == [1, 3]', obj)).toBe(false);
    expect(testFilter('@.rec == {"a": 1}', obj)).toBe(true);
    expect(() => testFilter('@.rec == {"a": "1"}', obj)).toThrowError(ExpressionError);
    expect(() => testFilter('@.pair == [1, "2"]', obj)).toThrowError(ExpressionError);
  });
});

// ---------------------------------------------------------------------------
// NaN strategy
// ---------------------------------------------------------------------------

describe('NaN strategy', () => {
  const withNaN = ITEMS[1];

  it('NaN == NaN is true (SameValue semantics)', () => {
    expect(testFilter('NaN == NaN', {})).toBe(true);
    expect(testFilter('@.nan == NaN', withNaN)).toBe(true);
  });

  it('NaN != 0 and NaN != 5', () => {
    expect(testFilter('@.nan != 0', withNaN)).toBe(true);
    expect(testFilter('@.nan != 5', withNaN)).toBe(true);
  });

  it('ordering NaN throws an ExpressionError, never silently false', () => {
    expect(() => testFilter('@.nan < 5', withNaN)).toThrowError(ExpressionError);
    expect(() => testFilter('@.nan >= 5', withNaN)).toThrowError(ExpressionError);
    expect(() => testFilter('NaN < NaN', {})).toThrowError(ExpressionError);
  });

  it('truth conversion treats NaN as false', () => {
    expect(asTruth(NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Arrays / wildcards / membership
// ---------------------------------------------------------------------------

describe('arrays and wildcard node lists', () => {
  it('membership equality over a wildcard projection', () => {
    expect(testFilter('@.tags[*] == "x"', ITEMS[0])).toBe(true);
    expect(testFilter('@.tags[*] == "z"', ITEMS[0])).toBe(false);
    expect(testFilter('@.tags[*] == "z"', ITEMS[2])).toBe(true);
  });

  it('!= is the negation of the membership test', () => {
    expect(testFilter('@.tags[*] != "z"', ITEMS[2])).toBe(false); // only element is z
    expect(testFilter('@.tags[*] != "x"', ITEMS[0])).toBe(true);  // y differs
  });

  it('an empty projection compared with a scalar is missing/non-matching', () => {
    const r = evaluateExpression('@.tags[*] == "x"', ITEMS[1]); // tags: []
    expect(r.state).toBe('missing');
    expect(testFilter('@.tags[*] == "x"', ITEMS[1])).toBe(false);
  });

  it('ordering over projections is existential', () => {
    expect(testFilter('@.vals[*] > 5', { vals: [1, 6] })).toBe(true);
    expect(testFilter('@.vals[*] > 9', { vals: [1, 6] })).toBe(false);
  });

  it('projection against an incompatible type throws, it does not return false', () => {
    expect(() => testFilter('@.tags[*] < 5', ITEMS[0])).toThrowError(ExpressionError);
  });

  it('query with wildcard path segments', () => {
    const doc = { groups: { a: { v: 1 }, b: { v: 2 } } };
    expect(query(doc, '$.groups.*.v')).toEqual([1, 2]);
    expect(query(ITEMS, '$[*].id')).toEqual([1, 2, 3, 4]);
  });

  it('indexes including negatives', () => {
    expect(query({ list: [10, 20, 30] }, '$.list[0]')).toEqual([10]);
    expect(query({ list: [10, 20, 30] }, '$.list[-1]')).toEqual([30]);
  });

  it('a plain array field is a concrete value for existence and truth', () => {
    expect(testFilter('@.tags', ITEMS[1])).toBe(true); // [] exists and is truthy
  });
});

// ---------------------------------------------------------------------------
// Logical operators and short-circuiting
// ---------------------------------------------------------------------------

describe('logical operators with explicit short circuit', () => {
  const item = ITEMS[0]; // count 0, note null

  it('! applies truth conversion only to concrete values', () => {
    expect(testFilter('!@.enabled', item)).toBe(true);  // !false
    expect(testFilter('!@.count', item)).toBe(true);    // !0
    expect(testFilter('!@.id', item)).toBe(false);
  });

  it('negation of a missing value is missing (non-matching), not true', () => {
    expect(evaluateExpression('!@.absent', item).state).toBe('missing');
    expect(testFilter('!@.absent', item)).toBe(false);
  });

  it('&& and || over concrete booleans', () => {
    expect(testFilter('@.id == 1 && @.count == 0', item)).toBe(true);
    expect(testFilter('@.id == 1 && @.count == 9', item)).toBe(false);
    expect(testFilter('@.id == 9 || @.count == 0', item)).toBe(true);
    expect(testFilter('@.id == 9 || @.count == 9', item)).toBe(false);
  });

  it('short-circuit skips a type error on the right when left decides', () => {
    // left false: right must never be evaluated
    expect(testFilter('@.count == 9 && @.note < 5', item)).toBe(false);
    // left true for ||: right must never be evaluated
    expect(testFilter('@.count == 0 || @.note < 5', item)).toBe(true);
  });

  it('a short-circuited-but-needed right side still surfaces type errors', () => {
    // left true -> && needs right, which is type-incompatible
    expect(() => testFilter('@.count == 0 && @.note < 5', item)).toThrowError(ExpressionError);
    // left false -> || needs right, which is type-incompatible
    expect(() => testFilter('@.count == 9 || @.note < 5', item)).toThrowError(ExpressionError);
  });

  it('missing combines with concrete values per Kleene truth tables', () => {
    // missing && false => false (false dominates)
    expect(testFilter('@.absent && @.enabled', item)).toBe(false);
    // missing || true => true (true dominates)
    expect(testFilter('@.absent || @.id == 1', item)).toBe(true);
    // missing && true => missing => non-match
    expect(evaluateExpression('@.absent && @.id == 1', item).state).toBe('missing');
    expect(testFilter('@.absent && @.id == 1', item)).toBe(false);
    // missing || false => missing
    expect(evaluateExpression('@.absent || @.enabled', item).state).toBe('missing');
  });

  it('unary minus is numeric only', () => {
    expect(testFilter('-@.count == 0', item)).toBe(true);
    expect(() => testFilter('-@.note', item)).toThrowError(ExpressionError);
  });
});

// ---------------------------------------------------------------------------
// Explicit predicate functions for heterogeneous collections
// ---------------------------------------------------------------------------

describe('isnull / ismissing / exists / istrue / isfalse / type', () => {
  const mixed = [
    { id: 1, v: null },
    { id: 2 },
    { id: 3, v: false },
    { id: 4, v: 0 },
    { id: 5, v: true },
    { id: 6, v: 'x' },
  ];
  const mids = (rows: unknown[]) => ids(rows);

  it('isnull distinguishes null from missing and from falsy values', () => {
    expect(mids(query(mixed, '$[?(isnull(@.v))]'))).toEqual([1]);
  });

  it('ismissing only matches absent properties', () => {
    expect(mids(query(mixed, '$[?(ismissing(@.v))]'))).toEqual([2]);
  });

  it('exists matches null and false just like concrete values', () => {
    expect(mids(query(mixed, '$[?(exists(@.v))]'))).toEqual([1, 3, 4, 5, 6]);
  });

  it('istrue/isfalse apply truth conversion explicitly', () => {
    expect(mids(query(mixed, '$[?(istrue(@.v))]'))).toEqual([5, 6]);
    // isfalse is "not truthy": null and missing are non-truthy as well
    expect(mids(query(mixed, '$[?(isfalse(@.v))]'))).toEqual([1, 2, 3, 4]);
  });

  it('a strict boolean comparison on homogeneous data works directly', () => {
    const flags = [{ id: 1, on: false }, { id: 2, on: true }, { id: 3 }];
    expect(mids(query(flags, '$[?(@.on == false)]'))).toEqual([1]);
    expect(mids(query(flags, '$[?(@.on == true)]'))).toEqual([2]);
  });

  it('type() reports the tri-state type', () => {
    expect(testFilter('type(@.v) == "null"', { v: null })).toBe(true);
    expect(testFilter('type(@.v) == "number"', { v: 0 })).toBe(true);
    expect(testFilter('type(@.v) == "boolean"', { v: false })).toBe(true);
    expect(testFilter('type(@.v) == "missing"', {})).toBe(true);
    expect(testFilter('type(@.v) == "array"', { v: [] })).toBe(true);
  });

  it('unknown functions and arity errors are ExpressionErrors', () => {
    expect(() => testFilter('nope(@.v)', {})).toThrowError(ExpressionError);
    expect(() => testFilter('isnull(@.v, 1)', {})).toThrowError(ExpressionError);
  });
});

// ---------------------------------------------------------------------------
// Nested properties
// ---------------------------------------------------------------------------

describe('nested properties', () => {
  const item = ITEMS[3];

  it('falsy values deep in the document still exist', () => {
    expect(testFilter('@.meta.nested.enabled', item)).toBe(true); // false exists
    expect(testFilter('@.meta.nested.zero', item)).toBe(true);    // 0 exists
    expect(testFilter('@.meta.nested.blank', item)).toBe(true);   // '' exists
    expect(testFilter('@.meta.nested.nil', item)).toBe(true);     // null exists
    expect(testFilter('@.meta.nested.absent', item)).toBe(false);
    expect(testFilter('@.meta.absent.deep', item)).toBe(false);
  });

  it('nested null is concrete, nested absence is missing', () => {
    const nil = evaluateExpression('@.meta.nested.nil', item);
    const absent = evaluateExpression('@.meta.nested.nope', item);
    expect(nil.state).toBe('value');
    expect(nil.value).toBeNull();
    expect(absent.state).toBe('missing');
  });

  it('filters on nested values in a collection', () => {
    expect(ids(query(ITEMS, '$[?(@.meta.nested.enabled)]'))).toEqual([4]);
  });

  it('descending through a primitive yields missing', () => {
    expect(evaluateExpression('@.id.x', item).state).toBe('missing');
  });

  it('$ binds the whole root document inside a filter', () => {
    const root = { limit: 3, rows: [{ n: 1 }, { n: 5 }] };
    expect(query(root, '$.rows[?(@.n < $.limit)]')).toEqual([{ n: 1 }]);
  });

  it('filters apply to object maps as well as arrays', () => {
    const doc = { a: { v: 1 }, b: { v: 2 }, c: { v: 3 } };
    expect(query(doc, '$[?(@.v >= 2)]').map((x) => (x as { v: number }).v)).toEqual([2, 3]);
  });

  it('bracket indexes and negative numeric literals work in expressions', () => {
    expect(testFilter('@[0] == 1', [1, 2])).toBe(true);
    expect(testFilter('@[-1] == 2', [1, 2])).toBe(true);
    expect(evaluateExpression('@[2]', [1, 2]).state).toBe('missing');
    expect(testFilter('@.t == -5', { t: -5 })).toBe(true);
    expect(testFilter('@.t < -1', { t: -5 })).toBe(true);
  });

  it('deep wildcard projections and update over object maps', () => {
    const doc = { xs: [{ ys: [1, 2] }, { ys: [3] }] };
    expect(query(doc, '$.xs[*].ys[*]')).toEqual([1, 2, 3]);
    expect(testFilter('@.xs[*].ys[*] == 3', doc)).toBe(true);

    const r = evaluateExpression('@.xs[*].ys[*]', doc);
    expect(r.resolvedPath).toEqual(['xs', '*', 'ys', '*']);
    expect(r.nodelist).toBe(true);

    const map = { a: 1, b: 2, c: 3 };
    update(map, '$[?(@ >= 2)]', () => 0);
    expect(map).toEqual({ a: 1, b: 0, c: 0 });
  });

  it('respects parentheses and operator precedence', () => {
    expect(testFilter('(@.a == 1 || @.b == 2) && @.c == 3', { a: 1, b: 9, c: 3 })).toBe(true);
    expect(testFilter('@.a == 1 || @.b == 2 && @.c == 9', { a: 1, b: 2, c: 3 })).toBe(true);
  });

  it('an empty array literal is concrete and structurally equal to []', () => {
    expect(testFilter('@.xs == []', { xs: [] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('expression path diagnostics', () => {
  it('reports source text and offsets for the producing node', () => {
    const r = evaluateExpression('@.meta.nested.zero', ITEMS[3]);
    expect(r.expr).toBe('@.meta.nested.zero');
    expect(r.offset).toBe(0);
    expect(r.end).toBe('@.meta.nested.zero'.length);
    expect(r.resolvedPath).toEqual(['meta', 'nested', 'zero']);
  });

  it('errors carry expression, offsets and operand paths', () => {
    try {
      evaluateExpression('@.note < 5', ITEMS[0]);
      throw new Error('expected ExpressionError');
    } catch (e) {
      const err = e as ExpressionError;
      expect(err).toBeInstanceOf(ExpressionError);
      expect(err.expression).toBe('@.note < 5');
      expect(err.expression.slice(err.offset, err.end)).toBe('@.note < 5');
      expect(err.details?.leftPath).toEqual(['note']);
    }
  });

  it('nested errors pinpoint the inner node offsets', () => {
    try {
      evaluateExpression('@.id == 1 && @.note < 5', ITEMS[0]);
      throw new Error('expected ExpressionError');
    } catch (e) {
      const err = e as ExpressionError;
      expect(err).toBeInstanceOf(ExpressionError);
      expect(err.expression.slice(err.offset, err.end)).toBe('@.note < 5');
    }
  });

  it('parse errors are ExpressionErrors with offsets too', () => {
    expect(() => parseExpression('@.a ==')).toThrowError(ExpressionError);
    expect(() => evaluateExpression('1 <', {})).toThrowError(ExpressionError);
  });
});

// ---------------------------------------------------------------------------
// Shared evaluator: query and update run the exact same filter
// ---------------------------------------------------------------------------

describe('query and update share one evaluator', () => {
  const makeDoc = () => ({
    items: [
      { id: 1, enabled: false, v: 1 },
      { id: 2, enabled: true, v: 2 },
      { id: 3, enabled: null, v: 3 },
    ],
  });

  it('identical filter expression selects the same nodes', () => {
    const doc = makeDoc();
    // istrue() gives the truth filter without an implicit null coercion;
    // the null-enabled row yields false, the false-enabled row false.
    const truthPath = '$.items[?(istrue(@.enabled))]';
    const queried = query(doc, truthPath);
    expect(queried.map((r) => (r as { id: number }).id)).toEqual([2]);

    const nodes = queryNodes(doc, truthPath);
    expect(nodes.map((n) => n.path)).toEqual([['items', 1]]);

    const changes = update(doc, truthPath, (value) => ({ ...(value as object), v: 99 }));
    expect(changes.map((c) => c.path)).toEqual([['items', 1]]);
    expect(doc.items[1].v).toBe(99);
    expect(doc.items[0].v).toBe(1); // false-enabled row untouched
    expect(doc.items[2].v).toBe(3); // null-enabled row untouched
  });

  it('pre-parsed AST is reused by both APIs', () => {
    const doc = makeDoc();
    const expression = 'isnull(@.enabled)';
    const ast = parseExpression(expression);
    const seg = { kind: 'filter', expression, ast } as const;
    expect(query(doc, [
      { kind: 'root' },
      { kind: 'field', name: 'items' },
      seg,
    ]).map((r) => (r as { id: number }).id)).toEqual([3]);

    const changes = update(doc, [
      { kind: 'root' },
      { kind: 'field', name: 'items' },
      seg,
    ], () => REMOVE);
    expect(changes).toHaveLength(1);
    expect(doc.items.map((i) => i.id)).toEqual([1, 2]);
  });

  it('REMOVE deletes object keys and splices array elements', () => {
    const arrDoc = { items: [1, 2, 3, 4] };
    update(arrDoc, '$.items[?(@ >= 3)]', () => REMOVE);
    expect(arrDoc.items).toEqual([1, 2]);

    const objDoc = { items: { a: 1, b: 2, c: 3 } };
    update(objDoc, '$.items[?(@ >= 2)]', () => REMOVE);
    expect(objDoc.items).toEqual({ a: 1 });
  });

  it('updater receives node refs with absolute paths', () => {
    const doc = makeDoc();
    const seen: (string | number)[][] = [];
    update(doc, '$.items[?(@.id > 1)]', (value, ref) => {
      seen.push(ref.path);
      return value;
    });
    expect(seen).toEqual([['items', 1], ['items', 2]]);
  });

  it('a type error in an update filter throws (never silently matches nothing)', () => {
    const doc = makeDoc();
    expect(() => update(doc, '$.items[?(@.enabled < 5)]', () => 0))
      .toThrowError(ExpressionError);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility of the original surface
// ---------------------------------------------------------------------------

describe('backward-compatible parse/query', () => {
  it('queries dot fields and wildcards', () => {
    expect(query({ a: 1 }, parse('$.a'))).toEqual([1]);
    expect(query({ a: { b: 1, c: 2 } }, '$.a.*')).toEqual([1, 2]);
  });

  it('rejects paths not rooted at $', () => {
    expect(() => parse('a.b')).toThrow();
  });

  it('supports quoted and bracketed field names', () => {
    const doc = { 'odd key': { 'x-y': 7 } };
    expect(query(doc, "$['odd key']['x-y']")).toEqual([7]);
  });
});
