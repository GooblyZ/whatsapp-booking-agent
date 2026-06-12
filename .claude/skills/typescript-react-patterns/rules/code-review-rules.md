# Code Review Rules

> **Scope**: What to flag, distinguishing risk from preference, architecture smells, review templates  
> **Consult when**: Reviewing code, suggesting improvements in PRs  
> **See also**: → `anti-patterns.md`, → `debugging-checklists.md`

---

## Risk vs Preference

### [HARD RULE] Flag as risk — likely bug or maintenance bomb

**Type safety**
- `any` without documented justification
- `as` on external data (API response, URL params, FormData)
- `!` non-null assertion without prior null check
- Missing runtime validation at trust boundary
- `enum` (prefer union types)

**React**
- `useEffect` with object/array deps (likely infinite loop)
- Missing `useEffect` cleanup (listeners, timers, subscriptions)
- Server data in `useState` (stale copy)
- `"use client"` at page/layout level

**Next.js**
- `params`/`searchParams` not awaited (15+)
- Server Action without FormData validation
- Server-only import in client component
- Functions in cross-boundary Props

**Performance**
- `React.memo` on component receiving new objects every render
- Entire Zustand store selected (no selector)

### [PREFERENCE] Mention, don't block

- `type` vs `interface` for objects (prefer interface)
- Handler naming convention (`handleX` vs `onX`)
- File/folder organization
- Import ordering
- Formatting (should be handled by Prettier, not review)

---

## Architecture Smells

Flag these as **design concerns** (not necessarily bugs):

- **God component**: One component doing data fetching + state + multiple UI sections + effects
  - → Split into smaller components with clear responsibilities
- **Prop drilling 3+ levels**: Same prop passed through multiple intermediary components
  - → Context, composition (children), or restructuring
- **Duplicate fetching**: Same API called in multiple components without caching
  - → TanStack Query or shared cache
- **Business logic in components**: Calculation, validation, formatting mixed into JSX
  - → Extract to hooks or utility functions
- **Missing loading/error states**: Only the "happy path" handled
  - → Add Suspense, error boundaries, or explicit state handling
- **Giant useEffect**: Single effect doing multiple unrelated things
  - → Split into separate effects by concern

---

## Review Comment Templates

### For bugs (blocking)

> "This `as User` assertion trusts the API response without validation. If the API shape changes, this fails silently at runtime. Suggest parsing with `userSchema.parse(data)` instead. See: data-fetching-and-api-types.md."

### For improvements (non-blocking)

> "This works correctly. One option: extracting this into a custom hook would make it testable independently and reusable. Not blocking — flagging for future consideration."

### For preferences (informational)

> "Nit: `interface` would be more consistent with the rest of the codebase here, but `type` works fine for this use case."

---

## Review Checklist (copy for PR reviews)

**Must check**:
- [ ] No `any` without reason
- [ ] No `as` on external data
- [ ] API responses validated
- [ ] Effects have stable deps and cleanup
- [ ] Server/client boundary respected
- [ ] Loading and error states handled

**Should check**:
- [ ] Types derived from schemas (not duplicated)
- [ ] State in the right place (URL, query cache, or local)
- [ ] Accessibility (labels, roles, keyboard)

**Nice to check**:
- [ ] Naming consistency
- [ ] File co-location
- [ ] Import cleanliness

---

## Architecture Smell Examples (Detailed)

### God Component

**Smell**: One component doing data fetching + state + effects + complex JSX.

```tsx
// ❌ God component — doing everything
function OrderPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [filters, setFilters] = useState({ status: 'all', sort: 'date' })
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [isExporting, setIsExporting] = useState(false)

  useEffect(() => { fetchOrders(filters).then(setOrders) }, [filters])
  useEffect(() => { trackPageView('orders') }, [])

  const filteredOrders = orders.filter(/* ... */)
  const totalRevenue = orders.reduce(/* ... */)
  const handleExport = async () => { /* 20 lines of export logic */ }

  return (
    <div>
      {/* 200 lines of JSX mixing filters, table, modals, stats */}
    </div>
  )
}

// ✅ Split by responsibility
function OrderPage() {
  return (
    <>
      <OrderStats />
      <OrderFilters />
      <OrderTable />
      <OrderDetailDialog />
    </>
  )
}
// Each sub-component owns its own data fetching or receives props
// Export logic extracted to useExportOrders() hook
// Tracking extracted to usePageTracking('orders')
```

**Why it matters**: When requirements change (new filter, new column, new export format), you must understand the entire 400-line component to make a safe change.

### Prop Drilling (3+ levels)

**Smell**: Same prop passed through multiple components that don't use it.

```tsx
// ❌ onAddToCart drilled through 3 levels
<ProductPage onAddToCart={handleAdd}>        {/* passes down */}
  <ProductList onAddToCart={handleAdd}>       {/* passes down */}
    <ProductCard onAddToCart={handleAdd}>      {/* actually uses it */}
      <AddButton onClick={() => onAddToCart(id)} />
    </ProductCard>
  </ProductList>
</ProductPage>

// ✅ Option A: Composition — pass the rendered element
<ProductList
  renderItem={(product) => (
    <ProductCard
      product={product}
      action={<AddButton onClick={() => handleAdd(product.id)} />}
    />
  )}
/>

// ✅ Option B: Context / Zustand for deeply shared actions
const addToCart = useCartStore(s => s.addItem)  // accessed directly where needed
```

### Missing Loading / Error States

**Smell**: Only the happy path handled.

```tsx
// ❌ What happens during loading? On error?
function UserProfile({ userId }: { userId: string }) {
  const { data } = useQuery(userQueryOptions(userId))
  return <Profile user={data} />  // data might be undefined
}

// ✅ Handle all states
function UserProfile({ userId }: { userId: string }) {
  const { data, isLoading, isError, error } = useQuery(userQueryOptions(userId))

  if (isLoading) return <ProfileSkeleton />
  if (isError) return (
    <div role="alert">
      <p>Failed to load profile.</p>
      <button onClick={() => queryClient.refetchQueries(userKeys.detail(userId))}>
        Retry
      </button>
    </div>
  )
  return <Profile user={data} />
}

// ✅ Or use Suspense + Error Boundary (cleaner)
function UserProfilePage({ userId }: { userId: string }) {
  return (
    <ErrorBoundary fallback={<ErrorState />}>
      <Suspense fallback={<ProfileSkeleton />}>
        <UserProfile userId={userId} />
      </Suspense>
    </ErrorBoundary>
  )
}
```

---

## Safe Recommendation Template

When reviewing code:
1. **Is this a bug risk or a preference?** → Be explicit. Block bugs, suggest preferences.
2. **Is there a simpler alternative?** → Propose it, explain the tradeoff.
3. **Is the concern theoretical or proven?** → "This *will* crash when X" vs "This *could* be cleaner."
4. **Will this comment help the author grow?** → Explain *why*, not just *what*.
5. **Is this the right time?** → Large refactors belong in separate PRs, not review comments.
