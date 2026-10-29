/*
 * Nyansi AI backend configuration.
 *
 * FREE MODE (current): answers come from the free, no-key Pollinations.AI
 * text API (https://pollinations.ai), which speaks the OpenAI chat format and
 * allows browser calls (CORS). Images come from Pollinations' image endpoint.
 * It is a shared community service: no SLA, rate limited, and models can change.
 *
 * TO UPGRADE: run your own small server (e.g. a Cloudflare Worker, Vercel or
 * Render function) that keeps your paid API key SECRET on the server and
 * exposes an OpenAI-compatible POST /chat endpoint. Then set:
 *   provider: "backend", chatEndpoint: "https://your-server.example/chat"
 * NEVER put an API key in this file — everything here is public.
 */
window.NYANSI_CONFIG = {
  provider: "pollinations",                       // "pollinations" | "backend"
  chatEndpoint: "https://text.pollinations.ai/openai",
  model: "openai",
  imageEndpoint: "https://image.pollinations.ai/prompt/",
  referrer: "nyansi",                             // identifies the app to Pollinations
  maxHistory: 16,                                 // messages sent as context
  // Free-plan daily limits (counted on this device) for the agent tools.
  freeLimits: { bot: 10, code: 30 }
};
