# Security policy

Vampire exposes shell sessions over the network. Treat every authenticated browser as having the operating-system permissions of the Vampire server process.

## Supported versions

Security fixes target the latest published release and the default branch. Reproduce a report against the latest release when practical.

## Reporting a vulnerability

Please use the repository's private vulnerability-reporting feature under the **Security** tab. Include:

- the affected revision and deployment platform;
- required network access and authentication state;
- clear reproduction steps or a minimal proof of concept;
- the impact you observed; and
- any suggested mitigation.

Do not include real access tokens, private terminal output, project files, or session-registry contents. Do not open a public issue until a maintainer confirms that disclosure is appropriate.

## Deployment expectations

- Bind to loopback unless remote binding is intentional. Prefer token authentication for every remote bind.
- Use `VAMPIRE_ALLOW_INSECURE_NO_AUTH=1` only on a trusted private network. Every device that can reach an unauthenticated instance can control shell sessions with the server user's permissions.
- Never expose an unauthenticated instance to the public Internet. Put Internet-reachable deployments behind HTTPS/WSS and an additional private-network or access-control layer.
- Run Vampire as an unprivileged user with access only to the projects it needs.
- Use a long, random, unique `VAMPIRE_TOKEN` and rotate it after suspected exposure.
- Keep the host operating system, Node.js, tmux, reverse proxy, and clipboard tools updated.
- Protect `~/.vampire` or `VAMPIRE_STATE_DIR`; it contains project paths, session metadata, notes, and saved status plugin commands.

For a reverse-proxy deployment, prefer a fixed public origin instead of trusting request headers:

```sh
VAMPIRE_HOST=127.0.0.1 \
VAMPIRE_PUBLIC_ORIGIN=https://vampire.example.com \
VAMPIRE_TOKEN="..." \
npx vampire
```

`VAMPIRE_PUBLIC_ORIGIN` controls HTTP URL construction, secure session cookies, same-origin checks, and WebSocket origin checks. The backend should remain available only through the proxy.

Adapter-node forwarding variables such as `VAMPIRE_ADAPTER_PROTOCOL_HEADER`, `VAMPIRE_ADAPTER_HOST_HEADER`, `VAMPIRE_ADAPTER_PORT_HEADER`, and `VAMPIRE_ADAPTER_ADDRESS_HEADER` are advanced explicit opt-ins. A client can spoof these headers when it can reach the backend directly. Configure them only when the proxy overwrites the corresponding headers and direct backend access is blocked; otherwise leave them unset and use `VAMPIRE_PUBLIC_ORIGIN`.

Vampire provides authentication and defense-in-depth controls, but it is not a sandbox, privilege boundary, or multi-tenant terminal service. Host compromise, malicious shell commands, exposed credentials, and insecure reverse-proxy configuration are outside the protection that the application alone can provide.

## Status plugin considerations

An authenticated browser can save a status plugin that executes an arbitrary shell command or multiline script with the operating-system permissions and environment of the Vampire server user. Treat this as equivalent to terminal access. Do not put access tokens directly in plugin scripts; the script is stored in owner-readable plaintext under `VAMPIRE_STATE_DIR`.

The Claude Limit preset may read the Vampire server user's existing Claude Code OAuth credential from `CLAUDE_CODE_OAUTH_TOKEN`, the macOS Keychain, or Claude Code's credentials file. It uses that credential only as an authorization header to Anthropic's usage endpoint and does not print, cache, refresh, or modify it. The endpoint is an undocumented Claude Code interface and may change. Remove or disable that preset if Vampire should not access the account's usage data.

Vampire runs each enabled plugin once for the server and shares its output with all authenticated browsers. It prevents overlapping runs, applies a 10-second timeout and 32 KB output limit, strips terminal control sequences, and renders output as text rather than HTML. These controls limit accidental resource use and browser injection; they do not sandbox a command, restrict its network or filesystem access, or make a malicious command safe. Plugin output can itself contain sensitive data, so give access only to browsers that are trusted with the server user's shell.

## Image clipboard considerations

Image paste temporarily changes the server computer's clipboard. Uploads are size- and type-limited, staged in an owner-only temporary directory, serialized, and removed after the paste attempt. Avoid enabling this feature on a shared graphical host when clipboard changes could cross trust boundaries.

## Repository viewer considerations

The repository viewer exposes files and Git diffs from every managed workspace to an authenticated browser. It is read-only, limits preview sizes, rejects path traversal, and resolves symlinks before checking that a target remains inside the workspace. These checks reduce accidental exposure; they do not make an untrusted workspace safe.

Do not add a workspace that contains secrets an authenticated Vampire user should not be able to read. Run Vampire with an operating-system account whose file permissions match the intended access boundary.

## Vampire King considerations

King's local control socket is restricted to the Vampire operating-system user and never grants authenticated owner authority. Owner approvals, answers, and workspace handoffs are recorded only through authenticated HTTP actions. Other processes running as the same operating-system user can still issue King-level orchestration commands, read that user's files, and control their terminals; the socket is not a privilege boundary against them.

King verification accepts only bounded, allowlisted command shapes and runs them without a shell, but package scripts and test tools execute code from the selected repository with the Vampire server user's permissions. Verification has a five-minute total command budget; it is not a sandbox. Delegate and verify only repositories you would otherwise trust an authenticated terminal user to execute.

## Listening port inspector considerations

The listening port inspector shows TCP bind addresses, process IDs, process names, and working directories visible to the Vampire server user. An authenticated browser can send `SIGTERM` to a listed process when that operating-system user has permission. Vampire protects its own server process, refuses incomplete process records, and rechecks the port, process name, and working directory immediately before signaling, but it is not a process sandbox.

Run Vampire as an unprivileged user. Do not give that account permission to signal processes an authenticated Vampire user should not control.
