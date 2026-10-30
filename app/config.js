/*
 * Nyansi AI backend configuration. NEVER put an API key in this file — it is public.
 *
 * provider "backend": answers come from Nyansi's own Cloudflare Worker (worker/),
 * which keeps the Google Gemini key secret on the server and speaks the OpenAI
 * chat format at POST /chat. Fast (usually ~1 s).
 * If the backend is down or busy, the app automatically falls back to the free,
 * no-key Pollinations.AI text API (fallbackEndpoint) so chat keeps working.
 *
 * Backend: Cloudflare Worker "nyansi-api" on the reghson1 workers.dev subdomain.
 * If chatEndpoint ever contains "<", the app skips it and uses Pollinations only.
 */
window.NYANSI_CONFIG = {
  provider: "backend",                            // "backend" | "pollinations"
  chatEndpoint: "https://nyansi-api.reghson1.workers.dev/chat",
  backendTimeoutMs: 25000,                        // give up on the backend after this, then fall back
  fallbackEndpoint: "https://text.pollinations.ai/openai",
  fallbackModel: "openai",
  imageEndpoint: "https://image.pollinations.ai/prompt/",
  referrer: "nyansi",                             // identifies the app to Pollinations
  maxHistory: 16,                                 // messages sent as context
  // Free-plan daily limits (counted on this device) for the agent tools.
  freeLimits: { bot: 10, code: 30 },
  // Nyansi Create runs on the same backend: POST /image, /video, /tts, /storyboard, GET /limits.
  // The real daily limits are enforced by the backend, per device and per network.
  // A video clip is one 5-second AI scene; a 20-second video uses 4 clips.
  mediaEndpoint: "https://nyansi-api.reghson1.workers.dev",
  mediaLimits: { image: 20, video: 10, voice: 15 }
};
