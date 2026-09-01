# Vampire

**A self-hosted web workspace for terminal-based coding agents.**

<table>
  <tr>
    <td width="78%" valign="top">
      <img src="docs/images/vampire-desktop.png" alt="Vampire desktop workspace" />
    </td>
    <td width="22%" valign="top">
      <img src="docs/images/vampire-mobile.png" alt="Vampire mobile workspace" />
    </td>
  </tr>
</table>

Vampire keeps Codex, Claude Code, and other CLI coding agents running in persistent tmux workspaces. Monitor several agents, reconnect from desktop or mobile, inspect the repository, and send notes or scheduled work to the active agent. Vampire runs on your machine, alongside your project files and processes.

## Built for agent work

- **Keep agents running.** Codex, Claude Code, and ordinary shells stay alive in tmux when the browser disconnects.
- **See what needs attention.** Monitor multiple workspaces and return to the right agent without hunting through terminal tabs.
- **Step in from any screen.** Use the full terminal on desktop or the mobile composer and terminal controls when you are away from your desk.
- **Work with the repository.** Browse and edit files, inspect Git changes, and manage isolated worktrees beside the live terminal.
- **Hand work back to the agent.** Keep workspace notes, schedule recurring prompts, and ask the visible main agent to create status widgets.
- **Keep control of the host.** Vampire is local-first and self-hosted, with frictionless loopback access and authenticated remote deployments.

### Schedule work for the active agent

<img src="docs/images/vampire-automations.png" alt="Vampire agent automations page" />

Automations deliver a saved prompt to the workspace's main agent session on a one-time or recurring schedule. They use the same persistent workspace instead of starting a separate hidden agent.

## Quick start

Requirements:

- Node.js 22.18+
- tmux

Install tmux with your operating system's package manager, then run:

```bash
npx vampire
```

Open the printed URL (`http://localhost:7677` by default), choose a project directory, and create a workspace. Start your coding agent or shell inside it:

```bash
codex
# or
claude
```

Your workspace keeps running when you close the browser. Reopen the workspace whenever you want to continue.

Run `npx vampire --help` to see the available server options.

## Configuration

CLI options override process environment variables, which override values from an explicit `--env-file`; built-in defaults apply last.

| Purpose | CLI option | Environment variable | Default |
| --- | --- | --- | --- |
| Bind address | `--host` | `VAMPIRE_HOST` | `127.0.0.1` |
| Listen port | `--port` | `VAMPIRE_PORT` | `7677` |
| Public reverse-proxy origin | `--origin` | `VAMPIRE_PUBLIC_ORIGIN` | direct HTTP origin |
| Allowed workspace roots | repeat `--workspace-root` | `VAMPIRE_WORKSPACE_ROOTS` | launch directory |
| Persistent state directory | `--state-dir` | `VAMPIRE_STATE_DIR` | `~/.vampire` |
| Login secret | `--token-file` | `VAMPIRE_TOKEN` | optional on loopback; required for external access |
| Allow external access without authentication (unsafe) | `--allow-insecure-no-auth` | `VAMPIRE_ALLOW_INSECURE_NO_AUTH=1` | disabled |

`VAMPIRE_WORKSPACE_ROOTS` uses the operating system's path-list separator (`:` on macOS/Linux and `;` on Windows). Repeat the CLI option when allowing multiple roots:

```bash
npx vampire --port 8787 \
  --workspace-root ~/Code \
  --workspace-root ~/Projects
```

The installed CLI does not automatically read `.env` from the current directory. Use `--env-file <path>` when that behavior is intentional. `pnpm dev` does load Vite's development `.env` files, while existing process variables continue to take precedence.

Loopback access through `127.0.0.1`, `localhost`, or `::1` works without a token by default. A non-loopback bind or non-loopback `VAMPIRE_PUBLIC_ORIGIN` requires a token unless the explicit unsafe override is set. Do not use that override for an instance shared with another device.

When configured, `VAMPIRE_TOKEN` is the only authentication value you provide. Vampire derives a slow scrypt verifier at startup. Before starting user commands, it deletes `VAMPIRE_TOKEN` from Node's `process.env` so later child processes do not inherit it. This cannot erase shell history, parent-process environments, operating-system startup environment snapshots, memory, or the original secret source, which all remain sensitive.

A successful login exchanges the TOKEN for an opaque, revocable server session used by HTTP APIs and WebSockets; the raw TOKEN is not accepted as an API or WebSocket bearer credential. Sessions are memory-only and end on logout, expiry, or server restart.

An ordinary passphrase is supported, but longer and unique is safer; a random value remains the strongest choice. Prefer `--token-file` over putting a real password in an inline environment assignment, which can leave it in shell history and process metadata. Restrict the token file to the server user.

## Remote access

Vampire listens on localhost by default and does not terminate TLS itself. A secure remote deployment must put the loopback backend behind an HTTPS/WSS reverse proxy and an additional private-network or access-control layer. The following starts only the loopback backend; it is not a TLS configuration by itself:

```bash
mkdir -p ~/.config/vampire
chmod 700 ~/.config/vampire
${EDITOR:-vi} ~/.config/vampire/token
chmod 600 ~/.config/vampire/token

VAMPIRE_HOST=127.0.0.1 \
VAMPIRE_PUBLIC_ORIGIN=https://vampire.example.com \
npx vampire --token-file ~/.config/vampire/token
```

Configure the proxy separately to serve `https://vampire.example.com`, forward HTTP and WebSocket upgrades to `127.0.0.1:7677`, and prevent direct backend access. Do not use `--allow-insecure-no-auth` for a network-reachable deployment.

The proxy must preserve or overwrite `Host` to exactly match the authority in `VAMPIRE_PUBLIC_ORIGIN`, including a non-default port, and must forward WebSocket `Upgrade` requests. Unexpected Host headers are rejected. See [SECURITY.md](SECURITY.md) for deployment guidance.

Wildcard binds accept only `localhost` or IP-literal Host values unless a fixed public origin is configured. Access through a LAN, mDNS, or tailnet hostname should use an explicit HTTPS `VAMPIRE_PUBLIC_ORIGIN` and reverse proxy rather than exposing Vampire's HTTP listener directly.

## Development

```bash
pnpm install
pnpm dev
pnpm check
pnpm test
```

The Vite development server is forcibly restricted to loopback and must not be exposed through a remote bind or reverse proxy. To exercise authentication during development, put a development-only `VAMPIRE_TOKEN` in the ignored `.env` file.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.

## License

MIT
