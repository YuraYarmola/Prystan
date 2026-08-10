# Changelog

All notable changes to Prystan are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-08-10

### Added
- **Local projects** — pin a folder on your own machine and get its files, a shell
  opened right inside it, and `compose up / build / down` without leaving the app
- **Folder size analysis** (`du`) for servers and local projects: one level deep with
  bars, drill down into any folder, reachable from the file manager context menu
- `compose build` as a first-class action for stacks and projects
- Telegram: pick which events are sent (container crash, resource thresholds,
  lost connection, finished compose action) and find `chat_id` automatically —
  paste the bot token, message the bot, and the id fills itself in

### Fixed
- **Alerts only worked for the server you were already looking at.** Container
  events from every other connection were dropped at the door, so a crash on
  production stayed silent while you had another host open. Events now carry the
  container name and exit code, and alerts fire for every connection
- **A container that had been running since before the app started never
  alerted.** "Unexpected" was decided by whether we had seen it start; it is now
  decided by whether *we* stopped it, which is what the word actually means
- **Resource thresholds were only checked while a server was on screen.** Every
  connected host is now monitored — the focused one every 3 s, the rest on a slow
  background interval that can be tuned or turned off
- Crash loops are called out: three deaths within ten minutes raise a separate
  notification and mark the container in the list
- The left panel's drag limit did not match its CSS minimum, so it could be
  pulled narrower than it would then render

### Removed
- Screenshots taken against real servers. They are replaced with demo-mode captures —
  no real host names, addresses or project names remain in the repository

### Added
- **Demo mode** (⚙ → Demo mode) — the app runs on invented servers, containers, logs
  and files, so it can be explored without Docker and captured for documentation
  without exposing anyone's infrastructure. Addresses come from the ranges reserved
  for documentation (RFC 5737). Every screenshot in the README is taken from it
- A full **usage guide** in both READMEs: every feature, how to switch it on and how
  to use it, with keyboard shortcuts and where settings and secrets are stored
- **Load view** — one `docker stats`-style table for every running container,
  sortable by CPU, memory, network or process count, with a click through to the
  container
- **Keyboard navigation**: arrows walk the list, `Enter` opens, `←`/`→` fold
  stacks, `Del` removes, `?` shows a shortcut sheet
- **Context menu on containers and stacks** — logs, shell, files, inspect,
  start/stop/restart, copy name or id, delete
- **Recursive file search** over a server or a project, by file name or by
  content, with a jump to the containing folder
- **Copy a whole error** from the log view — the multi-line block is already
  detected, now it can be taken in one action
- **Update check** against GitHub releases, with a badge in the header
- The left panel can be dragged to any width; the editor can be docked to the
  side so logs stay visible while you edit
- Every port of a container is reachable, not only the first one
- The list filter also matches ports, container ids and status text
- A first-run screen that offers the three ways to start instead of an empty pane
- Settings for refresh intervals, background monitoring, log buffer, default
  shell, delete confirmations and update checks — the key was handed to the shell as
  `^V` instead of letting the browser's own paste run. `Ctrl+C` now copies when
  there is a selection and still sends the interrupt when there is none
- Right-click in the terminal silently pasted instead of offering a menu; there
  is now a real one — copy, paste, select all, clear screen — plus a menu in the
  log view (copy line / copy everything / search / export / clear) and a copy
  entry anywhere text is selected
- Clipboard reading moved to the native side: `navigator.clipboard.readText()`
  asks WebView2 for permission and hangs until it is answered
- Context menus could stop opening after one had been used: every menu added
  one-shot "close" listeners that were never removed when it closed by any other
  route, and a leftover listener then killed the next menu the moment it
  appeared. The lifecycle is now a single set of listeners installed once, with
  one flag for state — nothing accumulates. Closing on `Escape`, on window blur
  and on a press anywhere outside the menu now works regardless of what any
  handler underneath does with the event

### Changed
- Emoji replaced with a single outline icon set that inherits the text colour, so
  the interface reads the same in light and dark themes and on every platform
- Health is now shown by the indicator itself: healthy pulses green, unhealthy but
  running pulses amber, anything stopped is a steady grey dot
- Switching servers clears the previous server's data and shows a skeleton and a
  progress bar instead of silently displaying the old list
- Container state changes land in the list almost immediately: every action
  refreshes on its own, a spinner holds until the state really changes, and the
  container list is polled cheaply between Docker events
- Logs render in batches per frame — a 10 000-line history opens already scrolled
  to the end instead of visibly crawling through the buffer
- Language is chosen from a dropdown instead of a cycling button
- File manager context menu opens anywhere in the pane, including deep folders whose
  listing leaves no empty space
- The browser's own "Save as…" context menu no longer appears; it stays only in text
  fields where paste is genuinely useful

## [0.1.0] — 2026-08-06

### Files
- Right-click context menu in the file manager: open, download, copy, cut, paste,
  rename, move, permissions, copy path, new file, new folder, delete
- Copy/cut buffer with paste into another directory; pasting into the same folder
  creates a `-copy` duplicate instead of failing
- Keyboard shortcuts: `Ctrl+C` / `Ctrl+X` / `Ctrl+V`, `F2` rename, `Del` delete,
  `Backspace` to go up

First public release. Everything below was built and tested against a local Docker
daemon and five real SSH servers.

### Connections
- Local socket / named pipe, TCP (with TLS) and SSH tunnel connections
- Connection profiles with automatic restore on startup and reconnect with backoff
- Manual disconnect is remembered — a profile turned off stays off
- Read-only mode per profile, blocking every mutating action
- Import of existing `docker context` entries

### Containers
- Compose-aware grouping with stack-level start / stop / restart
- Start, stop, restart, pause, unpause, kill, remove; bulk selection
- Health badges and quick filters: running, stopped, problematic
- Live CPU and memory per container
- Container recreation with edited environment variables
- CPU and memory limits changed without recreating the container

### Logs
- Live streaming with automatic reconnect
- Error highlighting that spans full multi-line tracebacks, not just the first line
- Level filters with counters that count incidents, not lines
- Server-side search across the entire history, plain text or regex
- Aggregated logs of a whole compose stack in one colour-coded stream
- Export to file

### Files
- Browse, view and edit files inside containers and on the host
- Syntax highlighting, in-file search, `.bak` copies on save
- Upload, download, rename, chmod, delete, drag-and-drop from the OS
- Host file operations run over one persistent SSH session (~45 ms per operation)

### Terminals
- Multiple sessions per container or host, in tabs
- Inline suggestions from command history, PowerShell style
- Real `Tab` completion, with a client-side fallback for shells without it (`dash`)
- Saved snippets, buffer search, working resize for host shells (ConPTY)

### Server management
- Live CPU, memory and disk with sparklines over a single persistent SSH session
- Process list with filtering and kill
- Host file manager and full shell
- Dashboard across all configured servers

### Images and maintenance
- Image layer breakdown with sizes and originating commands
- Vulnerability scanning through a throwaway Trivy container — nothing leaves the host
- Disk usage with prune per category
- Build from Dockerfile, container creation form, private registries with push
- Container filesystem diff

### Other
- Command palette (`Ctrl+K`)
- Port forwarding with "open in browser"
- Local action journal
- Telegram alerts for container crashes and resource thresholds
- Light and dark themes; Ukrainian, Russian and English interface

[Unreleased]: https://github.com/YuraYarmola/prystan/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/YuraYarmola/prystan/releases/tag/v0.2.0
[0.1.0]: https://github.com/YuraYarmola/prystan/releases/tag/v0.1.0
