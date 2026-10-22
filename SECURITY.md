# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[Private vulnerability reporting](../../security/advisories/new) — that keeps the
details hidden until a fix is available.

Please include:

- what the vulnerability allows an attacker to do
- steps to reproduce, ideally minimal
- affected version and platform

You will get an initial response within a few days. Once fixed, you will be credited in
the advisory and the changelog unless you prefer otherwise.

## What Prystan touches on your machine

Prystan is a desktop client with a lot of reach, so it is worth knowing what it holds:

| Data | Where it lives |
|---|---|
| Connection profiles (host, port, user, key path) | `%APPDATA%\Prystan\profiles.json` — plain JSON, **no passwords** |
| Database profile metadata (no passwords) | `%APPDATA%\Prystan\database-connections.json` |
| Remembered database passwords | OS credential store (`Prystan.Database` service) |
| Registry credentials | Windows Credential Manager (`Prystan` service) |
| Telegram bot token | Windows Credential Manager (`Prystan` service) |
| Action journal | `%APPDATA%\Prystan\journal.jsonl` |
| UI preferences, command history | browser `localStorage` inside the app |

SSH authentication is delegated entirely to the system `ssh` client — Prystan never
reads, stores or transmits your private keys. TCP profiles currently use HTTP;
client TLS certificate configuration is not implemented. Use SSH for encrypted access.

## Security-relevant design notes

- **Read-only profiles.** Any profile can be marked read-only; all mutating actions are
  blocked by backend policy checks as well as UI guards. Interactive remote/container
  shells and image scans are included. Local project files and local shells are
  independent of a remote profile; Compose validation is allowed. This is an application
  policy, not a Docker daemon authorization boundary.
- **Database browser.** Read-only profiles can run fixed database read operations
  through container exec or SSH, without granting an interactive shell. The backend
  resolves the source on the selected server, quotes identifiers, rejects unknown
  operations and enables native SQL read-only settings. Redis uses a read-command
  allowlist with SCAN instead of KEYS. There is no arbitrary query/command input.
  Result caches and live credentials are cleared on disconnect. Opt-in remembering
  (enabled by default) stores passwords only in the native OS credential store,
  after a successful login, with no plaintext fallback. The metadata index contains
  no passwords. Stored passwords stay in the backend and are bound to the server
  profile, endpoint and database source. Failed logins do not overwrite them.
  Deleting a saved connection removes its vault entry; closing a session retains
  the saved profile. Database account permissions remain the underlying
  authorization boundary.
- **Secrets are masked** in the environment-variables view (keys matching
  `PASS|SECRET|TOKEN|KEY|...` and passwords inside DSN URLs) — but they are revealed on
  demand, and they are visible in `RAW JSON`. Be careful when screen-sharing.
- **The vulnerability scanner** runs `aquasec/trivy` as a throwaway container on the
  *target* daemon with the Docker socket mounted read-only. Nothing is sent to any cloud
  service. Mounting the socket does grant that container broad access to the daemon
  while it runs — this is how Trivy inspects local images.
- **Port forwarding** binds only to `127.0.0.1`, never to a public interface.
- **`open_url`** accepts `http`/`https` only, to avoid launching local executables.

## Supported versions

The project is early. Only the latest release receives fixes.
