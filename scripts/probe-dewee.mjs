#!/usr/bin/env bun
// Sends one real message to the Zuey AI agent through the Dewee gateway using the
// production client (src/lib/ai/dewee-client.ts) and prints only the streamed reply
// and timings. Requires Bun (it imports the TypeScript client directly).
//
//   bun scripts/probe-dewee.mjs ["your question"]
//
// Env: DEWEE_GATEWAY_URL, DEWEE_GATEWAY_TOKEN, optional DEWEE_AGENT_KEY (default zuey-ai).
// Falls back to GOCLAW_GATEWAY_URL / GOCLAW_GATEWAY_TOKEN used by the dewee CLI.
// The URL and token are never printed.
import { resolveDeweeConfig, streamChat } from '../src/lib/ai/dewee-client.ts';

const env = {
  DEWEE_GATEWAY_URL: process.env.DEWEE_GATEWAY_URL || process.env.GOCLAW_GATEWAY_URL,
  DEWEE_GATEWAY_TOKEN: process.env.DEWEE_GATEWAY_TOKEN || process.env.GOCLAW_GATEWAY_TOKEN,
  DEWEE_AGENT_KEY: process.env.DEWEE_AGENT_KEY,
};

let config;
try {
  config = resolveDeweeConfig(env);
} catch (err) {
  console.error(`[probe] ${err.code ?? 'error'}: ${err.message}`);
  process.exit(2);
}

const message = process.argv[2] || 'Xin chào! Bạn là ai và bạn giúp được gì trên zuey.me? Trả lời ngắn gọn.';
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

const started = performance.now();
let firstDeltaMs = null;
let deltas = 0;
let exitCode = 0;
console.log(`[probe] agent=${config.agentKey} message=${JSON.stringify(message)}`);
for await (const event of streamChat(config, {
  userId: 'probe',
  chatSessionId: `probe-${Date.now()}`,
  message,
  signal: controller.signal,
})) {
  if (event.type === 'delta') {
    if (firstDeltaMs === null) firstDeltaMs = performance.now() - started;
    deltas += 1;
    process.stdout.write(event.text);
  } else if (event.type === 'tool') {
    console.log(`\n[probe] tool ${event.phase}: ${event.name}`);
  } else if (event.type === 'done') {
    const total = performance.now() - started;
    const usage = event.usage ? ` tokens=${event.usage.promptTokens}+${event.usage.completionTokens}` : '';
    console.log(
      `\n[probe] done cancelled=${event.cancelled} deltas=${deltas} first_delta_ms=${firstDeltaMs?.toFixed(0) ?? '-'} total_ms=${total.toFixed(0)}${usage}`,
    );
  } else if (event.type === 'error') {
    console.error(`\n[probe] error ${event.code} retryable=${event.retryable}: ${event.message}`);
    exitCode = 1;
  }
}
process.exit(exitCode);
