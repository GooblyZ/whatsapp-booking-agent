# Playbook: useEffect Dependency Bugs

> **Scope**: Infinite loops, stale closures, missing cleanups, effects that shouldn't be effects  
> **Consult when**: Component keeps re-rendering, data is stale, memory leaks, "too many re-renders"  
> **See also**: → `rules/performance-and-accessibility.md`, → `rules/anti-patterns.md`

---

## Diagnosis: Which Bug Is It?

| Symptom | Likely cause | Section |
|---------|-------------|---------|
| Infinite re-render loop | Unstable dependency | → Object/Array Dependencies |
| State value always initial | Stale closure | → Stale Closure |
| Memory leak / duplicate listeners | Missing cleanup | → Missing Cleanup |
| Effect runs on wrong trigger | Should be event handler | → Effect vs Handler |

---

## Object/Array Dependencies → Infinite Loop

**Root cause**: Object or array created during render → new reference every time → effect re-runs → state update → re-render → new object → ∞

```ts
// ❌ filters is a new object every render
function UserList({ page, sort }: { page: number; sort: string }) {
  const filters = { page, sort }  // new object every render

  useEffect(() => {
    fetchUsers(filters)
  }, [filters])  // reference changes every render → infinite loop
}

// ✅ Fix 1: Destructure to primitives
useEffect(() => {
  fetchUsers({ page, sort })
}, [page, sort])

// ✅ Fix 2: Stabilize with useMemo (when object is complex)
const filters = useMemo(() => ({ page, sort, ...otherStuff }), [page, sort])
useEffect(() => { fetchUsers(filters) }, [filters])
```

**Tradeoff**: Fix 1 is simpler and preferred. Fix 2 is for objects with many fields where destructuring is unwieldy.

---

## Stale Closure

**Root cause**: Callback inside effect captures the state value at creation time, not the current value.

```ts
// ❌ count is captured at the time the effect was created
function Counter() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      console.log(count)      // always 0
      setCount(count + 1)     // always sets to 1
    }, 1000)
    return () => clearInterval(id)
  }, [])  // empty deps → closure captures initial count

  return <span>{count}</span>
}

// ✅ Fix: Use updater function
useEffect(() => {
  const id = setInterval(() => {
    setCount(prev => prev + 1)  // always reads latest
  }, 1000)
  return () => clearInterval(id)
}, [])
```

**When updater isn't enough** (need to read current state for logic):
```ts
// ✅ Use ref to hold latest value
const countRef = useRef(count)
countRef.current = count

useEffect(() => {
  const id = setInterval(() => {
    if (countRef.current >= 10) { /* stop logic */ }
    setCount(prev => prev + 1)
  }, 1000)
  return () => clearInterval(id)
}, [])
```

---

## Missing Cleanup

**Root cause**: Event listener, timer, or subscription created but never removed.

```ts
// ❌ Listeners accumulate on every render
useEffect(() => {
  window.addEventListener('resize', handleResize)
}, [])

// ❌ Timer never cleared
useEffect(() => {
  const id = setInterval(tick, 1000)
}, [])

// ✅ Always return cleanup
useEffect(() => {
  window.addEventListener('resize', handleResize)
  return () => window.removeEventListener('resize', handleResize)
}, [])

useEffect(() => {
  const id = setInterval(tick, 1000)
  return () => clearInterval(id)
}, [])
```

### Cleanup checklist:

- `addEventListener` → `removeEventListener`
- `setInterval` / `setTimeout` → `clearInterval` / `clearTimeout`
- `WebSocket` / `EventSource` → `.close()`
- `AbortController` → `.abort()` (for fetch)
- Subscription (RxJS, Firebase) → `.unsubscribe()` / cleanup callback

---

## Effect vs Event Handler

**Symptom**: Effect that only makes sense in response to a user action.

```ts
// ❌ Effect triggered by state flag
const [submitted, setSubmitted] = useState(false)
useEffect(() => {
  if (submitted) {
    sendForm(data)
    setSubmitted(false)
  }
}, [submitted, data])

// ✅ Just call it in the handler
const handleSubmit = () => { sendForm(data) }
```

**Rule of thumb**: If the logic responds to a user action (click, submit, keypress), it belongs in an event handler, not an effect.

---

## Real-World Scenario: Search with Debounce

```ts
function useSearch(query: string) {
  const [results, setResults] = useState<SearchResult[]>([])

  useEffect(() => {
    if (!query) { setResults([]); return }

    const controller = new AbortController()

    const timeoutId = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        })
        if (res.ok) setResults(await res.json())
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error(err)
      }
    }, 300)

    return () => {
      clearTimeout(timeoutId)
      controller.abort()
    }
  }, [query])  // query is a primitive string → stable

  return results
}
```

**Why this is correct**:
- `query` is a string (primitive) → no unstable reference
- Timeout debounces rapid typing
- AbortController cancels in-flight requests on cleanup
- Cleanup runs before each new effect invocation

---

## Safe Recommendation Template

When diagnosing an effect bug:

1. **Identify the symptom** (loop, stale data, leak, wrong trigger)
2. **Check dependencies** — any objects/arrays? → destructure or memoize
3. **Check closures** — reading state directly? → use updater or ref
4. **Check cleanup** — every subscription/listener/timer cleaned up?
5. **Check if it should be an effect at all** — user action? → event handler
