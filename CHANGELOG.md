# Changelog

All notable changes to Prystan are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/YuraYarmola/prystan/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YuraYarmola/prystan/releases/tag/v0.1.0
