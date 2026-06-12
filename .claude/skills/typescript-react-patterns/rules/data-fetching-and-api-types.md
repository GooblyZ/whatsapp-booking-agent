# Data Fetching & API Types

> **Scope**: Fetch typing, schema validation, safe response handling, TanStack Query  
> **Consult when**: Typing API calls, handling responses, setting up React Query  
> **See also**: → `typescript-core.md` (Zod basics), → `forms-and-validation.md`, → `state-management.md`

---

## Trust Boundaries [HARD RULE]

Static types do NOT validate runtime data. Every API response, URL param, and external input MUST be validated.

```ts
// ❌ Trusting API response
const user: User = await res.json()  // no guarantee shape matches

// ✅ Parse at the boundary
const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
})
type User = z.infer<typeof userSchema>

async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/api/users/${id}`)
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return userSchema.parse(await res.json())
}
```

---

## Result Type [DEFAULT]

For expected failures (not found, forbidden, validation). Exceptions for unexpected failures (bugs).

```ts
type Result<T, E = string> =
  | { success: true; data: T }
  | { success: false; error: E }

async function getUser(id: string): Promise<Result<User, 'NOT_FOUND' | 'FORBIDDEN'>> {
  const user = await db.user.findUnique({ where: { id } })
  if (!user) return { success: false, error: 'NOT_FOUND' }
  return { success: true, data: user }
}

// Caller MUST handle both cases
const result = await getUser(id)
if (!result.success) {
  if (result.error === 'NOT_FOUND') return notFound()
  if (result.error === 'FORBIDDEN') return redirect('/login')
}
// result.data narrowed to User
```

**When NOT to use**: Truly unexpected errors → let them throw. Simple functions that can't fail → just return the value.

---

## TanStack Query [DEFAULT]

### queryOptions — single source of truth

```ts
import { queryOptions } from '@tanstack/react-query'

function userQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['users', 'detail', id] as const,
    queryFn: async () => {
      const res = await fetch(`/api/users/${id}`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      return userSchema.parse(await res.json())
    },
    staleTime: 5 * 60_000,
  })
}
```

### Usage across the app

```ts
// In component (Suspense eliminates undefined)
const { data: user } = useSuspenseQuery(userQueryOptions(id))
// user is User, not User | undefined

// Prefetch (e.g., in loader or server component)
await queryClient.prefetchQuery(userQueryOptions(id))

// Cache write — type-safe
queryClient.setQueryData(userQueryOptions(id).queryKey, updatedUser)

// Invalidation
queryClient.invalidateQueries({ queryKey: ['users'] })  // all user queries
```

### Query Key Factory [DEFAULT]

```ts
const userKeys = {
  all:     () => ['users'] as const,
  lists:   () => [...userKeys.all(), 'list'] as const,
  list:    (filters: UserFilters) => [...userKeys.lists(), filters] as const,
  details: () => [...userKeys.all(), 'detail'] as const,
  detail:  (id: string) => [...userKeys.details(), id] as const,
}
```

### Typed select [DEFAULT]

```ts
// Define a list query separately from the detail query
function userListQueryOptions(filters?: UserFilters) {
  return queryOptions({
    queryKey: userKeys.list(filters ?? {}),
    queryFn: async () => {
      const res = await fetch(`/api/users?${new URLSearchParams(filters as any)}`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      return z.array(userSchema).parse(await res.json())
    },
    staleTime: 30_000,
  })
}

function useUserNames() {
  return useQuery({
    ...userListQueryOptions(),
    select: (users): string[] => users.map(u => u.name),
    // Memoized — only recalculates when source data changes
  })
}
```

### Typed mutations [DEFAULT]

```ts
function useUpdateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateUserInput }) => {
      const res = await fetch(`/api/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      return userSchema.parse(await res.json())
    },
    onSuccess: (updatedUser, { id }) => {
      queryClient.setQueryData(userKeys.detail(id), updatedUser)
      queryClient.invalidateQueries({ queryKey: userKeys.lists() })
    },
  })
}
```

---

## Schema Utilities [DEFAULT]

```ts
const createUserSchema = userSchema.omit({ id: true })
const updateUserSchema = userSchema.partial().omit({ id: true })
const loginSchema = userSchema.pick({ email: true }).extend({ password: z.string().min(8) })

type CreateUserInput = z.infer<typeof createUserSchema>
type UpdateUserInput = z.infer<typeof updateUserSchema>
```

## Environment Variables [HARD RULE]

```ts
const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'production', 'test']),
})
export const env = envSchema.parse(process.env)
```

---

## Common Bug Patterns

- `res.json()` typed with `as User` → no runtime validation
- Hardcoded query keys → typo in one place, stale cache in another
- `data as User` on query result → may be `undefined` before load
- Transforming data in component instead of `select` → recalculates every render
- Schema and manually-written type diverge over time
- `z.any()` in schema → defeats the purpose of validation

## Review Checklist

- [ ] Every API response parsed through Zod schema
- [ ] Types derived from schemas (`z.infer`), not duplicated
- [ ] Query keys in a factory, not hardcoded strings
- [ ] `queryOptions` for reusable query configs
- [ ] No `as` on API data
- [ ] `select` for derived data
- [ ] Environment variables validated at startup

---

## Pagination Types [DEFAULT]

**Tradeoff**: More types to define upfront, but prevents page/offset/cursor bugs at compile time.

```ts
// Offset-based pagination
interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const paginatedUsersSchema = z.object({
  data: z.array(userSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
})

// Cursor-based pagination
interface CursorResponse<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}
```

### Real-World: Paginated List with TanStack Query

```tsx
function useUsers(page: number, pageSize = 20) {
  return useSuspenseQuery(
    queryOptions({
      queryKey: userKeys.list({ page, pageSize }),
      queryFn: async () => {
        const res = await fetch(`/api/users?page=${page}&pageSize=${pageSize}`)
        if (!res.ok) throw new Error(`Failed: ${res.status}`)
        return paginatedUsersSchema.parse(await res.json())
      },
      staleTime: 30_000,
    })
  )
}

function UserListPage() {
  const [page, setPage] = useState(1)
  const { data } = useUsers(page)

  return (
    <>
      <ul>
        {data.data.map(user => (
          <li key={user.id}>
            <span>{user.name}</span>
            <span>{user.email}</span>
          </li>
        ))}
      </ul>
      <nav aria-label="Pagination">
        <button onClick={() => setPage(p => p - 1)} disabled={page <= 1}>
          Previous
        </button>
        <span>Page {data.page} of {data.totalPages}</span>
        <button onClick={() => setPage(p => p + 1)} disabled={page >= data.totalPages}>
          Next
        </button>
      </nav>
    </>
  )
}
```

---

## Error & Retry Typing [DEFAULT]

**Tradeoff**: More explicit error handling code, but prevents silent failures and improves UX.

```ts
// TanStack Query error handling with typed errors
const userQuery = useQuery({
  ...userQueryOptions(id),
  retry: (failureCount, error) => {
    // Don't retry on 4xx (client errors)
    if (error instanceof Response && error.status >= 400 && error.status < 500) {
      return false
    }
    return failureCount < 3
  },
})

// Error boundary integration
function UserProfile({ id }: { id: string }) {
  const { data, error, isError } = useQuery(userQueryOptions(id))

  if (isError) {
    return (
      <div role="alert">
        <p>Failed to load user profile.</p>
        <button onClick={() => queryClient.refetchQueries(userKeys.detail(id))}>
          Retry
        </button>
      </div>
    )
  }

  if (!data) return <Skeleton />
  return <Profile user={data} />
}
```

---

## Safe Recommendation Template

When helping with data fetching:
1. Is the response validated? If not → add Zod schema
2. Is the query key in a factory? If not → create one
3. Are errors handled in the UI? If not → add error state
4. Is loading state shown? If not → add Suspense or conditional render
5. Is pagination type-safe? If not → define PaginatedResponse<T>
