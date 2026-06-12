# Playbook: Hydration Issues

> **Scope**: SSR/CSR mismatch diagnosis and fixes in Next.js  
> **Consult when**: "Hydration failed", "Text content does not match", or UI flicker after load  
> **See also**: → `rules/nextjs-typescript.md`, → `rules/performance-and-accessibility.md`

---

## What Is a Hydration Mismatch?

1. Server renders HTML
2. Browser receives HTML (fast first paint)
3. React "hydrates" — attaches event handlers and compares server HTML with client render
4. **If they differ → hydration error.** React can't reconcile.

---

## Diagnosis Flowchart

```
Is the mismatched content...
├─ Date/time dependent?        → Defer to useEffect
├─ Random (Math.random, UUID)? → Seed-based or defer to useEffect
├─ Browser-API dependent?      → useEffect or dynamic import
│  (window, document, localStorage, navigator)
├─ User-specific? (auth, theme preference)
│  → <Suspense> boundary, or defer to useEffect
├─ From a browser extension?   → Test in incognito. Not your bug.
└─ From CSS-in-JS?             → Configure SSR extraction for your library
```

---

## Fix Patterns

### Pattern 1: Defer to useEffect (most common)

```tsx
function ClientTimestamp() {
  const [time, setTime] = useState<string | null>(null)

  useEffect(() => {
    setTime(new Date().toLocaleString())
  }, [])

  if (!time) return <span aria-busy="true">Loading...</span>
  return <time>{time}</time>
}
```

**Why this works**: `useState(null)` on server → renders "Loading...".  
Same `null` on client during hydration → matches. Then `useEffect` runs client-only.

### Pattern 2: dynamic import with ssr: false

```tsx
import dynamic from 'next/dynamic'

const Chart = dynamic(() => import('./Chart'), {
  ssr: false,
  loading: () => <div aria-busy="true">Loading chart...</div>,
})
```

**When to use**: Entire component depends on browser APIs (canvas, WebGL, IntersectionObserver).

### Pattern 3: Suspense boundary for user-specific content

```tsx
export default function Page() {
  return (
    <>
      <h1>Dashboard</h1>                                    {/* static */}
      <Suspense fallback={<Skeleton />}>
        <UserGreeting />                                     {/* dynamic, user-specific */}
      </Suspense>
    </>
  )
}

async function UserGreeting() {
  const session = await cookies()
  const name = session.get('name')?.value
  return <p>Welcome back, {name ?? 'Guest'}</p>
}
```

### Pattern 4: suppressHydrationWarning (last resort)

```tsx
<time suppressHydrationWarning>{new Date().toISOString()}</time>
```

**Only use when**: The mismatch is known, harmless, and unfixable (e.g., third-party ad scripts).

---

## [HARD RULE] Common Misconceptions

### `typeof window !== 'undefined'` in render does NOT fix hydration

```tsx
// ❌ Still causes mismatch
function Clock() {
  if (typeof window !== 'undefined') {
    return <span>{new Date().toLocaleString()}</span>  // client
  }
  return <span>Loading...</span>  // server
  // During hydration, client runs BOTH paths and compares — MISMATCH
}

// ✅ useEffect defers to client only
function Clock() {
  const [time, setTime] = useState<string | null>(null)
  useEffect(() => setTime(new Date().toLocaleString()), [])
  return <span>{time ?? 'Loading...'}</span>
}
```

---

## Common Failure Modes

- Suppressing the warning without understanding the cause
- Using `typeof window` in render logic (causes mismatch, doesn't prevent it)
- Assuming the error is in the highlighted component (may be a parent or layout)
- Third-party scripts injecting DOM nodes — test in incognito first

## Safe Recommendation Template

1. Identify what differs between server and client render
2. If browser API → `useEffect` or `dynamic(..., { ssr: false })`
3. If date/random → render placeholder on server, real value after mount
4. If user-specific → `<Suspense>` boundary
5. If truly irrelevant (3rd party injection) → `suppressHydrationWarning`
