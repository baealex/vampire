# Vampire

**Keep your coding agents running in tmux. Continue the same conversation from a desktop or mobile browser.**

<table>
  <tr>
    <td width="78%" valign="top">
      <img src="docs/images/vampire-desktop.png" alt="Vampire desktop workspace with Smart status groups, a Codex session, and repository changes" />
    </td>
    <td width="22%" valign="top">
      <img src="docs/images/vampire-mobile.png" alt="Vampire mobile workspace with the same Codex session" />
    </td>
  </tr>
</table>

Vampire is a small, self-hosted browser UI for Codex, Claude Code, and ordinary shell sessions. The CLI, credentials, and project files stay on your machine.

## Quick start

### 1. Install prerequisites

You need Node.js 22.18+ and tmux.

macOS (Homebrew):

```bash
brew install tmux
```

Debian, Ubuntu, or WSL2:

```bash
sudo apt update
sudo apt install tmux
```

Fedora:

```bash
sudo dnf install tmux
```

Arch:

```bash
sudo pacman -S tmux
```

### 2. Start Vampire

```bash
npx vampire
```

Open the printed URL, choose a project directory, and create a workspace.

### 3. Start your CLI

Inside a workspace, run the agent or shell you already use:

```bash
codex
# or
claude
```

The process keeps running in tmux when you close the browser. Reopen the workspace from any device to continue.

## What you get

- Persistent tmux sessions for Codex, Claude Code, and any CLI.
- Workspace actions for startup profiles, aliases, ordering, and **New isolated workspace**.
- Background commands, server-side agent automations, and shared Markdown workspace notes.
- A customizable status bar with user-defined command plugins.
- The same workspace from a desktop or mobile browser.
- Smart status groups for main sessions that are working, need review, are idle, or have ended.
- Repository browsing, Git diffs, image previews, text editing, and port inspection.
- Light and dark themes with a mobile-friendly terminal.

See [Status plugins](docs/status-plugins.md) for the plugin format.

| State | Meaning |
| --- | --- |
| Working | The main terminal is producing output. |
| Review needed | New main-terminal output is waiting for you to check it. |
| Idle | The main terminal has no unreviewed output. |
| Ended | The saved workspace no longer has a running tmux shell. |

## Remote access

Vampire is local-only by default. If you need to access it from another device, set a token and put it behind HTTPS or a private network:

```bash
VAMPIRE_TOKEN="$(openssl rand -base64 32)" npx vampire
```

Do not expose an unauthenticated instance to the public internet. See [SECURITY.md](SECURITY.md) for the threat model and reverse-proxy guidance.

For a trusted private network only, unauthenticated LAN access requires an explicit opt-in:

```bash
VAMPIRE_HOST=192.168.1.10 VAMPIRE_ALLOW_INSECURE_NO_AUTH=1 npx vampire
```

## Optional configuration

Running `npx vampire` needs no environment variables. Set only the options your deployment actually needs:

| Variable | Purpose | Default |
| --- | --- | --- |
| `VAMPIRE_HOST` | Bind address | `127.0.0.1` |
| `VAMPIRE_PORT` | HTTP port | `7677` |
| `VAMPIRE_TOKEN` | Bearer token for remote access | unset |
| `VAMPIRE_ALLOW_INSECURE_NO_AUTH` | Allow a non-loopback bind without authentication when set to `1` | unset |
| `VAMPIRE_WORKSPACE_ROOTS` | Server-side directories available to the workspace picker, separated by `:` (`;` on Windows) | server launch directory (`process.cwd()`) |
| `VAMPIRE_STATE_DIR` | Session registry, profiles, aliases, shared ordering, workspace notes, explicit command favorites, managed worktrees, and status plugin commands | `~/.vampire` |

Project files, commands, terminal history, and running processes stay on your machine. The workspace picker and new sessions are restricted to the configured workspace roots; browsing reads only immediate child directories. Existing registered workspaces remain restartable even if they are outside a newly configured root.

### Workspace directory access

`VAMPIRE_WORKSPACE_ROOTS` controls which server-side directories can be selected when creating a workspace. Paths may be absolute, relative to the server launch directory, or use `~` for the server user's home directory.

```bash
# macOS or Linux: allow two project areas
VAMPIRE_WORKSPACE_ROOTS="$HOME/Code:$HOME/Projects" npx vampire
```

If it is unset or empty, the server launch directory is the only root. The root itself or any directory below it can be registered; Vampire stores that server path and starts the tmux session there. The manual path field uses the same validation, and paths outside the roots or non-directories are rejected.

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
