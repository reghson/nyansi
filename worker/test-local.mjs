// Local harness: node test-local.mjs   (needs GEMINI_API_KEY in env; never printed)
import worker, { toGemini } from "./worker.js";
const env = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, ALLOWED_ORIGINS: "https://reghson.github.io" };
const post = (body, origin = "https://reghson.github.io", ip = "1.2.3.4") => worker.fetch(new Request("http://x/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env);
const msgs = [{ role: "system", content: "You are Nyansi. Answer in one short sentence." }, { role: "user", content: "My name is Kofi." }, { role: "assistant", content: "Nice to meet you, Kofi!" }, { role: "user", content: "What is my name, and what is the capital of Ghana?" }];

console.log("conversion:", JSON.stringify(toGemini(msgs)).slice(0, 400));
let t = Date.now(), r = await post({ messages: msgs, model: "openai" });
const j = await r.json();
console.log("non-stream", r.status, (Date.now() - t) + "ms", "model=" + j.model, "CORS=" + r.headers.get("access-control-allow-origin"), "|", j.choices?.[0]?.message?.content?.trim(), "| finish=" + j.choices?.[0]?.finish_reason);

t = Date.now(); r = await post({ messages: [{ role: "user", content: "Count from 1 to 15 in words, comma separated." }], stream: true });
const reader = r.body.getReader(), dec = new TextDecoder(); let raw = "", firstAt = 0, n = 0;
for (;;) { const { value, done } = await reader.read(); if (done) break; if (!firstAt) firstAt = Date.now() - t; raw += dec.decode(value); }
let text = ""; for (const l of raw.split("\n")) if (l.startsWith("data: ") && l !== "data: [DONE]") { n++; text += JSON.parse(l.slice(6)).choices[0].delta.content || ""; }
console.log("stream", r.status, r.headers.get("content-type"), "first-chunk " + firstAt + "ms total " + (Date.now() - t) + "ms chunks=" + n, "endsWithDONE=" + raw.trim().endsWith("[DONE]"), "|", text.trim());

r = await post({ messages: msgs }, "https://evil.example"); console.log("bad origin ->", r.status);
r = await post({ messages: msgs }, "http://localhost:8080"); console.log("localhost ->", r.status, r.headers.get("access-control-allow-origin")); await r.text();
r = await worker.fetch(new Request("http://x/chat", { method: "OPTIONS", headers: { Origin: "https://reghson.github.io" } }), env); console.log("preflight ->", r.status, r.headers.get("access-control-allow-methods"));
r = await post({ messages: [{ role: "user", content: "x".repeat(70000) }] }); console.log("too big ->", r.status);
r = await post({ foo: 1 }); console.log("no messages ->", r.status);
let codes = []; for (let i = 0; i < 32; i++) { const rr = await worker.fetch(new Request("http://x/health"), env); } // health not limited
for (let i = 0; i < 31; i++) { const rr = await post({ foo: 1 }, undefined, "9.9.9.9"); codes.push(rr.status); }
console.log("rate limit: request 31 ->", codes.at(-1));
