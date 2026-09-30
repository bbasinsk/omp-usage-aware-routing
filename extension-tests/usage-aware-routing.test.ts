import { describe, expect, test } from "bun:test";
import {
  buildAgentQuotaOrder,
  buildQuotaScopeOrder,
  calculatePace,
  completeQuotaStrategy,
  normalizeUsage,
  quotaStrategyViolation,
  selectAgentRoutes,
} from "../extensions/usage-aware-routing";

const NOW = Date.UTC(2026, 8, 15, 12);
const HOUR = 60 * 60 * 1000;

describe("usage-aware routing", () => {
  test("calculates pace deficit and strips account identity", () => {
    const snapshot = normalizeUsage({
      generatedAt: NOW,
      reports: [{
        provider: "anthropic",
        metadata: { email: "private@example.com" },
        limits: [{
          id: "anthropic:7d:fable",
          label: "Claude 7 Day (Fable)",
          scope: { provider: "anthropic", tier: "fable", accountId: "secret-account" },
          window: { durationMs: 100 * HOUR, resetsAt: NOW + 60 * HOUR },
          amount: { usedFraction: 0.6, remainingFraction: 0.4 },
          status: "ok",
        }],
      }],
    }, NOW);

    const pace = calculatePace(snapshot.windows[0]!, NOW);
    expect(pace.timeRemainingMs).toBe(60 * HOUR);
    expect(pace.deficitFraction).toBeCloseTo(0.2);
    expect(pace.surplusFraction).toBe(0);
    expect(snapshot.windows[0]!.paceAtRefresh?.deficitFraction).toBeCloseTo(0.2);

    const persisted = JSON.stringify(snapshot);
    expect(persisted).not.toContain("private@example.com");
    expect(persisted).not.toContain("secret-account");

  });

  test("keeps Codex Chat and Spark meters distinct", () => {
    const snapshot = normalizeUsage({
      reports: [{
        provider: "openai-codex",
        resetCredits: { availableCount: 2 },
        limits: [
          {
            id: "openai-codex:primary",
            label: "7 days",
            scope: { provider: "openai-codex", windowId: "7d" },
            window: { durationMs: 7 * 24 * HOUR, resetsAt: NOW + HOUR },
            amount: { used: 70, remaining: 30, limit: 100 },
            status: "ok",
          },
          {
            id: "openai-codex:spark:primary",
            label: "5 hours (Spark)",
            scope: { provider: "openai-codex", tier: "spark", windowId: "5h" },
            window: { durationMs: 5 * HOUR, resetsAt: NOW + HOUR },
            amount: { used: 10, remaining: 90, limit: 100 },
            status: "ok",
          },
        ],
      }],
    }, NOW);

    expect(snapshot.windows.map(window => window.scope)).toEqual(["Chat", "Spark"]);
    expect(snapshot.resetCredits).toEqual({ "openai-codex": 2 });
  });

  test("completes strategy modes and cached provider ids", () => {
    const snapshot = normalizeUsage({
      reports: [
        {
          provider: "openai-codex",
          resetCredits: { availableCount: 2 },
          limits: [{
            id: "openai-codex:primary",
            label: "7 days",
            scope: { provider: "openai-codex" },
            amount: { usedFraction: 0.5, remainingFraction: 0.5 },
          }],
        },
        {
          provider: "xai-oauth",
          limits: [{
            id: "xai-oauth:weekly",
            label: "Weekly",
            scope: { provider: "xai-oauth" },
            amount: { usedFraction: 0, remainingFraction: 1 },
          }],
        },
      ],
    }, NOW);

    expect(completeQuotaStrategy("", snapshot)?.map(item => item.value))
      .toEqual(["balanced", "targeted"]);
    expect(completeQuotaStrategy("bal", snapshot)?.map(item => item.value))
      .toEqual(["balanced"]);
    expect(completeQuotaStrategy("targeted ", snapshot)?.map(item => item.value))
      .toEqual(["targeted openai-codex", "targeted xai-oauth"]);
    expect(completeQuotaStrategy("targeted o", snapshot)).toEqual([{
      value: "targeted openai-codex",
      label: "openai-codex",
      description: "2 saved reset credits",
    }]);
    expect(completeQuotaStrategy("balanced ", snapshot)).toBeNull();
  });

  test("balanced strategy ranks quota pressure without rejecting deficit routes", () => {
    const snapshot = normalizeUsage({
      reports: [
        {
          provider: "anthropic",
          limits: [{
            id: "anthropic:7d",
            label: "Claude 7 Day",
            scope: { provider: "anthropic" },
            window: { durationMs: 100 * HOUR, resetsAt: NOW + 60 * HOUR },
            amount: { usedFraction: 0.6, remainingFraction: 0.4 },
            status: "ok",
          }],
        },
        {
          provider: "openai-codex",
          limits: [{
            id: "openai-codex:primary",
            label: "7 days",
            scope: { provider: "openai-codex" },
            window: { durationMs: 100 * HOUR, resetsAt: NOW + 60 * HOUR },
            amount: { usedFraction: 0.7, remainingFraction: 0.3 },
            status: "ok",
          }],
        },
        {
          provider: "xai-oauth",
          limits: [{
            id: "xai-oauth:credits:1w",
            label: "SuperGrok Weekly Credits",
            scope: { provider: "xai-oauth" },
            window: { durationMs: 100 * HOUR, resetsAt: NOW + 20 * HOUR },
            amount: { usedFraction: 0, remainingFraction: 1 },
            status: "ok",
          }],
        },
      ],
    }, NOW);

    const order = buildQuotaScopeOrder(
      snapshot,
      NOW,
      { version: 1, mode: "balanced", updatedAt: NOW },
    );
    expect(order).toBeDefined();
    expect(order!.indexOf("xai-oauth/shared")).toBeLessThan(order!.indexOf("anthropic/shared"));
    expect(order!.indexOf("anthropic/shared")).toBeLessThan(order!.indexOf("openai-codex/Chat"));
    const balanced = { version: 1 as const, mode: "balanced" as const, updatedAt: NOW };
    const agents = [
      { name: "future-codex", modelSelectors: ["@codex"] },
      { name: "future-grok", modelSelectors: ["@grok"] },
    ];
    const resolveModel = (spec: string) => ({
      "@codex": { provider: "openai-codex", id: "future-codex-model" },
      "@grok": { provider: "xai-oauth", id: "future-grok-model" },
    })[spec];
    expect(quotaStrategyViolation(
      snapshot,
      agents,
      resolveModel,
      { task: "Run the check", agent: "future-codex" },
      balanced,
      NOW,
    )).toBeUndefined();
  });

  test("targeted strategy prioritizes a deficit provider backed by reset credits", () => {
    const snapshot = normalizeUsage({
      reports: [
        {
          provider: "openai-codex",
          resetCredits: { availableCount: 2 },
          limits: [{
            id: "openai-codex:primary",
            label: "7 days",
            scope: { provider: "openai-codex" },
            window: { durationMs: 100 * HOUR, resetsAt: NOW + 60 * HOUR },
            amount: { usedFraction: 0.7, remainingFraction: 0.3 },
            status: "ok",
          }],
        },
        {
          provider: "xai-oauth",
          limits: [{
            id: "xai-oauth:credits:1w",
            label: "SuperGrok Weekly Credits",
            scope: { provider: "xai-oauth" },
            window: { durationMs: 100 * HOUR, resetsAt: NOW + 20 * HOUR },
            amount: { usedFraction: 0, remainingFraction: 1 },
            status: "ok",
          }],
        },
      ],
    }, NOW);
    const targeted = {
      version: 1 as const,
      mode: "targeted" as const,
      provider: "openai-codex",
      updatedAt: NOW,
    };
    const scopeOrder = buildQuotaScopeOrder(snapshot, NOW, targeted);
    expect(scopeOrder!.indexOf("openai-codex/Chat")).toBeLessThan(scopeOrder!.indexOf("xai-oauth/shared"));

    const agents = [
      { name: "future-codex", modelSelectors: ["@codex"] },
      { name: "future-grok", modelSelectors: ["@grok"] },
    ];
    const resolveModel = (spec: string) => ({
      "@codex": { provider: "openai-codex", id: "future-codex-model" },
      "@grok": { provider: "xai-oauth", id: "future-grok-model" },
    })[spec];
    const agentOrder = buildAgentQuotaOrder(snapshot, agents, resolveModel, NOW, targeted);
    expect(agentOrder!.indexOf("future-codex")).toBeLessThan(agentOrder!.indexOf("future-grok"));
    expect(quotaStrategyViolation(
      snapshot,
      agents,
      resolveModel,
      { task: "Run the check", agent: "future-grok" },
      targeted,
      NOW,
    )).toContain("future-codex");
    expect(quotaStrategyViolation(
      snapshot,
      agents,
      resolveModel,
      { task: "Run the check", agent: "future-codex" },
      targeted,
      NOW,
    )).toBeUndefined();
  });

  test("uses normalized scopes for previously unseen providers and models", () => {
    const snapshot = normalizeUsage({
      reports: [{
        provider: "future-provider",
        limits: [{
          id: "future-provider:model",
          label: "Next model",
          scope: { provider: "future-provider", modelId: "next-model" },
          window: { durationMs: 100 * HOUR, resetsAt: NOW + 50 * HOUR },
          amount: { usedFraction: 0.25, remainingFraction: 0.75 },
          status: "ok",
        }],
      }],
    }, NOW);

    expect(snapshot.windows[0]!.scope).toBe("model=next-model");
    expect(buildQuotaScopeOrder(snapshot, NOW)).toContain("future-provider/model=next-model");
    const agentOrder = buildAgentQuotaOrder(
      snapshot,
      [{ name: "future-worker", modelSelectors: ["@future"] }],
      spec => spec === "@future" ? { provider: "future-provider", id: "next-model" } : undefined,
      NOW,
    );
    expect(agentOrder).toContain("future-worker [future-provider/model=next-model");
  });

  test("disabling target agents removes them from routing choices and allows off-target work", () => {
    const definitions = [
      { name: "target-worker", model: ["@target"], readOnly: false },
      { name: "other-worker", model: ["@other"], readOnly: false },
      { name: "reader", model: ["@target"], readOnly: true },
    ];
    const isReadOnly = (agent: unknown) =>
      !!agent && typeof agent === "object" && "readOnly" in agent && agent.readOnly === true;
    const snapshot = normalizeUsage({
      reports: ["target-provider", "other-provider"].map(provider => ({
        provider,
        limits: [{
          id: `${provider}:weekly`,
          label: "Weekly",
          scope: { provider },
          window: { durationMs: 100 * HOUR, resetsAt: NOW + 50 * HOUR },
          amount: { usedFraction: 0.25, remainingFraction: 0.75 },
          status: "ok",
        }],
      })),
    }, NOW);
    const resolveModel = (spec: string) => ({
      "@target": { provider: "target-provider", id: "target-model" },
      "@other": { provider: "other-provider", id: "other-model" },
    })[spec];
    const strategy = { version: 1 as const, mode: "targeted" as const, provider: "target-provider", updatedAt: NOW };
    const input = { agent: "other-worker", task: "Complete the work" };

    const disabledRoutes = selectAgentRoutes(definitions, ["target-worker"], isReadOnly);
    expect(disabledRoutes.map(route => route.name)).toEqual(["other-worker"]);
    expect(quotaStrategyViolation(snapshot, disabledRoutes, resolveModel, input, strategy, NOW)).toBeUndefined();

    const enabledRoutes = selectAgentRoutes(definitions, [], isReadOnly);
    expect(enabledRoutes.map(route => route.name)).toEqual(["target-worker", "other-worker"]);
    expect(quotaStrategyViolation(snapshot, enabledRoutes, resolveModel, input, strategy, NOW)).toBeDefined();
  });
});
