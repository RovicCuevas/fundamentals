---
applyTo: "frontend/**/*.{ts,tsx}"
---
# Frontend rules
- Next.js 16 App Router + React 19. Run `npx next typegen` before `tsc` if route types are missing.
- API access only through `frontend/lib/*` helpers. Never hardcode backend URLs; use the `/api` rewrite.
- No `any`, no `@ts-ignore`, no `eslint-disable`. Fix the type instead.
- Every data screen needs loading, error and empty states. Buttons that call the API disable while pending and show errors.
- Show human labels, never raw backend strings (`unpaid`, `no_show`). Do not prefix "Dr." to names that already contain a title.
- Dates and times use clinic timezone (Asia/Manila), not the browser's.
- Do not store tokens in localStorage; auth is the httpOnly cookie.
- Accessibility: labels on inputs, real buttons (not divs), visible focus, keyboard operable.
- Match existing Tailwind and design tokens; do not add UI libraries without asking.
