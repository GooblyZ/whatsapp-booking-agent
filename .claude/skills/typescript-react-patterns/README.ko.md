# typescript-react-patterns

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-18+-61DAFB?logo=react&logoColor=black)
![Next.js](https://img.shields.io/badge/Next.js-14+-000?logo=next.js)

> TypeScript, React, Next.js를 위한 실전형 Agent Skill

English README: [README.md](README.md)

실제 TypeScript 프론트엔드에서 일하는 AI 코딩 에이전트를 위한 구조화된 마크다운 레퍼런스입니다. 특히 React 패턴과 Next.js App Router 아키텍처에 강하게 초점을 맞추고 있습니다.

**npm 패키지가 아닙니다. 튜토리얼도 아닙니다.** 프론트엔드 엔지니어를 보조하는 AI 에이전트를 위한, 실무 중심의 필드 매뉴얼입니다.

## Before / After

### 이 skill이 없을 때

```ts
User: "이 API 호출 타입 잡아줘";
Agent: const user: User = await res.json(); // ❌ 런타임 검증 없음
```

### 이 skill이 있을 때

```ts
User: "이 API 호출 타입 잡아줘";
Agent: const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
type User = z.infer<typeof userSchema>;
const user = userSchema.parse(await res.json()); // ✅ 런타임 검증 + 타입 안정성
```

### 이 skill이 없을 때

```ts
User: "이 컴포넌트에 로딩 상태 추가해줘";
Agent: const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState(null);
const [data, setData] = useState(null); // ❌ boolean 플래그 + nullable 필드 남용
```

### 이 skill이 있을 때

```ts
User: "이 컴포넌트에 로딩 상태 추가해줘";
// 판별 유니온으로 불가능한 상태를 아예 표현할 수 없게 만듦
Agent: type State<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: Error };
```

## 설치

```bash
# 전역 설치 (모든 프로젝트)
git clone https://github.com/leejpsd/typescript-react-patterns.git ~/.claude/skills/typescript-react-patterns

# 프로젝트 전용 설치
git clone https://github.com/leejpsd/typescript-react-patterns.git .claude/skills/typescript-react-patterns
```

Claude Code, Cursor, Codex, Gemini CLI, 그리고 `SKILL.md`를 읽을 수 있는 모든 에이전트에서 사용할 수 있습니다.

## 구조

```text
typescript-react-patterns/
├── SKILL.md                                ← 허브: 에이전트 규칙, 의사결정 가이드, 체크리스트
├── rules/                                  ← 패턴 레퍼런스 모음 (필요할 때 로드)
│   ├── typescript-core.md                     narrowing, unions, generics, utility types, as const, satisfies
│   ├── react-typescript-patterns.md           Props, children, events, hooks, context, forwardRef
│   ├── nextjs-typescript.md                   App Router, params, Server Actions, RSC, Edge, useOptimistic
│   ├── component-patterns.md                  판별 Props, compound components, modal/dialog, polymorphic
│   ├── data-fetching-and-api-types.md         Fetch, Zod, TanStack Query, Result<T,E>, pagination, error handling
│   ├── forms-and-validation.md                Form state, Zod, react-hook-form, Server Actions, multi-step forms
│   ├── state-management.md                    local vs context vs Zustand (+ middleware) vs TanStack Query vs URL state
│   ├── performance-and-accessibility.md       메모이제이션, effects, semantic HTML, ARIA, focus management
│   ├── debugging-checklists.md                빠른 진단 라우터, serialization, null access
│   ├── code-review-rules.md                   risk vs preference, architecture smells, comment templates
│   └── anti-patterns.md                       흔한 실수 12가지와 원인, 해결법
├── playbooks/                              ← 단계별 디버깅 가이드
│   ├── type-error-debugging.md                체계적인 타입 에러 해결
│   ├── hydration-issues.md                    SSR/CSR mismatch 진단 흐름도
│   └── effect-dependency-bugs.md              loops, stale closures, cleanups, debounce example
├── README.md
├── README.ko.md
└── LICENSE
```

## 무엇이 다른가

대부분의 프론트엔드 skill은 TypeScript 팁 모음에 머무르지만, 이 skill은 React와 Next.js에서 에이전트가 실제로 자주 틀리는 지점을 더 깊게 다룹니다. Props 설계, effect 안정성, 상태 소유권, server/client boundary, `searchParams`, Server Actions, hydration, serialization, 그리고 리뷰 단계의 아키텍처 판단까지 실무 관점에서 다룹니다.

즉, 단순히 패턴을 나열하는 문서가 아니라 React와 Next.js 코드베이스에서 에이전트가 더 안전한 판단을 하도록 돕는 운영형 레퍼런스에 가깝습니다.

| 항목                   | 일반적인 skill | 이 skill                                                       |
| ---------------------- | -------------- | -------------------------------------------------------------- |
| React + Next.js 깊이   | 얕거나 범용적  | 실제 React 패턴과 Next.js App Router 제약을 깊게 다룸          |
| 패턴 가이드            | ✅             | ✅                                                             |
| 에이전트 행동 규칙     | ❌             | ✅ 무엇을 먼저 확인해야 하는지, 무엇을 가정하면 안 되는지 제시 |
| 의사결정 가이드        | ❌             | ✅ 상황별 추천 패턴과 참고 파일 제시                           |
| 디버깅 플레이북        | ❌             | ✅ 타입 에러, hydration, effect, serialization 대응            |
| 코드 리뷰 휴리스틱     | ❌             | ✅ risk vs preference, comment templates 제공                  |
| 규칙 분류              | ❌             | ✅ [HARD RULE] / [DEFAULT] / [SITUATIONAL]                     |
| 생성 + 리뷰 체크리스트 | ❌             | ✅ `SKILL.md`에 별도 제공                                      |

## 각 파일이 담고 있는 것

모든 모듈은 일관된 구조를 따릅니다.

- **Scope** + **Consult when** + **See also** (상호 참조)
- **핵심 규칙**을 [HARD RULE], [DEFAULT], [SITUATIONAL]로 구분
- **When to use / When NOT to use**
- 실제 프론트엔드 시나리오 기반의 **예제** (forms, APIs, lists, modals)
- 잘못된 접근을 보여주는 **반례**
- 무엇을 얻고 무엇을 잃는지 설명하는 **트레이드오프**
- 실제 장애로 이어지는 **공통 버그 패턴**
- PR에 바로 활용 가능한 **리뷰 체크리스트**

## 기여

PR은 언제나 환영합니다. 특히 아래 영역을 우선적으로 보강하고 싶습니다.

- Testing patterns (Vitest, Testing Library)
- Internationalization typing
- More debugging playbooks (React Query cache, Zustand devtools)
- Accessibility deep dive (ARIA patterns, focus management)
- Edge/middleware typing patterns

### 새 규칙을 기여하는 방법

새 규칙을 추가할 때는 기존 `rules/*.md` 문서의 템플릿을 따르는 것을 권장합니다.

1. Scope + Consult when + See also
2. [HARD RULE] / [DEFAULT] / [SITUATIONAL]로 라벨링된 패턴
3. 장난감 예제가 아닌 실제 예제
4. Common bug patterns
5. Review checklist

## 라이선스

MIT
