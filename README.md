# JSONPath engine

TypeScript library for JSON query and update, with a three-state filter
evaluator. Run `npm install`, then `npm test` and `npm run build`.

## The three states

Every resolved value is exactly one of:

| State      | Meaning                                            |
| ---------- | -------------------------------------------------- |
| `missing`  | the property / index does not exist (`Nothing`)    |
| `null`     | a JSON `null` that is present                      |
| `concrete` | any real value: `false`, `0`, `""`, `[]`, `NaN`…  |

`null` and `missing` are never conflated. Two distinct operations are exposed:

- **`exists(v)`** — true for `null` and concrete values, false only for
  `missing`.
- **`truthy(v)`** — JS-style truthiness of concrete values; `missing` and
  `null` are falsy. So `false` / `0` / `""` are falsy while `[]` and `NaN`
  are truthy.

A bare path in a filter is an **existence test**, so:

```js
query(data, '$.items[?(@.enabled)]');
// matches enabled === false and enabled === null, excludes missing only
```

To compare actual values, write an explicit comparison
(`@.enabled == true`).

## Filter semantics

- **Equality (`==` / `!=`)** works across the three states. `missing` never
  equals `null` or a concrete value. A path that selects nothing is
  `Nothing`, and under `!=` it does not collapse into "unequal". Concrete
  numbers use **SameValue**, so **`NaN == NaN` is true**.
- **Ordering (`<`, `<=`, `>`, `>=`)** is defined only for two concrete
  numbers or two concrete strings.
  - `missing` / `null` operands yield `Nothing` (the item does not match).
  - Ordering with **`NaN` throws `ENAN`**.
  - Type-incompatible operands (e.g. number vs string) **throw `ETYPE`**.
  These never silently become `false`.
- **`&&` / `||` short-circuit** with explicit semantics; a type error in a
  branch that is not evaluated is never raised, and an error in an evaluated
  branch propagates.
- **`!expr`** negates the logical test of its operand. A bare path's logical
  test is existence, so `!@.x` means "x is absent" (present `false`/`null`
  still survive). To test an actual value's truthiness compare explicitly
  (`@.enabled == false`).
- Field/index navigation into a concrete primitive throws `ETYPE` rather
  than silently reading as `undefined`.

## Diagnostics

Errors are `JsonPathError` instances with:

- `code` — `EPARSE`, `ETYPE`, `ENAN`
- `expression` — the full filter source
- `offending` — source text of the failing sub-expression
- `path` — absolute document segments at which evaluation failed

## API

```ts
parse(path)                 // Token[]
query(root, path)           // concrete values present at matches
select(root, path)          // Match[] with { value, present, path }
update(root, path, fn)      // { root, changes }; uses the same evaluator
evalFilter(expr, ctx)       // raw three-state TriResult
testFilter(expr, ctx)       // boolean filter test
box / exists / truthy       // three-state helpers
```

`ctx` for standalone filter calls is `{ root, current }`; inside a selection
`@` is the current element and `$` is the document root.

`query` and `update` run through the single shared `select` evaluator, so
they always agree on which nodes match. In `update`, returning `undefined`
from the replacer deletes an object key or splices out an array element.
