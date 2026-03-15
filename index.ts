import * as fs from "fs";
import * as path from "path";

/**
 * Smart Model Router — 20-Watt Principle (3-Tier)
 *
 * Classifies incoming messages using keyword pre-filters + local LLM (Ollama)
 * and routes to the appropriate model:
 *   - simple  → Haiku   (greetings, confirmations, trivial)
 *   - medium  → Sonnet  (default: code, file ops, normal questions)
 *   - complex → Opus    (strategy, architecture, vision, deep analysis)
 *
 * Fail-safe: if Ollama is down or classification fails, no override is applied
 * and the default model (Sonnet) handles the request.
 */

// --- Fast keyword pre-filter ---
// These patterns strongly indicate complexity (skip Ollama call)
const OPUS_KEYWORDS =
  /\b(strategie|vision|architektur|konzept|philosophie|grundsätzlich|langfristig|world.?model|trade.?off|pro.*contra)\b/i;

// These patterns strongly indicate simplicity (skip Ollama call)
const SIMPLE_FAST =
  /^(ja|nein|ok|danke|gut|passt|mach|guten morgen|morgen|gn8|hi|hey|jo|klar|genau|stimmt|richtig|cool|super|nice|perfekt|alles klar|bin da|logo|hallo|moin|thx|thanks|bye|tschüss|ciao)[\s!.]*$/i;

// Media/image messages need vision → Opus
const HAS_MEDIA = /\[media attached|image data removed/i;

const CLASSIFY_PROMPT = `Classify the user message as simple, medium, or complex. ONE word only.

simple = greetings, confirmations, thanks, yes/no, trivial chitchat
medium = factual lookups, file operations, status checks, code tasks, tool usage, deployments, summaries, reviews, analysis of specific things
complex = architecture decisions, strategy, vision, deep multi-step analysis, creative writing with depth, system design, trade-off evaluation, long-form planning

Respond with ONLY one word: simple, medium, or complex`;

type Tier = "simple" | "medium" | "complex";

async function classifyWithOllama(
  prompt: string,
  ollamaBase: string,
  model: string,
  timeoutMs: number
): Promise<Tier> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${ollamaBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: `${CLASSIFY_PROMPT}\n\nMessage: ${prompt.slice(0, 500)}`,
          },
        ],
        stream: false,
        options: {
          temperature: 0,
          num_predict: 5,
        },
      }),
      signal: controller.signal,
    });

    const data = await res.json();
    const answer = (data.message?.content || "").trim().toLowerCase();

    if (answer.includes("complex")) return "complex";
    if (answer.includes("simple")) return "simple";
    return "medium";
  } catch {
    // Ollama down, timeout, or error → fail-safe: no override (Sonnet)
    return "medium";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the actual user message from the prompt, stripping OpenClaw metadata.
 * The prompt typically looks like:
 *   Conversation info (untrusted metadata):\n```json\n{...}\n```\n\nSender (untrusted metadata):\n```json\n{...}\n```\n\nActual message here
 * We also strip "Replied message" blocks.
 */
function extractUserMessage(prompt: string): string {
  let msg = prompt;

  // Strip "Conversation info (untrusted metadata):" JSON blocks
  msg = msg.replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "");

  // Strip "Sender (untrusted metadata):" JSON blocks
  msg = msg.replace(/Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "");

  // Strip "Replied message (untrusted, for context):" JSON blocks
  msg = msg.replace(/Replied message \(untrusted,? for context\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "");

  return msg.trim();
}

// --- Sticky routing patterns ---
// Short follow-up messages that should inherit the previous tier
const FOLLOW_UP =
  /^(ja|nein|ok|mach|mach das|genau|stimmt|richtig|und jetzt|weiter|next|dann|go|los|mach weiter|ja bitte|nein danke|ja mach|ok mach|passt|gut|klar)[\s!?.]*$/i;

// Model name shortcuts for /router lock commands
const MODEL_ALIASES: Record<string, { model: string; provider: string }> = {
  opus: { model: "claude-opus-4-6", provider: "anthropic" },
  sonnet: { model: "claude-sonnet-4-6", provider: "anthropic" },
  haiku: { model: "claude-haiku-4-5", provider: "anthropic" },
};

export default function register(api: any) {
  const cfg = api.config ?? {};
  const ollamaBase = cfg.ollamaBase ?? "http://localhost:11434";
  const classifyModel = cfg.classifyModel ?? "ministral-3:8b-cloud";
  const stateFile = cfg.stateFile ?? path.join(
    process.env.HOME || "/tmp",
    ".openclaw",
    "extensions",
    "smart-router",
    "state.json"
  );
  const simpleModel = cfg.simpleModel ?? "claude-haiku-4-5";
  const simpleProvider = cfg.simpleProvider ?? "anthropic";
  const complexModel = cfg.complexModel ?? "claude-opus-4-6";
  const complexProvider = cfg.complexProvider ?? "anthropic";
  const enabled = cfg.enabled ?? true;
  const logRouting = cfg.logRouting ?? true;
  const timeoutMs = cfg.timeoutMs ?? 3000;
  const stickyDecayMs = (cfg.stickyDecayMinutes ?? 5) * 60_000;

  // In-memory state for sticky routing (per chat)
  const lastRouting = new Map<string, { tier: Tier; timestamp: number }>();

  api.on(
    "before_model_resolve",
    async (event: any) => {
      if (!enabled) return undefined;

      const rawPrompt = (event.prompt || "").trim();
      if (!rawPrompt) return undefined;

      // Strip metadata to get the actual user message
      const userMessage = extractUserMessage(rawPrompt);
      if (!userMessage) return undefined;

      // Handle /router commands FIRST (before state file check)
      // so commands work even when router is disabled
      const routerCmd = userMessage.match(/^\/router\s+(off|on|lock\s+(\w+)|unlock|status)\s*$/i);
      if (routerCmd) {
        const cmd = routerCmd[1].toLowerCase();
        try {
          let state: any = {};
          try { state = JSON.parse(await fs.promises.readFile(stateFile, "utf-8")); } catch {}

          if (cmd === "off") {
            state.enabled = false;
            delete state.lockedModel;
            delete state.lockedProvider;
          } else if (cmd === "on") {
            state.enabled = true;
            delete state.lockedModel;
            delete state.lockedProvider;
          } else if (cmd === "unlock") {
            delete state.lockedModel;
            delete state.lockedProvider;
            state.enabled = true;
          } else if (cmd.startsWith("lock")) {
            const modelName = routerCmd[2]?.toLowerCase();
            const alias = MODEL_ALIASES[modelName];
            if (alias) {
              state.lockedModel = alias.model;
              state.lockedProvider = alias.provider;
              state.enabled = true;
            }
          } else if (cmd === "status") {
            const mode = state.enabled === false
              ? "DISABLED"
              : state.lockedModel
                ? `LOCKED → ${state.lockedModel}`
                : "AUTO (3-tier routing)";
            api.logger?.info(`[smart-router] STATUS: ${mode} | classifyModel=${classifyModel} | stickyDecay=${cfg.stickyDecayMinutes ?? 5}min | stateFile=${stateFile}`);
            return undefined;
          }

          await fs.promises.writeFile(stateFile, JSON.stringify(state, null, 2));
          if (logRouting) {
            api.logger?.info(`[smart-router] /router ${cmd} → state updated: ${JSON.stringify(state)}`);
          }
        } catch (e: any) {
          if (logRouting) {
            api.logger?.info(`[smart-router] /router command failed: ${e.message}`);
          }
        }
        // Don't override model for the command message itself
        return undefined;
      }

      // Respect manual model overrides via state file
      // Since OpenClaw's plugin API doesn't expose /model overrides on the
      // event object, we use a local state file that can be toggled via
      // messages like "/router off", "/router on", "/router lock opus"
      try {
        const stateRaw = await fs.promises.readFile(stateFile, "utf-8");
        const state = JSON.parse(stateRaw);
        if (state.enabled === false) {
          if (logRouting) {
            api.logger?.info(`[smart-router] router disabled via state file, skipping`);
          }
          return undefined;
        }
        if (state.lockedModel) {
          if (logRouting) {
            api.logger?.info(`[smart-router] model locked to ${state.lockedModel} via state file`);
          }
          return {
            modelOverride: state.lockedModel,
            providerOverride: state.lockedProvider || "anthropic",
          };
        }
      } catch {
        // State file doesn't exist or is invalid → router runs normally
      }

      // Chat ID for sticky routing (fallback to "default")
      const chatId: string = event.chatId || event.chat_id || "default";

      let decision: Tier;
      let method: string;

      // --- Layer 0: Sticky routing for follow-ups ---
      // If the message is a short follow-up and there's a recent routing
      // decision, inherit the previous tier (don't downgrade Opus to Haiku
      // just because the user said "ja mach das")
      const prev = lastRouting.get(chatId);
      const isFollowUp = FOLLOW_UP.test(userMessage);
      const isSticky = prev
        && isFollowUp
        && prev.tier !== "simple"
        && (Date.now() - prev.timestamp) < stickyDecayMs;

      if (isSticky) {
        decision = prev!.tier;
        method = `sticky-${prev!.tier}`;
      }
      // --- Layer 1: Fast keyword filter (no Ollama call needed) ---
      // Very short confirmations/greetings (only if NOT a follow-up to a complex conversation)
      else if (SIMPLE_FAST.test(userMessage) && !isFollowUp) {
        decision = "simple";
        method = "keyword-fast";
      }
      // Greetings that are never follow-ups (standalone simple)
      else if (/^(guten morgen|morgen|gn8|hi|hey|hallo|moin|bye|tschüss|ciao|thx|thanks)[\s!.]*$/i.test(userMessage)) {
        decision = "simple";
        method = "keyword-greeting";
      }
      // Media attached → Opus (vision)
      else if (HAS_MEDIA.test(rawPrompt)) {
        decision = "complex";
        method = "media-detected";
      }
      // Strong complexity keywords
      else if (OPUS_KEYWORDS.test(userMessage)) {
        decision = "complex";
        method = "keyword-complex";
      }
      // Very short messages without question mark → simple
      else if (userMessage.length < 20 && !userMessage.includes("?") && !isFollowUp) {
        decision = "simple";
        method = "short-message";
      }
      // Short follow-up without previous context → medium (safe default)
      else if (isFollowUp && !prev) {
        decision = "medium";
        method = "followup-no-context";
      }
      // --- Layer 2: Ollama classification for ambiguous cases ---
      else {
        decision = await classifyWithOllama(
          userMessage,
          ollamaBase,
          classifyModel,
          timeoutMs
        );
        method = "ollama";
      }

      // Update sticky state
      lastRouting.set(chatId, { tier: decision, timestamp: Date.now() });

      if (logRouting) {
        const preview = userMessage.slice(0, 60).replace(/\n/g, " ");
        api.logger?.info(
          `[smart-router] "${preview}..." → ${decision} (${method})`
        );
      }

      // Route based on tier
      if (decision === "simple") {
        return {
          modelOverride: simpleModel,
          providerOverride: simpleProvider,
        };
      }
      if (decision === "complex") {
        return {
          modelOverride: complexModel,
          providerOverride: complexProvider,
        };
      }

      // medium → no override, uses default model (Sonnet)
      return undefined;
    },
    { priority: 50 }
  );
}
