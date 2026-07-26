# Contributing to Vampire

Thanks for helping make persistent project shells calmer, safer, and easier to reach.

## Product direction

Vampire is deliberately small. Contributions should preserve these constraints:

- The user's own computer and tmux sessions remain the source of truth.
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
3. Add or update tests for protocol, security, session-lifecycle, and parsing changes.
4. Check both a desktop viewport and a narrow mobile viewport for interface changes.
5. Avoid committing real tokens, private project paths, terminal output, or personal session data.

Run the full local verification before opening a pull request:

```sh
pnpm test
```

GitHub Actions runs the same command for pushes to `main` and for pull requests.

## Releases

npm releases are published by `.github/workflows/publish.yml` when a GitHub release is published. The release tag must match the version in `package.json`, including the `v` prefix—for example, package version `0.1.0` uses tag `v0.1.0`.

The publish job uses the GitHub environment named `npm` and npm Trusted Publishing. It requests a short-lived OIDC identity and does not use an `NPM_TOKEN` secret. Run `pnpm test` and verify a packed tarball before creating the release.

## Pull requests

A useful pull request includes:

- the problem and intended behavior;
- screenshots for material interface changes, with private information removed;
- verification performed;
- deployment, migration, or security considerations; and
- known limitations or follow-up work.

Small pull requests are easier to review. Refactors are welcome when they make ownership, lifecycle, or security boundaries easier to understand.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md) instead.
