# Contributing to Vampire

Thanks for helping make persistent project shells calmer, safer, and easier to reach.

## Product direction

Vampire is deliberately small. Contributions should preserve these constraints:

- The user's own computer and tmux state remain the source of truth.
- No hosted relay or vendor service is required.
- The product serves ordinary shell workflows rather than one command-line program.
- Activity indicators describe observable terminal state without guessing task completion.
- Mobile and desktop are both first-class surfaces.
- Security defaults should remain conservative because authenticated users receive shell-level capabilities.

Before adding a new abstraction, consider whether the same outcome can be achieved by exposing tmux or shell behavior more clearly.

## Set up the project

You need Node.js 22 or newer, pnpm, and tmux.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

The development server is restricted to loopback and listens on `127.0.0.1:7677` by default. Put a development-only `VAMPIRE_TOKEN` in the ignored `.env` file when testing authentication; never expose the Vite development server remotely.

## Make a change

1. Keep the change focused and explain the user problem it solves.
2. Preserve backward compatibility for `~/.vampire/sessions.json` whenever possible.
3. Add or update tests for protocol, security, workspace-lifecycle, and parsing changes.
4. Check both a desktop viewport and a narrow mobile viewport for interface changes.
5. Avoid committing real tokens, private project paths, terminal output, or personal workspace data.

## Project layout

Vampire uses a SvelteKit-first domain layout rather than strict Feature-Sliced Design. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before adding or moving modules; it defines the placement decision tree, server-only rules, dependency direction, and allowed exceptions.

- `src/routes` contains SvelteKit page and API route entrypoints.
- `src/lib/app` contains application composition and bootstrap state.
- `src/lib/server` contains domain-independent Node-only configuration, authentication support, path policy, and persistence helpers. SvelteKit enforces this directory as server-only.
- `src/lib/features/<feature>` contains feature-owned code. Keep Svelte components and browser-facing UI behavior in `ui`, external calls and client adapters in `api`, feature state and transformations in `model`, and Node-only implementation in `server`. Production modules in feature `server` directories use the `*.server.ts` suffix so SvelteKit enforces the boundary.
- `src/lib/shared` contains domain-independent API helpers, contracts, theme, UI primitives, and utility code shared by features.
- `src/lib/app/server` contains the custom Node runtime entrypoints, also named `*.server.ts`; feature server behavior stays with its owning feature.
- `src/lib` imports use the `~/lib/...` alias; same-feature leaf components may use relative imports.
- The dependency direction is `app → features → shared`; `shared` must not depend on a feature, and SvelteKit routes should remain thin adapters.
- `tools` contains development, build, release, and package smoke-test scripts; `bin` contains the npm executable entrypoint.
- Tests live beside the code they own; repository-level checks stay in `tools`, while `e2e` contains browser-server fixtures and Playwright tests.
- Source tests use `.test.ts`, Svelte component tests use `.component.test.ts`, and `.spec.ts` is reserved for Playwright E2E.
- `static` and `docs` contain shipped static assets and contributor-facing documentation.

Run the local verification before squashing a working branch into main:

```sh
pnpm format:check
pnpm check
pnpm test:node
pnpm build
```

GitHub Actions does not run on ordinary `main` pushes. Pushing a version tag
runs CI, then E2E, then the release gate for that exact commit.

## Releases

See [docs/RELEASE.md](docs/RELEASE.md) for the tag-based release gate and the
same-version retry procedure.

## Working branches

Use a focused working branch and squash it into `main` when the change is
ready. A pull request may be used for discussion, but it is not a required
integration or release step. The change description should include:

- the problem and intended behavior;
- screenshots for material interface changes, with private information removed;
- verification performed;
- deployment, migration, or security considerations; and
- known limitations or follow-up work.

Small pull requests are easier to review. Refactors are welcome when they make ownership, lifecycle, or security boundaries easier to understand.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md) instead.
