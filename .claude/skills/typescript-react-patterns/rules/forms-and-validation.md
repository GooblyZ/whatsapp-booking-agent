# Forms & Validation

> **Scope**: Form state, Zod validation, react-hook-form, Server Actions, progressive enhancement  
> **Consult when**: Building or reviewing forms, choosing validation strategy  
> **See also**: → `data-fetching-and-api-types.md` (Zod schemas), → `nextjs-typescript.md` (Server Actions)

---

## Key Principles

- **[HARD RULE]** Validate on both client AND server. Client for UX, server for security.
- **[HARD RULE]** FormData values are `string | File | null`. Never `as string` without checking.
- **[DEFAULT]** Schema-first: Zod schema → derive TypeScript type → use in both client and server.
- **[DEFAULT]** Controlled for complex forms (dynamic validation, dependent fields). Uncontrolled for simple forms.

---

## Pattern: react-hook-form + Zod [DEFAULT]

```tsx
const contactSchema = z.object({
  name: z.string().min(1, 'Required'),
  email: z.string().email('Invalid email'),
  message: z.string().min(10, 'At least 10 characters'),
})

type ContactForm = z.infer<typeof contactSchema>

function ContactPage() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ContactForm>({
    resolver: zodResolver(contactSchema),
  })

  const onSubmit = async (data: ContactForm) => {
    // data is fully validated and typed
    await sendMessage(data)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <label htmlFor="name">Name</label>
      <input id="name" {...register('name')} />
      {errors.name && <span role="alert">{errors.name.message}</span>}

      <label htmlFor="email">Email</label>
      <input id="email" type="email" {...register('email')} />
      {errors.email && <span role="alert">{errors.email.message}</span>}

      <label htmlFor="message">Message</label>
      <textarea id="message" {...register('message')} />
      {errors.message && <span role="alert">{errors.message.message}</span>}

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending...' : 'Send'}
      </button>
    </form>
  )
}
```

## Pattern: Server Action + FormData [DEFAULT]

```tsx
// Shared schema (used by both server and client)
// lib/schemas/contact.ts
export const contactSchema = z.object({
  name: z.string().min(1, 'Required'),
  email: z.string().email('Invalid email'),
  message: z.string().min(10, 'At least 10 characters'),
})

// Server Action
'use server'
import { contactSchema } from '@/lib/schemas/contact'

export async function submitContact(prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = contactSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    message: formData.get('message'),
  })
  if (!parsed.success) {
    return { success: false, errors: parsed.error.flatten().fieldErrors }
  }
  await saveContact(parsed.data)
  return { success: true }
}

// Client
'use client'
function ContactForm() {
  const [state, formAction, isPending] = useActionState(submitContact, { success: false })
  return (
    <form action={formAction}>
      <input name="name" required />
      {state.errors?.name && <span role="alert">{state.errors.name[0]}</span>}
      <button disabled={isPending}>{isPending ? 'Sending...' : 'Send'}</button>
    </form>
  )
}
```

**Tradeoff**: Server Action forms work without JavaScript (progressive enhancement) but have less immediate client-side feedback.

---

## Common Bug Patterns

- `formData.get('x') as string` → could be `null` (missing field) or `File` (file input)
- Client-only validation → bypassed by malicious users
- Schema and type defined separately → drift over time
- Missing `role="alert"` on error messages → invisible to screen readers

## Review Checklist

- [ ] Types derived from Zod schema, not manually duplicated
- [ ] Server-side validation present (not just client)
- [ ] FormData values parsed through Zod, not cast with `as`
- [ ] Error messages use `role="alert"` for accessibility
- [ ] Form inputs have associated `<label>` elements
- [ ] Loading/submitting state shown to user

---

## Real-World: Multi-Step Form with Validation [DEFAULT]

A complete scenario showing schema-first, multi-section form with react-hook-form.

```tsx
// 1. Schema
const shippingSchema = z.object({
  fullName: z.string().min(1, 'Required'),
  address: z.string().min(5, 'Too short'),
  city: z.string().min(1, 'Required'),
  postalCode: z.string().regex(/^\d{5}(-\d{4})?$/, 'Invalid postal code'),
  phone: z.string().min(10, 'Invalid phone number'),
})

const paymentSchema = z.object({
  cardNumber: z.string().regex(/^\d{16}$/, 'Must be 16 digits'),
  expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, 'MM/YY format'),
  cvv: z.string().regex(/^\d{3,4}$/, 'Invalid CVV'),
})

type ShippingData = z.infer<typeof shippingSchema>
type PaymentData = z.infer<typeof paymentSchema>

// 2. Component
type CheckoutStep = 'shipping' | 'payment' | 'review'

function CheckoutForm() {
  const [step, setStep] = useState<CheckoutStep>('shipping')
  const [shipping, setShipping] = useState<ShippingData | null>(null)

  if (step === 'shipping') {
    return (
      <ShippingForm
        defaultValues={shipping ?? undefined}
        onNext={(data) => { setShipping(data); setStep('payment') }}
      />
    )
  }
  if (step === 'payment') {
    return (
      <PaymentForm
        onBack={() => setStep('shipping')}
        onNext={(data) => { submitOrder(shipping!, data); setStep('review') }}
      />
    )
  }
  return <OrderConfirmation />
}

// 3. Step component
function ShippingForm({
  defaultValues,
  onNext,
}: {
  defaultValues?: ShippingData
  onNext: (data: ShippingData) => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ShippingData>({
    resolver: zodResolver(shippingSchema),
    defaultValues,
  })

  return (
    <form onSubmit={handleSubmit(onNext)}>
      <fieldset>
        <legend>Shipping Address</legend>

        <label htmlFor="fullName">Full Name</label>
        <input id="fullName" {...register('fullName')} />
        {errors.fullName && <span role="alert">{errors.fullName.message}</span>}

        <label htmlFor="address">Address</label>
        <input id="address" {...register('address')} />
        {errors.address && <span role="alert">{errors.address.message}</span>}

        <label htmlFor="city">City</label>
        <input id="city" {...register('city')} />

        <label htmlFor="postalCode">Postal Code</label>
        <input id="postalCode" {...register('postalCode')} />
        {errors.postalCode && <span role="alert">{errors.postalCode.message}</span>}

        <label htmlFor="phone">Phone</label>
        <input id="phone" type="tel" {...register('phone')} />
      </fieldset>

      <button type="submit" disabled={isSubmitting}>Continue to Payment</button>
    </form>
  )
}
```

**Why this works**:
- Schema is the single source of truth for both types and validation
- Each step validates independently
- Previous step data preserved when going back
- All inputs have labels, errors use `role="alert"`
- `defaultValues` pre-fills when user navigates back

---

## Safe Recommendation Template

When helping with forms:
1. Is there a Zod schema? If not → create one first, derive types from it
2. Is server-side validation present? If not → add it (client is not enough)
3. Are FormData values validated? If not → parse through schema, don't cast
4. Are error messages accessible? If not → add `role="alert"`
5. Is there a loading/submitting state? If not → add it
