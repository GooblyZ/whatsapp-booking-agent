# TypeScript Core Patterns

> **Scope**: Narrowing, unions, generics, utility types, inference, unknown vs any, as const, satisfies  
> **Consult when**: Any TypeScript type question not specific to React or Next.js  
> **See also**: → `component-patterns.md` (discriminated unions in Props), → `data-fetching-and-api-types.md` (Zod inference)

---

## Narrowing & Control Flow

### typeof, in, instanceof, equality [HARD RULE]

Prefer built-in narrowing over type assertions. TypeScript narrows automatically inside `if`/`switch` branches.

```ts
// typeof
function format(value: string | number): string {
  if (typeof value === 'string') return value.toUpperCase()
  return value.toFixed(2)
}

// in operator
type Admin = { role: 'admin'; permissions: string[] }
type Guest = { role: 'guest' }
function getPermissions(user: Admin | Guest): string[] {
  if ('permissions' in user) return user.permissions
  return []
}
```

**Common bug**: `typeof x === 'object'` is true for `null`. Always add `x !== null`.

### Custom Type Guards [DEFAULT]

**When to use**: Narrowing logic is complex or reused across files.  
**When NOT to use**: Simple `typeof`/`in` checks suffice.

```ts
function isNonNullable<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined
}

// Domain-specific
interface ApiError { code: number; message: string }
function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' && value !== null &&
    'code' in value && typeof (value as any).code === 'number' &&
    'message' in value && typeof (value as any).message === 'string'
  )
}
```

**Tradeoff**: Type guards are trusted by the compiler. A wrong predicate silently lies. Keep them minimal and test them.

### Assertion Functions [SITUATIONAL]

```ts
function assertDefined<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value == null) throw new Error(`${name} must be defined`)
}

const el = document.getElementById('root')
assertDefined(el, 'Root element')
el.innerHTML = 'ok'  // narrowed to HTMLElement
```

---

## unknown vs any [HARD RULE]

`any` disables type checking and infects downstream code. Use `unknown` + narrowing instead.

```ts
// ❌ any — spreads silently
function parse(input: any) { return input.name }

// ✅ unknown — forces narrowing before use
function parse(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'name' in input) {
    return (input as { name: string }).name
  }
  throw new Error('Invalid input')
}

// ✅✅ Zod — runtime + type in one step
const schema = z.object({ name: z.string() })
function parse(input: unknown) { return schema.parse(input).name }
```

---

## as const & satisfies

### as const [DEFAULT]

Freezes values to literal types. Use for constants that should never widen.

```ts
const ROUTES = { home: '/', about: '/about', user: '/user/:id' } as const
type RoutePath = (typeof ROUTES)[keyof typeof ROUTES]  // '/' | '/about' | '/user/:id'
```

### satisfies [DEFAULT]

Validates structure without losing inference.

```ts
interface RouteConfig { path: string; auth: boolean }

const routes = {
  home: { path: '/', auth: false },
  dashboard: { path: '/dashboard', auth: true },
} satisfies Record<string, RouteConfig>

routes.home.path  // ✅ autocomplete
routes.typo       // ❌ compile error
```

### as const satisfies [DEFAULT]

Combined: literal values + structural validation.

```ts
type Status = 'idle' | 'loading' | 'success' | 'error'

const STATUS_CONFIG = {
  idle:    { icon: '⏸', color: 'gray' },
  loading: { icon: '⏳', color: 'blue' },
  success: { icon: '✅', color: 'green' },
  error:   { icon: '❌', color: 'red' },
} as const satisfies Record<Status, { icon: string; color: string }>
// Adding a Status value → compile error here until config updated
```

---

## Utility Types

### Essential Recipes

```ts
interface User { id: string; name: string; email: string; role: string; createdAt: Date }

type CreateInput = Omit<User, 'id' | 'createdAt'>
type UpdateInput = Partial<Omit<User, 'id'>>
type Summary = Pick<User, 'id' | 'name'>

// Exhaustive key-value map
type Theme = 'light' | 'dark'
const colors: Record<Theme, { bg: string; text: string }> = { ... }

// Filter union
type Response = { status: 'ok'; data: User } | { status: 'error'; msg: string }
type Success = Extract<Response, { status: 'ok' }>

// Function return type
type FetchReturn = Awaited<ReturnType<typeof fetchUser>>

// Template literal
type EventName = `on${Capitalize<'click' | 'hover' | 'focus'>}`

// Require specific optional fields
type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>
```

### interface vs type [DEFAULT]

- **interface** for object shapes (extensible, better error messages)
- **type** for unions, intersections, mapped types, function types

```ts
interface UserProps { name: string }              // ✅ object shape
type Status = 'idle' | 'loading' | 'error'        // ✅ union
type Callback = (value: string) => void            // ✅ function
```

---

## Generics

### When to use [SITUATIONAL]

Use when a function, hook, or component must work with multiple types AND the type can be inferred from arguments.

```ts
// ✅ T inferred from argument
function first<T>(items: T[]): T | undefined { return items[0] }

// ❌ T has no inference source
function useSomething<T>(): T { ... }
```

### Constrained generics [DEFAULT]

```ts
// ✅ Constraint ensures T has required structure
function getProperty<T extends Record<string, unknown>, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key]
}
```

---

## `as` Assertion [HARD RULE: last resort]

Before using `as`, exhaust these alternatives:
1. Type guard (`if`, `in`, `typeof`)
2. Generic inference
3. `satisfies`
4. Zod parse

If `as` is truly needed, document why in a comment.

---

## Common Bug Patterns

- `typeof x === 'object'` without `x !== null` → null passes through
- Custom type guard that doesn't check all fields → silently lies
- `as Type` on API data → no runtime check, crashes later
- `any` in one function → infects all callers
- Using `enum` → runtime code + tree-shaking issues. Prefer union + `as const`.

## Review Checklist

- [ ] No `any` (search codebase)
- [ ] No `as` without justification comment
- [ ] No `enum` (use union types + `as const`)
- [ ] `unknown` used for external data, not `any`
- [ ] Type guards check all required fields including `null`
- [ ] `satisfies` used for config objects (not plain type annotations)

---

## Type Inference Dos and Don'ts [DEFAULT]

### Let inference work internally

```ts
// ✅ No annotation needed — TS infers correctly
const count = 0                                     // number
const users = data.filter(d => d.active)             // User[]
const getName = (u: User) => u.name                  // (u: User) => string
const result = await fetchUser(id)                   // Awaited<ReturnType<...>>

// ❌ Redundant annotations — adds noise, no safety benefit
const count: number = 0
const users: User[] = data.filter((d: User) => d.active)
```

### Annotate at trust boundaries

```ts
// ✅ Function signatures exposed to other modules
export function formatPrice(amount: number, currency: string): string { ... }

// ✅ Props interfaces
interface ProductCardProps { product: Product; onAddToCart: (id: string) => void }

// ✅ API responses — always validate, never trust
async function fetchProducts(): Promise<Product[]> {
  const res = await fetch('/api/products')
  return productListSchema.parse(await res.json())
}
```

**Tradeoff**: Over-annotating clutters code and fights inference. Under-annotating at boundaries lets `any` leak. The boundary is where you choose.

---

## Advanced: Conditional Types [SITUATIONAL]

**When to use**: Library-level utilities, design-system APIs. Rarely in application code.  
**When NOT to use**: Application logic — prefer discriminated unions instead.

```ts
// Extract the value type from a Promise or return as-is
type Unwrap<T> = T extends Promise<infer U> ? U : T

type A = Unwrap<Promise<string>>  // string
type B = Unwrap<number>           // number

// Conditional prop requirement
type RequiredIf<Condition extends boolean, T> = Condition extends true ? T : T | undefined
```

**Tradeoff**: Powerful for DRY type definitions, but hard to read and debug. Prefer simpler alternatives when possible.

---

## Common Bug Patterns (Detailed)

### 1. Widened literal type

**Symptom**: Function expects `'success' | 'error'` but receives `string`.
```ts
// ❌ status is string (widened)
let status = 'success'
handleStatus(status)  // Error: string not assignable to 'success' | 'error'

// ✅ Fix 1: const
const status = 'success'  // literal type 'success'

// ✅ Fix 2: as const on object
const config = { status: 'success' } as const
```

### 2. Generic function returns unknown

**Symptom**: Return type is `unknown` or `{}` instead of the expected type.
```ts
// ❌ T has no constraint — TS can't infer structure
function first<T>(items: T[]): T { return items[0] }
const name = first(['a', 'b']).toUpperCase()  // might error if T is unknown

// ✅ Constrain or let inference flow from usage
function first<T extends string>(items: T[]): T { return items[0] }
```

### 3. Readonly array passed to mutable parameter

**Symptom**: `readonly string[]` not assignable to `string[]`.
```ts
const ROLES = ['admin', 'user', 'viewer'] as const
// typeof ROLES = readonly ['admin', 'user', 'viewer']

// ❌ Function expects mutable array
function process(roles: string[]) { ... }
process(ROLES)  // Error

// ✅ Accept readonly
function process(roles: readonly string[]) { ... }
```

---

## Safe Recommendation Template

When helping with TypeScript core questions:
1. **Is this a type error?** → See `playbooks/type-error-debugging.md`
2. **Choosing between approaches?** → State the tradeoff explicitly
3. **Suggesting a utility type?** → Show the input/output types, not just the name
4. **Suggesting generics?** → Verify T can be inferred from arguments
5. **Suggesting `as const` or `satisfies`?** → Explain what it gains over a plain annotation
6. **Uncertain about a feature's version?** → State the minimum TS version required
