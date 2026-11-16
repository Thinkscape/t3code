// @effect-diagnostics nodeBuiltinImport:off -- The test recomputes the mapper's account hash.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { ompUsageReportToLimits } from "./usageLimits.ts";

const checkedAt = "2026-11-13T08:05:03.741Z";

const accountKey = (accountId: string) =>
  NodeCrypto.createHash("sha256").update(accountId).digest("hex").slice(0, 8);

// Captured from `omp usage --json --redact` (omp 18.20.0), trimmed of reset-credit detail.
const capturedUsage = {
  generatedAt: 1794561903741,
  reports: [
    {
      provider: "ollama-cloud",
      fetchedAt: 1794561783010,
      limits: [],
      notes: ["Ollama does not expose a standalone quota usage API."],
    },
    {
      provider: "openai-codex",
      fetchedAt: 1794561902638,
      limits: [
        {
          id: "openai-codex:primary",
          label: "7 days",
          scope: { provider: "openai-codex", windowId: "7d", shared: true },
          window: { id: "7d", label: "7 days", durationMs: 604800000, resetsAt: 1795083536000 },
          amount: {
            used: 1,
            limit: 100,
            remaining: 99,
            usedFraction: 0.01,
            remainingFraction: 0.99,
            unit: "percent",
          },
          status: "ok",
        },
      ],
      resetCredits: { availableCount: 3 },
      metadata: { planType: "pro", email: "ab*2*", accountId: "9e*" },
    },
    {
      provider: "openai-codex",
      fetchedAt: 1794561783010,
      limits: [
        {
          id: "openai-codex:primary",
          label: "30 days",
          scope: { provider: "openai-codex", windowId: "30d", shared: true },
          window: { id: "30d", label: "30 days", durationMs: 2592000000, resetsAt: 1797153783000 },
          amount: {
            used: 0,
            limit: 100,
            remaining: 100,
            usedFraction: 0,
            remainingFraction: 1,
            unit: "percent",
          },
          status: "ok",
        },
      ],
      metadata: { planType: "free", email: "ab*x@*", accountId: "93*" },
    },
    {
      provider: "anthropic",
      fetchedAt: 1794561902946,
      limits: [
        {
          id: "anthropic:7d",
          label: "Claude 7 Day",
          scope: { provider: "anthropic", windowId: "7d", shared: true },
          window: { id: "7d", label: "7 Day", durationMs: 604800000, resetsAt: 1794657599893 },
          amount: {
            used: 42,
            limit: 100,
            remaining: 58,
            usedFraction: 0.42,
            remainingFraction: 0.5800000000000001,
            unit: "percent",
          },
          status: "ok",
        },
        {
          id: "anthropic:7d:fable",
          label: "Claude 7 Day (Fable)",
          scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
          window: { id: "7d", label: "7 Day", durationMs: 604800000, resetsAt: 1794657599893 },
          amount: {
            used: 60,
            limit: 100,
            remaining: 40,
            usedFraction: 0.6,
            remainingFraction: 0.4,
            unit: "percent",
          },
          status: "ok",
        },
      ],
      metadata: { accountId: "6d*", email: "ab*", orgId: "6b*" },
      resetCredits: { availableCount: 4, redeemableCount: 1, nextCreditId: "full-reset-2611" },
    },
    { provider: "ollama", fetchedAt: 1794561783010, limits: [] },
  ],
};

describe("omp usage limits", () => {
  it("maps every account's limits to provider-labelled windows with stable ids", () => {
    const limits = ompUsageReportToLimits(capturedUsage, checkedAt);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.checkedAt).toBe(checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "anthropic:7d",
        kind: "weekly",
        label: "Anthropic · 7 Day",
        usedPercent: 42,
        resetsAt: "2026-11-14T11:59:59.893Z",
        windowDurationMins: 10080,
      },
      {
        id: "anthropic:7d:fable",
        kind: "weekly",
        label: "Anthropic · 7 Day (Fable)",
        usedPercent: 60,
        resetsAt: "2026-11-14T11:59:59.893Z",
        windowDurationMins: 10080,
      },
      {
        id: `openai-codex:${accountKey("9e*")}:primary`,
        kind: "weekly",
        label: "OpenAI Codex (Pro) · 7 days",
        usedPercent: 1,
        resetsAt: "2026-11-19T10:18:56.000Z",
        windowDurationMins: 10080,
      },
      {
        id: `openai-codex:${accountKey("93*")}:primary`,
        kind: "monthly",
        label: "OpenAI Codex (Free) · 30 days",
        usedPercent: 0,
        resetsAt: "2026-12-13T09:23:03.000Z",
        windowDurationMins: 43200,
      },
    ]);
  });

  it("keeps the remaining bars when one limit is malformed and derives missing fractions", () => {
    const limits = ompUsageReportToLimits(
      {
        reports: [
          {
            provider: "github-copilot",
            limits: [
              { id: "broken", label: "Broken" },
              {
                id: "premium",
                label: "Premium requests",
                window: { label: "Monthly", durationMs: 2592000000 },
                amount: { used: 150, limit: 300, unit: "requests" },
              },
              {
                id: "chat",
                label: "Chat",
                amount: { unit: "requests" },
                status: "exhausted",
              },
            ],
          },
        ],
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "github-copilot:premium",
        kind: "monthly",
        label: "GitHub Copilot · Monthly",
        usedPercent: 50,
        windowDurationMins: 43200,
      },
      {
        id: "github-copilot:chat",
        kind: "other",
        label: "GitHub Copilot · Chat",
        usedPercent: 100,
      },
    ]);
  });

  it("reports unsupported when no account has limits and probeFailed on a foreign shape", () => {
    expect(
      ompUsageReportToLimits({ reports: [{ provider: "ollama", limits: [] }] }, checkedAt),
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
    expect(ompUsageReportToLimits({ error: "nope" }, checkedAt).unavailable?.reason).toBe(
      "probeFailed",
    );
  });
});
