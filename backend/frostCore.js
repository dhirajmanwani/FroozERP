const crypto = require("crypto");

const FROST_ASSISTANT_NAME = "FROST";

const FROST_ENGINES = [
  "conversation",
  "voice",
  "business_intelligence",
  "reminder",
  "notification",
  "recommendation",
  "automation",
  "memory",
  "analytics",
  "action_execution",
];

const PROVIDERS = {
  openai: {
    key: "openai",
    label: "OpenAI",
    required: ["api_key", "model"],
    supportsStreaming: true,
    supportsVoice: true,
  },
  azure_openai: {
    key: "azure_openai",
    label: "Azure OpenAI",
    required: ["endpoint", "deployment", "api_key", "api_version"],
    supportsStreaming: true,
    supportsVoice: true,
  },
  anthropic: {
    key: "anthropic",
    label: "Anthropic Claude",
    required: ["api_key", "model"],
    supportsStreaming: true,
    supportsVoice: false,
  },
  ollama: {
    key: "ollama",
    label: "Local Ollama",
    required: ["base_url", "model"],
    supportsStreaming: true,
    supportsVoice: false,
  },
};

const DEFAULT_FROST_SETTINGS = {
  assistantName: FROST_ASSISTANT_NAME,
  providerKey: "deterministic",
  model: "",
  realtimeModel: "gpt-realtime",
  voice: "alloy",
  languageMode: "hindi_english_hinglish",
  enabled: false,
  streamingEnabled: true,
  cacheEnabled: true,
  voicePrepared: true,
  wakeWordEnabled: false,
  voiceActivityDetection: true,
  noiseSuppression: true,
  fullDuplexEnabled: true,
  maxInputTokens: 6000,
  maxOutputTokens: 1200,
  costAlertAmount: 500,
};

const TOKEN_PRICING_PER_1K = {
  openai: { input: 0, output: 0 },
  azure_openai: { input: 0, output: 0 },
  anthropic: { input: 0, output: 0 },
  ollama: { input: 0, output: 0 },
  deterministic: { input: 0, output: 0 },
};

const stableJson = (value) => JSON.stringify(value, Object.keys(value || {}).sort());

const hashPayload = (value) =>
  crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");

const estimateTokens = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return Math.max(1, Math.ceil(text.length / 4));
};

const estimateCost = ({ providerKey = "deterministic", inputTokens = 0, outputTokens = 0 }) => {
  const pricing = TOKEN_PRICING_PER_1K[providerKey] || TOKEN_PRICING_PER_1K.deterministic;
  return Number((((inputTokens / 1000) * pricing.input) + ((outputTokens / 1000) * pricing.output)).toFixed(6));
};

const maskProviderConfig = (config = {}) => {
  const masked = { ...config };
  for (const key of Object.keys(masked)) {
    if (/key|token|secret|password/i.test(key)) {
      masked[key] = masked[key] ? "configured" : "";
    }
  }
  return masked;
};

const classifyBusinessIntent = (question = "") => {
  const text = String(question || "").toLowerCase();
  if (/(cash|bank|drawer|till|counter cash|payable|receivable|position)/.test(text)) return "CASH_DRAWER";
  if (/(purchase tomorrow|what should i purchase|buy tomorrow|reorder|purchase quantity|purchase quantities)/.test(text)) return "PURCHASE_PLANNING";
  if (/(sale rate|selling rate|rate revision|revise.*rate|price revision|pricing)/.test(text)) return "SALE_RATE_REVIEW";
  if (/(loss|lose money|lost money|waste|expense|low margin|margin problem)/.test(text)) return "LOSS_REVIEW";
  if (/(profit.*month|most profit|top profit|generated.*profit)/.test(text)) return "PROFIT_RANKING";
  if (/(today.*sale|sales|revenue|profit|compare|month|last month|gross profit)/.test(text)) return "SALES_FINANCE";
  if (/(supplier.*bill|purchase bill|payment|pending|receivable|outstanding|ledger|customer.*pay|supplier.*pay)/.test(text)) return "PAYMENTS";
  if (/(customer.*recent|haven.?t purchased|inactive customer|not purchased)/.test(text)) return "CUSTOMER_ACTIVITY";
  if (/(expiry|expire|close to expiry|near expiry|old lot|lot aging|fruits close)/.test(text)) return "INVENTORY_EXPIRY";
  if (/(supplier.*margin|best margin|margin supplier)/.test(text)) return "SUPPLIER_MARGIN";
  if (/(low stock|stock|inventory|run out|waste|lowest-selling|highest-selling|fruit)/.test(text)) return "INVENTORY";
  return "BUSINESS_BRIEFING";
};

const actionRequiresApproval = (actionType = "") => {
  const readOnlyActions = new Set(["VIEW", "OPEN_LEDGER", "OPEN_REPORT", "OPEN_PRODUCT", "IGNORE"]);
  return !readOnlyActions.has(String(actionType || "").toUpperCase());
};

class FrostProviderRegistry {
  constructor() {
    this.providers = new Map(Object.values(PROVIDERS).map((provider) => [provider.key, provider]));
  }

  list() {
    return Array.from(this.providers.values()).map((provider) => ({
      key: provider.key,
      label: provider.label,
      required: provider.required,
      supportsStreaming: provider.supportsStreaming,
      supportsVoice: provider.supportsVoice,
    }));
  }

  resolve(providerKey) {
    return this.providers.get(providerKey) || null;
  }

  buildRuntime(settings = {}) {
    const providerKey = settings.providerKey || settings.provider_key || "deterministic";
    const provider = this.resolve(providerKey);
    if (!provider) {
      return {
        configured: false,
        providerKey: "deterministic",
        label: "Deterministic FROST",
        supportsStreaming: true,
        supportsVoice: false,
        async complete() {
          return null;
        },
        async *stream() {
          yield "";
        },
      };
    }
    return {
      configured: Boolean(settings.enabled),
      providerKey: provider.key,
      label: provider.label,
      supportsStreaming: provider.supportsStreaming,
      supportsVoice: provider.supportsVoice,
      async complete() {
        return null;
      },
      async *stream() {
        yield "";
      },
    };
  }
}

class FrostServiceLayer {
  constructor({ pool, providerRegistry = new FrostProviderRegistry() }) {
    this.pool = pool;
    this.providerRegistry = providerRegistry;
    this.engines = new Map(FROST_ENGINES.map((engine) => [engine, { key: engine, status: "READY" }]));
  }

  listEngines() {
    return Array.from(this.engines.values());
  }

  getProviderOptions() {
    return this.providerRegistry.list();
  }

  async getSettings() {
    const result = await this.pool.query("SELECT * FROM ai_settings WHERE id = 1");
    const row = result.rows[0] || {};
    const frost = { ...DEFAULT_FROST_SETTINGS, ...(row.frost_settings || {}) };
    const runtime = this.providerRegistry.buildRuntime(frost);
    return {
      thresholds: row.thresholds || {},
      frost,
      provider: {
        configured: runtime.configured,
        key: runtime.providerKey,
        name: runtime.label,
        supportsStreaming: runtime.supportsStreaming,
        supportsVoice: runtime.supportsVoice,
      },
      providers: this.getProviderOptions(),
      engines: this.listEngines(),
      cache: {
        enabled: frost.cacheEnabled !== false,
      },
    };
  }

  async updateSettings({ thresholds, frostSettings, updatedBy }) {
    const current = await this.getSettings();
    const nextFrost = { ...current.frost, ...(frostSettings || {}), assistantName: FROST_ASSISTANT_NAME };
    const result = await this.pool.query(
      `
      UPDATE ai_settings
      SET thresholds = COALESCE($1::jsonb, thresholds),
          frost_settings = $2::jsonb,
          ai_provider_enabled = $3,
          updated_by = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        thresholds ? JSON.stringify(thresholds) : null,
        JSON.stringify(nextFrost),
        nextFrost.enabled === true,
        updatedBy || null,
      ]
    );
    await this.audit({
      userId: updatedBy,
      eventType: "FROST_SETTINGS_UPDATED",
      answer: "FROST settings updated",
      suggestedAction: { providerKey: nextFrost.providerKey, streamingEnabled: nextFrost.streamingEnabled, cacheEnabled: nextFrost.cacheEnabled },
    });
    return result.rows[0];
  }

  buildCacheKey({ engine, question, facts, range, providerKey }) {
    return hashPayload({ engine, question, facts, range, providerKey });
  }

  async getCache(cacheKey) {
    const result = await this.pool.query(
      "SELECT * FROM ai_cache WHERE cache_key = $1 AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
      [cacheKey]
    );
    return result.rows[0] || null;
  }

  async setCache({ cacheKey, engine, providerKey, requestPayload, responsePayload, ttlMinutes = 30 }) {
    await this.pool.query(
      `
      INSERT INTO ai_cache (cache_key, engine_key, provider_key, request_hash, request_payload, response_payload, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, CURRENT_TIMESTAMP + ($7::TEXT || ' minutes')::interval)
      ON CONFLICT (cache_key)
      DO UPDATE SET response_payload = EXCLUDED.response_payload, expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP
      `,
      [cacheKey, engine, providerKey, hashPayload(requestPayload), JSON.stringify(requestPayload), JSON.stringify(responsePayload), ttlMinutes]
    );
  }

  async recordTokenUsage({ conversationId = null, engine, providerKey, model = "", inputPayload, outputText = "", cost = null }) {
    const inputTokens = estimateTokens(inputPayload);
    const outputTokens = estimateTokens(outputText);
    const estimatedCost = cost === null ? estimateCost({ providerKey, inputTokens, outputTokens }) : Number(cost || 0);
    await this.pool.query(
      `
      INSERT INTO ai_token_usage (conversation_id, engine_key, provider_key, model, input_tokens, output_tokens, estimated_cost)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [conversationId, engine, providerKey, model, inputTokens, outputTokens, estimatedCost]
    );
    return { inputTokens, outputTokens, estimatedCost };
  }

  async createActionProposal({
    conversationId = null,
    actionType,
    payload = {},
    proposedBy = null,
    approvalStatus,
  }) {
    const status = approvalStatus || (actionRequiresApproval(actionType) ? "PENDING_OWNER_APPROVAL" : "READ_ONLY");
    const result = await this.pool.query(
      `
      INSERT INTO ai_action_proposals (conversation_id, proposed_action, payload, approval_status, proposed_by)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      RETURNING *
      `,
      [conversationId, actionType, JSON.stringify(payload), status, proposedBy]
    );
    await this.audit({
      userId: proposedBy,
      eventType: "FROST_ACTION_PROPOSED",
      answer: `FROST proposed ${actionType}`,
      suggestedAction: { actionType, payload },
      approvalStatus: status,
    });
    return result.rows[0];
  }

  async createRealtimeSession({ userId, deviceId = "", providerKey = "openai", instructions = "" }) {
    const settings = await this.getSettings();
    const frost = settings.frost || DEFAULT_FROST_SETTINGS;
    const selectedProvider = providerKey || frost.providerKey || "openai";
    if (selectedProvider !== "openai") {
      return {
        configured: false,
        provider: selectedProvider,
        message: "Realtime voice is currently prepared for OpenAI-compatible providers only.",
      };
    }
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      await this.audit({
        userId,
        deviceId,
        eventType: "FROST_VOICE_SESSION_UNAVAILABLE",
        answer: "OpenAI Realtime voice requested without configured server API key",
      });
      return {
        configured: false,
        provider: "openai",
        message: "OpenAI Realtime voice is not configured on this server.",
      };
    }
    const payload = {
      session: {
        type: "realtime",
        model: frost.realtimeModel || "gpt-realtime",
        audio: {
          output: { voice: frost.voice || "alloy" },
          input: {
            turn_detection: frost.voiceActivityDetection === false ? null : { type: "server_vad" },
          },
        },
        instructions: instructions || "You are FROST, FroozERP's business copilot. Use concise Hindi, English, or Hinglish as the owner speaks. Never execute business actions without explicit owner confirmation.",
      },
    };
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      await this.audit({
        userId,
        deviceId,
        eventType: "FROST_VOICE_SESSION_FAILED",
        answer: `OpenAI Realtime session failed: ${response.status}`,
        suggestedAction: { status: response.status, body: text.slice(0, 400) },
      });
      return {
        configured: false,
        provider: "openai",
        message: "OpenAI Realtime session could not be created.",
        status: response.status,
      };
    }
    const body = await response.json();
    await this.audit({
      userId,
      deviceId,
      eventType: "FROST_VOICE_SESSION_CREATED",
      answer: "OpenAI Realtime voice session created",
      suggestedAction: { provider: "openai", model: frost.realtimeModel || "gpt-realtime" },
    });
    return {
      configured: true,
      provider: "openai",
      realtimeUrl: "https://api.openai.com/v1/realtime/calls",
      model: frost.realtimeModel || "gpt-realtime",
      voice: frost.voice || "alloy",
      clientSecret: body.value || body.client_secret?.value,
      expiresAt: body.expires_at || body.client_secret?.expires_at,
      vad: frost.voiceActivityDetection !== false,
      noiseSuppression: frost.noiseSuppression !== false,
      fullDuplex: frost.fullDuplexEnabled !== false,
      wakeWordEnabled: false,
    };
  }

  async audit({ userId = null, deviceId = "", eventType, question = "", verifiedFacts = [], answer = "", suggestedAction = {}, approvalStatus = "READ_ONLY" }) {
    await this.pool.query(
      `
      INSERT INTO ai_audit_log (company_id, branch_id, user_id, device_id, event_type, question, verified_facts, answer, suggested_action, approval_status)
      VALUES (1, 1, $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
      `,
      [userId, deviceId, eventType, question, JSON.stringify(verifiedFacts), answer, JSON.stringify(suggestedAction), approvalStatus]
    );
  }

  async getUsageSummary() {
    const result = await this.pool.query(
      `
      SELECT
        COALESCE(SUM(input_tokens), 0)::INTEGER AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::INTEGER AS output_tokens,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC AS estimated_cost,
        COUNT(*)::INTEGER AS request_count
      FROM ai_token_usage
      WHERE created_at >= CURRENT_DATE
      `
    );
    return result.rows[0] || { input_tokens: 0, output_tokens: 0, estimated_cost: 0, request_count: 0 };
  }
}

module.exports = {
  DEFAULT_FROST_SETTINGS,
  FROST_ASSISTANT_NAME,
  FROST_ENGINES,
  FrostProviderRegistry,
  FrostServiceLayer,
  actionRequiresApproval,
  classifyBusinessIntent,
  estimateCost,
  estimateTokens,
  maskProviderConfig,
};
