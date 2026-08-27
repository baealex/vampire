# Architecture

Vampire uses a SvelteKit-first, domain-oriented module layout. It borrows dependency direction and ownership ideas from Feature-Sliced Design, but it is not a strict FSD implementation.

When two conventions compete, use this priority:

1. Preserve SvelteKit's browser/server boundary.
2. Keep behavior with the domain that owns it.
3. Preserve the `app → features → shared` dependency direction.
4. Prefer the simplest placement over directory symmetry.

Do not add FSD layers such as `pages` or `entities`, public barrel files, or matching folders in every feature only to make the tree look uniform.

## Module map

```text
src/
├── routes/                       SvelteKit pages and HTTP entrypoints
└── lib/
    ├── app/                      Application composition and runtime bootstrap
    │   ├── model/
    │   ├── server/*.server.ts
    │   └── ui/
    ├── features/<domain>/        Domain-owned vertical modules
    │   ├── api/
    │   ├── model/
    │   ├── server/*.server.ts
    │   └── ui/
    ├── server/                   Cross-domain Node-only infrastructure
    ├── shared/                   Runtime-neutral primitives and contracts
    │   ├── api/
    │   ├── contracts/
    │   ├── lib/
    │   ├── theme/
    │   └── ui/
    └── widgets/                  Page-sized composition of features
```

Folders are created when a domain needs them. A feature does not need empty `api`, `model`, `server`, or `ui` directories.

## Placement decision

| Question | Placement |
| --- | --- |
| Is it a SvelteKit page, page load, or HTTP endpoint? | `src/routes` |
| Is it Node-only infrastructure shared by multiple domains? | `src/lib/server` |
| Is it Node-only behavior owned by one domain? | `src/lib/features/<domain>/server/*.server.ts` |
| Does it assemble runtimes, WebSockets, or multiple features? | `src/lib/app/server/*.server.ts` |
| Is it browser state or a domain transformation? | The owning feature's `model` |
| Is it a domain-owned component? | The owning feature's `ui` |
| Is it a domain-independent UI primitive or utility? | `src/lib/shared/ui` or `src/lib/shared/lib` |
| Is it a runtime-neutral wire format or validation contract? | `src/lib/shared/contracts` |
| Does it compose several features into a screen region? | `src/lib/widgets` or `src/lib/app` |

Ownership matters more than reuse count. Code used by two places does not automatically belong in `shared`; move it only when it is genuinely domain-independent.

## Server boundary

The server boundary is a security and bundling property, not just a folder name.

- `src/lib/server/**` is protected by SvelteKit's `$lib/server` rule.
- Production files under `src/lib/app/server` and `src/lib/features/*/server` must use a `*.server.ts`-style filename.
- Colocated `*.test.ts` and `*.component.test.ts` files are test-only exceptions to the filename rule.
- Browser-capable modules must not import server-only modules, including through type-only imports. Put shared types in a runtime-neutral contract module instead.
- `+server.*`, `+page.server.*`, `+layout.server.*`, and `hooks.server.*` may import server-only modules.
- `.svelte`, `+page.ts`, `+layout.ts`, feature `ui`, feature `model`, feature `api`, `widgets`, and `shared` are treated as browser-capable unless SvelteKit marks the file server-only.

Do not create an unsuffixed production file such as `features/terminal/server/process.ts`. The directory name alone does not make it server-only to SvelteKit.

## Dependency direction

The intended direction is:

```text
routes/app → widgets/features → shared
              app server → lib/server
          feature server → lib/server
```

- `shared` does not import `features`, `widgets`, or `app`.
- A feature does not import a peer feature, `widgets`, or `app`.
- A widget does not import `app` or a peer widget.
- Feature server code does not import feature UI.
- `app` owns orchestration across multiple features.

When two features need to collaborate, prefer one of these approaches:

1. Let `app` orchestrate both features.
2. Extract only a genuinely neutral data contract or utility into `shared`.
3. Re-evaluate domain ownership if the behavior actually belongs to one feature.

Do not move domain behavior into `shared` merely to bypass the peer-feature rule.

## Routes and contracts

Routes are adapters. They should authenticate, parse and validate request data, call an owning server module, and translate its result into an HTTP response. Persistent state, process management, Git behavior, and other domain logic stay outside route files.

Contract modules must be safe to import in browser and server builds. They may define types, constants, parsers, validators, and inert command text, but must not read environment variables, access the filesystem, start processes, or perform work at module import time.

## Examples

```ts
// Allowed: an HTTP endpoint delegates to its owning server module.
import { readRepositorySnapshot } from '~/lib/features/repository/server/repository.server.ts';

// Allowed: feature UI imports a runtime-neutral contract.
import type { RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';

// Rejected: browser-capable UI imports a server implementation.
import { readRepositorySnapshot } from '../server/repository.server.ts';

// Rejected: a production server file lacks a protected suffix.
// src/lib/features/repository/server/repository.ts
```

## Change checklist

Before adding or moving a module:

1. Identify the runtime: browser-capable, server-only, or runtime-neutral.
2. Identify the owning domain before considering reuse.
3. Use `$lib/server` or `*.server.*` for every server-only production module.
4. Keep routes and application composition thin.
5. Add an architecture fixture when introducing a new allowed exception.
6. Run `pnpm check:architecture`, then the relevant tests and `pnpm check`.

An architecture exception should be documented here and encoded in `tools/architecture.ts`; a comment or folder name alone is not an enforceable boundary.
