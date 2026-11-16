import { describe, it } from "@effect/vitest";

import { OmpOrchestratorReplayHarness } from "../Adapters/OmpAdapterV2.testkit.ts";
import { OMP_REPLAY_FIXTURES } from "./fixtures/omp/index.ts";
import { runReplayFixture } from "./ProviderReplayFixtures.ts";

// omp fixtures live in their own list (fixtures/omp), so this mirrors itRunsReplayFixtures over it.
describe("omp replay fixtures", () => {
  it.effect.each(
    OMP_REPLAY_FIXTURES.flatMap((fixture) =>
      fixture.providers.map(
        (provider) => [fixture.name, provider.driver, fixture, provider] as const,
      ),
    ),
  )("runs %s/%s through OrchestratorV2 using deterministic replay", ([, , fixture, provider]) =>
    runReplayFixture({
      fixtureName: fixture.name,
      buildInput: fixture.buildInput,
      driver: provider,
      harness: OmpOrchestratorReplayHarness,
    }),
  );
});
