# State Management

> **Scope**: Choosing where state lives, typing stores, avoiding duplicated sources of truth  
> **Consult when**: Deciding between useState, Context, Zustand, TanStack Query, URL state  
> **See also**: → `data-fetching-and-api-types.md` (TanStack Query), → `performance-and-accessibility.md`

---

## Decision Matrix [DEFAULT]

| State type | Solution | When |
|-----------|---------|------|
| UI-only (toggle, modal) | `useState` | One component, ephemeral |
| Complex local logic | `useReducer` | Multiple related transitions |
| Shared UI state (theme, sidebar) | Zustand or Context | Multiple components need it |
| Server/async data | TanStack Query | Data from API, needs caching/sync |
| Form state | react-hook-form | Complex forms with validation |
| URL-shareable state (filters, page) | `searchParams` | Must survive refresh, be shareable |

### [HARD RULE] Do NOT copy server data into client state

```ts
// ❌ Creates a stale copy
const { data: users } = useQuery(userListQueryOptions())
const [localUsers, setLocalUsers] = useState(users)

// ✅ Query owns the data
const { data: users } = useQuery(userListQueryOptions())
```

---

## Zustand [DEFAULT]

```ts
import { create } from 'zustand'

interface CartState {
  items: CartItem[]
  addItem: (item: CartItem) => void
  removeItem: (id: string) => void
  clearCart: () => void
}

const useCartStore = create<CartState>((set) => ({
  items: [],
  addItem: (item) => set((s) => ({ items: [...s.items, item] })),
  removeItem: (id) => set((s) => ({ items: s.items.filter(i => i.id !== id) })),
  clearCart: () => set({ items: [] }),
}))

// [HARD RULE] Select only what you need
const itemCount = useCartStore((s) => s.items.length)  // ✅ re-renders only when count changes
const store = useCartStore()  // ❌ re-renders on ANY change
```

## Context [SITUATIONAL]

**When to use**: Infrequently changing values (theme, locale, auth).  
**When NOT to use**: Frequently changing data (keystrokes, timers) — causes all consumers to re-render.

```tsx
interface AuthContextValue {
  user: User | null
  login: (credentials: Credentials) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
```

---

## Common Bug Patterns

- Server data in `useState` → stale copy, out of sync with cache
- Zustand selecting entire store → unnecessary re-renders
- Context for frequently changing data → all consumers re-render
- URL-shareable state in Zustand/Context → not bookmarkable, lost on refresh
- Multiple sources of truth for the same data → guaranteed inconsistency

## Review Checklist

- [ ] Server data NOT duplicated in useState
- [ ] Zustand selectors are granular
- [ ] Context only for infrequently changing values
- [ ] URL-shareable state uses searchParams
- [ ] No two stores/states holding the same data

---

## Zustand Middleware Typing [SITUATIONAL]

**Tradeoff**: Middleware adds capabilities (persistence, devtools) but makes the type signature more complex.

### persist

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface CartState {
  items: CartItem[]
  addItem: (item: CartItem) => void
  removeItem: (id: string) => void
  clearCart: () => void
}

const useCartStore = create<CartState>()(
  persist(
    (set) => ({
      items: [],
      addItem: (item) => set((s) => ({ items: [...s.items, item] })),
      removeItem: (id) => set((s) => ({ items: s.items.filter(i => i.id !== id) })),
      clearCart: () => set({ items: [] }),
    }),
    {
      name: 'cart-storage',  // localStorage key
      // ⚠️ Stored data is unvalidated — parse on read if shape may change
      version: 1,
      migrate: (persisted, version) => {
        // Handle schema migrations between versions
        return persisted as CartState
      },
    }
  )
)
```

**[HARD RULE]**: Persisted Zustand data is stored as JSON in localStorage. If you change the state shape, old data will have the wrong shape. Use `version` + `migrate` to handle this.

### devtools

```ts
import { devtools, persist } from 'zustand/middleware'

const useCartStore = create<CartState>()(
  devtools(
    persist(
      (set) => ({ ... }),
      { name: 'cart-storage' }
    ),
    { name: 'CartStore' }  // shown in Redux DevTools
  )
)
```

**Note**: Middleware wrapping order matters. `devtools(persist(...))` — devtools on the outside.

---

## URL State with nuqs [SITUATIONAL]

**When to use**: Filters, pagination, search queries — state that should survive refresh and be shareable.  
**Tradeoff**: More setup than useState, but URL is the source of truth.

```ts
import { useQueryState, parseAsInteger, parseAsStringEnum } from 'nuqs'

function ProductFilters() {
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1))
  const [sort, setSort] = useQueryState('sort',
    parseAsStringEnum(['price', 'name', 'date']).withDefault('date')
  )
  // URL: ?page=2&sort=price — type-safe, survives refresh
}
```

---

## Safe Recommendation Template

When helping with state management:
1. Is this server data? → TanStack Query (never useState)
2. Should it be in the URL? → searchParams or nuqs
3. Multiple components need it? → How often does it change?
   - Rarely (theme, locale) → Context
   - Often (cart, notifications) → Zustand with selectors
4. Local to one component? → useState or useReducer

---

## Real-World: Filter + Pagination State Synchronization [DEFAULT]

A complete scenario showing URL state, server state, and derived state working together.

```tsx
import { useQueryState, parseAsInteger, parseAsStringEnum } from 'nuqs'

function ProductListPage() {
  // URL state — source of truth for filters
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1))
  const [sort, setSort] = useQueryState('sort',
    parseAsStringEnum(['price-asc', 'price-desc', 'newest', 'popular']).withDefault('newest')
  )
  const [category, setCategory] = useQueryState('category')

  // Server state — derived from URL state
  const { data, isLoading } = useSuspenseQuery(
    queryOptions({
      queryKey: productKeys.list({ page, sort, category }),
      queryFn: () => fetchProducts({ page, sort, category }),
      staleTime: 30_000,
    })
  )

  // Local UI state — ephemeral, not in URL
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false)

  return (
    <>
      <FilterBar
        sort={sort}
        onSortChange={setSort}
        category={category}
        onCategoryChange={setCategory}
        onOpenDrawer={() => setIsFilterDrawerOpen(true)}
      />
      <ProductGrid products={data.products} />
      <Pagination
        page={page}
        totalPages={data.totalPages}
        onPageChange={setPage}
      />
      {isFilterDrawerOpen && (
        <FilterDrawer onClose={() => setIsFilterDrawerOpen(false)} />
      )}
    </>
  )
}
```

**Why this works**:
- **URL state** (page, sort, category): survives refresh, shareable, bookmarkable
- **Server state** (products): TanStack Query owns it, cached, auto-revalidated
- **Local state** (drawer open): ephemeral UI, no need to persist
- **No duplication**: each piece of state has exactly one owner

---

## useReducer vs Zustand [SITUATIONAL]

| | useReducer | Zustand |
|---|-----------|---------|
| Scope | One component tree | Cross-component |
| DevTools | React DevTools only | Redux DevTools via middleware |
| Persistence | Manual | `persist` middleware |
| Selectors | Not needed (local) | Essential (performance) |
| **Use when** | Complex local transitions | Global shared state |

**Tradeoff**: `useReducer` is simpler and doesn't need a library. Zustand scales better for cross-component state. If the state is used by one component tree, prefer `useReducer`. If 3+ components in different trees need it, use Zustand.

---

## Common Bug Patterns (Detailed)

### Zustand selector returning new object

```ts
// ❌ Creates new object every call → component re-renders every time
const { items, total } = useCartStore(s => ({
  items: s.items,
  total: s.items.reduce((sum, i) => sum + i.price, 0),
}))

// ✅ Use separate selectors for stable references
const items = useCartStore(s => s.items)
const total = useCartStore(s => s.items.reduce((sum, i) => sum + i.price, 0))

// ✅ Or use shallow equality check
import { useShallow } from 'zustand/react/shallow'
const { items, total } = useCartStore(useShallow(s => ({
  items: s.items,
  total: s.items.reduce((sum, i) => sum + i.price, 0),
})))
```

### Context value recreated every render

```tsx
// ❌ New object every render → all consumers re-render
function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
  // { theme, setTheme } is a new object every render
}

// ✅ Memoize the value
function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const value = useMemo(() => ({ theme, setTheme }), [theme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
```

---

## Safe Recommendation Template

When helping with state management:
1. **Where does this data come from?** API → TanStack Query. User input → form library. UI toggle → useState.
2. **Should it survive page refresh?** Yes → URL params or localStorage (Zustand persist). No → useState/Zustand.
3. **How many components need it?** 1 → useState. 2-3 in same tree → lift state up. Many across trees → Zustand/Context.
4. **How often does it change?** Every keystroke → Zustand with selectors (not Context). Rarely → Context is fine.
5. **Is there already a source of truth for this?** Yes → don't duplicate it. No → pick one owner.
