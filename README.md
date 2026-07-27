# Vampire

**Keep your coding agents running in tmux. Continue the same conversation from a desktop or mobile browser.**

<table>
  <tr>
    <td width="78%" valign="top">
      <img src="docs/images/vampire-desktop.png" alt="Vampire desktop workspace with an agent conversation" />
    </td>
    <td width="22%" valign="top">
      <img src="docs/images/vampire-mobile.png" alt="Vampire mobile workspace with an agent conversation" />
    </td>
  </tr>
</table>

Vampire is a small, self-hosted browser UI for Codex, Claude Code, and ordinary shell sessions. The CLI, credentials, and project files stay on your machine.

## Quick start

### 1. Install prerequisites

You need Node.js 22+ and tmux.

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
- The same workspace from a desktop or mobile browser.
- Activity states for sessions that are live, under review, or idle.
- Notes and process labels in the workspace list.
- Git diffs, image previews, text editing, and inline file/folder creation.
- Light and dark themes with a mobile-friendly terminal.

| State | Meaning |
| --- | --- |
| Live | Terminal output is active. |
| Review | New terminal output needs review. |
| Idle | No process is currently active. |

## Remote access

Vampire is local-only by default. If you need to access it from another device, set a token and put it behind HTTPS or a private network:

```bash
VAMPIRE_TOKEN="$(openssl rand -base64 32)" npx vampire
```

Do not expose an unauthenticated instance to the public internet. See [SECURITY.md](SECURITY.md) for the threat model and reverse-proxy guidance.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `VAMPIRE_HOST` | Bind address | `127.0.0.1` |
| `VAMPIRE_PORT` | HTTP port | `7677` |
| `VAMPIRE_TOKEN` | Bearer token for remote access | unset |
| `VAMPIRE_STATE_DIR` | Session registry and workspace notes | `~/.vampire` |
| `VAMPIRE_ADAPTER_ORIGIN` | Allowed browser origin for an adapter | unset |

Project files, commands, terminal history, and running processes stay on your machine. Repository access is restricted to the workspace directory.

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
