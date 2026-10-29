# Nyansi — all-in-one AI assistant

**Nyansi** (from the Twi word *nyansa*, "wisdom") is an all-in-one AI assistant website and installable app (PWA): AI chat, image creation, writing and coding help, and story/video ideas in one place.

- Website: `index.html` (landing page, features, Free / Pro / Max pricing — paid tiers are "coming soon", no payments collected)
- App: `app/` (chat UI with saved conversations, markdown, modes, dark/light theme, mobile layout)
- PWA: `manifest.json` + `sw.js` — installs on Android, iPhone and desktop from the browser

## AI backend
`app/config.js` controls the backend.

- **Current (free):** [Pollinations.AI](https://pollinations.ai) — free, no API key, OpenAI-compatible text endpoint (`https://text.pollinations.ai/openai`) and image endpoint (`https://image.pollinations.ai/prompt/...`). It is a shared community service: rate-limited, no uptime guarantee, models may change.
- **Upgrade:** deploy a small server (Cloudflare Worker / Vercel / Render) that keeps your paid API key **on the server** and exposes an OpenAI-compatible `POST /chat`. Set `provider: "backend"` and `chatEndpoint` to that URL. **Never put API keys in this repo** — it is public and everything here runs in the browser.

## Run locally
```
python3 -m http.server 8080
```
Then open http://localhost:8080/
