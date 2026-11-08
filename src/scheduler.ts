export interface Checkpoint {
  anchor: string;
  turns: number;
}
export type Trigger = "periodic" | "settled" | "manual";
type TimerHandle = ReturnType<typeof setTimeout> | number;
interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(timer: TimerHandle): void;
}
const realClock: Clock = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Single flight, bounded pending work, and cadence independent of Pi's agent loop. */
export class ReviewScheduler {
  private pending?: { checkpoint: Checkpoint; trigger: Trigger };
  private timer?: TimerHandle;
  private controller?: AbortController;
  private generation = 0;
  private lastAttemptAt = -Infinity;
  private lastAttemptTurns: number;
  private lastAttemptAnchor?: string;
  private stopped = false;

  constructor(
    private options: { everyTurns: number; minIntervalSeconds: number },
    private review: (checkpoint: Checkpoint, signal: AbortSignal) => Promise<void>,
    private onError: (error: unknown) => void,
    private onChange: () => void = () => {},
    initial: Partial<Checkpoint> = {},
    private clock: Clock = realClock,
  ) {
    this.lastAttemptTurns = initial.turns ?? 0;
    this.lastAttemptAnchor = initial.anchor;
  }

  get running(): boolean {
    return !!this.controller;
  }

  request(checkpoint: Checkpoint, trigger: Trigger): void {
    if (this.stopped || !checkpoint.anchor) return;
    if (trigger !== "manual" && checkpoint.anchor === this.lastAttemptAnchor) return;
    // Even below-cadence requests refresh an already pending tail review.
    const cadenceDue = checkpoint.turns - this.lastAttemptTurns >= this.options.everyTurns;
    if (trigger === "periodic" && !cadenceDue && !this.pending) return;
    const strongest =
      this.pending?.trigger === "manual"
        ? "manual"
        : this.pending?.trigger === "settled" && trigger === "periodic"
          ? "settled"
          : trigger;
    this.pending = { checkpoint, trigger: strongest };
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.pending = undefined;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  private drain(): void {
    if (this.stopped || this.controller || !this.pending) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const { checkpoint, trigger } = this.pending;
    if (trigger !== "manual" && checkpoint.anchor === this.lastAttemptAnchor) {
      this.pending = undefined;
      return;
    }
    const delay = this.lastAttemptAt + this.options.minIntervalSeconds * 1000 - this.clock.now();
    if (trigger !== "manual" && delay > 0) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, delay);
      return;
    }
    this.pending = undefined;
    this.lastAttemptAt = this.clock.now();
    this.lastAttemptTurns = checkpoint.turns;
    this.lastAttemptAnchor = checkpoint.anchor;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.onChange();
    void Promise.resolve()
      .then(() => this.review(checkpoint, controller.signal))
      .catch((error) => {
        if (!this.stopped && generation === this.generation) this.onError(error);
      })
      .finally(() => {
        this.controller = undefined;
        if (!this.stopped && generation === this.generation) {
          this.onChange();
          this.drain();
        }
      });
  }
}
