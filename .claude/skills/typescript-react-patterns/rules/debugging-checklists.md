# Debugging Checklists

> **Scope**: Quick diagnosis hub + inline checklists for issues not covered by dedicated playbooks  
> **Consult when**: User reports any error or unexpected behavior  
> **See also**: → `playbooks/type-error-debugging.md`, → `playbooks/hydration-issues.md`, → `playbooks/effect-dependency-bugs.md`

---

## Diagnosis Router

Start here. Match the symptom to the right resource.

| Symptom | Go to |
|---------|-------|
| TypeScript compile error / red squiggles | → `playbooks/type-error-debugging.md` |
| "Hydration failed" / text content mismatch | → `playbooks/hydration-issues.md` |
| Infinite re-render / too many re-renders | → `playbooks/effect-dependency-bugs.md` § Object/Array deps |
| State value always shows initial | → `playbooks/effect-dependency-bugs.md` § Stale closure |
| Memory leak / duplicate listeners | → `playbooks/effect-dependency-bugs.md` § Missing cleanup |
| "X is not serializable" (Next.js) | → Serialization Issues below |
| "Cannot read properties of undefined/null" | → Null/Undefined Access below |
| "Too many re-renders" (React limit) | → State Update During Render below |
| Component renders but shows wrong data | → Stale Data Checklist below |
| Build succeeds but runtime crash | → Runtime vs Type Mismatch below |

---

## Serialization Issues (Next.js Server → Client)

**Symptom**: Error when passing props from Server Component to Client Component, or during JSON serialization.

### Diagnosis

1. **Identify the non-serializable value** — error message usually names the prop.
2. **Match to fix**:

| Value type | Fix |
|-----------|-----|
| Function / callback | Use Server Action (`"use server"`) or move logic to client |
| `Date` object | `.toISOString()` before passing → `new Date(str)` on client |
| `Map` | `Array.from(map.entries())` → `new Map(entries)` on client |
| `Set` | `Array.from(set)` → `new Set(arr)` on client |
| Class instance | Extract plain object: `{ ...instance }` or explicit mapping |
| `undefined` in array | Replace with `null` (JSON drops `undefined`) |
| `BigInt` | `.toString()` → `BigInt(str)` on client |

### Example

```tsx
// ❌
<ClientComponent createdAt={product.createdAt} />  // Date object

// ✅
<ClientComponent createdAt={product.createdAt.toISOString()} />

// Client side
function ClientComponent({ createdAt }: { createdAt: string }) {
  const date = new Date(createdAt)  // reconstruct from ISO string
  return <time dateTime={createdAt}>{date.toLocaleDateString()}</time>
}
```

---

## Null / Undefined Access

**Symptom**: `TypeError: Cannot read properties of undefined (reading 'x')`

### Diagnosis flowchart

```
Where does the value come from?
├─ API response         → Has it loaded yet? Add loading state / Suspense
├─ Array.find()         → Returns T | undefined. Add null check.
├─ Optional chaining    → .? returns undefined when chain breaks. Handle it.
├─ useRef               → ref.current is null until mounted. Check before using.
├─ useContext            → Missing provider? Hook should throw on null.
├─ Object property      → Is the object itself undefined? Check parent.
└─ searchParams / params → Always string | undefined. Validate with Zod.
```

### Fixes by source

```ts
// Array.find
const user = users.find(u => u.id === id)
if (!user) { console.error(`User ${id} not found`); return null }
// user is now narrowed to User

// useRef
const inputRef = useRef<HTMLInputElement>(null)
const focus = () => { inputRef.current?.focus() }  // safe optional chain

// API data with loading state
const { data, isLoading } = useQuery(userQueryOptions(id))
if (isLoading) return <Skeleton />
if (!data) return <NotFound />
// data is narrowed to User below
```

---

## State Update During Render

**Symptom**: `Too many re-renders. React limits the number of renders to prevent an infinite loop.`

### Common causes

```tsx
// ❌ Cause 1: setState called directly in render body
function Counter() {
  const [count, setCount] = useState(0)
  setCount(count + 1)  // called every render → triggers re-render → loop
  return <span>{count}</span>
}

// ❌ Cause 2: onClick={handler()} — called immediately, not on click
<button onClick={setCount(count + 1)}>Increment</button>
// Fix: onClick={() => setCount(count + 1)}

// ❌ Cause 3: Derived state that triggers update
function List({ items }: { items: Item[] }) {
  const [sorted, setSorted] = useState<Item[]>([])
  setSorted([...items].sort(compareFn))  // called every render
  return <ul>{sorted.map(...)}</ul>
}

// ✅ Fix: Derive without state — just compute it
function List({ items }: { items: Item[] }) {
  const sorted = useMemo(() => [...items].sort(compareFn), [items])
  return <ul>{sorted.map(...)}</ul>
}
```

---

## Stale Data Checklist

**Symptom**: Component shows outdated information after a mutation or navigation.

| Check | Fix |
|-------|-----|
| Did you invalidate queries after mutation? | `queryClient.invalidateQueries({ queryKey: ... })` |
| Is data copied into useState? | Remove the copy — let query own it. See `anti-patterns.md` §6 |
| Is staleTime too high? | Lower it, or invalidate explicitly after mutations |
| Is the component reading from the right cache key? | Verify query key factory matches |
| Server Component cache stale? | Use `revalidateTag()` or `revalidatePath()` |
| Closure capturing old state? | Use updater `setState(prev => ...)` or ref |

---

## Runtime vs Type Mismatch

**Symptom**: TypeScript shows no errors, but app crashes at runtime.

| Check | Fix |
|-------|-----|
| API response validated? | Add Zod `.parse()` at fetch boundary |
| `as` assertion used on external data? | Replace with validation |
| `!` non-null assertion? | Replace with explicit null check |
| `JSON.parse()` result typed as specific type? | Parse through schema |
| `localStorage.getItem()` result trusted? | Validate — stored data may be from old schema version |
| Third-party callback typed correctly? | Verify against library docs, add runtime check |

---

## Safe Diagnosis Template

When diagnosing any bug:
1. **Get the exact symptom**: error message, console output, or visual behavior
2. **Classify**: type error → playbook. Runtime error → checklist above. Rendering → effects/state.
3. **Follow the relevant checklist** — don't skip steps
4. **Propose the minimal fix** — don't rewrite the entire file
5. **Explain why it broke** — not just what to change. The user should understand the root cause.
