import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { isOmpPlanModeSelection, thinkingCapabilitiesForOmpModel } from "./thinkingCapabilities.ts";
it("uses OMP thinking.efforts without inventing unsupported levels", () => {
  const capabilities = thinkingCapabilitiesForOmpModel(
    { reasoning: true, thinking: { efforts: ["low", "high", "max"] } },
    "high",
  );
  const thinking = capabilities.optionDescriptors?.[0];
  expect(thinking?.type === "select" ? thinking.options.map((option) => option.id) : []).toEqual([
    "low",
    "high",
    "max",
  ]);
});

it("offers Plan as a mode on every model, including ones without thinking levels", () => {
  for (const model of [{ reasoning: true, thinking: { efforts: ["low"] } }, { reasoning: false }]) {
    const mode = thinkingCapabilitiesForOmpModel(model, undefined).optionDescriptors?.find(
      (descriptor) => descriptor.id === "mode",
    );
    expect(mode?.type === "select" ? mode.options.map((option) => option.id) : []).toEqual([
      "default",
      "plan",
    ]);
  }
  const selection = {
    instanceId: ProviderInstanceId.make("omp"),
    model: "anthropic/claude-opus-5-5",
  };
  expect(isOmpPlanModeSelection({ ...selection, options: [{ id: "mode", value: "plan" }] })).toBe(
    true,
  );
  expect(isOmpPlanModeSelection(selection)).toBe(false);
});
