import { expect, it } from 'vitest';
import {
    box,
    evalFilter,
    exists,
    JsonPathError,
    MISSING,
    NULL,
    parse,
    query,
    select,
    testFilter,
    truthy,
    update,
} from '../src/index.js';

const data = {
    items: [
        { id: 1, enabled: false, n: 0, s: '', tags: [] },
        { id: 2, enabled: true, n: 3, s: 'x', tags: ['a'] },
        { id: 3, enabled: null, n: null, s: null },
        { id: 4 /* enabled / n / s all missing */ },
        { id: 5, meta: { active: false, level: 0, code: '' } },
    ],
};

// ---------------------------------------------------------------------------
// Existing behavior preserved
// ---------------------------------------------------------------------------

it('queries simple fields and wildcards', () => {
    expect(query({ a: 1 }, parse('$.a'))).toEqual([1]);
    expect(query({ a: 1, b: 2 }, '$.*')).toEqual([1, 2]);
});

// ---------------------------------------------------------------------------
// Existence test [?(@.enabled)] keeps the three states apart
// ---------------------------------------------------------------------------

it('existence test keeps false / 0 / "" but drops missing; null exists', () => {
    const ids = (f: string) => query(data, `$.items[?(${f})].id`);
    // false EXISTS, so it must not be treated like a missing property
    expect(ids('@.enabled')).toEqual([1, 2, 3]);
    expect(ids('@.n')).toEqual([1, 2, 3]);
    expect(ids('@.s')).toEqual([1, 2, 3]);
    // empty arrays exist too
    expect(ids('@.tags')).toEqual([1, 2]);
    // nested falsy-but-present values exist
    expect(ids('@.meta.active')).toEqual([5]);
});

it('truthiness conversion is separate from existence', () => {
    expect(exists(box(false))).toBe(true);
    expect(exists(box(0))).toBe(true);
    expect(exists(box(''))).toBe(true);
    expect(exists(box(null))).toBe(true);
    expect(exists(MISSING)).toBe(false);

    expect(truthy(box(false))).toBe(false);
    expect(truthy(box(0))).toBe(false);
    expect(truthy(box(''))).toBe(false);
    expect(truthy(box([]))).toBe(true);
    expect(truthy(NULL)).toBe(false);
    expect(truthy(MISSING)).toBe(false);

    // ! negates the logical test of its operand. For a bare path the logical
    // test is EXISTENCE, so !path means "absent"; false/null still exist.
    expect(testFilter('!@.enabled', { root: data, current: { enabled: false } })).toBe(false);
    expect(testFilter('!@.enabled', { root: data, current: { enabled: null } })).toBe(false);
    expect(testFilter('!@.enabled', { root: data, current: {} })).toBe(true);
    // truthiness of an actual value is obtained via comparison, not by !path
    expect(testFilter('@.enabled == false', { root: data, current: { enabled: false } })).toBe(
        true,
    );
    expect(testFilter('@.enabled == false', { root: data, current: { enabled: true } })).toBe(
        false,
    );
    // bare path existence distinguishes present-false from missing
    expect(testFilter('@.enabled', { root: data, current: { enabled: false } })).toBe(true);
    expect(testFilter('@.enabled', { root: data, current: {} })).toBe(false);
});

// ---------------------------------------------------------------------------
// null vs missing comparison
// ---------------------------------------------------------------------------

it('null and missing compare differently', () => {
    const ids = (f: string) => query(data, `$.items[?(${f})].id`);
    // == null matches only an actual concrete null ...
    expect(ids('@.enabled == null')).toEqual([3]);
    // ... and != null matches concrete values; a missing operand selects
    // nothing (it never accidentally equals null)
    expect(ids('@.enabled != null')).toEqual([1, 2]);
    // bare-existence negation distinguishes present-false from absent
    expect(ids('!@.enabled')).toEqual([4, 5]);
});

it('evalFilter exposes all three states directly', () => {
    expect(evalFilter('@.enabled', { root: {}, current: { enabled: false } })).toMatchObject({
        state: 'concrete',
        value: false,
    });
    expect(evalFilter('@.enabled', { root: {}, current: { enabled: null } })).toMatchObject({
        state: 'null',
    });
    expect(evalFilter('@.enabled', { root: {}, current: {} })).toMatchObject({ state: 'missing' });
    expect(evalFilter('@.enabled', { root: {}, current: { enabled: false } }).expression).toBe('@.enabled');
});

// ---------------------------------------------------------------------------
// Comparisons: explicit semantics, type errors do not become false
// ---------------------------------------------------------------------------

it('equality uses SameValue for numbers (NaN strategy)', () => {
    expect(testFilter('@.x == 1', { root: {}, current: { x: 1 } })).toBe(true);
    expect(testFilter('@.x == 1', { root: {}, current: { x: 2 } })).toBe(false);
    expect(testFilter('@.x == "1"', { root: {}, current: { x: 1 } })).toBe(false);
    expect(testFilter('@.x != 2', { root: {}, current: { x: 1 } })).toBe(true);

    // NaN equals NaN under SameValue equality ...
    expect(testFilter('@.x == @.y', { root: {}, current: { x: NaN, y: NaN } })).toBe(true);
    // ... but ordering with NaN is an error, not false
    expect(() => testFilter('@.x > 0', { root: {}, current: { x: NaN } })).toThrowError(JsonPathError);
    try {
        testFilter('@.x > 0', { root: {}, current: { x: NaN } });
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(JsonPathError);
        const err = e as JsonPathError;
        expect(err.code).toBe('ENAN');
        expect(err.expression).toBe('@.x > 0');
        expect(err.offending).toContain('>');
    }
});

it('incompatible ordering throws with diagnostics instead of returning false', () => {
    try {
        testFilter('@.x < "a"', { root: {}, current: { x: 1 } });
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(JsonPathError);
        const err = e as JsonPathError;
        expect(err.code).toBe('ETYPE');
        expect(err.expression).toBe('@.x < "a"');
        expect(err.offending).toBe('@.x < "a"');
    }
    expect(() => testFilter('true < 1', { root: {}, current: {} })).toThrowError(JsonPathError);
    // null ordering is Nothing: it does not match, but does not throw
    expect(testFilter('@.x <= 1', { root: {}, current: { x: null } })).toBe(false);
    expect(testFilter('@.x > 1', { root: {}, current: { x: null } })).toBe(false);
});

it('ordering works within same concrete types; missing operands are Nothing', () => {
    expect(testFilter('@.x > 2', { root: {}, current: { x: 3 } })).toBe(true);
    expect(testFilter('@.x >= 3', { root: {}, current: { x: 3 } })).toBe(true);
    expect(testFilter('@.s < "b"', { root: {}, current: { s: 'a' } })).toBe(true);
    function ids(f: string) {
        return query(data, `$.items[?(${f})].id`);
    }
    // item 2 (n=3); null item throws if reached, missing item is Nothing
    expect(ids('@.n > 0')).toEqual([2]);
});

it('field access on a concrete primitive is a type error, not false', () => {
    expect(() => query(data, '$.items.id[?(@.k)].x')).not.toThrow(); // array.field -> missing, silent
    expect(() => testFilter('@.x.y', { root: {}, current: { x: 1 } })).toThrowError(JsonPathError);
});

// ---------------------------------------------------------------------------
// Logical operators and short-circuiting
// ---------------------------------------------------------------------------

it('&& and || short-circuit', () => {
    // Right side would throw ETYPE (string > number) if evaluated.
    // left false (literal): right never runs
    expect(testFilter('false && @.b > 0', { root: {}, current: { b: 'x' } })).toBe(false);
    // missing path on the left is falsy via existence; right never runs
    expect(testFilter('@.a && @.b > 0', { root: {}, current: { b: 'x' } })).toBe(false);
    // present-false on the left is EXISTENCE-true, so the right IS reached
    expect(() =>
        testFilter('@.a && @.b > 0', { root: {}, current: { a: false, b: 'x' } }),
    ).toThrowError(JsonPathError);
    // left true: right IS evaluated and its error propagates
    expect(() =>
        testFilter('@.a && @.b > 0', { root: {}, current: { a: true, b: 'x' } }),
    ).toThrowError(JsonPathError);
    // || short-circuits on true, skipping the throwing right side
    expect(testFilter('@.a || @.b > 0', { root: {}, current: { a: true, b: 'x' } })).toBe(true);
    // || present-false left (existence-true) also short-circuits
    expect(testFilter('@.a || @.b > 0', { root: {}, current: { a: false, b: 'x' } })).toBe(true);
    // || missing left evaluates the throwing right
    expect(() =>
        testFilter('@.a || @.b > 0', { root: {}, current: { b: 'x' } }),
    ).toThrowError(JsonPathError);
});

it('logical composition over false/0/""/null/missing', () => {
    const ids = (f: string) => query(data, `$.items[?(${f})].id`);
    // bare paths in && test existence: present false/null all pass
    expect(ids('@.enabled && @.s')).toEqual([1, 2, 3]);
    // explicit == true compares concrete values: false/null/missing rejected
    expect(ids('@.enabled == true && @.s == "x"')).toEqual([2]);
    // || : first three have enabled present; item1 also matches via n==0
    expect(ids('@.enabled || @.n == 0')).toEqual([1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

it('arrays: empty arrays exist; wildcard predicates; array literals as values', () => {
    const d = {
        list: [
            { tags: [] },
            { tags: ['x'] },
            { tags: null },
            {},
        ],
    };
    // empty array AND null are present -> existence test matches both;
    // only the missing-tags item is excluded
    expect(query(d, '$.list[?(@.tags)]').length).toBe(3);
    // wildcard inside a filter: exists if tags is an array with any element;
    // empty array wildcard selects nothing, null/missing select nothing
    expect(query(d, '$.list[?(@.tags[*])]').length).toBe(1);
    // ordering on arrays is a type error, never false
    expect(() =>
        testFilter('@.tags > 1', { root: d, current: d.list[0] }),
    ).toThrowError(JsonPathError);
    // equality of arrays is identity based
    const arr: unknown[] = [];
    expect(testFilter('@.tags == @.other', { root: { arr }, current: { tags: arr, other: arr } })).toBe(
        true,
    );
});

// ---------------------------------------------------------------------------
// Nested properties
// ---------------------------------------------------------------------------

it('nested property navigation distinguishes missing/null at every hop', () => {
    const d = { a: { b: { c: false } }, x: { b: null }, y: {} };
    expect(query(d, '$.a.b.c')).toEqual([false]);
    expect(select(d, '$.x.b.c')).toMatchObject([{ present: false, path: ['x', 'b', 'c'] }]);
    expect(select(d, '$.y.b.c')).toMatchObject([{ present: false, path: ['y', 'b', 'c'] }]);
    // filter on the b object: @.c is false but EXISTS, so the object matches
    expect(query(d, '$.a.b[?(@.c)]')).toEqual([{ c: false }]);
    // null intermediate hop yields Nothing, never a type error
    expect(() => query(d, '$.x.b.c')).not.toThrow();
});

it('filters can reference $ root', () => {
    const d = { threshold: 1, items: [{ n: 0 }, { n: 5 }] };
    expect(query(d, '$.items[?(@.n > $.threshold)].n')).toEqual([5]);
});

it('multi-valued comparisons use some-match semantics', () => {
    const d = { items: [{ xs: [1, 2], ys: [9] }, { xs: [3], ys: [9] }] };
    expect(query(d, '$.items[?(@.xs[*] == 2)]').length).toBe(1);
    expect(query(d, '$.items[?(@.xs[*] == 3)]').length).toBe(1);
});

it('numeric index on object reads the matching string key', () => {
    expect(query({ a: { 0: 'x' } }, '$.a[0]')).toEqual(['x']);
    expect(query({ a: { 0: 'x' } }, '$.a[1]')).toEqual([]);
    expect(query({ a: [1, 2] }, '$.a[-1]')).toEqual([]);
    expect(query({ a: [1, 2] }, '$.a[5]')).toEqual([]);
});

// ---------------------------------------------------------------------------
// Parse errors carry diagnostics
// ---------------------------------------------------------------------------

it('parse errors carry expression diagnostics', () => {
    expect(() => parse('a.b')).toThrowError(JsonPathError);
    expect(() => query({}, '$.items[?(@.x <> 1)]')).toThrowError(JsonPathError);
    try {
        query(data, '$.items[?(@.n ==== 1)]');
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(JsonPathError);
        expect((e as JsonPathError).code).toBe('EPARSE');
    }
});

it('runtime diagnostics carry the full expression path', () => {
    const d = { groups: [{ items: [{ v: 1 }] }] };
    try {
        // v is a concrete number; comparing it with < against a string is a
        // type error. The diagnostic must name the filter, the offending
        // sub-expression, and the absolute document path.
        query(d, '$.groups[*].items[*][?(@.v < "z")]');
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(JsonPathError);
        const err = e as JsonPathError;
        expect(err.code).toBe('ETYPE');
        expect(err.expression).toBe('@.v < "z"');
        expect(err.offending).toBe('@.v < "z"');
        expect(err.path).toEqual(['groups', 0, 'items', 0]);
    }
    // NaN ordering is a distinct code with the same diagnostics
    try {
        query({ rows: [{ x: NaN }] }, '$.rows[?(@.x > 0)]');
        throw new Error('should have thrown');
    } catch (e) {
        const err = e as JsonPathError;
        expect(err.code).toBe('ENAN');
        expect(err.path).toEqual(['rows', 0]);
    }
});

// ---------------------------------------------------------------------------
// select() results include expression paths
// ---------------------------------------------------------------------------

it('select reports full segment paths, including missing results', () => {
    const m = select(data, '$.items[*].enabled');
    expect(m).toHaveLength(5);
    expect(m[0]).toMatchObject({ value: false, present: true, path: ['items', 0, 'enabled'] });
    expect(m[3]).toMatchObject({ present: false, path: ['items', 3, 'enabled'] });
});

// ---------------------------------------------------------------------------
// Update uses the SAME evaluator as query
// ---------------------------------------------------------------------------

it('query and update agree on matched nodes', () => {
    const d = structuredClone(data);
    const before = query(d, '$.items[?(@.enabled)].id');
    // Only concrete numbers are rewritten; the matched-but-null node is
    // left untouched, proving null was selected (existence) yet distinguished.
    const result = update(d, '$.items[?(@.enabled)].n', (v) => (v === null ? null : 99));
    expect(before).toEqual([1, 2, 3]);
    expect(result.changes.map((c) => c.path)).toEqual([
        ['items', 0, 'n'],
        ['items', 1, 'n'],
        ['items', 2, 'n'],
    ]);
    // null exists and is reported; the missing item is dropped by query()
    expect(query(result.root, '$.items[*].n')).toEqual([99, 99, null]);
    // select() keeps the missing results too, with present=false
    const sel = select(result.root, '$.items[*].n');
    expect(sel.map((m) => m.present)).toEqual([true, true, true, false, false]);
});

it('update replaces, deletes and can replace root', () => {
    const d = { list: [1, 2, 3] };
    const r = update(d, '$.list[?(@ >= 2)]', () => undefined);
    expect(r.root).toEqual({ list: [1] });
    expect(r.changes.map((c) => c.oldValue)).toEqual([2, 3]);
    expect(r.changes.map((c) => c.path)).toEqual([
        ['list', 1],
        ['list', 2],
    ]);

    const r2 = update({ a: 1 }, '$', () => ({ a: 2 }));
    expect(r2.root).toEqual({ a: 2 });
    expect(r2.changes[0].path).toEqual([]);
});

it('update filter shares semantics: false/0/"" matched, missing not', () => {
    const d = {
        rows: [{ v: false }, { v: 0 }, { v: '' }, { other: 1 }],
    };
    const r = update(d, '$.rows[?(@.v)].v', (x) => `set:${String(x)}`);
    expect(r.changes).toHaveLength(3);
    expect((r.root as typeof d).rows[0].v).toBe('set:false');
    expect((r.root as typeof d).rows[1].v).toBe('set:0');
    expect((r.root as typeof d).rows[2].v).toBe('set:');
    expect((r.root as typeof d).rows[3].v).toBeUndefined();
});
