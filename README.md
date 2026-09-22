# jsonpath-filter-core

TypeScript JSONPath query/update engine with a **three-state filter evaluator**.

Run `npm install`, then `npm test` and `npm run build`.

## Why three states

Evaluating a path against a document has two distinct outcomes:

- **concrete value** — the property exists. The value may be `null`, `false`,
  `0`, `''`, an empty array, … all of them *present*;
- **missing** — the property/index does not exist.

`null` is a concrete value and is never collapsed into "missing". Two
operations that a naive engine conflates are kept separate:

- **existence** — `exists(result)` / a bare filter `[?(@.field)]`: every
  concrete value matches, including `false`, `0`, `''` and `null`;
- **truth conversion** — `truthy(result)` / `istrue(...)`: applies the usual
  truth rules (`false`, `0`, `NaN`, `''`, `null`, missing → false).

So these differ on purpose:

```
[?(@.enabled)]            // existence: matches false, 0, '', null; skips absent
[?(istrue(@.enabled))]    // truth:     matches only truthy values
[?(@.enabled == true)]    // strict ==, throws on null (null is not a boolean)
```

## Strict comparison semantics

- No implicit coercion: `"0" == 0`, `null == 0`, `null < 5` raise
  `ExpressionError` instead of silently becoming `false`.
- Missing operands make a comparison **missing** (a filter then does not
  match); they do not throw.
- `==`/`!=` are structural (arrays/objects compare element-wise).
- Ordering (`< <= > >=`) is defined for numbers and strings of the same type.
- **NaN strategy:** `NaN == NaN` is true (SameValue); ordering with NaN throws.
- Wildcard paths produce **node lists**; comparisons over them are
  existential (`@.tags[*] == "x"` = "any tag is x").
- `&&`/`||` use Kleene three-state logic with real short circuit: the right
  operand is skipped when the left decides the answer, but a needed right
  operand can still raise a type error.

Heterogeneous collections get explicit predicates:
`isnull(x)`, `ismissing(x)`, `exists(x)`, `istrue(x)`, `isfalse(x)`, `type(x)`.

## Diagnostics

`evaluateExpression` returns an `EvalResult` with `state`, `value`, the
source slice (`expr`, `offset`, `end`) and the traversed `resolvedPath`.
`ExpressionError` carries the same location info plus operand paths.

## API

```ts
import {
  parse, parseExpression,
  query, queryNodes,
  update, REMOVE,
  evaluateExpression, testFilter,
  exists, truthy, asTruth, isMissing, MISSING,
  ExpressionError,
} from './dist/index.js';

// isnull/ismissing/exists/istrue/isfalse/type are functions usable *inside*
// filter expressions, e.g. '$.items[?(isnull(@.note))]'.

query(data, '$.items[?(@.enabled)]');

// update uses the exact same traversal + evaluator as query
update(doc, '$.items[?(istrue(@.enabled))]', v => ({ ...v, seen: true }));
update(doc, '$.items[?(isnull(@.note))]', () => REMOVE);
```

`queryNodes` returns node references (`value`, `parent`, `key`, absolute
`path`); `update` returns a list of `Change`s and splices array removals from
the highest index down.
