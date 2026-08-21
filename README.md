# Vampire

**A self-hosted browser workspace for persistent Codex, Claude Code, and shell sessions.**

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

Vampire runs your command-line sessions in tmux and lets you reconnect from a desktop or mobile browser. Your credentials, project files, and running processes stay on your machine.

## Features

- Persistent tmux sessions for Codex, Claude Code, and any shell command.
- Browser workspaces for multiple projects, with desktop and mobile support.
- At-a-glance session status, so you can see what needs your attention.
- Local-first and self-hosted, with optional authenticated remote access.

## Quick start

Requirements:

- Node.js 22.18+
- tmux

Install tmux with your operating system's package manager, then run:

```bash
npx vampire
```

Open the printed URL, choose a project directory, and create a workspace. Start the CLI or shell you want to use inside it:

```bash
codex
# or
claude
```

Your session keeps running when you close the browser. Reopen the workspace whenever you want to continue.

## Remote access

Vampire listens on localhost by default. To access it from another device, bind it to a reachable interface, set a token, and use HTTPS or a private network:

```bash
VAMPIRE_HOST=0.0.0.0 \
VAMPIRE_TOKEN="$(openssl rand -base64 32)" \
npx vampire
```

Never expose an unauthenticated instance to the public internet. See [SECURITY.md](SECURITY.md) for deployment guidance.

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
