import {
  type ModelCapabilities,
  type ModelSelection,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Predicate from "effect/Predicate";

// OMP declares the model-specific effort vocabulary in thinking.efforts.
const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];

const OMP_THINKING_LEVEL_LABELS: Record<OmpThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const OMP_MODE_OPTION_ID = "mode";
export const OMP_PLAN_MODE = "plan";

// omp's RPC has no plan-mode command: Plan is chosen when omp starts (`--plan-yolo`). Offering it
// as a model option lets T3 restart the session when it changes, as it does for other selections.
// omp leaves plan mode when a plan is approved, and the adapter then resets the thread's option.
const OMP_MODE_DESCRIPTOR: ProviderOptionDescriptor = {
  id: OMP_MODE_OPTION_ID,
  label: "Mode",
  type: "select",
  options: [
    { id: "default", label: "Default", isDefault: true },
    {
      id: OMP_PLAN_MODE,
      label: "Plan",
      description: "Plans read-only, then asks before implementing.",
    },
  ],
};

export function isOmpPlanModeSelection(selection: ModelSelection): boolean {
  return getModelSelectionStringOptionValue(selection, OMP_MODE_OPTION_ID) === OMP_PLAN_MODE;
}

export const BASE_OMP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [OMP_MODE_DESCRIPTOR],
});

export function thinkingCapabilitiesForOmpModel(
  model: unknown,
  defaultThinkingLevel: unknown,
): ModelCapabilities {
  const levels = supportedOmpThinkingLevelsFromModel(model);
  if (levels.length === 0) return BASE_OMP_MODEL_CAPABILITIES;
  const defaultLevel = clampOmpThinkingLevel(defaultThinkingLevel, levels);
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: levels.map((level): ProviderOptionChoice => ({
          id: level,
          label: OMP_THINKING_LEVEL_LABELS[level],
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
      },
      OMP_MODE_DESCRIPTOR,
    ],
  });
}

function clampOmpThinkingLevel(
  input: unknown,
  availableLevels: ReadonlyArray<OmpThinkingLevel>,
): OmpThinkingLevel | undefined {
  if (typeof input !== "string") return undefined;
  const requestedIndex = OMP_THINKING_LEVELS.findIndex((level) => level === input);
  if (requestedIndex === -1) return undefined;
  const exact = availableLevels.find((level) => level === input);
  if (exact !== undefined) return exact;
  for (let index = requestedIndex + 1; index < OMP_THINKING_LEVELS.length; index += 1) {
    const higher = availableLevels.find((level) => level === OMP_THINKING_LEVELS[index]);
    if (higher !== undefined) return higher;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const lower = availableLevels.find((level) => level === OMP_THINKING_LEVELS[index]);
    if (lower !== undefined) return lower;
  }
  return availableLevels[0];
}

function supportedOmpThinkingLevelsFromModel(model: unknown): ReadonlyArray<OmpThinkingLevel> {
  if (recordField(model, "reasoning") !== true) return [];
  const efforts = recordField(recordField(model, "thinking"), "efforts");
  if (!Array.isArray(efforts)) return [];
  return OMP_THINKING_LEVELS.filter((level) => efforts.includes(level));
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}
