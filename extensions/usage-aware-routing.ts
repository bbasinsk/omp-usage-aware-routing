import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REFRESH_MS = 30 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const RESERVE_FRACTION = 0.1;
const CACHE_PATH = process.env.OMP_USAGE_ROUTING_CACHE ?? join(homedir(), ".omp", "cache", "usage-routing.json");
const STRATEGY_PATH = process.env.OMP_USAGE_ROUTING_STRATEGY
  ?? join(homedir(), ".omp", "cache", "usage-routing-strategy.json");
const LOCK_PATH = `${CACHE_PATH}.lock`;
const ROUTING_HEADER = "## Live provider quota for subagent routing";

type PaceSnapshot = {
  calculatedAt: number;
  timeRemainingMs?: number;
  timeRemainingFraction?: number;
  deficitFraction?: number;
  surplusFraction?: number;
};

type UsageWindow = {
  provider: string;
  id: string;
  label: string;
  scope: string;
  windowId?: string;
  tier?: string;
  modelId?: string;
  shared?: boolean;
  sharedGroup?: string;
  durationMs?: number;
  resetsAt?: number;
  remainingFraction: number;
  usedFraction: number;
  status: string;
  paceAtRefresh?: PaceSnapshot;
};

type UsageSnapshot = {
  version: 4;
  refreshedAt: number;
  sourceGeneratedAt: number;
  windows: UsageWindow[];
  resetCredits: Record<string, number>;
};

type ResolvedModel = {
  provider: string;
  id: string;
};

type AgentRoute = {
  name: string;
  modelSelectors: string[];
};

type QuotaStrategy =
  | { version: 1; mode: "balanced"; updatedAt: number }
  | { version: 1; mode: "targeted"; provider: string; updatedAt: number };

type RoutingStrategy = QuotaStrategy | { version: 1; mode: "quality"; updatedAt: number };

const DEFAULT_STRATEGY: QuotaStrategy = { version: 1, mode: "balanced", updatedAt: 0 };

const QUALITY_INSTRUCTION = `${ROUTING_HEADER}
Active strategy: quality. Quota data is intentionally omitted. Pick the best-fitting model for each subagent task on capability alone; ignore quota pressure and cost. Still match model strength to the task: a stronger model is best only when it improves the result.`;

type BeforeAgentStartEvent = {
  systemPrompt: string[];
};

type BeforeAgentStartContext = {
  cwd: string;
  models: {
    resolve(spec: string): ResolvedModel | undefined;
  };
};

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type ToolCallResult = {
  block?: boolean;
  reason?: string;
};

type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
};

const STRATEGY_MODE_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: "balanced", label: "balanced", description: "Balance task suitability with quota pressure" },
  { value: "quality", label: "quality", description: "Pick the best model for each task, ignoring quota" },
  { value: "targeted", label: "targeted", description: "Prefer one subscription provider" },
];

type StrategyCommandContext = {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
};

type PiApi = {
  getActiveTools(): string[];
  exec(command: string, args: string[], options?: Record<string, unknown>): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    killed?: boolean;
  }>;
  logger?: { warn(message: string, details?: Record<string, unknown>): void };
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, ctx: BeforeAgentStartContext) => Promise<unknown> | unknown,
  ): void;
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: BeforeAgentStartContext) => Promise<ToolCallResult | undefined> | ToolCallResult | undefined,
  ): void;
  registerCommand(
    name: "quota-strategy",
    options: {
      description: string;
      handler: (args: string, ctx: StrategyCommandContext) => Promise<void> | void;
      getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
    },
  ): void;
  setLabel(label: string): void;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fraction(amount: Record<string, unknown>, name: "used" | "remaining"): number | undefined {
  const direct = finiteNumber(amount[`${name}Fraction`]);
  if (direct !== undefined) return clamp01(direct);
  const value = finiteNumber(amount[name]);
  const limit = finiteNumber(amount.limit);
  return value !== undefined && limit && limit > 0 ? clamp01(value / limit) : undefined;
}

function scopeLabel(
  provider: string,
  id: string,
  tier?: string,
  modelId?: string,
  sharedGroup?: string,
): string {
  // Codex's unscoped default meter and separately-scoped Spark meter are
  // indistinguishable without their provider ids. Every other provider uses
  // normalized model/tier/group metadata and needs no extension change.
  if (provider === "openai-codex") return tier === "spark" || /:spark:/i.test(id) ? "Spark" : "Chat";
  if (modelId) return `model=${modelId}`;
  if (tier) return `tier=${tier}`;
  if (sharedGroup) return `group=${sharedGroup}`;
  return "shared";
}

export function normalizeUsage(payload: unknown, refreshedAt = Date.now()): UsageSnapshot {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const reports = Array.isArray(root.reports) ? root.reports : [];
  const windows: UsageWindow[] = [];
  const resetCredits: Record<string, number> = {};

  for (const rawReport of reports) {
    if (!rawReport || typeof rawReport !== "object") continue;
    const report = rawReport as Record<string, unknown>;
    const provider = typeof report.provider === "string" ? report.provider : undefined;
    if (!provider) continue;
    const credits = report.resetCredits && typeof report.resetCredits === "object"
      ? report.resetCredits as Record<string, unknown>
      : undefined;
    const availableCount = finiteNumber(credits?.availableCount);
    if (availableCount !== undefined && availableCount >= 0) {
      resetCredits[provider] = (resetCredits[provider] ?? 0) + Math.floor(availableCount);
    }
    if (!Array.isArray(report.limits)) continue;

    for (const rawLimit of report.limits) {
      if (!rawLimit || typeof rawLimit !== "object") continue;
      const limit = rawLimit as Record<string, unknown>;
      const amount = limit.amount && typeof limit.amount === "object"
        ? limit.amount as Record<string, unknown>
        : {};
      const remainingFraction = fraction(amount, "remaining");
      const usedFraction = fraction(amount, "used") ?? (remainingFraction === undefined ? undefined : 1 - remainingFraction);
      if (remainingFraction === undefined || usedFraction === undefined) continue;

      const scope = limit.scope && typeof limit.scope === "object"
        ? limit.scope as Record<string, unknown>
        : {};
      const window = limit.window && typeof limit.window === "object"
        ? limit.window as Record<string, unknown>
        : {};
      const id = typeof limit.id === "string" ? limit.id : `${provider}:${windows.length}`;
      const tier = typeof scope.tier === "string" ? scope.tier : undefined;
      const modelId = typeof scope.modelId === "string" ? scope.modelId : undefined;
      const sharedGroup = typeof scope.sharedGroup === "string" ? scope.sharedGroup : undefined;

      const normalized: UsageWindow = {
        provider,
        id,
        label: typeof limit.label === "string" ? limit.label : id,
        scope: scopeLabel(provider, id, tier, modelId, sharedGroup),
        windowId: typeof scope.windowId === "string" ? scope.windowId : undefined,
        tier,
        modelId,
        shared: typeof scope.shared === "boolean" ? scope.shared : undefined,
        sharedGroup,
        durationMs: finiteNumber(window.durationMs),
        resetsAt: finiteNumber(window.resetsAt),
        remainingFraction,
        usedFraction,
        status: typeof limit.status === "string" ? limit.status : "unknown",
      };
      normalized.paceAtRefresh = {
        calculatedAt: refreshedAt,
        ...calculatePace(normalized, refreshedAt),
      };
      windows.push(normalized);
    }
  }

  windows.sort((a, b) => a.provider.localeCompare(b.provider) || a.scope.localeCompare(b.scope) || a.label.localeCompare(b.label));
  return {
    version: 4,
    refreshedAt,
    sourceGeneratedAt: finiteNumber(root.generatedAt) ?? refreshedAt,
    windows,
    resetCredits,
  };
}

export function calculatePace(window: UsageWindow, now = Date.now()): Omit<PaceSnapshot, "calculatedAt"> {
  if (window.durationMs === undefined || window.resetsAt === undefined || window.durationMs <= 0) {
    return {
      timeRemainingMs: undefined,
      timeRemainingFraction: undefined,
      deficitFraction: undefined,
      surplusFraction: undefined,
    };
  }
  const timeRemainingMs = Math.max(0, window.resetsAt - now);
  const timeRemainingFraction = clamp01(timeRemainingMs / window.durationMs);
  const balance = window.remainingFraction - timeRemainingFraction;
  return {
    timeRemainingMs,
    timeRemainingFraction,
    deficitFraction: Math.max(0, -balance),
    surplusFraction: Math.max(0, balance),
  };
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `${days}d${hours}h`;
  if (hours) return `${hours}h${mins}m`;
  return `${mins}m`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function paceText(window: UsageWindow, now: number): string {
  const pace = calculatePace(window, now);
  if (pace.deficitFraction === undefined || pace.surplusFraction === undefined) return "pace unknown";
  if (pace.deficitFraction >= 0.001) return `${percent(pace.deficitFraction)} deficit`;
  if (pace.surplusFraction >= 0.001) return `${percent(pace.surplusFraction)} ahead`;
  return "on pace";
}
type QuotaScope = {
  provider: string;
  scope: string;
  deficitFraction: number;
  headroomFraction: number;
  reserveReached: boolean;
  paceUnknown: boolean;
};

function compareQuota(
  left: QuotaScope,
  right: QuotaScope,
  strategy: QuotaStrategy,
  resetCredits: Record<string, number>,
): number {
  const targeted = (quota: QuotaScope) =>
    strategy.mode === "targeted"
    && quota.provider === strategy.provider
    && (!quota.reserveReached || (resetCredits[strategy.provider] ?? 0) > 0);
  return Number(targeted(right)) - Number(targeted(left))
    || Number(left.reserveReached) - Number(right.reserveReached)
    || Number(left.paceUnknown) - Number(right.paceUnknown)
    || left.deficitFraction - right.deficitFraction
    || right.headroomFraction - left.headroomFraction
    || left.provider.localeCompare(right.provider)
    || left.scope.localeCompare(right.scope);
}

function strategyName(strategy: QuotaStrategy): string {
  return strategy.mode === "balanced" ? "Balanced" : `Targeted ${strategy.provider}`;
}

export function buildQuotaScopeOrder(
  snapshot: UsageSnapshot,
  now = Date.now(),
  strategy: QuotaStrategy = DEFAULT_STRATEGY,
): string | undefined {
  const grouped = new Map<string, UsageWindow[]>();
  for (const window of snapshot.windows) {
    const key = `${window.provider}\u0000${window.scope}`;
    const group = grouped.get(key);
    if (group) group.push(window);
    else grouped.set(key, [window]);
  }

  const scopes: QuotaScope[] = [];
  for (const windows of grouped.values()) {
    const pace = windows.map(window => calculatePace(window, now));
    const knownDeficits = pace.flatMap(value => value.deficitFraction === undefined ? [] : [value.deficitFraction]);
    scopes.push({
      provider: windows[0]!.provider,
      scope: windows[0]!.scope,
      deficitFraction: knownDeficits.length ? Math.max(...knownDeficits) : Number.POSITIVE_INFINITY,
      headroomFraction: Math.min(...windows.map(window => window.remainingFraction)),
      reserveReached: windows.some(window =>
        window.remainingFraction <= RESERVE_FRACTION || window.status !== "ok"
      ),
      paceUnknown: knownDeficits.length !== windows.length,
    });
  }

  scopes.sort((left, right) => compareQuota(left, right, strategy, snapshot.resetCredits));
  if (!scopes.length) return undefined;

  const order = scopes.map(scope => {
    const deficit = scope.paceUnknown ? "pace unknown" : `${percent(scope.deficitFraction)} deficit`;
    const reserve = scope.reserveReached ? ", reserve reached" : "";
    return `${scope.provider}/${scope.scope} [${deficit}, ${percent(scope.headroomFraction)} left${reserve}]`;
  });
  return `${strategyName(strategy)} provider/scope order (${strategy.mode === "balanced" ? "advisory quota ranking; not a model-selection order" : "left to right; apply only after capability fit"}): ${order.join(" > ")}`;
}
type AgentQuota = QuotaScope & {
  agent: string;
};

export function selectAgentRoutes(
  agents: unknown[],
  disabledAgents: readonly string[],
  isReadOnlyAgent: (agent: unknown) => boolean,
): AgentRoute[] {
  const routes: AgentRoute[] = [];
  for (const value of agents) {
    if (!value || typeof value !== "object" || isReadOnlyAgent(value)) continue;
    const agent = value as Record<string, unknown>;
    if (typeof agent.name !== "string" || disabledAgents.includes(agent.name)) continue;
    const selectors = Array.isArray(agent.model)
      ? agent.model.filter((selector): selector is string => typeof selector === "string")
      : [];
    routes.push({ name: agent.name, modelSelectors: selectors.length ? selectors : ["@task"] });
  }
  return routes;
}

async function discoverAgentRoutes(cwd: string, logger: PiApi["logger"]): Promise<AgentRoute[]> {
  try {
    // Runtime-only import: the standalone OMP binary provides this module to
    // extensions, while keeping this file independently testable with Bun.
    const loaded: unknown = await import("@oh-my-pi/pi-coding-agent/task");
    if (!loaded || typeof loaded !== "object") return [];
    const taskModule = loaded as Record<string, unknown>;
    if (typeof taskModule.discoverAgents !== "function" || typeof taskModule.isReadOnlyAgent !== "function") return [];
    const discoverAgents = taskModule.discoverAgents as (cwd: string) => Promise<unknown>;
    const isReadOnlyAgent = taskModule.isReadOnlyAgent as (agent: unknown) => boolean;
    const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { cfgTaskDisabledAgents } = await import("@oh-my-pi/pi-coding-agent/task/settings");
    const settings = findScopedSettings(cwd);
    if (!settings) throw new Error("Active session settings unavailable");
    const disabledAgents = cfgTaskDisabledAgents.get(settings);
    const discovered: unknown = await discoverAgents(cwd);
    if (!discovered || typeof discovered !== "object" || !(("agents" in discovered))) return [];
    const agents = discovered.agents;
    if (!Array.isArray(agents)) return [];

    return selectAgentRoutes(agents, disabledAgents, isReadOnlyAgent);
  } catch (error) {
    logger?.warn("usage-aware routing agent discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function applicableWindows(snapshot: UsageSnapshot, model: ResolvedModel): { scope: string; windows: UsageWindow[] } {
  const providerWindows = snapshot.windows.filter(window => window.provider === model.provider);
  if (model.provider === "openai-codex") {
    const scope = /spark/i.test(model.id) ? "Spark" : "Chat";
    return { scope, windows: providerWindows.filter(window => window.scope === scope) };
  }

  const modelId = model.id.toLowerCase();
  const general = providerWindows.filter(window => !window.modelId && !window.tier);
  const specific = providerWindows.filter(window =>
    window.modelId?.toLowerCase() === modelId
    || (window.tier !== undefined && modelId.includes(window.tier.toLowerCase()))
  );
  const windows = specific.length ? [...general, ...specific] : general;
  return {
    scope: [...new Set(windows.map(window => window.scope))].join("+") || "unknown",
    windows,
  };
}

function evaluateAgentQuotas(
  snapshot: UsageSnapshot,
  agents: AgentRoute[],
  resolveModel: (spec: string) => ResolvedModel | undefined,
  now: number,
): AgentQuota[] {
  const candidates: AgentQuota[] = [];
  for (const agent of agents) {
    const model = agent.modelSelectors.map(resolveModel).find((value): value is ResolvedModel => value !== undefined);
    if (!model) continue;
    const applicable = applicableWindows(snapshot, model);
    if (!applicable.windows.length) continue;
    const pace = applicable.windows.map(window => calculatePace(window, now));
    const knownDeficits = pace.flatMap(value => value.deficitFraction === undefined ? [] : [value.deficitFraction]);
    candidates.push({
      agent: agent.name,
      provider: model.provider,
      scope: applicable.scope,
      deficitFraction: knownDeficits.length ? Math.max(...knownDeficits) : Number.POSITIVE_INFINITY,
      headroomFraction: Math.min(...applicable.windows.map(window => window.remainingFraction)),
      reserveReached: applicable.windows.some(window =>
        window.remainingFraction <= RESERVE_FRACTION || window.status !== "ok"
      ),
      paceUnknown: knownDeficits.length !== applicable.windows.length,
    });
  }
  return candidates;
}

export function buildAgentQuotaOrder(
  snapshot: UsageSnapshot,
  agents: AgentRoute[],
  resolveModel: (spec: string) => ResolvedModel | undefined,
  now = Date.now(),
  strategy: QuotaStrategy = DEFAULT_STRATEGY,
): string | undefined {
  const candidates = evaluateAgentQuotas(snapshot, agents, resolveModel, now);

  candidates.sort((left, right) =>
    compareQuota(left, right, strategy, snapshot.resetCredits)
    || left.agent.localeCompare(right.agent)
  );
  if (!candidates.length) return undefined;

  const groups: Array<AgentQuota & { agents: string[] }> = [];
  for (const candidate of candidates) {
    const previous = groups.at(-1);
    if (
      previous
      && previous.provider === candidate.provider
      && previous.scope === candidate.scope
      && previous.deficitFraction === candidate.deficitFraction
      && previous.headroomFraction === candidate.headroomFraction
      && previous.reserveReached === candidate.reserveReached
      && previous.paceUnknown === candidate.paceUnknown
    ) {
      previous.agents.push(candidate.agent);
    } else {
      groups.push({ ...candidate, agents: [candidate.agent] });
    }
  }

  const order = groups.map(group => {
    const deficit = group.paceUnknown ? "pace unknown" : `${percent(group.deficitFraction)} deficit`;
    const reserve = group.reserveReached ? ", reserve reached" : "";
    return `${group.agents.join("/")} [${group.provider}/${group.scope}: ${deficit}, ${percent(group.headroomFraction)} left${reserve}]`;
  });
  return `${strategyName(strategy)} live-agent order (${strategy.mode === "balanced" ? "advisory quota ranking; not a model-selection order" : "left to right; apply only after capability fit"}): ${order.join(" > ")}`;
}

const QUOTA_EXCEPTION_MARKER = "[quota-route-exception:";

export function quotaStrategyViolation(
  snapshot: UsageSnapshot,
  agents: AgentRoute[],
  resolveModel: (spec: string) => ResolvedModel | undefined,
  input: Record<string, unknown>,
  strategy: RoutingStrategy,
  now = Date.now(),
): string | undefined {
  if (strategy.mode !== "targeted") return undefined;

  const candidates = evaluateAgentQuotas(snapshot, agents, resolveModel, now);
  const context = typeof input.context === "string" ? input.context : "";
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [input];

  for (const rawTask of rawTasks) {
    if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) continue;
    const task = rawTask as Record<string, unknown>;
    const instructions = `${context}\n${typeof task.task === "string" ? task.task : ""}`.toLowerCase();
    if (instructions.includes(QUOTA_EXCEPTION_MARKER)) continue;
    const agent = typeof task.agent === "string" && task.agent.trim() ? task.agent.trim() : "task";
    const selected = candidates.find(candidate => candidate.agent === agent);
    if (!selected) continue;

    const healthy = candidates.filter(candidate =>
      candidate.agent !== agent
      && !candidate.reserveReached
      && !candidate.paceUnknown
      && candidate.deficitFraction < 0.001
    );
    let alternatives: AgentQuota[] = [];
    const credits = snapshot.resetCredits[strategy.provider] ?? 0;
    if (selected.provider !== strategy.provider) {
      alternatives = candidates.filter(candidate =>
        candidate.provider === strategy.provider
        && (!candidate.reserveReached || credits > 0)
      );
    } else if (selected.reserveReached && credits === 0) {
      alternatives = healthy;
    }
    if (!alternatives.length) continue;

    alternatives.sort((left, right) =>
      compareQuota(left, right, strategy, snapshot.resetCredits)
      || left.agent.localeCompare(right.agent)
    );
    const names = [...new Set(alternatives.map(candidate => candidate.agent))].slice(0, 8);
    return `Quota strategy targeted (${strategy.provider}) rejected agent ${agent}. Retry with a capable option from: ${names.join(", ")}. If none satisfies required specialization or the user explicitly requested ${agent}, retry with ${QUOTA_EXCEPTION_MARKER} required specialization] in the task context.`;
  }
  return undefined;
}

export function buildRoutingInstruction(
  snapshot: UsageSnapshot,
  now = Date.now(),
  quotaScopeOrder?: string,
  agentQuotaOrder?: string,
  strategy: QuotaStrategy = DEFAULT_STRATEGY,
): string {
  const ageMs = Math.max(0, now - snapshot.refreshedAt);
  const stale = ageMs >= REFRESH_MS ? "; stale" : "";
  const rows = snapshot.windows.map(window => {
    const pace = calculatePace(window, now);
    const reserve = window.remainingFraction <= RESERVE_FRACTION ? "; reserve reached" : "";
    return `- ${window.provider} [${window.scope}] ${window.label}: ${percent(window.remainingFraction)} left; resets in ${formatDuration(pace.timeRemainingMs)}; ${paceText(window, now)}${reserve}`;
  });
  const resetCredits = Object.entries(snapshot.resetCredits)
    .filter(([, count]) => count > 0)
    .map(([provider, count]) => `${provider}=${count}`)
    .join(", ");
  const strategyPolicy = strategy.mode === "balanced"
    ? "Balanced strategy: weigh task suitability and quota pressure together. Prefer healthier quota routes for routine or well-specified work when expected results are comparable. Prefer the stronger-fitting model when its capabilities are likely to materially improve correctness, judgment, or completeness, or reduce rework. Do not downgrade solely because another route has a lower deficit or appears earlier in the quota order. Likewise, do not choose a stronger model without a task-specific benefit. Treat quota pressure as a reason to conserve capacity, not an automatic veto; treat the displayed order as advisory. Handle exhaustion and reserve restrictions separately."
    : `Targeted strategy: capability and required specialization still set the eligible task agents, then MUST prefer ${strategy.provider} even when it is at a pace deficit. Within ${strategy.provider}, prefer the strongest eligible model when it can materially improve the result; do not down-tier merely to conserve its quota. Fall back off-target only when no eligible target agent exists, the target is unavailable, or it has reached the 10% reserve with no saved reset credits.`;

  return [
    ROUTING_HEADER,
    `Automatic shared snapshot; provider usage refreshes when older than 30 minutes (age ${formatDuration(ageMs)}${stale}). Do not run or parse \`omp usage\` yourself.`,
    `Active strategy: ${strategy.mode === "balanced" ? "balanced" : `targeted (${strategy.provider})`}.`,
    ...(resetCredits ? [`Saved reset credits: ${resetCredits}.`] : []),
    ...rows,
    ...(quotaScopeOrder ? [quotaScopeOrder] : []),
    ...(agentQuotaOrder ? [agentQuotaOrder] : []),
    "The live-agent order is resolved from current project/user/plugin/bundled agent definitions and their model selectors; never infer a stale allowlist.",
    strategyPolicy,
    ...(strategy.mode === "targeted" ? [
      `A task call that violates the targeted strategy is rejected before spawning. Retry with a listed capable agent, or add ${QUOTA_EXCEPTION_MARKER} required specialization] to that task's instructions when specialization or an explicit user choice must override quota routing.`,
    ] : []),
    "Scope: shared rows apply provider-wide; model/tier/group rows apply to matching models. Codex Chat and Spark are a narrow explicit exception because upstream omits that distinction from its default scope metadata. Missing limits are unknown; never invent them.",
  ].join("\n");
}

function isUsageWindow(value: unknown): value is UsageWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.provider === "string"
    && typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && typeof candidate.scope === "string"
    && typeof candidate.remainingFraction === "number"
    && Number.isFinite(candidate.remainingFraction)
    && typeof candidate.usedFraction === "number"
    && Number.isFinite(candidate.usedFraction)
    && typeof candidate.status === "string";
}

function isResetCreditMap(value: unknown): value is Record<string, number> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every(count => typeof count === "number" && Number.isFinite(count) && count >= 0);
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 4
    && typeof candidate.refreshedAt === "number"
    && Number.isFinite(candidate.refreshedAt)
    && typeof candidate.sourceGeneratedAt === "number"
    && Number.isFinite(candidate.sourceGeneratedAt)
    && Array.isArray(candidate.windows)
    && candidate.windows.every(isUsageWindow)
    && isResetCreditMap(candidate.resetCredits);
}

function isRoutingStrategy(value: unknown): value is RoutingStrategy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt)) return false;
  if (candidate.mode === "balanced" || candidate.mode === "quality") return true;
  return candidate.mode === "targeted"
    && typeof candidate.provider === "string"
    && candidate.provider.length > 0;
}

async function readStrategy(): Promise<RoutingStrategy> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STRATEGY_PATH, "utf8"));
    return isRoutingStrategy(parsed) ? parsed : DEFAULT_STRATEGY;
  } catch {
    return DEFAULT_STRATEGY;
  }
}

function readSnapshotSync(): UsageSnapshot | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    return isUsageSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function completeQuotaStrategy(
  argumentPrefix: string,
  snapshot: UsageSnapshot | undefined = readSnapshotSync(),
): AutocompleteItem[] | null {
  const input = argumentPrefix.trimStart();
  if (!input.includes(" ")) {
    const normalized = input.toLowerCase();
    const modes = STRATEGY_MODE_COMPLETIONS.filter(item => item.value.startsWith(normalized));
    return modes.length ? modes.map(item => ({ ...item })) : null;
  }

  const targeted = /^targeted\s+(\S*)$/i.exec(input);
  if (!targeted || !snapshot) return null;
  const providerPrefix = targeted[1]!.toLowerCase();
  const providers = [...new Set([
    ...snapshot.windows.map(window => window.provider),
    ...Object.keys(snapshot.resetCredits),
  ])].sort();
  const matches = providers
    .filter(provider => provider.toLowerCase().startsWith(providerPrefix))
    .map(provider => {
      const credits = snapshot.resetCredits[provider] ?? 0;
      return {
        value: `targeted ${provider}`,
        label: provider,
        description: credits
          ? `${credits} saved reset credit${credits === 1 ? "" : "s"}`
          : "Target this subscription provider",
      };
    });
  return matches.length ? matches : null;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function configureStrategy(args: string, ctx: StrategyCommandContext, pi: PiApi): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const current = await readStrategy();
    ctx.ui.notify(
      current.mode === "targeted"
        ? `Quota strategy: targeted (${current.provider})`
        : `Quota strategy: ${current.mode}`,
      "info",
    );
    return;
  }

  if ((parts[0] === "balanced" || parts[0] === "quality") && parts.length === 1) {
    await writeJsonAtomically(STRATEGY_PATH, { version: 1, mode: parts[0], updatedAt: Date.now() });
    ctx.ui.notify(`Quota strategy set to ${parts[0]}.`, "info");
    return;
  }

  if (parts[0] === "targeted" && parts.length <= 2) {
    const snapshot = await sharedUsage(pi);
    const providers = snapshot
      ? [...new Set(snapshot.windows.map(window => window.provider))].sort()
      : [];
    const requested = parts[1];
    const provider = requested
      ? providers.find(candidate => candidate.toLowerCase() === requested.toLowerCase())
      : await ctx.ui.select("Target subscription provider", providers);
    if (!provider) {
      ctx.ui.notify(
        providers.length
          ? `Choose a provider: ${providers.join(", ")}`
          : "No providers with usage data are available.",
        "warning",
      );
      return;
    }
    await writeJsonAtomically(STRATEGY_PATH, {
      version: 1,
      mode: "targeted",
      provider,
      updatedAt: Date.now(),
    });
    const credits = snapshot?.resetCredits[provider] ?? 0;
    ctx.ui.notify(
      `Quota strategy set to targeted (${provider})${credits ? ` with ${credits} saved reset credit${credits === 1 ? "" : "s"}` : ""}.`,
      "info",
    );
    return;
  }

  ctx.ui.notify("Usage: /quota-strategy balanced | quality | targeted [provider]", "warning");
}

async function readSnapshot(): Promise<UsageSnapshot | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    return isUsageSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function needsRefresh(snapshot: UsageSnapshot | undefined, now: number): boolean {
  if (!snapshot || now - snapshot.refreshedAt >= REFRESH_MS) return true;
  return snapshot.windows.some(window => window.resetsAt !== undefined && window.resetsAt <= now);
}

async function acquireLock(now: number): Promise<boolean> {
  await mkdir(dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
  try {
    await mkdir(LOCK_PATH);
    return true;
  } catch (error) {
    if (!error || typeof error !== "object" || !(("code" in error)) || error.code !== "EEXIST") throw error;
  }

  try {
    const lockStat = await stat(LOCK_PATH);
    if (now - lockStat.mtimeMs < LOCK_STALE_MS) return false;
    await rm(LOCK_PATH, { recursive: true, force: true });
    await mkdir(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

async function writeSnapshot(snapshot: UsageSnapshot): Promise<void> {
  await writeJsonAtomically(CACHE_PATH, snapshot);
}

let refreshInFlight: Promise<UsageSnapshot | undefined> | undefined;

async function loadUsage(pi: PiApi): Promise<UsageSnapshot | undefined> {
  const cached = await readSnapshot();
  const now = Date.now();
  if (!needsRefresh(cached, now)) return cached;
  if (!(await acquireLock(now))) return cached;

  try {
    const result = await pi.exec("omp", ["usage", "--json"]);
    if (result.killed || result.code !== 0) throw new Error(result.stderr || `omp usage exited ${result.code}`);
    const snapshot = normalizeUsage(JSON.parse(result.stdout));
    await writeSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    pi.logger?.warn("usage-aware routing refresh failed", { error: error instanceof Error ? error.message : String(error) });
    return cached;
  } finally {
    await rm(LOCK_PATH, { recursive: true, force: true }).catch(() => {});
  }
}

function sharedUsage(pi: PiApi): Promise<UsageSnapshot | undefined> {
  if (!refreshInFlight) refreshInFlight = loadUsage(pi).finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

export default function usageAwareRouting(pi: PiApi) {
  pi.setLabel("Usage-aware subagent routing");
  pi.registerCommand("quota-strategy", {
    description: "Show or change balanced/quality/targeted subagent quota routing",
    getArgumentCompletions: argumentPrefix => completeQuotaStrategy(argumentPrefix),
    handler: (args, ctx) => configureStrategy(args, ctx, pi),
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!pi.getActiveTools().includes("task")) return;
    const strategy = await readStrategy();
    if (strategy.mode === "quality") {
      return {
        systemPrompt: [...event.systemPrompt.filter(part => !part.startsWith(ROUTING_HEADER)), QUALITY_INSTRUCTION],
      };
    }
    const snapshot = await sharedUsage(pi);
    if (!snapshot?.windows.length) return;
    const now = Date.now();
    const quotaScopeOrder = buildQuotaScopeOrder(snapshot, now, strategy);
    const agents = await discoverAgentRoutes(ctx.cwd, pi.logger);
    const agentQuotaOrder = buildAgentQuotaOrder(snapshot, agents, spec => ctx.models.resolve(spec), now, strategy);
    return {
      systemPrompt: [
        ...event.systemPrompt.filter(part => !part.startsWith(ROUTING_HEADER)),
        buildRoutingInstruction(snapshot, now, quotaScopeOrder, agentQuotaOrder, strategy),
      ],
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return;
    const strategy = await readStrategy();
    if (strategy.mode !== "targeted") return;
    const snapshot = await sharedUsage(pi);
    if (!snapshot?.windows.length) return;
    const agents = await discoverAgentRoutes(ctx.cwd, pi.logger);
    const reason = quotaStrategyViolation(
      snapshot,
      agents,
      spec => ctx.models.resolve(spec),
      event.input,
      strategy,
    );
    return reason ? { block: true, reason } : undefined;
  });
}
