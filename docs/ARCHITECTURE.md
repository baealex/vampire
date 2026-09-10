# Architecture

Vampire is a React + Vite client served by a Fastify application. It uses a small pnpm workspace, follows Ocean Brain's client/server package split where that split improves runtime clarity, and keeps Vampire's existing domain-oriented modules rather than copying unrelated GraphQL or persistence choices.

When two conventions compete, use this priority:

1. Preserve the browser/server runtime boundary.
2. Keep behavior with the domain that owns it.
3. Preserve the `app → features → shared` dependency direction.
4. Keep HTTP and realtime adapters thin.
5. Prefer the simplest placement over directory symmetry.

Do not introduce GraphQL, Prisma, or a second server process only to mirror Ocean Brain. Vampire's existing REST contract and filesystem/tmux domain services remain the appropriate fit.

## Module map

```text
packages/client/                    Browser application
├── index.html
└── src/
    ├── app/                        React composition, routing, connection state
    ├── features/<domain>/          Domain-owned React UI and browser state
    └── shared/                     Browser-neutral UI primitives, API helpers, theme

src/
├── routes/                         Runtime-neutral REST adapter modules
└── lib/
    ├── app/server/*.server.ts      Fastify composition and cross-domain orchestration
    ├── features/<domain>/
    │   ├── api/                    Runtime-neutral browser/server clients
    │   ├── model/                  Runtime-neutral domain transformations
    │   └── server/*.server.ts      Domain-owned Node behavior
    ├── server/                     Cross-domain Node-only infrastructure
    └── shared/                     Runtime-neutral contracts, utilities, and tokens
```

Folders are created only when a domain needs them. Ownership matters more than reuse count.

## Runtime boundaries

The production deployment is one Fastify process and one browser origin:

- Vite builds `packages/client` into `build/client`.
- esbuild bundles the Fastify entry into `build/vampire-server.js`.
- Fastify serves REST routes, event streams, terminal WebSockets, and the client SPA.
- Development runs Fastify and Vite together; Vite proxies `/api`, `/events`, and `/ws`.

Browser modules live in `packages/client/src`. They may import runtime-neutral modules from `src/lib`, but never a `*.server.*` module or `src/lib/server`.

Node-only production modules under `src/lib/app/server` and `src/lib/features/*/server` must use a `*.server.ts`-style suffix. Colocated test files are the exception.

## Placement decision

| Question | Placement |
| --- | --- |
| Does it compose Fastify, realtime transports, or multiple server domains? | `src/lib/app/server/*.server.ts` |
| Is it Node-only infrastructure shared by multiple domains? | `src/lib/server` |
| Is it Node-only behavior owned by one domain? | `src/lib/features/<domain>/server/*.server.ts` |
| Is it an HTTP compatibility adapter? | `src/routes/**/+server.ts` and the Fastify route manifest |
| Is it browser state or domain UI? | `packages/client/src/features/<domain>` |
| Does it compose the whole browser application? | `packages/client/src/app` |
| Is it a reusable browser primitive? | `packages/client/src/shared` |
| Is it a runtime-neutral wire format or transformation? | `src/lib/shared` or the owning `src/lib/features/<domain>` module |

The `+server.ts` filenames are retained as stable REST adapters during and after the framework migration. Fastify imports them through an explicit manifest; they are not SvelteKit routes and must not depend on SvelteKit.

## Dependency direction

```text
client app → client features → client shared
     │              │
     └──────→ runtime-neutral contracts/models

Fastify app → feature servers → shared/server infrastructure
     │
     └──────→ REST route adapters
```

- Shared code does not import features or app code.
- A feature does not import a peer feature or app code.
- Cross-feature behavior is orchestrated by app code or expressed through a genuinely neutral contract.
- `@baejino/react-ui` is wrapped by `packages/client/src/shared/ui`; feature and app code consume those local primitives.
- Routes authenticate, validate, delegate, and translate responses. Persistence, tmux, Git, and process behavior remain in domain server modules.

## Realtime transport

Vampire deliberately uses both transports:

- `GET /events/workspaces` uses Server-Sent Events for server-to-browser workspace snapshots and updates. Reconnection and event ordering are handled by the browser connection store.
- `/ws/terminal` uses WebSocket because terminal input, output, resize, acknowledgement, and recovery are bidirectional and latency-sensitive.

Do not move workspace state back to WebSocket unless the client needs bidirectional messages on that same channel. Do not move terminal traffic to SSE because client-to-server terminal messages would require a second transport and weaken delivery semantics.

## Change checklist

Before adding or moving a module:

1. Identify the runtime: browser, Node-only, or runtime-neutral.
2. Identify the owning domain before considering reuse.
3. Keep React application code in `packages/client/src`.
4. Use `*.server.*` for Node-only production modules in app/feature server directories.
5. Keep REST and realtime entrypoints thin.
6. Add an architecture fixture for every new allowed exception.
7. Run `pnpm check:architecture`, then the relevant tests and `pnpm check`.

An architecture exception must be documented here and encoded in `tools/architecture.ts`; a comment or folder name alone is not enforceable.
