# React + TypeScript Patterns

> **Scope**: Props, children, events, hooks, context, forwardRef  
> **Consult when**: Typing any React component, hook, or context  
> **See also**: → `component-patterns.md` (advanced patterns), → `typescript-core.md` (generics)

---

## Props [HARD RULE]

Use `interface`. Extend native HTML attributes when wrapping elements. Only truly optional fields get `?`.

```tsx
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  isLoading?: boolean
}

function Button({ variant, size = 'md', isLoading, children, ...rest }: ButtonProps) {
  return (
    <button disabled={isLoading || rest.disabled} {...rest}>
      {isLoading ? <Spinner /> : children}
    </button>
  )
}
```

**When custom props collide with native**: `Omit` the native one.

```tsx
type Base = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange'>

interface TextFieldProps extends Base {
  size: 'sm' | 'md' | 'lg'
  onChange: (value: string) => void
  label: string
  error?: string
}
```

### children [HARD RULE]

Use `React.ReactNode`. Never `JSX.Element` (excludes strings, numbers, null, fragments).

```tsx
interface CardProps {
  children: React.ReactNode    // ✅ accepts string, number, null, fragments
  title: string
}

// ❌ JSX.Element — too narrow
interface CardProps { children: JSX.Element }
```

---

## forwardRef [DEFAULT]

**When to use**: Parent needs DOM access (focus, measurement, scroll-to, animation).

```tsx
interface InputProps extends React.ComponentPropsWithoutRef<'input'> {
  label: string
  error?: string
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, ...rest }, ref) => (
    <div>
      <label>{label}</label>
      <input ref={ref} aria-invalid={!!error} {...rest} />
      {error && <span role="alert">{error}</span>}
    </div>
  )
)
Input.displayName = 'Input'
```

**Key detail**: Use `ComponentPropsWithoutRef` (not `WithRef`) — `forwardRef` handles ref separately.

**Common bug**: Missing `displayName` → poor DevTools experience.

---

## Event Handlers [DEFAULT]

**Inline**: Let inference work — no annotation needed.  
**Extracted**: Use `React.XEvent<HTMLXElement>`.  
**Custom Props**: Expose values, not event objects.

```tsx
// ✅ Custom handler exposes value, not event
interface SearchBarProps {
  onSearch: (query: string) => void
}

function SearchBar({ onSearch }: SearchBarProps) {
  return <input onChange={(e) => onSearch(e.target.value)} />
}

// ❌ Leaking event object to parent
interface SearchBarProps {
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}
```

**Quick reference**:
```
onClick:   React.MouseEvent<HTMLButtonElement>
onChange:  React.ChangeEvent<HTMLInputElement>
onSubmit:  React.FormEvent<HTMLFormElement>
onKeyDown: React.KeyboardEvent<HTMLInputElement>
```

---

## Custom Hooks [DEFAULT]

Return type should be inferred unless the hook is exported from a library.

```ts
function useToggle(initial = false) {
  const [value, setValue] = useState(initial)
  const toggle = useCallback(() => setValue(v => !v), [])
  const setTrue = useCallback(() => setValue(true), [])
  const setFalse = useCallback(() => setValue(false), [])
  return { value, toggle, setTrue, setFalse } as const
}
```

### Generic Hooks [SITUATIONAL]

Only when the hook works with multiple types AND T is inferable from arguments.

```ts
function useForm<T extends Record<string, unknown>>(initialValues: T) {
  const [values, setValues] = useState<T>(initialValues)
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({})

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues(prev => ({ ...prev, [key]: value }))
  }, [])

  const reset = useCallback(() => setValues(initialValues), [initialValues])

  return { values, errors, setValue, reset }
}

// T inferred automatically
const form = useForm({ name: '', age: 0 })
form.setValue('name', 'Eddie')    // ✅
form.setValue('age', 'twenty')    // ❌ must be number
```

---

## Context [DEFAULT]

Always define context type explicitly. Always throw on missing provider.

```tsx
interface ThemeContextValue {
  theme: 'light' | 'dark'
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>')
  return ctx
}
```

**Common bug**: `createContext(undefined)` without null check → silent undefined access.

---

## Generic Components [SITUATIONAL]

**When to use**: Lists, selects, tables, autocompletes — components that work with arbitrary data shapes.

```tsx
interface SelectProps<T> {
  items: T[]
  value: T | null
  onChange: (item: T) => void
  getLabel: (item: T) => string
  getKey: (item: T) => string | number
  placeholder?: string
}

function Select<T>({ items, value, onChange, getLabel, getKey, placeholder }: SelectProps<T>) {
  return (
    <select
      value={value ? String(getKey(value)) : ''}
      onChange={(e) => {
        const found = items.find(item => String(getKey(item)) === e.target.value)
        if (found) onChange(found)
      }}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {items.map(item => (
        <option key={getKey(item)} value={String(getKey(item))}>
          {getLabel(item)}
        </option>
      ))}
    </select>
  )
}
```

---

## Common Bug Patterns

- `ReturnType<typeof useX>` as Props → couples UI to hook implementation
- All Props optional when actually required → null checks everywhere
- `JSX.Element` for children → breaks with strings, null, fragments
- `ComponentPropsWithRef` with `forwardRef` → double ref conflict
- Missing `...rest` spread → native attributes silently ignored
- Context without null check → silent undefined access downstream

## Review Checklist

- [ ] Props use `interface`, not `type` for objects
- [ ] `children: React.ReactNode` (not `JSX.Element`)
- [ ] Only truly optional props have `?`
- [ ] `...rest` spread on underlying HTML element
- [ ] `displayName` on forwardRef components
- [ ] Context hook throws on missing provider
- [ ] Event handler Props expose values, not events
- [ ] Generic hooks have inferable T from arguments

---

## Design-System Component API Example [SITUATIONAL]

A realistic design-system `<Badge>` showing variant-driven styling, size, and optional icon.

```tsx
interface BadgeProps {
  variant: 'default' | 'success' | 'warning' | 'error' | 'info'
  size?: 'sm' | 'md'
  icon?: React.ReactNode
  children: React.ReactNode
}

function Badge({ variant, size = 'sm', icon, children }: BadgeProps) {
  return (
    <span
      className={`badge badge-${variant} badge-${size}`}
      role="status"
    >
      {icon && <span className="badge-icon" aria-hidden="true">{icon}</span>}
      {children}
    </span>
  )
}

// Usage
<Badge variant="success" icon={<CheckIcon />}>Payment complete</Badge>
<Badge variant="error" size="md">3 errors</Badge>
```

---

## Render Props / Slot Pattern [SITUATIONAL]

**When to use**: Parent needs to control how children render, but child owns the data.  
**When NOT to use**: Simple composition with `children: ReactNode` suffices.  
**Tradeoff**: More flexible than fixed children, but harder to read. Consider compound components first.

```tsx
interface DataTableProps<T> {
  data: T[]
  columns: {
    key: string
    header: string
    render: (item: T) => React.ReactNode  // render prop per column
  }[]
  keyExtractor: (item: T) => string
  emptyState?: React.ReactNode  // slot pattern
}

function DataTable<T>({ data, columns, keyExtractor, emptyState }: DataTableProps<T>) {
  if (data.length === 0) return <>{emptyState ?? <p>No data.</p>}</>

  return (
    <table>
      <thead>
        <tr>{columns.map(col => <th key={col.key}>{col.header}</th>)}</tr>
      </thead>
      <tbody>
        {data.map(item => (
          <tr key={keyExtractor(item)}>
            {columns.map(col => <td key={col.key}>{col.render(item)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// Usage — T inferred as Order
<DataTable
  data={orders}
  keyExtractor={o => o.id}
  columns={[
    { key: 'id', header: 'Order ID', render: (o) => <code>{o.id}</code> },
    { key: 'total', header: 'Total', render: (o) => formatPrice(o.total) },
    { key: 'status', header: 'Status', render: (o) => <Badge variant={statusVariant(o.status)}>{o.status}</Badge> },
  ]}
  emptyState={<p>No orders yet. <a href="/products">Start shopping</a></p>}
/>
```

---

## useReducer with Discriminated Action [DEFAULT]

**When to use**: Component has multiple related state transitions (form wizard, complex toggle logic).  
**Tradeoff**: More boilerplate than useState, but state transitions are explicit and testable.

```ts
type CartAction =
  | { type: 'add'; item: CartItem }
  | { type: 'remove'; itemId: string }
  | { type: 'updateQuantity'; itemId: string; quantity: number }
  | { type: 'clear' }

interface CartState {
  items: CartItem[]
  lastUpdated: number
}

function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add':
      return { items: [...state.items, action.item], lastUpdated: Date.now() }
    case 'remove':
      return { items: state.items.filter(i => i.id !== action.itemId), lastUpdated: Date.now() }
    case 'updateQuantity':
      return {
        items: state.items.map(i =>
          i.id === action.itemId ? { ...i, quantity: action.quantity } : i
        ),
        lastUpdated: Date.now(),
      }
    case 'clear':
      return { items: [], lastUpdated: Date.now() }
  }
}

// Usage
const [cart, dispatch] = useReducer(cartReducer, { items: [], lastUpdated: 0 })
dispatch({ type: 'add', item: newItem })
dispatch({ type: 'updateQuantity', itemId: '123', quantity: 3 })
```

---

## Common Bug Patterns (Detailed)

### Stale Props in callback

**Symptom**: Callback reads old prop value after parent re-renders.
```tsx
// ❌ onClick captures initial onSelect
function Item({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  const handleClick = useCallback(() => {
    onSelect(id)  // if onSelect changes, this is stale
  }, [])  // missing deps

  return <button onClick={handleClick}>Select</button>
}

// ✅ Include deps or skip useCallback (button isn't memoized anyway)
function Item({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  return <button onClick={() => onSelect(id)}>Select</button>
}
```

### Overusing React.memo without stable props

**Symptom**: Component still re-renders despite being wrapped in React.memo.
```tsx
// ❌ Parent creates new object every render → memo is useless
function Parent() {
  return <MemoChild style={{ color: 'red' }} />  // new object each render
}

// ✅ Stabilize or move outside component
const style = { color: 'red' } as const  // stable reference
function Parent() {
  return <MemoChild style={style} />
}
```

---

## Safe Recommendation Template

When helping with React + TypeScript:
1. **Props question?** → Start with `interface`, extend HTML attributes if wrapping an element
2. **children type?** → `React.ReactNode` unless you need a render function
3. **Event handler?** → Inline = infer. Extracted = `React.XEvent<HTMLXElement>`. Custom = pass values.
4. **Hook return type?** → Let inference work. Only annotate if exported from a library.
5. **Generic component?** → Only if T is inferable from props. Show usage example.
6. **Context?** → `createContext<T | null>(null)` + hook that throws on missing provider
