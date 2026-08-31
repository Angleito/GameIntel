import { computeFetchSlot, type Clock, type SourcePacingStore } from "@gameintel/contracts";

export class InMemoryPacingStore implements SourcePacingStore {
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async acquireFetchSlot(sourceId: string, requestsPerMinute: number): Promise<number> {
    if (!sourceId.trim()) {
      throw new Error("Source fetch pacing requires a positive request rate");
    }
    const now = this.clock.now();
    const { scheduledAtMs, waitMs } = computeFetchSlot(now, this.nextAllowedAt.get(sourceId) ?? now, requestsPerMinute);
    this.nextAllowedAt.set(sourceId, scheduledAtMs);
    return waitMs;
  }
}