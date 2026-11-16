import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

/** omp fixtures record on its cheapest Anthropic model. */
export const OMP_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("omp"),
  model: "anthropic/claude-haiku-5-5",
} satisfies ModelSelection;

/** omp's Plan mode is a model option; the adapter launches omp with `--plan-yolo` for it. */
export const OMP_PLAN_MODEL_SELECTION = {
  ...OMP_MODEL_SELECTION,
  options: [{ id: "mode", value: "plan" }],
} satisfies ModelSelection;
