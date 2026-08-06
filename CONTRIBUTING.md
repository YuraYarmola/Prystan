# Contributing to Prystan

Thanks for wanting to help. This document explains how the project is run and what to
expect when you send a change.

## How this project is governed

Prystan is **open source, but not open governance**. Anyone can read the code, fork it,
open issues and send pull requests — but the project has a single maintainer,
[@YuraYarmola](https://github.com/YuraYarmola), who reviews and merges everything.

Practically:

- `main` is protected: no direct pushes, every change goes through a pull request.
- Every pull request needs an approving review from the owner before it can merge.
- The owner decides what fits the project's direction and may decline changes that do
  not, even if they are well written.

If you plan something bigger than a bug fix, **open an issue first** and agree on the
approach. It saves you from writing code that will not be merged.

## Contributor License Agreement

Every contribution requires agreeing to the [CLA](CLA.md). You keep the copyright to
your work; the CLA grants the project owner the rights needed to distribute it —
including under licences other than AGPL-3.0.

You accept it by ticking the checkbox in the pull-request template. No paperwork, no
signing service.

## Getting set up

**Prerequisites**

- [Rust](https://rustup.rs/), stable toolchain (`stable-msvc` on Windows)
- Visual Studio Build Tools with the C++ workload (Windows)
- WebView2 runtime (already present on most Windows 10/11 machines)

There is **no Node.js, npm or bundler**. The frontend is plain HTML/CSS/JS; third-party
libraries (xterm.js, CodeMirror) are vendored in `app/ui/vendor/`.

```bash
git clone https://github.com/YuraYarmola/prystan.git
cd prystan/app/src-tauri

cargo build --release     # build
cargo test                # unit tests
cargo clippy              # lints
```

> **Note:** the frontend is embedded into the binary at compile time. `build.rs`
> registers every file under `app/ui/` with cargo, so editing JS or CSS does trigger a
> rebuild. If you ever see stale UI, that mechanism is the first place to look.

For debugging the frontend, launch with the DevTools port open and connect any
Chromium-based debugger:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
.\target\release\prystan.exe
```

## Project layout

| Path | What lives there |
|---|---|
| `app/src-tauri/src/main.rs` | connections, profiles, app state, command registry |
| `app/src-tauri/src/containers.rs` | container listing, actions, log and stats streams |
| `app/src-tauri/src/logs.rs` | full-history search, aggregated stack logs |
| `app/src-tauri/src/files.rs` | container filesystem through the archive API |
| `app/src-tauri/src/host.rs` | SSH agent, host monitor, host files, compose commands |
| `app/src-tauri/src/term.rs` | container exec sessions |
| `app/src-tauri/src/resources.rs` | images, volumes, networks, registries, limits |
| `app/src-tauri/src/security.rs` | Trivy scanning |
| `app/ui/js/` | frontend modules — one file per area |
| `app/ui/js/i18n.js` | all user-facing strings, three languages |

## Coding conventions

**Rust**

- `cargo fmt` before committing; `cargo clippy` should stay clean.
- Return `Result<_, String>` from Tauri commands with a message a user can act on.
  "стек не знайдено" beats "None unwrap".
- Long-running work streams results through Tauri events instead of blocking a command.
- Comments explain *why*, not *what*. Skip comments that restate the code.

**JavaScript**

- No frameworks and no build step — keep it that way.
- One module per feature area; attach entry points to the shared `S` state object.
- Every user-visible string goes through `t("key")` and must be added to **all three**
  language dictionaries in `i18n.js`. A missing key renders as the raw key.
- Escape anything that reaches `innerHTML` with `esc()`.

**Commits**

Short imperative subject, body explaining reasoning when it is not obvious:

```
Fix stale UI after frontend-only edits

Cargo did not track app/ui, so builds silently embedded the previous
frontend. build.rs now emits rerun-if-changed for every ui file.
```

## Testing

Unit tests cover the parsers that historically broke (`ls` output, monitor blocks):

```bash
cargo test
```

Anything touching Docker, SSH or the filesystem should also be checked by hand against
a real daemon. If your change affects remote behaviour, please say in the pull request
what you tested it against (local socket, SSH host, Docker version).

**Never test destructive operations against someone else's production server.**

## Releasing (maintainer)

Regular pushes to `main` only run CI. The six-platform release build is triggered
deliberately, in one of three ways:

1. **Commit marker** — put `[release]` anywhere in the commit message on `main`.
   The version comes from `version` in `app/src-tauri/Cargo.toml`, the tag is created
   automatically, and a **draft** release is prepared.

   ```
   git commit -m "Add volume backup [release]"
   ```

   Bump the version in `Cargo.toml` first — the workflow refuses to overwrite a version
   that already has a release.

2. **Tag** — `git tag v0.2.0 && git push origin v0.2.0`. The tag name becomes the
   release name.

3. **Manually** — *Actions → Release → Run workflow*. Leave *publish* off to only build
   artifacts and check that all six targets compile, without creating a release.

The release is always created as a **draft**: review the assets and notes, then publish
it by hand.

## Reporting bugs

Open an issue using the bug template and include:

- what you did, what you expected, what happened
- OS, Docker version, connection type (local / TCP / SSH)
- relevant output from the action journal or a screenshot

## Security issues

Do **not** open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
