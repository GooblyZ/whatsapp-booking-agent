# Component Patterns

> **Scope**: Discriminated union Props, compound components, controlled/uncontrolled, polymorphic, modal/dialog  
> **Consult when**: Designing component APIs with conditional props, multi-part components, or design-system primitives  
> **See also**: → `react-typescript-patterns.md` (basic Props), → `forms-and-validation.md` (controlled/uncontrolled forms)

---

## Discriminated Union Props [DEFAULT]

**When to use**: Component has mutually exclusive prop combinations.  
**When NOT to use**: Props are independent — just use optional fields.  
**Tradeoff**: More complex type definition, but impossible states are unrepresentable at compile time. Worth it for components with 2+ distinct modes.

```tsx
type ModalProps =
  | { variant: 'content'; children: React.ReactNode; onClose: () => void }
  | { variant: 'confirm'; title: string; message: string; onConfirm: () => void; onClose: () => void }
  | { variant: 'link'; url: string; title: string; onClose: () => void }
```

**Counterexample — why boolean flags fail**:
```tsx
// ❌ These Props allow nonsensical combinations
interface ModalProps {
  isConfirm?: boolean
  isLink?: boolean     // What if both true?
  url?: string         // Present when isLink is false?
  onConfirm?: () => void  // Callable when isConfirm is false?
  children?: ReactNode    // Rendered when isLink is true?
}
// The type system cannot prevent: { isConfirm: true, isLink: true, url: "..." }
```

### Forbidding props with `never` [SITUATIONAL]

**When to use**: Variant A has a prop that Variant B must NOT have.

```tsx
type NotificationProps =
  | { type: 'toast'; duration: number; persistent?: never }
  | { type: 'banner'; persistent: boolean; duration?: never }

<Notification type="toast" duration={3000} />           // ✅
<Notification type="toast" duration={3000} persistent /> // ❌ Error
```

### Exhaustive check [HARD RULE when using discriminated unions]

```ts
function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`)
}

// In switch default — compile error when a new variant is added
switch (props.variant) {
  case 'content': ...
  case 'confirm': ...
  case 'link':    ...
  default: assertNever(props)  // new variant → error here
}
```

---

## Modal / Dialog Pattern [DEFAULT]

A realistic production modal with proper typing, accessibility, and event handling.

**Tradeoff**: More boilerplate than a simple boolean toggle, but handles edge cases (escape key, backdrop click, focus trap, scroll lock) correctly.

```tsx
interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
}

function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return

    if (open) {
      el.showModal()  // native <dialog> handles focus trap + backdrop
    } else {
      el.close()
    }
  }, [open])

  // Handle Escape key and backdrop click
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return

    const handleCancel = (e: Event) => {
      e.preventDefault()  // prevent default close — let React control state
      onClose()
    }
    const handleClick = (e: MouseEvent) => {
      if (e.target === el) onClose()  // clicked backdrop
    }

    el.addEventListener('cancel', handleCancel)
    el.addEventListener('click', handleClick)
    return () => {
      el.removeEventListener('cancel', handleCancel)
      el.removeEventListener('click', handleClick)
    }
  }, [onClose])

  return (
    <dialog ref={dialogRef} aria-labelledby="dialog-title">
      <header>
        <h2 id="dialog-title">{title}</h2>
        <button onClick={onClose} aria-label="Close dialog">✕</button>
      </header>
      <div>{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  )
}

// Usage
function ProductPage() {
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)

  return (
    <>
      <button onClick={() => setIsDeleteOpen(true)}>Delete Product</button>
      <Dialog
        open={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        title="Delete Product"
        footer={
          <>
            <button onClick={() => setIsDeleteOpen(false)}>Cancel</button>
            <button onClick={handleDelete}>Delete</button>
          </>
        }
      >
        <p>Are you sure? This action cannot be undone.</p>
      </Dialog>
    </>
  )
}
```

---

## Compound Components [SITUATIONAL]

**When to use**: Multi-part component where children share parent state (Tabs, Accordion, Dropdown).  
**When NOT to use**: Simple parent-child — Props suffice.  
**Tradeoff**: More setup (Context, provider, hook), but gives consumers flexible composition. Components can be reordered, wrapped, or conditionally rendered without breaking state.

```tsx
// Context
interface TabsContextValue {
  activeTab: string
  setActiveTab: (id: string) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext(): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('Tabs sub-components must be within <Tabs.Root>')
  return ctx
}

// Root
function TabsRoot({ defaultTab, children }: { defaultTab: string; children: React.ReactNode }) {
  const [activeTab, setActiveTab] = useState(defaultTab)
  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div role="tablist">{children}</div>
    </TabsContext.Provider>
  )
}

// Trigger
function TabsTrigger({ id, children }: { id: string; children: React.ReactNode }) {
  const { activeTab, setActiveTab } = useTabsContext()
  return (
    <button
      role="tab"
      aria-selected={activeTab === id}
      aria-controls={`panel-${id}`}
      onClick={() => setActiveTab(id)}
    >
      {children}
    </button>
  )
}

// Panel
function TabsPanel({ id, children }: { id: string; children: React.ReactNode }) {
  const { activeTab } = useTabsContext()
  if (activeTab !== id) return null
  return <div role="tabpanel" id={`panel-${id}`}>{children}</div>
}

// Namespace export
export const Tabs = { Root: TabsRoot, Trigger: TabsTrigger, Panel: TabsPanel }

// Usage — consumers can compose freely
<Tabs.Root defaultTab="overview">
  <div className="tab-bar">
    <Tabs.Trigger id="overview">Overview</Tabs.Trigger>
    <Tabs.Trigger id="reviews">Reviews ({reviewCount})</Tabs.Trigger>
    <Tabs.Trigger id="specs">Specifications</Tabs.Trigger>
  </div>
  <Tabs.Panel id="overview"><ProductOverview product={product} /></Tabs.Panel>
  <Tabs.Panel id="reviews"><ReviewList productId={product.id} /></Tabs.Panel>
  <Tabs.Panel id="specs"><SpecsTable specs={product.specs} /></Tabs.Panel>
</Tabs.Root>
```

---

## Controlled vs Uncontrolled [DEFAULT]

| | Controlled | Uncontrolled |
|---|-----------|-------------|
| Value ownership | React state | DOM |
| Props | `value` + `onChange` | `defaultValue` + optional `ref` |
| Use when | Dynamic validation, dependent inputs, format-on-type | Simple forms, Server Actions, progressive enhancement |
| **Tradeoff** | More re-renders, but full control | Fewer re-renders, but less control |

```tsx
// Controlled — full programmatic control
interface ControlledTextFieldProps {
  value: string
  onChange: (value: string) => void
  label: string
}

// Uncontrolled — simpler, works with FormData / Server Actions
interface UncontrolledTextFieldProps {
  defaultValue?: string
  name: string  // required for FormData
  label: string
}

// Combined — support both modes (design-system pattern)
interface TextFieldProps {
  label: string
  name: string
  value?: string              // if present → controlled
  defaultValue?: string       // if present → uncontrolled
  onChange?: (value: string) => void
}
```

---

## Polymorphic `as` Pattern [SITUATIONAL]

**When to use**: Design-system primitives (Box, Text, Button) that render as different HTML elements.  
**When NOT to use**: Component always renders the same element. Complexity not justified.  
**Tradeoff**: Correct HTML attributes per element type, but complex types slow IDE and increase onboarding cost.

```tsx
type PolymorphicProps<E extends React.ElementType, P = {}> = P & {
  as?: E
} & Omit<React.ComponentPropsWithoutRef<E>, keyof P | 'as'>

function Text<E extends React.ElementType = 'span'>({
  as, children, ...rest
}: PolymorphicProps<E, { children: React.ReactNode }>) {
  const Component = as || 'span'
  return <Component {...rest}>{children}</Component>
}

<Text>span by default</Text>
<Text as="h1">Heading — gets h1 attributes</Text>
<Text as="a" href="/about">Link — gets anchor attributes</Text>
<Text as="a" disabled />  // ❌ Error: <a> has no disabled prop
```

---

## Common Bug Patterns

- Boolean flags instead of discriminated union → impossible states representable
- Missing `assertNever` → new variants silently unhandled
- Context without null check → silent undefined downstream
- Controlled input without `onChange` → React warning, read-only input
- Modal not using `<dialog>` → must manually implement focus trap, backdrop, Escape
- Compound component sub-components used outside Root → unhelpful error

## Review Checklist

- [ ] Mutually exclusive props use discriminated unions, not optional fields
- [ ] Switch covers all variants + `assertNever` in default
- [ ] Compound component context throws on missing provider
- [ ] Modals/dialogs use `<dialog>` element with proper ARIA
- [ ] Controlled inputs have both `value` AND `onChange`
- [ ] Polymorphic `as` only on design-system foundations
