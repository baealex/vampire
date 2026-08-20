# Status plugins

A status plugin is a shell script that prints a compact bar value and an optional menu. Vampire runs it once on the server for each refresh and broadcasts the result to every connected browser.

Scripts run only while a browser is connected, never overlap, time out after 10 seconds, and may emit at most 32 KB. Saving the configuration reruns enabled plugins once. A recent result is reused after a short disconnect until its interval is due.

## Plain output

The first line appears in the bar. The first `---` starts the menu, later `---` lines become separators, and leading `--` pairs indent an item.

```text
Build passing | tone=success tooltip="Latest main build"
---
Main | value=passing badge=production checked=true
--Open dashboard | href=https://example.com/builds
---
Updated a minute ago
```

Menu items accept `value`, `detail`, `tooltip`, `badge`, `checked`, `progress`, `tone`, and `href`. Header lines accept `tooltip`, `progress`, and `tone`. Values containing spaces may be quoted. `tone` is `neutral`, `success`, `warning`, or `danger`; the SwiftBar colors `red`, `orange`, `yellow`, and `green` also map to semantic tones.

## JSON output

JSON provides headings, localized times, progress, links, and other structured content without tying the UI to a particular service:

```json
{
  "text": "7d 22%",
  "tone": "neutral",
  "menu": [
    { "type": "heading", "text": "Account", "badge": "Overall" },
    {
      "type": "item",
      "text": "7d",
      "value": "22% used",
      "progress": 22,
      "time": { "label": "Resets", "at": "2026-08-27T12:16:07Z" }
    },
    { "type": "separator" },
    {
      "type": "item",
      "text": "Usage dashboard",
      "href": "https://example.com/usage"
    }
  ]
}
```

An `item` may contain `text`, `value`, `detail`, `time`, `badge`, `checked`, `progress`, `tone`, `href`, and an `indent` from 0 to 3. A time accepts ISO text or Unix seconds/milliseconds and is formatted using the browser's language and time zone. Links are limited to HTTP and HTTPS.

Output is bounded, stripped of terminal controls, and rendered as text rather than HTML. Menu items cannot execute server commands; put data collection in the plugin script itself.
