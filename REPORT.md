# Prystan — Аналіз ринку, вибір технологій та вимоги

> **Статус (2026-08-05):** робочий застосунок зібрано в `prototype/` (Tauri 2 + Rust + bollard).
> Реалізовано: підключення local/TCP/SSH-тунель, compose-групування, push-події, стрім логів із пошуком,
> файловий менеджер (browse/read/edit/upload/download/mkdir/rm), термінал xterm.js (exec, TTY, Ctrl+C, copy/paste),
> inspect, образи/томи/мережі, pull із прогресом, prune. Протестовано на локальному демоні та на реальному
> SSH-сервері (read-only). Бінарник 8.1 МБ, ~32 МБ RAM, старт+конект ~600 мс.

> Звіт підготовлено: 2026-08-05
> Мета продукту: десктопна програма, що повністю замінює роботу з Docker через CLI — керування контейнерами, файлами, логами й терміналом через зручний UI. Референс UX — Docker-плагін для JetBrains IDE (панель Services).

---

## 1. Бачення продукту

Швидкий, легкий, кросплатформенний (Windows / macOS / Linux) десктопний клієнт для Docker, який:

- підключається до будь-якого Docker-демона: локальний сокет, TCP (з TLS і без), **SSH**;
- дає повний CRUD над контейнерами, образами, томами, мережами, compose-стеками;
- має **файловий менеджер контейнера**: перегляд, завантаження, вивантаження, редагування файлів прямо в контейнері;
- показує логи в реальному часі з **пошуком, фільтрацією та підсвіткою**;
- має «розумний» вбудований термінал (exec/attach) з повноцінною вставкою, копіюванням, історією та керуванням процесами.

---

## 2. Аналіз конкурентів

### 2.1 Зведена таблиця

| Продукт | Тип | Платформи | Remote (TCP/SSH) | Файли контейнера | Логи + пошук | Термінал | Ліцензія / ціна |
|---|---|---|---|---|---|---|---|
| **Docker Desktop** | Desktop (Electron) | Win/mac/Linux | Обмежено (contexts через CLI) | Перегляд/редагування (базово) | Так, пошук базовий | Так | Платно для компаній >250 осіб або >$10M |
| **Portainer CE/BE** | Web (self-hosted) | Будь-де (у контейнері) | Agent/Edge, TCP | Обмежено (browse томів у BE) | Так, базовий пошук | Так (web) | CE безкоштовно; BE платно |
| **Dockge** | Web | У контейнері | Ні (тільки локальний хост, agents у розробці) | Ні | Так, без розвиненого пошуку | Так (web) | MIT, безкоштовно |
| **Komodo** | Web (Rust) | У контейнері | Так (core/periphery, багато серверів) | Ні | Так | Обмежено | Безкоштовно, OSS |
| **Dokploy** | Web (PaaS-стиль) | У контейнері | Так (multi-server) | Ні | Так | Так (web) | OSS + Cloud |
| **Lazydocker** | TUI (термінал) | Win/mac/Linux | Через DOCKER_HOST | Ні | Так, без UI-пошуку | Ні (делегує в shell) | MIT |
| **OrbStack** | Desktop (нативний) | **Тільки macOS** | Ні (локальна віртуалізація) | Так | Так | Так | Платно для комерції |
| **Podman Desktop** | Desktop (Electron) | Win/mac/Linux | Частково | Ні | Так, базово | Так | Apache 2.0 |
| **Rancher Desktop** | Desktop | Win/mac/Linux | Ні | Ні | **GUI керування контейнерами практично відсутній** | Ні | Apache 2.0 |
| **DockStation** | Desktop (Electron) | Win/mac/Linux | SSH (частково) | Ні | Так | Ні | Безкоштовно, **закинутий (не оновлюється)** |
| **JetBrains Docker plugin** | Плагін IDE | Win/mac/Linux | TCP, SSH (через IDE) | Так (browse/upload/download) | Так, з пошуком IDE | Так | У складі платних IDE |

### 2.2 Ключові висновки

1. **Ніша реально відкрита.** Жоден *легкий нативний десктопний* застосунок не покриває одночасно: remote-підключення (TCP+TLS, SSH), файловий менеджер контейнера з редагуванням, потужний пошук у логах і якісний термінал. Найближчий за функціями — JetBrains-плагін, але він живе тільки всередині важкої IDE.
2. **Web-інструменти (Portainer, Dockge, Komodo)** вимагають розгортання на сервері й самі є контейнерами — це інший сценарій використання (адміністрування сервера), а не «інструмент розробника на локальній машині».
3. **Docker Desktop** — головний конкурент, але: платний для середніх/великих компаній, важкий (Electron + вбудована VM), слабкий у remote-сценаріях і роботі з файлами.
4. **DockStation** — доказ попиту саме на такий продукт (desktop + SSH), але проєкт покинутий, зроблений на Electron і повільний.
5. **Rancher/Podman Desktop** сфокусовані на заміні рушія (containerd/podman), а не на UX керування — GUI там вторинний.

**Диференціатори Prystan:** швидкість і мала вага (нативний бекенд), першокласні remote-підключення (SSH як основний сценарій), файловий менеджер із вбудованим редактором, пошук у логах рівня «як у IDE», термінал без компромісів.

---

## 3. Вибір технологій

### 3.1 Каркас застосунку — **Tauri 2 (Rust) — рекомендовано**

Порівняння основних варіантів (за бенчмарками 2026 року):

| Критерій | **Tauri 2 (Rust)** | Electron (Node.js) | Wails (Go) |
|---|---|---|---|
| Розмір інсталятора (hello world) | ~3–10 МБ | ~85–120 МБ | ~15 МБ |
| RAM у простої | ~40–60 МБ | ~170–300 МБ | ~50–80 МБ |
| Холодний старт | ~0.4 с | ~1.4 с | ~0.5 с |
| Рендеринг | системний WebView | вбудований Chromium | системний WebView |
| Екосистема Docker-клієнта | **bollard** (повний API, SSH, TLS, streaming) | dockerode | docker/docker (офіційний Go SDK) |
| Безпека / модель дозволів | сильна (capabilities) | слабша | середня |
| Зрілість | висока (v2 стабільна) | найвища | середня |

**Чому Tauri:** прямо відповідає нефункціональним вимогам «швидко, не навантажує комп'ютер, компілюється під різні середовища». Rust-бекенд дає безкоштовну багатопотоковість для стрімінгу логів/терміналів без блокувань UI. Альтернатива №2 — **Wails + офіційний Go SDK Docker** (простіший бекенд-код, але слабша модель безпеки і менша екосистема плагінів).

> Застереження щодо Tauri: системний WebView означає WebView2 на Windows, WebKit на macOS/Linux — потрібне тестування рендерингу терміналу на всіх трьох.

### 3.2 Стек компонентів

| Задача | Технологія | Обґрунтування |
|---|---|---|
| Docker API клієнт | **bollard** (Rust) | Повне покриття Engine API v1.48+, підтримка unix socket, Windows named pipe, HTTP/HTTPS з TLS, **SSH-тунелювання**; асинхронний (tokio), нативний streaming |
| SSH-транспорт | `russh` або спавн системного `ssh` (як робить Docker CLI: `docker system dial-stdio`) | Fallback на системний ssh дає підтримку ~/.ssh/config, agent, ProxyJump |
| UI-фреймворк | **React + TypeScript** (або SolidJS для меншого рантайму) | Найбільша екосистема компонентів; віртуалізовані списки для логів |
| Термінал | **xterm.js** + addon-clipboard, addon-search, addon-fit, WebGL-рендерер | Стандарт де-факто (VS Code, Portainer); готові рішення для copy/paste, пошуку, ресайзу |
| Редактор файлів | **CodeMirror 6** (легший) або Monaco (якщо потрібен повний VS Code-досвід) | Підсвітка синтаксису, великі файли, легка вага |
| Логи: рендер | Віртуалізований список (custom / `@tanstack/virtual`) + ring buffer у Rust | Мільйони рядків без деградації; пошук виконується в Rust-бекенді, не в JS |
| Файлові операції | Docker Engine API `GET/PUT /containers/{id}/archive` (tar-стріми) | Працює однаково для локальних і remote-демонів, без залежності від docker CLI |
| Стан/сховище | SQLite (профілі підключень) + OS keychain для секретів (TLS-ключі, SSH-паролі) | Секрети ніколи не в plain text |

### 3.3 Ключові механізми Docker Engine API

- **Підключення:** unix socket (`/var/run/docker.sock`), named pipe (`//./pipe/docker_engine`), `tcp://host:2375` (без TLS), `tcp://host:2376` (TLS, mutual auth), `ssh://user@host` (тунель до remote-сокета).
- **Логи:** `GET /containers/{id}/logs?follow=true&timestamps=true` — стрім stdout/stderr із мультиплексованим фреймінгом; пошук — індексація на боці застосунку.
- **Термінал:** `POST /containers/{id}/exec` + `POST /exec/{id}/start` (hijacked TCP-стрім, TTY) + `POST /exec/{id}/resize`; attach — аналогічно через `/containers/{id}/attach`.
- **Файли:** `HEAD /containers/{id}/archive` (stat), `GET` (download tar), `PUT` (upload tar) — редагування = download → edit → upload.
- **Події:** `GET /events` — live-оновлення UI без полінгу.

---

## 4. Функціональні вимоги

### FR-1. Підключення до Docker
- **FR-1.1** Профілі підключень: локальний сокет/named pipe, TCP, TCP+TLS (CA/cert/key), SSH (пароль, ключ, ssh-agent, підтримка `~/.ssh/config`).
- **FR-1.2** Кілька одночасних підключень (мультихост) з перемиканням у сайдбарі.
- **FR-1.3** Автоперепідключення при обриві; індикатор стану з'єднання і версії демона.
- **FR-1.4** Імпорт існуючих docker contexts (`docker context ls`).
- **FR-1.5** Зберігання секретів у системному keychain (Windows Credential Manager / macOS Keychain / libsecret).

### FR-2. Контейнери
- **FR-2.1** Список з live-статусами (через events API), фільтрація, пошук, сортування.
- **FR-2.2** Дії: start / stop / restart / pause / kill / rm; масові операції.
- **FR-2.3** Створення контейнера через форму (образ, порти, томи, env, мережі, restart policy) з превʼю еквівалентної `docker run` команди.
- **FR-2.4** Inspect у зручному вигляді (порти, mounts, env, labels) + raw JSON.
- **FR-2.5** Статистика в реальному часі: CPU, RAM, мережа, диск (streaming `/stats`).

### FR-3. Файли контейнера
- **FR-3.1** Дерево файлової системи контейнера з навігацією (у т.ч. для зупинених контейнерів).
- **FR-3.2** Завантаження файлів/тек із контейнера на хост (download, з прогресом для великих файлів).
- **FR-3.3** Вивантаження файлів/тек у контейнер (upload, drag-and-drop з ОС).
- **FR-3.4** Перегляд файлів (текст, зображення, hex для бінарних).
- **FR-3.5** Редагування текстових файлів у вбудованому редакторі з підсвіткою синтаксису; збереження назад у контейнер однією дією.
- **FR-3.6** Базові операції: створити теку/файл, перейменувати, видалити, показ прав/власника.

### FR-4. Логи
- **FR-4.1** Стрімінг логів у реальному часі (follow) з розділенням stdout/stderr, timestamps.
- **FR-4.2** **Пошук:** підрядок і regex, підсвітка збігів, навігація між збігами, лічильник.
- **FR-4.3** Фільтрація: за рівнем (детект патернів ERROR/WARN/INFO), часовим діапазоном (`since`/`until`), stdout/stderr.
- **FR-4.4** Автопрокрутка з розумною паузою (скрол угору зупиняє follow, кнопка «до низу»).
- **FR-4.5** Експорт логів у файл; копіювання виділеного.
- **FR-4.6** Продуктивність: віртуалізація, ліміт буфера (ring buffer), відсутність фризів на ≥1 млн рядків.
- **FR-4.7** Агреговані логи compose-стека (кілька контейнерів в одному потоці з кольоровими префіксами).

### FR-5. Термінал
- **FR-5.1** Відкриття exec-сесії (вибір shell: bash/sh/ash/custom, user, env, робоча тека) та attach до PID 1.
- **FR-5.2** Повноцінний емулятор терміналу (xterm.js): кольори, курсор, TUI-програми (vim, htop, less).
- **FR-5.3** **Копіювання/вставка:** Ctrl+Shift+C/V + контекстне меню + вставка по правому кліку; коректна вставка багаторядкового тексту (bracketed paste); попередження при вставці багаторядкових команд.
- **FR-5.4** Керування процесами: Ctrl+C/Ctrl+Z/Ctrl+D передаються в контейнер; закриття вкладки коректно завершує exec-сесію.
- **FR-5.5** Кілька паралельних вкладок терміналів (у т.ч. до різних контейнерів); ресайз (`exec/resize`) при зміні вікна.
- **FR-5.6** Пошук по буферу терміналу, налаштовуваний scrollback, вибір шрифту/розміру.
- **FR-5.7** Локальний термінал хоста з преднастроєним `DOCKER_HOST` (для CLI-фанатів).

### FR-6. Образи, томи, мережі
- **FR-6.1** Образи: список, pull (з прогресом по шарах), rm, prune, тегування, push, історія шарів, inspect.
- **FR-6.2** Build із Dockerfile з живим виводом.
- **FR-6.3** Томи: список, створення, видалення, prune; перегляд вмісту тому (через допоміжний контейнер).
- **FR-6.4** Мережі: список, створення, підключення/відключення контейнерів.
- **FR-6.5** Реєстри: логін у приватні registry, збереження credentials у keychain.

### FR-7. Docker Compose (фаза 2)
- **FR-7.1** Виявлення стеків (label `com.docker.compose.project`), групування контейнерів.
- **FR-7.2** Up / down / restart стека; статуси сервісів.

---

## 5. Нефункціональні вимоги

### NFR-1. Продуктивність
- Холодний старт застосунку: **< 1 с** до інтерактивного UI.
- Споживання RAM у простої з одним підключенням: **< 150 МБ**; ціль < 100 МБ.
- Розмір інсталятора: **< 30 МБ**.
- UI не блокується під час будь-яких операцій (усі виклики API асинхронні, стрімінг у окремих потоках).
- Рендер логів: стабільні 60 fps при streaming ≥ 5 000 рядків/с; пошук по 1 млн рядків < 500 мс.
- Затримка вводу в терміналі (локальний демон): не гірше нативного терміналу на око (< 16 мс на кадр).

### NFR-2. Кросплатформенність
- Windows 10/11 (x64, ARM64), macOS 12+ (Intel + Apple Silicon), Linux (deb/rpm/AppImage/Flatpak, X11 і Wayland).
- Єдина кодова база; CI збирає всі платформи (GitHub Actions).
- Автооновлення з підписаними збірками (Tauri updater).

### NFR-3. Безпека
- Секрети (TLS-ключі, SSH-креденшели, registry-паролі) — тільки в системному keychain, ніколи в конфігах.
- TLS: перевірка сертифікатів за замовчуванням, mutual TLS; явне попередження для незашифрованого tcp://2375.
- SSH: перевірка host key (known_hosts) із діалогом підтвердження.
- Мінімальні привілеї WebView (Tauri capabilities), без remote-контенту в UI.

### NFR-4. Надійність
- Обрив мережі не «ламає» стан: черги, ретраї, чіткі повідомлення про помилки.
- Некоректна відповідь демона старої версії → graceful degradation (feature detection за версією API).
- Втрата з'єднання під час редагування файлу не втрачає незбережені зміни (локальний draft).

### NFR-5. UX
- Референс — Services-панель JetBrains: дерево обʼєктів зліва, вкладки (Logs / Files / Terminal / Inspect / Stats) справа.
- Command palette (Ctrl+K) для всіх дій; повна керованість із клавіатури.
- Темна/світла теми, слідування системній.
- Локалізація: EN + UK на старті.
- Небезпечні дії (rm, prune) — з підтвердженням; типові дії — в 1–2 кліки.

### NFR-6. Супровід
- Телеметрія — тільки opt-in.
- Логи самого застосунку для діагностики (з rotate).
- Покриття тестами: unit для Rust-ядра (робота з API, tar, SSH), e2e-смоук на реальному Docker у CI (testcontainers).

---

## 6. Ризики та відкриті питання

| Ризик | Вплив | Мітигація |
|---|---|---|
| Рендеринг xterm.js у системних WebView (особливо WebKitGTK на Linux) | Середній | Ранній прототип терміналу на всіх 3 ОС — це фактично go/no-go тест для Tauri |
| SSH-транспорт у bollard може не покривати всі сценарії (agent, jump hosts) | Середній | Fallback: тунель через системний `ssh -W` / власний тунель на russh |
| `PUT /archive` перезаписує права/власника файлів при редагуванні | Низький | Читати stat перед upload, відтворювати uid/gid/mode у tar-заголовку |
| Файловий браузер для контейнерів без `ls` (distroless/scratch) | Низький | Читання FS через archive API не потребує утиліт усередині контейнера |
| Конкуренція з безкоштовним Docker Desktop для дому | Середній | Фокус на remote/SSH і швидкість — там Docker Desktop найслабший |

---

## 7. Рекомендований план (фази)

1. **MVP (8–10 тижнів):** підключення (socket/TCP/TLS/SSH) → список контейнерів + дії → логи зі стрімінгом і пошуком → термінал (exec) → файловий браузер із download/upload.
2. **Фаза 2:** редактор файлів, образи/томи/мережі, stats, command palette, автооновлення.
3. **Фаза 3:** compose-стеки, мультихост-дашборд, build, приватні registry.

---

## Джерела

- [Better Stack — Top Portainer Alternatives 2026](https://betterstack.com/community/comparisons/docker-ui-alternative/)
- [Cloudzy — Portainer Alternatives: Dockge, Arcane, Dockhand, Komodo](https://cloudzy.com/blog/portainer-alternatives/)
- [HomelabCompass — Dockge vs Portainer 2026](https://homelabcompass.com/compare/dockge-vs-portainer)
- [Portainer — Docker Desktop Alternatives](https://www.portainer.io/blog/docker-desktop-alternatives)
- [Bytebase — Top Free Docker Desktop Alternatives 2026](https://www.bytebase.com/blog/top-docker-desktop-alternatives/)
- [Порівняння OrbStack / Podman Desktop / Rancher Desktop 2026](https://insights.nomadlab.cc/blog/2026/04/orbstack-vs-podman-desktop-vs-rancher-desktop)
- [Tauri vs Electron 2026 — розміри, RAM, старт](https://tech-insider.org/tauri-vs-electron-2026/)
- [Digital Applied — Tauri vs Electron vs Wails 2026](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)
- [bollard — Docker daemon API клієнт на Rust](https://github.com/fussybeaver/bollard)
- [dockerode — Docker Remote API для Node.js](https://github.com/apocas/dockerode)
- [Docker Docs — Configure remote access for Docker daemon](https://docs.docker.com/engine/daemon/remote-access/)
- [Docker Docs — Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/)
- [JetBrains — Docker plugin (Marketplace)](https://plugins.jetbrains.com/plugin/7724-docker)
- [IntelliJ IDEA — Docker containers documentation](https://www.jetbrains.com/help/idea/docker-containers.html)
- [xterm.js — термінал для веб](https://github.com/xtermjs/xterm.js/)
