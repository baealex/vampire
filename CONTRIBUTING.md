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
VAMPIRE_TOKEN="development-token" pnpm dev
```

The development server listens on `127.0.0.1:7677` by default.

## Make a change

1. Keep the change focused and explain the user problem it solves.
2. Preserve backward compatibility for `~/.vampire/sessions.json` whenever possible.
3. Add or update tests for protocol, security, workspace-lifecycle, and parsing changes.
4. Check both a desktop viewport and a narrow mobile viewport for interface changes.
5. Avoid committing real tokens, private project paths, terminal output, or personal workspace data.

## Project layout

- `src/routes` contains SvelteKit page and API route entrypoints.
- `src/lib/app` contains application composition and bootstrap state.
- `src/lib/features/<feature>` contains feature-owned UI, client state, and feature-specific server behavior.
- `src/lib/shared` contains domain-independent API helpers, contracts, theme, UI primitives, and utility code shared by features.
- `src/server` contains the custom Node runtime entrypoint and its transport orchestration.
- `src/lib` imports use the `~/lib/...` alias; same-feature leaf components may use relative imports.
- The dependency direction is `app → features → shared`; `shared` must not depend on a feature, and SvelteKit routes should remain thin adapters.
- `tools` contains development, build, release, and package smoke-test scripts; `bin` contains the npm executable entrypoint.
- `tests` contains unit and integration tests, while `e2e` contains browser-server fixtures and Playwright tests.
- `static` and `docs` contain shipped static assets and contributor-facing documentation.

Run the local verification before squashing a working branch into main:

```sh
pnpm format:check
pnpm check
node --test tests/*.test.ts
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
