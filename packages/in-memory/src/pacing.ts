import type { Clock, SourcePacingStore } from "@gameintel/contracts";

export class InMemoryPacingStore implements SourcePacingStore {
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async acquireFetchSlot(sourceId: string, requestsPerMinute: number): Promise<number> {
    if (!sourceId.trim() || !Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new Error("Source fetch pacing requires a positive request rate");
    }
    const now = this.clock.now();
    const nextAllowedAt = this.nextAllowedAt.get(sourceId) ?? now;
    const scheduledAt = Math.max(now, nextAllowedAt);
    this.nextAllowedAt.set(sourceId, scheduledAt + 60_000 / requestsPerMinute);
    return Math.max(0, scheduledAt - now);
  }
}