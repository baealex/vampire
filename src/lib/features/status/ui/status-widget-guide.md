# Create a status widget

A status widget is a server-side command that prints a compact value for the global status bar. Use a preset for common system metrics, or use **Command** for anything you can calculate from a shell script, CLI, API, or local file.

## Choose a pattern

### Status

Show a short state such as `Build passing`, `3 jobs`, or `Offline`. Put the useful value in `text` and use `tone` only when the state needs emphasis.

### Progress

Add `progress` when the value is a percentage from 0 to 100. It gives the widget a visual progress bar in its detail popover.

### Details

Keep the status bar compact and put supporting information in `menu`. A menu can contain headings, separators, and items with values, details, badges, check marks, progress, or indentation.

### Times and links

Use `time` for reset times, timestamps, or deadlines. Use `href` for a related HTTP or HTTPS page. Links open in a new browser tab; menu items never execute commands.

## Write the command

The Command field accepts a shell command, not a special Vampire language. A small shell command is enough for a simple value:

```sh
printf 'API online | tone=success\n'
```

For a multi-line script, use a quoted shell heredoc. The built-in presets use this pattern with Node, but you can use any interpreter installed on the server:

```sh
node --input-type=module <<'VAMPIRE_STATUS'
const response = await fetch('https://example.com/health');
const healthy = response.ok;
console.log(JSON.stringify({
  text: healthy ? 'API online' : 'API unavailable',
  tone: healthy ? 'success' : 'danger'
}));
VAMPIRE_STATUS
```

`VAMPIRE_STATUS` is not a Vampire API or a required variable. It is only the heredoc delimiter: choose any clear token and repeat it exactly at the start and end of the script. The quotes keep the script body from being expanded by the shell.

Commands inherit the Vampire server's environment. Read values as `$NAME` in shell or `process.env.NAME` in Node. `VAMPIRE_*` names such as `VAMPIRE_WORKSPACE_ROOTS` are server configuration, not widget fields; never print `VAMPIRE_TOKEN` or other secrets.

## Return structured JSON

Print one JSON object to stdout. `text` is required; every other field is optional.

```json
{
  "text": "Backup 60%",
  "tone": "warning",
  "tooltip": "Nightly backup",
  "progress": 60,
  "menu": [
    { "type": "heading", "text": "Nightly backup", "badge": "Running" },
    {
      "type": "item",
      "text": "Files",
      "value": "12,480",
      "detail": "Documents and media"
    },
    { "type": "separator" },
    { "type": "item", "text": "Started", "time": { "at": "2026-08-21T03:00:00Z" } },
    { "type": "item", "text": "Open dashboard", "href": "https://example.com/backups" }
  ]
}
```

Supported top-level fields:

- `text` — the short value shown in the bar. Required.
- `tooltip` — a longer description for the widget.
- `tone` — `neutral`, `success`, `warning`, or `danger`.
- `progress` — a number from 0 to 100.
- `menu` — an array of `heading`, `separator`, and `item` entries.

An item requires `text`. It may also use `value`, `detail`, `badge`, `checked`, `progress`, `tone`, `indent` (0–3), `href`, and `time`. A time accepts an ISO date or a Unix timestamp in seconds or milliseconds.

## Plain text is also supported

For a small widget, print a single line:

```text
API online | tone=success tooltip="Health check"
```

Add menu items after `---`. Prefix an item with `--` to indent it:

```text
API online | tone=success
---
Latency | value=84 ms
--Open dashboard | href=https://example.com/health
```

## Command rules

- The command runs on the Vampire server with the server user's OS permissions.
- It runs through the server user's shell, so external programs and interpreters must be installed on that machine.
- Plugins run while a browser is connected, once per refresh, and the result is shared with connected browsers.
- Refresh intervals are 1 second to 24 hours. Commands have a 10-second timeout.
- Output is limited to 32 KB. Print status data to stdout and keep it concise.
- HTML and terminal control sequences are not rendered. Links must use `http://` or `https://`.

## Before you save

- Can someone understand the headline without opening the menu?
- Does the command always print a non-empty `text` value?
- Are detailed rows, timestamps, and links in `menu` rather than crammed into `text`?
- Does it finish quickly and keep secrets out of the output?
