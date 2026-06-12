# Performance & Accessibility

> **Scope**: Memoization tradeoffs, effect stability, rendering optimization, semantic HTML, ARIA  
> **Consult when**: Fixing re-render issues, optimizing performance, ensuring accessibility  
> **See also**: → `state-management.md`, → `debugging-checklists.md` (effect bugs)

---

## Memoization [SITUATIONAL]

### [DEFAULT] Don't memoize by default

React Compiler (19+) handles most memoization. Manual memos add complexity.

### [DEFAULT] Restructure before memoizing

```tsx
// ❌ Memoizing to work around state placement
function Page() {
  const [query, setQuery] = useState('')
  return (
    <>
      <SearchBar value={query} onChange={setQuery} />
      {useMemo(() => <ExpensiveList />, [])}
    </>
  )
}

// ✅ Move state down — ExpensiveList no longer re-renders
function Page() {
  return (
    <>
      <SearchSection />
      <ExpensiveList />
    </>
  )
}
function SearchSection() {
  const [query, setQuery] = useState('')
  return <SearchBar value={query} onChange={setQuery} />
}
```

### When React.memo IS justified [SITUATIONAL]

- Component renders 50+ times (list items)
- Props rarely change
- Render is genuinely expensive (complex DOM, canvas, charts)

```tsx
const ProductCard = React.memo(function ProductCard({ product }: { product: Product }) {
  return (
    <article>
      <img src={product.image} alt={product.name} loading="lazy" />
      <h3>{product.name}</h3>
      <p>{formatPrice(product.price)}</p>
    </article>
  )
})
```

### [HARD RULE] Don't break memo with unstable Props

```tsx
// ❌ New object every render → memo is useless
<MemoChild config={{ theme: 'dark' }} />

// ✅ Stable reference
const config = useMemo(() => ({ theme: 'dark' }), [])
<MemoChild config={config} />
```

---

## Effect Stability [HARD RULE]

See → `debugging-checklists.md` for full playbook.

```ts
// ❌ Object in deps → infinite loop
useEffect(() => { fetch(options) }, [options])  // new object every render

// ✅ Destructure to primitives
const { page, sort } = options
useEffect(() => { fetch({ page, sort }) }, [page, sort])
```

---

## Accessibility [HARD RULE where noted]

### Forms [HARD RULE]

- Every `<input>` needs a `<label>` (visible or `aria-label`)
- Error messages use `role="alert"`
- Submit button disabled during loading with visual feedback

### Semantic HTML [DEFAULT]

```tsx
// ❌ div soup
<div onClick={handleClick}>Click me</div>

// ✅ Semantic
<button onClick={handleClick}>Click me</button>
```

### Interactive elements [HARD RULE]

- Must be focusable (button, a, input — or `tabIndex={0}`)
- Must respond to keyboard (Enter, Space, Escape as appropriate)
- Must have accessible name (text content, `aria-label`, or `aria-labelledby`)

### Loading states [DEFAULT]

```tsx
<button disabled={isLoading} aria-busy={isLoading}>
  {isLoading ? 'Saving...' : 'Save'}
</button>
```

### Modals [DEFAULT]

- Trap focus inside modal when open
- Return focus to trigger element on close
- Close on Escape key
- Use `role="dialog"` and `aria-modal="true"`

---

## Common Bug Patterns

- `useMemo` for trivial computation (`items.length`)
- `useCallback` without a memoized consumer
- New object/array in render passed to memoized child
- `<div>` with `onClick` instead of `<button>` → not keyboard accessible
- Missing `<label>` on inputs → invisible to screen readers
- Loading state not communicated (no `aria-busy` or text change)

## Review Checklist

- [ ] No premature `React.memo`/`useMemo`/`useCallback`
- [ ] State lives as close to usage as possible
- [ ] No new objects in render passed to memoized children
- [ ] All form inputs have labels
- [ ] Error messages have `role="alert"`
- [ ] Interactive elements are keyboard accessible
- [ ] Loading states communicated visually AND to assistive technology

---

## Accessibility Deep Dive

### Focus Management [HARD RULE for interactive components]

**When to implement**: Modals, drawers, dropdown menus, route changes, dynamic content insertion.

```tsx
// Pattern: Return focus to trigger after modal closes
function useReturnFocus() {
  const triggerRef = useRef<HTMLElement | null>(null)

  const saveTrigger = () => {
    triggerRef.current = document.activeElement as HTMLElement
  }

  const returnFocus = () => {
    triggerRef.current?.focus()
    triggerRef.current = null
  }

  return { saveTrigger, returnFocus }
}

// Usage in a dialog component
function Dialog({ open, onClose, children }: DialogProps) {
  const { saveTrigger, returnFocus } = useReturnFocus()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open) {
      saveTrigger()
      dialogRef.current?.showModal()
    } else {
      dialogRef.current?.close()
      returnFocus()
    }
  }, [open])

  return (
    <dialog ref={dialogRef} aria-labelledby="dialog-title">
      {children}
    </dialog>
  )
}
```

### Skip Navigation [HARD RULE for multi-page apps]

```tsx
// Layout.tsx — first focusable element on the page
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Header />
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </>
  )
}
```

```css
.skip-link {
  position: absolute;
  left: -9999px;
  top: auto;
}
.skip-link:focus {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  padding: 1rem;
  background: white;
}
```

### Live Regions [DEFAULT]

**When to use**: Content updates that screen readers should announce (toast notifications, search result counts, async status changes).

```tsx
// Toast notification container
function ToastContainer({ toasts }: { toasts: Toast[] }) {
  return (
    <div aria-live="polite" aria-atomic="false" className="toast-container">
      {toasts.map(toast => (
        <div key={toast.id} role="status">
          {toast.message}
        </div>
      ))}
    </div>
  )
}

// Search results count
function SearchResults({ query, results }: { query: string; results: Product[] }) {
  return (
    <>
      <p aria-live="polite" role="status">
        {results.length} results for "{query}"
      </p>
      <ul>
        {results.map(r => <ProductCard key={r.id} product={r} />)}
      </ul>
    </>
  )
}
```

| `aria-live` value | Behavior | Use for |
|-------------------|----------|---------|
| `polite` | Announces after current speech finishes | Search results, status updates |
| `assertive` | Interrupts current speech | Errors, urgent alerts |

### Keyboard Navigation Patterns [HARD RULE for custom interactive widgets]

```tsx
// Roving tabindex for a tab list / toolbar
function TabList({ tabs, activeTab, onTabChange }: TabListProps) {
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex: number | null = null

    switch (e.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length
        break
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = tabs.length - 1
        break
    }

    if (nextIndex !== null) {
      e.preventDefault()
      onTabChange(tabs[nextIndex].id)
      // Focus the new tab
      const tabElements = e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')
      ;(tabElements?.[nextIndex] as HTMLElement)?.focus()
    }
  }

  return (
    <div role="tablist">
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          tabIndex={activeTab === tab.id ? 0 : -1}  // roving tabindex
          onKeyDown={(e) => handleKeyDown(e, i)}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
```

**Key**: Only the active tab has `tabIndex={0}`. Others have `tabIndex={-1}`. Arrow keys move focus between tabs. Tab key moves to the panel.

### Color Contrast [HARD RULE]

Not a TypeScript concern, but the agent should flag insufficient contrast when reviewing component styles:
- **Normal text**: minimum 4.5:1 contrast ratio
- **Large text** (18px+ or 14px bold): minimum 3:1
- **UI components and graphics**: minimum 3:1

---

## Real-World: List Rendering Optimization [DEFAULT]

Complete example showing list performance without over-memoizing.

```tsx
interface ProductListProps {
  products: Product[]
  onAddToCart: (productId: string) => void
}

function ProductList({ products, onAddToCart }: ProductListProps) {
  return (
    <ul role="list" aria-label="Products">
      {products.map(product => (
        <ProductCard
          key={product.id}
          product={product}
          onAddToCart={onAddToCart}
        />
      ))}
    </ul>
  )
}

// Memo justified: renders 50+ times, product data rarely changes per item
const ProductCard = React.memo(function ProductCard({
  product,
  onAddToCart,
}: {
  product: Product
  onAddToCart: (id: string) => void
}) {
  return (
    <li className="product-card">
      <img src={product.image} alt="" loading="lazy" width={200} height={200} />
      <h3>{product.name}</h3>
      <p>{formatPrice(product.price)}</p>
      <button onClick={() => onAddToCart(product.id)}>
        Add to cart
      </button>
    </li>
  )
})
```

**Why `React.memo` is justified here**:
- List could have 50-200 items
- Individual product data rarely changes
- `onAddToCart` should be stable (useCallback in parent or Zustand action)
- Render cost per card is non-trivial (image, formatting)

**Why NOT to memo `ProductList` itself**: It re-renders when `products` array changes — that's correct behavior.

---

## Common Bug Patterns (Detailed)

### Missing `alt` on images

```tsx
// ❌ No alt → invisible to screen readers
<img src={product.image} />

// ✅ Descriptive alt for content images
<img src={product.image} alt={`Photo of ${product.name}`} />

// ✅ Empty alt for decorative images
<img src="/decorative-border.svg" alt="" />
```

### Interactive div without keyboard support

```tsx
// ❌ Not keyboard accessible, no role
<div onClick={handleSelect} className="card">
  {product.name}
</div>

// ✅ Use a button (or add role + keyboard handling)
<button onClick={handleSelect} className="card">
  {product.name}
</button>

// ✅ If must be a div (rare): add role, tabIndex, keyboard handler
<div
  role="button"
  tabIndex={0}
  onClick={handleSelect}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelect() }}
>
  {product.name}
</div>
```

---

## Safe Recommendation Template

When helping with performance:
1. **"It's slow"** → Profile first. Don't guess. React DevTools Profiler or Chrome Performance tab.
2. **Re-render issue?** → Check if state can be moved down. Restructure before memoizing.
3. **Large list?** → `React.memo` on list items + stable key + `loading="lazy"` on images.
4. **Suggesting memo?** → Verify props are actually stable. If not, memo is useless.

When helping with accessibility:
1. **Form?** → Every input needs a label. Errors need `role="alert"`.
2. **Modal?** → Focus trap, return focus on close, Escape to dismiss.
3. **Custom widget?** → Keyboard navigable, proper ARIA role, announced to screen readers.
4. **Dynamic content?** → `aria-live` for async updates.
5. **Interactive element?** → Use `<button>`/`<a>` not `<div>`. If div is unavoidable: `role`, `tabIndex`, keyboard events.
