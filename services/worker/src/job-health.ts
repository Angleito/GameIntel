import type { Clock, IngestionJob, SourceHealthStore } from "@gameintel/contracts";
import { SourceFetchError } from "@gameintel/controlled-fetch";

// Only typed source-availability failures from the controlled-fetch layer are
// health observations; application failures (persistence, queue, parser) never
// count against the external source. Repeated attempts of the same job are not
// independent checks: a down is recorded only on the job's first execution.
// Transport/infrastructure failures (proxy unreachable, local fetch rejection)
// never count — only failures proven to be the origin's.
export function isSourceUnavailable(error: unknown): boolean {
  return error instanceof SourceFetchError && error.kind === "source_unavailable";
}

export async function recordJobHealth(input: {
  sourceHealth: SourceHealthStore;
  clock: Clock;
  sourceId: string;
  job: IngestionJob;
  error?: unknown;
}): Promise<void> {
  if (!input.error) {
    await input.sourceHealth.recordSourceHealth({ sourceId: input.sourceId, status: "ok", checkedAt: input.clock.nowIso() });
    return;
  }
  if (input.job.attempts === 1 && isSourceUnavailable(input.error)) {
    await input.sourceHealth.recordSourceHealth({
      sourceId: input.sourceId,
      status: "down",
      checkedAt: input.clock.nowIso(),
      message: input.error instanceof Error ? input.error.message : String(input.error),
    });
  }
}
