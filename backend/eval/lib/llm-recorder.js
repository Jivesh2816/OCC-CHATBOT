// Instruments the app's shared Groq client for a live eval run, without
// changing what the app sees:
//   - records every call: which stage made it, latency, token usage, errors
//   - inspects raw model output for malformed results (router JSON that won't
//     parse or names an unknown intent; tool calls to tools that don't exist
//     or with arguments that aren't JSON) — the app silently recovers from
//     these, so without this they'd never show up in a metric
//   - paces calls under a tokens-per-minute budget (Groq's free tier is 8k/min)
//   - notes rate-limit errors so the harness can retry the case rather than
//     score a model outage as a model mistake
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function stageOf(params) {
  if (params.tools) return 'action';
  if (params.response_format?.type === 'json_object') {
    return /intent router/i.test(params.messages?.[0]?.content || '') ? 'router' : 'json';
  }
  return 'answer';
}

// Rough prompt-size estimate (≈4 chars/token) plus the completion budget, used
// only to decide whether to wait before sending. Actual usage replaces it.
function estimateTokens(params) {
  const chars = (params.messages || []).reduce((n, m) => n + String(m.content || '').length, 0) + JSON.stringify(params.tools || '').length;
  return Math.ceil(chars / 4) + Math.min(params.max_tokens || 512, 900);
}

function createPacer(tokensPerMinute) {
  const window = [];
  const prune = () => { const cutoff = Date.now() - 60_000; while (window.length && window[0].t < cutoff) window.shift(); };
  const used = () => window.reduce((sum, e) => sum + e.tokens, 0);
  let blockedUntil = 0;
  return {
    async reserve(estimate) {
      for (;;) {
        if (Date.now() < blockedUntil) { await sleep(blockedUntil - Date.now()); continue; }
        prune();
        if (!window.length || used() + estimate <= tokensPerMinute) {
          const entry = { t: Date.now(), tokens: estimate };
          window.push(entry);
          return entry;
        }
        await sleep(Math.max(250, window[0].t + 60_000 - Date.now() + 50));
      }
    },
    settle(entry, actual) { if (entry && typeof actual === 'number') entry.tokens = actual; },
    blockFor(ms) { blockedUntil = Math.max(blockedUntil, Date.now() + ms); }
  };
}

function inspectOutput(stage, message, { validIntents, toolNames }) {
  const problems = [];
  if (stage === 'router') {
    try {
      const parsed = JSON.parse(message?.content || '');
      if (!validIntents.includes(parsed.intent)) problems.push(`router returned unknown intent "${parsed.intent}"`);
    } catch {
      problems.push('router returned invalid JSON');
    }
  }
  if (stage === 'action') {
    for (const call of message?.tool_calls || []) {
      if (!toolNames.includes(call.function?.name)) problems.push(`hallucinated tool "${call.function?.name}"`);
      try {
        const args = JSON.parse(call.function?.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) problems.push(`non-object arguments for ${call.function?.name}`);
      } catch {
        problems.push(`unparseable arguments for ${call.function?.name}`);
      }
    }
  }
  return problems;
}

function retryAfterMs(error) {
  const header = error?.headers?.['retry-after'] ?? error?.headers?.get?.('retry-after');
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

// Wraps groq.chat.completions.create in place. Returns a recorder whose
// `calls` array the harness resets per case.
function instrument(groq, { tokensPerMinute = 7000, validIntents, toolNames }) {
  const original = groq.chat.completions.create.bind(groq.chat.completions);
  const pacer = createPacer(tokensPerMinute);
  const recorder = { calls: [], pacer, restore: () => { groq.chat.completions.create = original; } };

  groq.chat.completions.create = async function instrumentedCreate(params, options) {
    const stage = stageOf(params);
    const call = { stage, model: params.model, ms: null, waitMs: 0, usage: null, error: null, malformed: [] };
    recorder.calls.push(call);
    // Time spent waiting on the eval's own rate pacing isn't latency a student
    // would see; it's recorded so the harness can subtract it from stage timings.
    const waitStarted = Date.now();
    const reservation = await pacer.reserve(estimateTokens(params));
    call.waitMs = Date.now() - waitStarted;
    const started = Date.now();
    try {
      const result = await original(params, options);
      if (!params.stream) {
        call.ms = Date.now() - started;
        call.usage = result.usage ? { input: result.usage.prompt_tokens, output: result.usage.completion_tokens } : null;
        pacer.settle(reservation, result.usage?.total_tokens);
        call.malformed = inspectOutput(stage, result.choices?.[0]?.message, { validIntents, toolNames });
        // Raw tool calls as the model wrote them, before the app parses/clamps them.
        if (stage === 'action') call.toolCalls = (result.choices?.[0]?.message?.tool_calls || []).map(tc => ({ name: tc.function?.name, arguments: tc.function?.arguments }));
        return result;
      }
      // Streamed answers: pass chunks through, pick up usage from the last one.
      return (async function* passThrough() {
        try {
          for await (const chunk of result) {
            const usage = chunk.x_groq?.usage || chunk.usage;
            if (usage) {
              call.usage = { input: usage.prompt_tokens, output: usage.completion_tokens };
              pacer.settle(reservation, usage.total_tokens);
            }
            yield chunk;
          }
        } catch (error) {
          call.error = { status: error?.status ?? null, message: String(error?.message || error).slice(0, 200) };
          throw error;
        } finally {
          call.ms = Date.now() - started;
        }
      })();
    } catch (error) {
      call.ms = Date.now() - started;
      call.error = { status: error?.status ?? null, message: String(error?.message || error).slice(0, 200) };
      // Groq's JSON mode rejects output that isn't valid JSON with a 400. That's
      // the model failing, not the infrastructure: score it, don't retry it.
      if (error?.status === 400 && /validate JSON|json_validate_failed/i.test(call.error.message)) {
        call.malformed.push(`${stage} output rejected by the provider's JSON validation`);
      }
      if (error?.status === 429) {
        call.error.retryAfterMs = retryAfterMs(error);
        pacer.blockFor(call.error.retryAfterMs || 20_000);
      }
      throw error;
    }
  };
  return recorder;
}

// Rate limits, server errors and network failures say nothing about the
// model's quality; the harness retries those and excludes cases that keep
// failing. Anything else (e.g. a 400 for invalid JSON) is a real output failure.
function isInfraError(call) {
  const status = call.error?.status;
  return !!call.error && (status === null || status === undefined || status === 429 || status >= 500);
}

module.exports = { instrument, stageOf, inspectOutput, createPacer, isInfraError };
