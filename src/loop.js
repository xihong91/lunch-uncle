import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

// OpenCode Go's OpenAI-compatible endpoint.
const LLM_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const LLM_MODEL = "glm-5.3-flash";

const LLM_TIMEOUT_MS = 20_000;
const MAX_ROUNDS = 8;

// Retry rate limits, server errors and network failures, with these waits.
const RETRY_DELAYS_MS = [500, 1500];

// History comes from the browser, so keep only plain chat turns and cap
// how much of it gets sent to the model.
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 2000;

const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages.
 */
export async function runLoop(history, message, env) {
  // If the Places key is missing, Uncle cannot search, so give a safe answer.
  if (!env.GOOGLE_PLACES_API_KEY) {
    return FALLBACK_REPLY;
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...sanitizeHistory(history),
    { role: "user", content: message },
  ];

  // One session id per turn, shared by every model call in this loop run,
  // so the OpenCode Go endpoint can route and cache consistently.
  const sessionId = crypto.randomUUID();

  let round = 0;
  while (round < MAX_ROUNDS) {
    const assistant = await callModel(messages, env, sessionId);

    // Drop malformed tool calls so they can't crash the loop or make the
    // next request invalid (every tool message needs a matching call id).
    const toolCalls = Array.isArray(assistant.tool_calls)
      ? assistant.tool_calls.filter((c) => c?.id && c?.function?.name)
      : [];
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls;
    } else {
      delete assistant.tool_calls;
    }
    messages.push(assistant);

    if (toolCalls.length === 0) {
      return assistant.content ?? "";
    }

    for (const call of toolCalls) {
      const args = parseArgs(call.function.arguments);
      console.log(`round ${round}: ${call.function.name}`, args);
      const result = await executeTool(call.function.name, args, env);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    round++;
  }

  return "Uncle tried too many times already. Ask something simpler.";
}

/**
 * Keep only well-formed user/assistant turns from client-supplied history,
 * trimmed to the most recent MAX_HISTORY_MESSAGES and MAX_HISTORY_CHARS each.
 * System and tool messages are dropped so a client can't rewrite the persona.
 */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({
      role,
      content: content.slice(0, MAX_HISTORY_CHARS),
    }));
}

/**
 * Call the model, retrying rate limits, server errors and network failures.
 */
async function callModel(messages, env, sessionId) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestCompletion(messages, env, sessionId);
    } catch (err) {
      if (!err.retryable || attempt >= RETRY_DELAYS_MS.length) {
        throw err;
      }
      console.warn(`model call failed, retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function requestCompletion(messages, env, sessionId) {
  let res;
  try {
    res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENCODE_API_KEY}`,
        "x-opencode-session": sessionId,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        tools: toolDefinitions,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err) {
    throw modelError(`LLM request failed: ${err.message}`, true);
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw modelError(`LLM returned ${res.status}: ${await res.text()}`, retryable);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw modelError("LLM returned a body that is not JSON", true);
  }

  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    const detail = JSON.stringify(data?.error ?? data).slice(0, 300);
    throw modelError(`LLM reply has no message: ${detail}`, true);
  }
  return message;
}

function modelError(text, retryable) {
  const err = new Error(text);
  err.retryable = retryable;
  return err;
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
