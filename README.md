<div align="center">

# ⚓ Prystan

**Docker and your servers in one native window.**

A fast desktop client for managing Docker over local socket, TCP or SSH —
containers, logs, files, terminals, and the host machine itself.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/backend-Rust-orange.svg)](https://www.rust-lang.org/)

🇺🇦 [Читати українською](README.uk.md)

![Dashboard](docs/screenshots/dashboard.png)

*Every screenshot in this README comes from the built-in **demo mode** — the servers,
containers and addresses in them are invented.*

</div>

---

## Why

Managing containers on several remote servers usually means one of three bad options:
SSH into each box and type `docker` commands by hand, install a web panel *onto* the
production server, or run Docker Desktop and give up 2 GB of RAM.

Prystan is a **13 MB binary that uses ~40 MB of RAM**, connects to any Docker daemon
over SSH without installing anything on the server, and puts logs, files, terminals
and host metrics into one window.

| | Prystan | Docker Desktop | Portainer | lazydocker |
|---|---|---|---|---|
| Install size | **13 MB** | ~1.5 GB | container | 30 MB |
| RAM idle | **~40 MB** | 1.5–2 GB | server-side | ~20 MB |
| Multi-server over SSH | **✅ built in** | ⚠️ contexts only | agents required | via `DOCKER_HOST` |
| Container file manager + editor | **✅** | basic | limited | ❌ |
| Host monitoring & processes | **✅** | ❌ | ❌ | ❌ |
| Full-history log search | **✅ server-side** | buffer only | buffer only | ❌ |
| Nothing installed on the server | **✅** | — | ❌ | ✅ |

<div align="center">

| Logs with whole-error highlighting | Load across all containers |
|---|---|
| ![Logs](docs/screenshots/logs.png) | ![Load](docs/screenshots/load.png) |

| Host files over SSH | Folder sizes |
|---|---|
| ![Files](docs/screenshots/host-files.png) | ![Disk usage](docs/screenshots/disk-usage.png) |

</div>

## Download

Builds live on the **[Releases](../../releases)** page — open the latest release and
expand **Assets** at the bottom. Every archive is portable: unpack it and run the
binary, no installer and no runtime to set up.

| Your system | File to download |
|---|---|
| **Windows 10/11** — almost every PC | `Prystan-vX.Y.Z-Windows-x64.zip` |
| Windows on ARM — Surface Pro X, Dev Kit | `Prystan-vX.Y.Z-Windows-ARM64.zip` |
| Windows 32-bit — older machines | `Prystan-vX.Y.Z-Windows-32bit.zip` |
| **Mac with Apple Silicon** — M1 through M4 | `Prystan-vX.Y.Z-macOS-AppleSilicon.tar.gz` |
| Mac with Intel — before 2020 | `Prystan-vX.Y.Z-macOS-Intel.tar.gz` |
| **Linux, 64-bit** | `Prystan-vX.Y.Z-Linux-x64.tar.gz` |

If you are unsure, take **Windows-x64** — it fits almost everyone. The ARM build
simply will not start on a regular PC.

**After downloading**

- **Windows** needs [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) —
  bundled with Windows 11 and with up-to-date Windows 10.
- **macOS** builds are not signed. On first launch use `Ctrl`+click → *Open*, or run
  `xattr -dr com.apple.quarantine prystan`.
- **Linux** needs `libwebkit2gtk-4.1-0` and `libgtk-3-0`.

> Want a build of the very latest commit rather than a release? Open
> [Actions](../../actions), pick a green run and download the artifact for your
> platform. Those expire after 14 days.

---

# Guide

Every feature, how to switch it on, and how to use it.

## Try it without Docker — demo mode

Open **⚙ → Demo mode** and the app restarts on invented servers, containers, logs and
files. Nothing touches your machine or your infrastructure. Use it to look around
before connecting anything, or to record a screenshot without exposing your own hosts.
A **DEMO** badge in the header shows the mode is on. Turn it off in the same place.

## Connections

**Set up.** Click **＋** next to *CONNECTIONS*, or take the *SSH server* card on the
start screen.

| Type | What to enter |
|---|---|
| **Local** | nothing — the local socket or named pipe is used |
| **SSH** | host, port, user, optionally a path to a private key |
| **TCP** | host and daemon port (`2375`, or `2376` with TLS) |

SSH needs no agent or extra software on the server: the app opens a tunnel with your
own `ssh` client, so anything that works in your terminal works here — including keys
from an agent and settings from `~/.ssh/config`.

**Use.** A click on the chip switches to a server, the power icon connects or
disconnects it. A manual disconnect is remembered and the profile is not raised again
on its own. Everything else reconnects at startup and after a dropped link, with a
growing pause between attempts.

**Read-only** in the profile blocks every mutating action for that server. A good fit
for production: browsing, logs and files stay available, buttons that change something
do not.

**Import** takes existing `docker context` entries and turns them into profiles.

## Containers

**Use.** The list groups containers by compose project. A group can be started,
stopped or opened as a stack; a single container gets logs, a shell, files and
inspect.

- **Right-click** a container or a stack for the full menu — logs, shell, files,
  inspect, start/stop/restart, copy name or id, delete.
- **Filter** (`/`) matches names, images, projects, **ports**, container ids and
  status text: type `8080` to find who took the port, `exited` to see what fell over.
- **Quick filters** in the toolbar: all, running, stopped, problematic.
- **Bulk mode** (checkbox icon) selects several containers and applies one action to
  all of them.
- **Keyboard**: `↑`/`↓` walk the list, `Enter` opens, `←`/`→` fold a stack, `Del`
  removes, `Space` toggles a bulk selection.

**Indicators.** The dot tells you the state at a glance: healthy pulses green,
unhealthy but still running pulses amber, anything stopped is a steady grey. A
container that crashed three times in ten minutes gets a crash-loop badge.

**Ports.** Every published port is clickable — the button opens a menu when there is
more than one. For an SSH server the app raises a tunnel first, so `localhost` in your
browser reaches the remote port.

## Load

The **LOAD** section shows one table for every running container: CPU, memory,
network in and out, process count. Click a column header to sort — the answer to
"who ate the server" is one glance instead of a walk through containers. The table
refreshes itself while it is open; a click on a row opens that container.

## Logs

**Use.** The log tab streams live and reconnects on its own.

- **Error highlighting understands whole blocks** — a Python traceback or a Java stack
  trace is coloured from its first line to its last, not just the line with the word
  `ERROR`.
- **Level filter** with counters that count incidents, not lines.
- **Search in the buffer** filters visible lines as you type.
- **🔍 Search the full history** asks the server instead of the buffer: plain text or a
  regular expression across everything the container has ever written, with a time
  limit if you need one.
- **Right-click** gives copy of the selection, of one line, of **the whole error**, or
  of the entire buffer, plus export to a file.
- **Follow** pins the view to the tail; scrolling up releases it, the button pins it
  again.
- A compose stack has **aggregated logs** — every service in one colour-coded stream.

**Tune.** The tail size (500 / 2000 / 10000) is next to the toolbar; the in-memory
buffer is in **⚙ → Log buffer**.

## Files

Works the same for a container, a server over SSH, and a local project folder.

**Use.** Double-click opens a folder or a file. The path field is editable — paste a
path and press `Enter`. Drag files from your file manager onto the window to upload.

**Right-click anywhere in the pane** — on a row or on empty space — for open,
download, copy, cut, paste, rename, move, permissions, copy path, new file, new
folder, size analysis and delete. `Ctrl+C` / `Ctrl+X` / `Ctrl+V`, `F2`, `Del` and
`Backspace` do the same from the keyboard.

**Editor.** Syntax highlighting, search inside the file, and a `.bak` copy on save
(the checkbox in the footer). **⚙ → Editor to the side** docks it to the right half
so the logs stay visible while you edit.

**Search** (magnifier in the toolbar) goes recursively through the folder, by file
name or by text inside files, and jumps to whatever you pick.

**Folder sizes** (pie icon) answers "what filled the disk": one level deep with bars,
click a folder to go deeper.

## Terminals

**Use.** Several sessions per container or server, in tabs. For a container pick the
shell in the toolbar (`bash`, `sh`, `ash`, `zsh`); the default is in
**⚙ → Shell**.

- **`Tab`** completes paths — including in shells like `dash` that have no completion
  of their own, where the app does it itself.
- **History suggestions** appear dimmed to the right of the cursor, PowerShell style;
  `→` or `End` accepts one. The 💡 button turns them off.
- **`Ctrl+C`** copies when text is selected and sends the interrupt when it is not.
  **`Ctrl+V`** pastes. Right-click opens copy / paste / select all / clear.
- **Snippets**: save the current command with 💾 and pick it from the dropdown later.
- The host shell runs through a real PTY, so resizing works and `sudo` can ask for a
  password.

![Terminal](docs/screenshots/terminal.png)

## Server

Available for SSH connections.

- **Overview** — CPU, memory and disks with sparklines, load average, uptime.
  Everything comes from one persistent SSH session, not a command per second.
- **Processes** — a live list with filtering and sorting by CPU or memory, and a kill
  button that sends `TERM` first and `KILL` on a second press.
- **Files** and **Folder sizes** — as described above, on the host filesystem.
- **Terminal** — a full shell.
- **Servers dashboard** shows every configured server on one screen.

## Local projects

For the folder you are actually working in.

**Set up.** **＋** next to *PROJECTS* → enter the path to a folder on your machine.

**Use.** The project gets its files with the editor, a **shell opened right inside
that folder**, `compose up / build / down / restart / pull` run by your local
`docker`, and folder size analysis. The badges in the header show what the app found
there: a compose file, a Dockerfile, git.

Read-only on a production profile does not affect projects — they are your own files
and have nothing to do with the server.

## Images and maintenance

- **Layers** — the size of every layer and the command that produced it, so you can
  see what makes the image heavy.
- **Vulnerability scan** — Trivy runs in a throwaway container, nothing leaves the
  host; results are filterable by severity and by "has a fix".
- **Disk usage** with prune per category: images, containers, volumes, build cache.
- **Build** from a Dockerfile, **pull**, **create a container** through a form that
  shows the equivalent `docker run` as you type.
- **Registries**: credentials go into the system keychain, then `push` works from the
  image list.
- **Environment variables** are editable in the Inspect tab exactly like the JetBrains
  plugin does it — the container is recreated with the new values, and the old one is
  restored if anything goes wrong. Secrets are masked until you open them.
- **CPU and memory limits** change without recreating the container.

| Image layers | Vulnerability scan | Inspect and environment |
|---|---|---|
| ![Layers](docs/screenshots/image-layers.png) | ![Scan](docs/screenshots/vulnerability-scan.png) | ![Inspect](docs/screenshots/inspect.png) |

## Port forwarding

The globe next to a running container raises an SSH tunnel to the published port and
opens the address in your browser. The 🔌 badge in the header counts open tunnels; a
click closes them all.

## Notifications

**Set up.** **⚙ → Telegram**: paste the bot token from
[@BotFather](https://t.me/BotFather) and press **Find chat** — then write anything to
your bot and the `chat_id` fills itself in. **Send test** confirms it works.

**Choose what to send** — each kind separately:

| Event | When it fires |
|---|---|
| A container stopped unexpectedly | it died and *you* did not stop it; the exit code is included, and `137` is flagged as a possible OOM |
| CPU, memory or disk over the threshold | above 95 % / 92 % / 90 %, at most once per ten minutes |
| Lost connection to a server | the event stream broke |
| A compose action finished | `up`, `down`, `build`, `restart` completed |

**Alerts cover every connected server, not only the one on screen.** Background hosts
are polled on a slow interval — **⚙ → Background monitoring**, where it can also be
turned off.

## Action journal

The **JOURNAL** section records what the app did: which action, on which server, with
which result. Handy when you need to remember what exactly was restarted an hour ago.
Stored locally and clearable.

## Settings

**⚙** in the header:

| Setting | What it changes |
|---|---|
| List refresh | how often the container list is polled (2 / 4 / 10 s, or off) |
| Background monitoring | interval for servers that are not on screen (needed for threshold alerts) |
| Log buffer | how many lines are kept in memory |
| Shell | the default shell for container terminals |
| Ask before deleting | confirmation dialogs for destructive actions |
| Editor to the side | dock the editor instead of covering the window |
| Check for updates | one request to GitHub Releases at startup |
| Demo mode | invented data instead of real |

**Theme** (moon/sun) and **language** (uk / ru / en) are next to the gear.

![English interface, light theme](docs/screenshots/english-ui.png)

## Keyboard shortcuts

Press **`?`** in the app for this list.

| Keys | Action |
|---|---|
| `Ctrl+K` | command palette — jump to any container, stack, server or action |
| `/` | focus the filter |
| `↑` `↓` · `Enter` | move through the list and open |
| `←` `→` | fold or expand a stack |
| `Ctrl+R` | refresh everything |
| `Del` | delete the selected item |
| `F2` | rename a file |
| `Ctrl+C` / `Ctrl+V` | copy and paste |
| `Ctrl+Shift+A` | select all in the terminal |
| `Backspace` | go up one folder |
| `Esc` | close a dialog or menu |
| `?` | this list |

## Where things are stored

| What | Windows | macOS | Linux |
|---|---|---|---|
| Profiles, projects, journal | `%APPDATA%\Prystan` | `~/Library/Application Support/Prystan` | `~/.config/prystan` |
| Registry and Telegram tokens | Credential Manager | Keychain | Secret Service |
| Interface settings | browser local storage inside the app | | |

Passwords and tokens never end up in configuration files.

---

## Build it yourself

Prerequisites:

- [Rust](https://rustup.rs/) (stable, MSVC toolchain on Windows)
- Visual Studio Build Tools with the **C++ workload** (Windows only)
- No Node.js, npm or bundler — the frontend is plain HTML/JS with vendored libraries

```bash
git clone https://github.com/YuraYarmola/prystan.git
cd prystan/app/src-tauri
cargo build --release
```

The binary lands in `app/src-tauri/target/release/prystan.exe`.

```bash
cargo test          # unit tests for parsers
cargo clippy        # lints
```

## Architecture

```
app/
  src-tauri/          Rust backend (Tauri 2)
    src/
      main.rs         connections, profiles, projects, app state
      containers.rs   container list, actions, logs, stats
      logs.rs         history search, aggregated stack logs
      files.rs        container filesystem via archive API
      host.rs         SSH agent, monitor, host files, find, du, compose
      term.rs         container exec sessions
      forward.rs      SSH port forwarding
      resources.rs    images, volumes, networks, registries
      security.rs     Trivy vulnerability scanning
      journal.rs      local action log
      notify.rs       Telegram notifications
      clipboard.rs    native clipboard read
      update.rs       release check
      procguard.rs    guaranteed cleanup of child ssh processes
  ui/                 frontend — plain JS modules, no build step
    js/               core, conn, logs, files, term, server, resources,
                      extras, project, icons, demo
    vendor/           xterm.js, CodeMirror (vendored, no CDN)
```

The backend talks to Docker through [bollard](https://github.com/fussybeaver/bollard)
(Engine API). SSH uses the system `ssh` client: a tunnel for the Docker socket, one
persistent agent process for file operations, and ConPTY for interactive terminals.

## Documentation

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Contributing

Contributions are welcome — issues, bug reports and pull requests. Every change is
reviewed by the project owner before it lands. Please read [CONTRIBUTING.md](CONTRIBUTING.md)
first; contributions require agreeing to the [CLA](CLA.md).

## License

Prystan is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In short: you may use, study, modify and share it freely, but if you distribute a
modified version or run it as a network service, your changes must be published under
the same license.

Copyright © 2026 Yurii Yarmola. Contributors keep the copyright to their own
contributions and license them to the project under the [CLA](CLA.md), which lets the
project owner also offer Prystan under other terms.
