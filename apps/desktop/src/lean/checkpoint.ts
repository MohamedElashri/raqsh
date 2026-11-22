import { invoke } from "@tauri-apps/api/core";
import type { Drawing, Scope } from "../model";

export type SaveState = { message: string; failed: boolean; pending?: boolean };

const debounce = 550;
const maximumDelay = 2000;

export class Checkpoint {
  private generation = 0;
  private saved = 0;
  private dirtySince = 0;
  private timer = 0;
  private running?: Promise<void>;
  private failure = false;
  private disposed = false;

  constructor(
    private scope: Scope,
    private revision: number,
    private drawing: Drawing,
    private report: (state: SaveState) => void,
  ) {}

  changed() {
    this.generation += 1;
    this.dirtySince ||= performance.now();
    this.failure = false;
    this.report({ message: "Drawing changes pending", failed: false, pending: true });
    this.schedule();
  }

  private schedule() {
    this.stopTimer();
    if (this.disposed || this.running || this.failure || this.saved === this.generation) return;
    const delay = Math.min(debounce, Math.max(0, maximumDelay - (performance.now() - this.dirtySince)));
    this.timer = window.setTimeout(() => { void this.save().catch(() => {}); }, delay);
  }

  private save(): Promise<void> {
    if (this.running) return this.running;
    if (this.saved === this.generation) return Promise.resolve();
    this.stopTimer();
    const generation = this.generation;
    this.dirtySince = 0;
    // The bridge serializes this snapshot synchronously. Later gestures only update the live scene.
    this.running = invoke<number>("save_drawing", {
      scope: this.scope, expected: this.revision, generation, drawing: this.drawing,
    }).then((revision) => {
      this.saved = generation;
      this.revision = revision;
      this.failure = false;
      if (!this.disposed && this.saved === this.generation) this.report({ message: `Drawing saved · checkpoint ${revision}`, failed: false });
    }).catch((error) => {
      this.failure = true;
      if (!this.disposed) this.report({ message: `Drawing save failed. ${String(error)}`, failed: true });
      throw error;
    }).finally(() => {
      this.running = undefined;
      this.schedule();
    });
    return this.running;
  }

  async flush() {
    while (!this.disposed && this.saved < this.generation) await this.save();
  }

  dispose() {
    this.disposed = true;
    this.stopTimer();
  }

  stopTimer() {
    window.clearTimeout(this.timer);
  }
}
