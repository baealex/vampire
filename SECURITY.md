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

- Bind to loopback unless remote access is intentional. Loopback access does not require authentication by default; use it only on a trusted local machine.
- A non-loopback bind or non-loopback `VAMPIRE_PUBLIC_ORIGIN` requires `VAMPIRE_TOKEN` authentication by default.
- Use `VAMPIRE_ALLOW_INSECURE_NO_AUTH=1` only for deliberate non-loopback testing in an isolated, disposable environment. Every device that can reach an unauthenticated instance can control shell sessions with the server user's permissions; a private network alone is not a sufficient boundary.
- Never expose an unauthenticated instance to the public Internet. Put Internet-reachable deployments behind HTTPS/WSS and an additional private-network or access-control layer.
- Run Vampire as an unprivileged user with access only to the projects it needs.
- Use a unique `VAMPIRE_TOKEN` of at least 12 characters. A long passphrase is supported; a random value is stronger. Rotate it after suspected exposure.
- Prefer an owner-readable `--token-file`; protect every environment, env file, secret manager, or token file containing `VAMPIRE_TOKEN` with the same care as a password.
- Keep the host operating system, Node.js, tmux, reverse proxy, and clipboard tools updated.
- Protect `~/.vampire` or `VAMPIRE_STATE_DIR`; it contains project paths, session metadata, notes, and saved status plugin commands.

For a reverse-proxy deployment, prefer a fixed public origin instead of trusting request headers:

```sh
VAMPIRE_HOST=127.0.0.1 \
VAMPIRE_PUBLIC_ORIGIN=https://vampire.example.com \
npx vampire --token-file /run/secrets/vampire-token
```

This command starts a plain HTTP loopback backend; `VAMPIRE_PUBLIC_ORIGIN` does not enable TLS. The reverse proxy must provide browser-facing HTTPS/WSS, forward WebSocket upgrades, and preserve or overwrite `Host` to exactly match the configured authority, including a non-default port. The backend should remain available only through the proxy.

Adapter-node forwarding variables such as `VAMPIRE_ADAPTER_PROTOCOL_HEADER`, `VAMPIRE_ADAPTER_HOST_HEADER`, `VAMPIRE_ADAPTER_PORT_HEADER`, and `VAMPIRE_ADAPTER_ADDRESS_HEADER` are advanced explicit opt-ins. A client can spoof these headers when it can reach the backend directly. Configure them only when the proxy overwrites the corresponding headers and direct backend access is blocked; otherwise leave them unset and use `VAMPIRE_PUBLIC_ORIGIN`.

## Authentication model

An unauthenticated loopback instance relies on the operating system's local-access boundary together with Vampire's Host and Origin checks. Loopback is not an identity boundary: other processes running on the same machine may still reach the server. Configure a token even on loopback when that distinction matters.

When configured, `VAMPIRE_TOKEN` is the only login secret an operator provides. At startup, Vampire derives a memory-hard scrypt verifier and retains that verifier and its salt for later login checks. Before user commands start, it deletes `VAMPIRE_TOKEN` from Node's `process.env` so subsequently spawned children do not inherit it. This is not secure erasure: shell history, parent processes, initial operating-system environment snapshots, process memory, env files, secret managers, and token files can retain the plaintext.

The browser submits the TOKEN only to `/api/login`. A successful login creates a random, opaque server-side session; protected HTTP APIs and both WebSocket endpoints accept that session cookie, not `Authorization: Bearer <VAMPIRE_TOKEN>`. Sessions are stored only in memory, expire after 24 hours, and are invalidated by logout or server restart. Logging out also closes WebSockets associated with that session. HTTPS deployments receive a Secure `__Host-` cookie.

Login verification is deliberately expensive and rate-limited. Request admission and a body deadline bound concurrent pre-verification work, while only an actual failed TOKEN verification contributes to credential backoff. This improves resistance to guessing but cannot make a weak or reused password safe, prevent every login-denial attack, or replace proxy-level connection and request limits on an Internet-reachable deployment. Behind a reverse proxy, configure `VAMPIRE_ADAPTER_ADDRESS_HEADER` only when the proxy overwrites it; otherwise Vampire deliberately falls back to its shared account limit instead of treating the proxy address as an individual client.

The Vite development server contains module and HMR endpoints outside Vampire's application session boundary. Vampire therefore refuses non-loopback development binds. Do not expose `pnpm dev` through a remote reverse proxy; use the production server for remote testing.

Vampire provides authentication and defense-in-depth controls, but it is not a sandbox, privilege boundary, or multi-tenant terminal service. Host compromise, malicious shell commands, exposed credentials, and insecure reverse-proxy configuration are outside the protection that the application alone can provide.

## Status plugin considerations

An authenticated browser can save a status plugin that executes an arbitrary shell command or multiline script with the operating-system permissions and remaining environment of the Vampire server user. Treat this as equivalent to terminal access. `VAMPIRE_TOKEN` is removed from Node's `process.env` before plugins run so it is not inherited, but the original secret sources and other secrets may remain. Do not put access tokens directly in plugin scripts; the script is stored in owner-readable plaintext under `VAMPIRE_STATE_DIR`.

The **Ask agent…** action can instruct the supported agent already running in a workspace's main terminal to edit the server-wide status configuration. Sending the request authorizes that agent interaction; the agent retains its normal operating-system permissions and may make broader changes if prompted or compromised. Vampire supplies a version-matched guide and structural validator, but neither is a sandbox or a safety review. Inspect the request in the visible terminal and review `status-plugins.json` before trusting a generated command.

The Claude Limit preset may read the Vampire server user's existing Claude Code OAuth credential from `CLAUDE_CODE_OAUTH_TOKEN`, the macOS Keychain, or Claude Code's credentials file. It uses that credential only as an authorization header to Anthropic's usage endpoint and does not print, cache, refresh, or modify it. The endpoint is an undocumented Claude Code interface and may change. Remove or disable that preset if Vampire should not access the account's usage data.

Vampire runs each enabled plugin once for the server and shares its output with all authenticated browsers. It prevents overlapping runs, applies a 10-second timeout and 32 KB output limit, strips terminal control sequences, and renders output as text rather than HTML. These controls limit accidental resource use and browser injection; they do not sandbox a command, restrict its network or filesystem access, or make a malicious command safe. Plugin output can itself contain sensitive data, so give access only to browsers that are trusted with the server user's shell.

## Image clipboard considerations

Image paste temporarily changes the server computer's clipboard. Uploads are size- and type-limited, staged in an owner-only temporary directory, serialized, and removed after the paste attempt. Avoid enabling this feature on a shared graphical host when clipboard changes could cross trust boundaries.

## Repository viewer considerations

The repository viewer exposes files and Git diffs from every managed workspace to an authenticated browser. It is read-only, limits preview sizes, rejects path traversal, and resolves symlinks before checking that a target remains inside the workspace. These checks reduce accidental exposure; they do not make an untrusted workspace safe.

Do not add a workspace that contains secrets an authenticated Vampire user should not be able to read. Run Vampire with an operating-system account whose file permissions match the intended access boundary.

## Listening port inspector considerations

The listening port inspector shows TCP bind addresses, process IDs, process names, and working directories visible to the Vampire server user. An authenticated browser can send `SIGTERM` to a listed process when that operating-system user has permission. Vampire protects its own server process, refuses incomplete process records, and rechecks the port, process name, and working directory immediately before signaling, but it is not a process sandbox.

Run Vampire as an unprivileged user. Do not give that account permission to signal processes an authenticated Vampire user should not control.
