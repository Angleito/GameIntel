import { assertPacingSourceId, computeFetchSlot, type Clock, type SourcePacingStore } from "@gameintel/contracts";

export class InMemoryPacingStore implements SourcePacingStore {
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async acquireFetchSlot(sourceId: string, requestsPerMinute: number): Promise<number> {
    assertPacingSourceId(sourceId);
    const now = this.clock.now();
    const { nextAllowedAtMs, waitMs } = computeFetchSlot(now, this.nextAllowedAt.get(sourceId) ?? now, requestsPerMinute);
    this.nextAllowedAt.set(sourceId, nextAllowedAtMs);
    return waitMs;
  }
}