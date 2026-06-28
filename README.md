<div align="center">

<img src="assets/dockshift-banner.png" alt="DockShift" width="100%" />

<br/><br/>

### Your entire workflow — one keystroke away.

**DockShift** is a floating command dock for Windows. Clipboard history, workspace
snapshots, a bring-your-own-model AI assistant, a real terminal, voice-to-text, and
more — always within reach, never in your way.

<br/>

[![Electron](https://img.shields.io/badge/Electron-40-47848F?style=flat-square&labelColor=1A1B26&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&labelColor=1A1B26&logo=react&logoColor=61DAFB)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&labelColor=1A1B26&logo=vite&logoColor=FFD62E)](https://vitejs.dev/)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?style=flat-square&labelColor=1A1B26&logo=windows11&logoColor=4CC2FF)](https://www.microsoft.com/windows)

[![License](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square&labelColor=1A1B26)](LICENSE)
[![Version](https://img.shields.io/badge/Version-0.10.0_beta-7AA2F7?style=flat-square&labelColor=1A1B26)](https://github.com/Salah-XD/dockshift/releases)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-BB9AF7?style=flat-square&labelColor=1A1B26)](#-contributing)
[![Star on GitHub](https://img.shields.io/badge/Star_on_GitHub-F5A623?style=flat-square&labelColor=1A1B26&logo=github&logoColor=white)](https://github.com/Salah-XD/dockshift)

[**Quick Start**](#-quick-start) · [**Features**](#-what-it-does) · [**Security**](#-built-secure) · [**Contributing**](#-contributing)

</div>

---

<div align="center">

<img src="assets/dock-preview.png" alt="The DockShift dock bar" width="92%" />

<sub>One translucent bar, floating above everything. Tap an icon — a panel slides out. Click away — it's gone.</sub>

</div>

<br/>

---

<div align="center">

### 📁 Save your desktop. Restore in one click.

<sub>Snapshot every open app, window, and layout — then put your full project back exactly where you left it.<br/>The one feature no other Windows tool ships out of the box.</sub>

<br/><br/>

<a href="https://vimeo.com/1192599015" title="Watch the 30-second workspace demo on Vimeo">
  <img src="assets/workspace.png" alt="DockShift workspace snapshots — click to watch the live demo" width="92%" />
</a>

<br/><br/>

<a href="https://vimeo.com/1192599015">
  <img src="https://img.shields.io/badge/▶%20WATCH%20IT%20LIVE-30%20second%20demo-7AA2F7?style=for-the-badge&labelColor=1A1B26&logo=vimeo&logoColor=white" alt="Watch the workspace demo on Vimeo" height="42" />
</a>

</div>

<br/>

---

## 🤔 Why DockShift?

You've got a clipboard manager, a launcher, a notes app, a terminal, an AI chat tab, and
a dozen browser windows open for *"that one doc."* Every tool lives somewhere else. Every
task is a context switch.

**DockShift collapses all of it into a single floating bar.** Hit `Ctrl + Shift + D` — it's
there. Click an icon — a clean, draggable, resizable panel appears. Click away — it disappears.
Your tools come to *you*.

> [!IMPORTANT]
> **Windows only.** DockShift hooks into Win32 window tracking and Windows clipboard
> internals — macOS and Linux aren't supported.

<br/>

## 🚀 What it does

<table>
<tr>
<td width="55%"><img src="assets/ai-assistant.png" alt="AI Assistant" width="100%" /></td>
<td width="45%">

### 🤖 Bring-Your-Own-Model AI

Chat with **Gemini, GPT, Claude, OpenRouter, or a local Ollama model** — switch providers
in a click, model lists fetched live. One-tap quick actions act on whatever's in your
clipboard: *explain code · write tests · fix an error · add types.* Streaming replies,
and keys are stored **encrypted by the OS keystore** — they never touch the renderer.

</td>
</tr>
<tr>
<td width="55%"><img src="assets/terminal.png" alt="Terminal" width="100%" /></td>
<td width="45%">

### 🖥️ A *Real* Terminal

A GPU-rendered terminal (`xterm.js` + WebGL, backed by `node-pty`) that actually pulls its
weight: **copy/paste keybindings, `Ctrl+F` scrollback search, clickable links, font zoom**,
and a **persistent session** that survives closing the panel. Clean Linux-style theme,
tmux-style status bar.

</td>
</tr>
<tr>
<td width="45%">

### 🎤 Voice to Text

Hit record, get a transcript — powered by your AI provider's speech model. Audio is
processed entirely in the main process, so your API key stays server-side.

</td>
<td width="55%"><img src="assets/voice-to-text.png" alt="Voice to Text" width="100%" /></td>
</tr>
<tr>
<td width="55%"><img src="assets/settings.png" alt="Settings" width="100%" /></td>
<td width="45%">

### ⚙️ Settings, Done Right

A clean, developer-grade control panel — theme, dock position, launch-on-startup, AI
provider & model, clipboard limits, shortcuts. Every preference persists across sessions.

</td>
</tr>
</table>

<br/>

### …and there's more

<table>
<tr>
<td width="33%">

#### 📋 Clipboard History
Persistent, system-wide, **type-aware** — text, images, files, links, and hex colors.
Filter by type, click to re-copy, click images for a fullscreen preview.

</td>
<td width="33%">

#### ⚡ Quick Launcher
Spotlight-style app launcher with fuzzy search across your Start Menu — now with **real
app icons**. Arrow keys to navigate, Enter to launch.

</td>
<td width="33%">

#### 📝 Quick Notes
A WYSIWYG rich-text editor — headings, lists, code blocks, checkboxes, blockquotes.
Pin the notes that matter to the top.

</td>
</tr>
<tr>
<td width="33%">

#### 📸 Screenshots
Capture the full screen or a single window. Saved, thumbnailed, and browsable — preview,
copy, or open in Explorer.

</td>
<td width="33%">

#### 🌐 Browser
A sandboxed `webview` with a URL bar, bookmarks, and history — perfect for a quick docs
lookup without leaving your flow.

</td>
<td width="33%">

#### 🎯 Floating Panels
Every panel is **draggable and resizable from any edge**. Drag the dock itself by the grip
handles. It all stays exactly where you put it.

</td>
</tr>
</table>

<br/>

## ⚡ Quick Start

> **Prerequisites** — [Node.js](https://nodejs.org/) 18+, Windows 10/11, and Windows build
> tools (`node-pty` compiles natively). For AI features, an API key for your provider of
> choice — or just run [Ollama](https://ollama.com/) locally, no key required.

```bash
# 1 — clone & install
git clone https://github.com/Salah-XD/dockshift.git
cd dockshift
npm install

# 2 — run it
npm run dev
```

That's it. The dock appears at the bottom of your screen — press `Ctrl + Shift + D` to
toggle it anytime.

**Add your AI provider** in **Settings → AI & Models** — paste a key (stored encrypted) or
pick Ollama for a fully local setup. _Optional:_ copy `.env.example` to `.env` for a
dev-time Gemini key.

> [!NOTE]
> **Installing the prebuilt `.exe` and Windows says "Unknown publisher"?** That's expected —
> DockShift is open source and not yet code-signed. A Microsoft cert costs ~$200/yr, so we're
> waiting until the first hundred installs to buy one. Click **More info** → **Run anyway**.
> Or read the source / build it yourself.

<details>
<summary><b>More commands</b></summary>

```bash
npm run dev:vite      # Vite dev server only (React HMR)
npm run dev:electron  # Electron only (expects Vite already running)
npm run build         # production renderer build → dist/
npm run dist          # Windows NSIS installer + portable build → release/
npm run dist:dir      # unpacked build (faster, for local testing)
```

> Packaging needs an app icon at `assets/icon.ico`. Tagged `v*` pushes also build releases
> via GitHub Actions.

</details>

<br/>

## 🏗️ Under the Hood

DockShift is an **Electron** app: a `node-pty`/Win32-powered **main process** for all
system access, and a **sandboxed React + Vite renderer** that talks to it only through an
allowlisted IPC bridge.

| Layer | Tech | Role |
|---|---|---|
| **Shell** | Electron 40 | Desktop runtime, system APIs, window tracking |
| **UI** | React 18 + Vite 5 | Component UI with instant HMR |
| **Terminal** | xterm.js + WebGL + node-pty | GPU-rendered embedded terminal |
| **AI** | Gemini · OpenAI · Claude · Ollama · OpenRouter | Multi-provider chat & transcription |
| **Panels** | re-resizable | Draggable, 8-way resizable containers |

```
dockshift/
├── electron-main.js     # main process — IPC, window mgmt, pty, AI providers
├── preload.js           # the secure, allowlisted main ↔ renderer bridge
├── electron-secrets.js  # OS-keystore-encrypted API key storage
└── src/
    ├── components/      # DockMenu + one *Panel.jsx per feature
    ├── components/ui/   # the shared design-system component library
    ├── hooks/           # panel drag + positioning
    ├── workspace/       # snapshot / window-tracking logic
    └── styles/          # design tokens + panel styles
```

<br/>

## 🔒 Built Secure

A floating dock with system-level access has to earn your trust:

| Measure | What it means |
|---|---|
| **Context isolation + sandbox** | The renderer has zero direct Node.js access |
| **Allowlisted IPC** | Every `invoke`/`send` channel is explicitly whitelisted in preload |
| **Encrypted secrets** | API keys live in the OS keystore — never in the renderer, never in git |
| **PTY env scrubbing** | Secret-looking environment variables are stripped from terminal sessions |
| **Injection-safe** | Shell calls use argument arrays; paths are validated against traversal |
| **Sandboxed webview** | The browser panel runs in an isolated partition, dangerous URL schemes blocked |

<br/>

## 🤝 Contributing

Pull requests are welcome — bug fixes, new panels, polish, all of it.

1. **Fork** the repo and branch off (`git checkout -b feature/your-idea`)
2. **Build** your thing — the renderer hot-reloads; main-process changes need a restart
3. **Open a PR** with a clear description

> **Good to know:** the project is ES Modules (`"type": "module"`), but `preload.js` is
> CommonJS (Electron requires it). `node-pty` needs native build tools on first install.

<br/>

## 📄 License

[MIT](LICENSE) — free to use, fork, and build on.

<br/>

---

<div align="center">

<sub>Built for people who keep too many windows open.</sub><br/>
<sub><b>DockShift</b> — because Alt+Tab is so last decade.</sub>

<br/><br/>

<sub>Powered by <a href="https://shineup.digital"><b>Shineup</b></a></sub>

</div>
