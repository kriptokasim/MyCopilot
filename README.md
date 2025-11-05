```markdown
# Personal Copilot Local (zip-ready)

This package is a single-user local "Copilot-like" app: file tree + Monaco editor + chat assistant capable of proposing file operations and applying them inside a local workspace.

What's included
- server.js — Node/Express server that proxies LLM calls (OpenAI or local Qwen), provides file API, preview/apply endpoints, streaming SSE, JSON repair fallback, diffs/hunks, and git commit & history.
- public/* — UI: Monaco editor, file tree, chat assistant, Markdown preview (copy code), CSV sheet view, diff preview modal, history modal.
- .env (placeholder) — set OPENAI_API_KEY or QWEN_URL
- zip.js / make-zip.sh / make-zip-windows.ps1 — scripts to create a zip excluding node_modules and .git
- package.json — includes dependencies. After unzipping run npm install.

Quickstart (recommended)
1. Save or unzip the project.
2. Install deps: `npm install`
3. Put your OpenAI key into `.env` (OPENAI_API_KEY) or set QWEN_URL for your local model.
4. Start: `npm start`
5. Open http://localhost:3000

Notes
- The .env file in this archive contains placeholder values. Replace OPENAI_API_KEY with your key before starting.
- The zip created by the included scripts will exclude node_modules to keep size small. After unzipping run `npm install`.
- For production use: add authentication, rate-limiting, and additional safety measures.
```