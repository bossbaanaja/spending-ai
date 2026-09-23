// Per-slip latency breakdown for benchmarking the photo → reply pipeline.
// Marks are timestamped as they're reached, in whatever order concurrent
// work actually finishes in, so the summary reflects the real timeline
// (e.g. the photo download and the "Reading your slip…" reply race each
// other) rather than the order they appear in the source.

export class SlipTimer {
  readonly reqId: string;
  private readonly t0: number;
  private readonly marks: [string, number][] = [];

  constructor(reqId: string) {
    this.reqId = reqId;
    this.t0 = Date.now();
  }

  mark(stage: string): void {
    this.marks.push([stage, Date.now()]);
  }

  /** One log line: total elapsed since the timer started, plus ms between each consecutive mark. */
  logSummary(extra?: Record<string, unknown>): void {
    const stagesMs: Record<string, number> = {};
    let prev = this.t0;
    for (const [stage, ts] of this.marks) {
      stagesMs[stage] = ts - prev;
      prev = ts;
    }
    console.error(
      JSON.stringify({
        event: "slip_timing",
        reqId: this.reqId,
        totalMs: Date.now() - this.t0,
        stagesMs,
        ...extra,
      }),
    );
  }
}

/** Epoch timestamps connect album work across webhook and queue invocations.
 * Emit starts too, so a terminated invocation leaves a visible unfinished step. */
export class AlbumTrace {
  constructor(private readonly context: Record<string, unknown>) {}

  child(details: Record<string, unknown>): AlbumTrace {
    return new AlbumTrace({ ...this.context, ...details });
  }

  event(stage: string, details: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ event: 'album_timing', ...this.context, stage, atMs: Date.now(), ...details }));
  }

  async measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now();
    const spanId = crypto.randomUUID();
    this.event(stage, { phase: 'start', spanId });
    let outcome = 'ok';
    try {
      return await work();
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      this.event(stage, { phase: 'end', spanId, startedAtMs, durationMs: Date.now() - startedAtMs, outcome });
    }
  }
}
