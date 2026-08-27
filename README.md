# Vampire

**A self-hosted browser workspace for persistent terminal workspaces.**

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

Vampire runs your terminal workspaces in tmux and lets you reconnect from a desktop or mobile browser. Your credentials, project files, and running processes stay on your machine.

## Features

- Persistent tmux-backed terminal workspaces for Codex, Claude Code, and any shell command.
- Browser workspaces for multiple projects, with desktop and mobile support.
- At-a-glance workspace status, so you can see what needs your attention.
- Local-first and self-hosted, with optional authenticated remote access.

## Quick start

Requirements:

- Node.js 22.18+
- tmux

Install tmux with your operating system's package manager, then run:

```bash
npx vampire
```

Open the printed URL (`http://localhost:7677` by default), choose a project directory, and create a workspace. Start the CLI or shell you want to use inside it:

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
| Access token | `--token-file` | `VAMPIRE_TOKEN` | disabled on loopback |
| Unauthenticated remote bind | `--allow-insecure-no-auth` | `VAMPIRE_ALLOW_INSECURE_NO_AUTH=1` | disabled |

`VAMPIRE_WORKSPACE_ROOTS` uses the operating system's path-list separator (`:` on macOS/Linux and `;` on Windows). Repeat the CLI option when allowing multiple roots:

```bash
npx vampire --port 8787 \
  --workspace-root ~/Code \
  --workspace-root ~/Projects
```

The installed CLI does not automatically read `.env` from the current directory. Use `--env-file <path>` when that behavior is intentional. `pnpm dev` does load Vite's development `.env` files, while existing process variables continue to take precedence.

## Remote access

Vampire listens on localhost by default. To access it from another device, bind it to a reachable interface, set a token, and use HTTPS or a private network:

```bash
VAMPIRE_TOKEN="$(openssl rand -base64 32)"
printf 'Vampire token: %s\n' "$VAMPIRE_TOKEN"
VAMPIRE_HOST=0.0.0.0 VAMPIRE_TOKEN="$VAMPIRE_TOKEN" npx vampire
```

Never expose an unauthenticated instance to the public internet. See [SECURITY.md](SECURITY.md) for deployment guidance.

When HTTPS terminates at a reverse proxy, bind the backend to loopback and configure the browser-facing origin explicitly:

```bash
VAMPIRE_HOST=127.0.0.1 \
VAMPIRE_PUBLIC_ORIGIN=https://vampire.example.com \
npx vampire --token-file /run/secrets/vampire-token
```

## Development

```bash
pnpm install
pnpm dev
pnpm check
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.

## License

MIT
