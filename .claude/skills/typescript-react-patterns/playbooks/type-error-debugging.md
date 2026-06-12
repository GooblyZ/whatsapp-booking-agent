# Playbook: Type Error Debugging

> **Scope**: Systematic resolution of TypeScript compile errors in React/Next.js  
> **Consult when**: User reports a type error, or generated code fails to compile  
> **See also**: → `rules/typescript-core.md`, → `rules/anti-patterns.md`

---

## Step 1: Read the Error Bottom-Up

TypeScript error chains show the root cause last. Always start from the bottom message.

```
Type 'string' is not assignable to type 'number'.
  The expected type comes from property 'age' which is declared here in type 'User'
```

↑ Read this first: the problem is `age` receiving a `string`.

---

## Step 2: Classify the Error

| Error pattern | Root cause | Typical fix |
|--------------|-----------|------------|
| `Type 'X' is not assignable to type 'Y'` | Value shape mismatch | Check the actual type of the value |
| `Property 'x' does not exist on type 'Y'` | Union not narrowed | Add type guard or discriminant check |
| `Argument of type 'X' is not assignable to parameter 'Y'` | Wrong argument | Check function/component signature |
| `Type 'X' is missing properties from type 'Y': a, b` | Incomplete object | Add missing required fields |
| `'X' refers to a value, but is being used as a type` | Type/value confusion | Use `typeof X` to get the type |
| `Object is possibly 'undefined'` | Nullable not narrowed | Add null check before accessing |
| `Cannot find module 'X'` | Missing declaration | Install `@types/X` or declare module |
| `Excessive stack depth comparing types` | Circular or deeply recursive type | Simplify, break circular reference |

---

## Step 3: Common React/Next.js-Specific Errors

### "Type '{ X: Y }' is not assignable to type 'IntrinsicAttributes & Props'"

**Cause**: Passing a prop the component doesn't accept.  
**Fix**: Check component's Props interface — you may have a typo or the prop was renamed.

### "Property 'X' does not exist on type 'EventTarget'"

**Cause**: Using `e.target` instead of `e.currentTarget`, or not typing the event.  
**Fix**:
```tsx
// ❌
<input onChange={(e) => setValue(e.target.value)} />
// If TS doesn't narrow, explicitly type:
const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  setValue(e.currentTarget.value)  // currentTarget is always the element with the handler
}
```

### "Argument of type 'X | undefined' is not assignable to parameter of type 'X'"

**Cause**: Optional chaining or nullable data passed where required value expected.  
**Fix**: Guard before passing, or use a default:
```ts
const user = users.find(u => u.id === id)
if (!user) throw new Error(`User ${id} not found`)
processUser(user)  // now narrowed to User, not User | undefined
```

### "'Promise<Element>' is not a valid JSX element" (Next.js Server Components)

**Cause**: Async Server Component in a context that doesn't support it.  
**Fix**: Ensure you're in App Router and the parent allows async children. Not supported in client components.

---

## Step 4: Debugging Tools

```ts
// Hover to inspect in IDE
const x = getValue()  // hover over x

// Force-show the resolved type
type Debug = typeof x  // hover over Debug

// Check assignability
type Test = typeof x extends ExpectedType ? '✅' : '❌'

// When type is deeply nested, use:
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never
type Readable = Expand<typeof complexValue>  // hover to see flattened
```

---

## [HARD RULE] Never "fix" type errors with:

- `as Type` — hides the mismatch, crashes at runtime
- `any` — infects everything downstream
- `@ts-ignore` / `@ts-expect-error` without a documented reason
- Adding `| undefined` to make errors go away without understanding why

---

## Safe Recommendation Template

When suggesting a fix for a type error:

1. **Quote the exact error message**
2. **Explain what TypeScript expects vs what it received**
3. **Show the minimal fix** (not a full rewrite)
4. **If `as` is truly needed**, explain specifically why it's safe in this case
5. **If the fix requires restructuring**, explain the tradeoff

```
The error says `Type 'string' is not assignable to type 'Status'`.
This is because `searchParams.status` is `string | undefined`,
but `filterByStatus()` expects the `Status` union type.

Fix: validate the param before passing it:

  const statusSchema = z.enum(['idle', 'active', 'archived'])
  const status = statusSchema.safeParse(searchParams.status)
  if (status.success) filterByStatus(status.data)
```
