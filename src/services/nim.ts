// One place for talking to NVIDIA NIM's chat-completions endpoint.
// Both the slip parser and the chat assistant go through here so the two
// hard-won NIM lessons apply everywhere: the endpoint intermittently returns
// an empty completion (retry fixes it), and prefill queueing can stall a
// request for a minute (so every call carries an abort timeout).

export interface NimTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface NimToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NimMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: NimToolCall[];
  tool_call_id?: string;
}

export interface NimChatResult {
  content: string | null;
  toolCalls: NimToolCall[];
}

interface NimChatOptions {
  tools?: NimTool[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  /**
   * Per-attempt abort timeout. Default 45s: the whole update gets ~55s of
   * lifetime (25s held request + ~30s waitUntil grace), so one slow attempt
   * must leave room to finish the rest of the flow.
   */
  timeoutMs?: number;
  /**
   * Absolute wall-clock cutoff (epoch ms). No attempt is started — or given
   * an abort window — that would still be running at this instant, so the
   * loop throws in time for the caller's catch to edit the status bubble
   * before the runtime cancels the update (~80s total, see index.ts).
   */
  deadline?: number;
  /** Index into the model chain (see nimModelList) to start the rotation
   * from, wrapping around. Used by nimChatHedged so its two racers sit in
   * two different NIM queues. Defaults to 0 (start of the chain). */
  startIndex?: number;
}

/**
 * The fallback chain, in priority order, read from the single comma-separated
 * NIM_MODELS var in wrangler.jsonc — one line to edit when a catalog ID dies,
 * with no code change and no fixed number of slots. Models die often: two of
 * the four entries chosen on 2026-08-02 were end-of-lifed by 2026-08-07, so
 * the list is ordered by measured health and re-tested when it changes.
 * Blank entries and stray whitespace are dropped rather than sent as models.
 */
export function nimModelList(env: Env): string[] {
  return (env.NIM_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

/**
 * Models to rotate through across attempts, starting at `startIndex` and
 * wrapping. Different models sit in different queues on NVIDIA's side —
 * observed 2026-07-08: every qwen/qwen3.5 request stalled past its 45s
 * timeout while openai/gpt-oss-120b answered the same prompts in ~3s.
 * Rotating means one jammed queue costs one attempt, not the whole flow.
 */
function modelRotation(env: Env, startIndex: number): string[] {
  const models = nimModelList(env);
  if (models.length === 0) return [];
  const offset = startIndex % models.length;
  return [...models.slice(offset), ...models.slice(0, offset)];
}

/**
 * Two nimChat calls raced — first usable answer wins. One racer starts on the
 * first model in the chain, the other on the second, so they sit in two
 * different NIM queues at every attempt: a stalled queue (measured 46s vs 5s
 * for the same prompt) or a fully jammed model no longer blocks the answer.
 * The second racer used to start halfway down the list, which broke once the
 * chain was ordered by health on 2026-08-11 — the back half is the unhealthy
 * half by construction, so that racer began on a model known to fail and
 * contributed nothing. The top two are the two best-measured models, which is
 * what a race actually wants. The caller's `transform` runs inside the race: if it
 * throws (e.g. truncated JSON — observed from gpt-oss-120b, whose hidden
 * reasoning eats the token budget), that racer loses and the twin's answer
 * is awaited instead of being discarded. Only for small deterministic calls
 * (the slip parse); the losing call keeps running until the update's
 * lifetime ends and is discarded.
 */
export async function nimChatHedged<T>(
  env: Env,
  messages: NimMessage[],
  options: NimChatOptions,
  transform: (res: NimChatResult) => T,
): Promise<T> {
  // 1, not half the list: see the note above. Falls back to 0 (both racers on
  // the same model) only if the chain somehow holds a single entry.
  const second = nimModelList(env).length > 1 ? 1 : 0;
  try {
    return await Promise.any([
      nimChat(env, messages, options).then(transform),
      nimChat(env, messages, { ...options, startIndex: second }).then(transform),
    ]);
  } catch (err) {
    throw err instanceof AggregateError ? err.errors[0] : err;
  }
}

/**
 * Chat call with the standard guardrails: one attempt per model in the
 * fallback chain, treating an empty completion (no content AND no tool
 * calls) as a failure worth retrying. Throws after the last attempt.
 */
export async function nimChat(env: Env, messages: NimMessage[], options: NimChatOptions = {}): Promise<NimChatResult> {
  const { tools, toolChoice, maxTokens = 2048, timeoutMs = 45_000, deadline, startIndex = 0 } = options;
  const models = modelRotation(env, startIndex);
  let lastError: unknown;

  // Cap the whole retry loop, not just each attempt: one queued 45s attempt
  // must not be followed by another that the runtime kills mid-flight —
  // throwing here lets the caller still send its "try again" message.
  const started = Date.now();
  let retryDelay = 300;
  for (let attempt = 0; attempt < models.length; attempt++) {
    if (attempt > 0 && Date.now() - started > 60_000) break;
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay));
    // Clamp the attempt to what the deadline leaves (minus a margin for the
    // caller's error reply); under 3s an attempt has no realistic chance.
    const attemptTimeout = deadline ? Math.min(timeoutMs, deadline - Date.now() - 2_000) : timeoutMs;
    if (attemptTimeout < 3_000) break;
    const model = models[attempt % models.length];
    const attemptStarted = Date.now();
    try {
      const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0,
          ...(tools ? { tools, tool_choice: toolChoice ?? "auto" } : {}),
        }),
        signal: AbortSignal.timeout(attemptTimeout),
      });
      if (!res.ok) {
        throw new Error(`NIM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: NimToolCall[] }; finish_reason?: string }[];
        usage?: { completion_tokens?: number };
      };
      const message = data.choices?.[0]?.message;
      const content = message?.content ?? null;
      const toolCalls = message?.tool_calls ?? [];
      if (!content && toolCalls.length === 0) {
        throw new Error(
          `NIM response had no content (finish_reason=${data.choices?.[0]?.finish_reason}, completion_tokens=${data.usage?.completion_tokens})`,
        );
      }
      console.error(
        JSON.stringify({ event: "nim_chat_attempt_ok", attempt, model, ms: Date.now() - attemptStarted }),
      );
      return { content, toolCalls };
    } catch (err) {
      lastError = err;
      // 429 = this key's rate window for *that model* is full. The next
      // attempt is always a different model (the loop never revisits one), and
      // a fresh model's window is usable immediately — measured 2026-08-26: 4
      // simultaneous requests split across two models all answered. So this
      // pause is only a stagger, to stop two concurrent album slips from
      // rotating onto the same next model in lockstep; it is deliberately
      // short, because every second here comes out of the shared parse budget.
      retryDelay = String(err).includes("NIM API 429") ? 750 : 300;
      console.error(JSON.stringify({ event: "nim_chat_attempt_failed", attempt, model, error: String(err) }));
    }
  }
  throw new Error(`NIM chat failed: ${String(lastError ?? "no time left before the deadline")}`);
}
