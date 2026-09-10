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
```

### Use isolated development state

`pnpm dev` refuses to start with the live `~/.vampire` directory, an unmarked directory, or no explicit state directory. This prevents a development build from migrating or overwriting the state used by an installed Vampire process.

Create a new development-only snapshot at a path outside the repository and outside `~/.vampire`. The installed Vampire process may remain running:

```sh
pnpm dev:state:prepare -- \
  --source "$HOME/.vampire" \
  --target "$HOME/.vampire-development/vampire-main"
```

The target must not already exist. The preparation command copies only durable state files into a private staging directory, verifies both the source and copied bytes, and retries when an atomic source-file update overlaps the snapshot. It applies pending layout migrations to staging, writes the development marker last, and then renames the completed directory into place. It never edits the source or replaces an existing target. Worktrees, pending agent requests, support files, backups, locks, and temporary files are not copied. Keep the copy private: it still contains notes, prompts, commands, and local project paths. There is no reverse synchronization into the live state.

Start the development server with the exact marked target and a port that does not conflict with an installed Vampire process:

```sh
VAMPIRE_STATE_DIR="$HOME/.vampire-development/vampire-main" \
VAMPIRE_PORT=7677 \
pnpm dev
```

Development uses a separate tmux socket and disables automatic launch profiles, automations, and status-widget commands. Explicit terminal, Background, and Repository actions are still real: copied workspaces retain their original `cwd`, so those actions can modify the referenced projects. Use disposable project copies when testing destructive behavior.

The development server is restricted to loopback and listens on `127.0.0.1:7677` by default. Put a development-only `VAMPIRE_TOKEN` in the ignored `.env` file when testing authentication; never expose the Vite development server remotely. Node and browser test runners use separate disposable state and tmux namespaces, and browser tests default to their own port.

See [docs/STATE_STORAGE.md](docs/STATE_STORAGE.md) for state ownership, forward-migration, locking, and recovery rules.

## Make a change

1. Keep the change focused and explain the user problem it solves.
2. Preserve forward migration from supported legacy state and never reinterpret a recorded migration in place.
3. Add or update tests for protocol, security, workspace-lifecycle, and parsing changes.
4. Check both a desktop viewport and a narrow mobile viewport for interface changes.
5. Avoid committing real tokens, private project paths, terminal output, or personal workspace data.

## Project layout

Vampire uses a React + Fastify domain layout rather than strict Feature-Sliced Design. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before adding or moving modules; it defines the placement decision tree, server-only rules, dependency direction, and allowed exceptions.

- `packages/client/src` contains React application composition, feature UI, browser state, shared UI primitives, and browser API helpers.
- `src/routes` contains runtime-neutral REST adapters imported by Fastify through an explicit manifest.
- `src/lib/server` contains domain-independent Node-only configuration, authentication support, path policy, and persistence helpers.
- `src/lib/features/<feature>` contains feature-owned runtime-neutral APIs/models and Node-only server behavior. Production modules in feature `server` directories use the `*.server.ts` suffix.
- `src/lib/shared` contains runtime-neutral contracts, theme tokens, and utilities shared across runtimes.
- `src/lib/app/server` contains Fastify composition and cross-domain Node orchestration, also named `*.server.ts`; feature server behavior stays with its owning feature.
- `src/lib` imports use the `~/lib/...` alias; same-feature leaf components may use relative imports.
- The dependency direction is `app → features → shared`; `shared` must not depend on a feature, and REST adapters should remain thin.
- `tools` contains development, build, release, and package smoke-test scripts; `bin` contains the npm executable entrypoint.
- Tests live beside the code they own; repository-level checks stay in `tools`, while `e2e` contains browser-server fixtures and Playwright tests.
- Source tests use `.test.ts` or `.test.tsx`, retained framework-neutral component tests use `.component.test.ts`, and `.spec.ts` is reserved for Playwright E2E.
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
