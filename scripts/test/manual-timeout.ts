/**
 * `scripts/test/manual-timeout.ts` — a timeout runner the tests fire by
 * hand. Each call gets an index; `fire(index)` aborts that call's signal and
 * rejects its promise with `TimeoutFiredError`, exactly what the real runner
 * does when its budget runs out. A call the test never fires just settles.
 * Promises the test holds (a held fake-API request) may settle after the
 * fire: `Promise.race` keeps them from rejecting unhandled.
 */

import { TimeoutFiredError } from "../provision/errors.ts";
import type { TimeoutRunner } from "../provision/client.ts";

export class ManualTimeouts {
  /** One entry per timed call, true once it was fired. */
  readonly fired: boolean[] = [];
  private readonly controllers: AbortController[] = [];
  private readonly fires: (() => void)[] = [];

  readonly runner: TimeoutRunner = <T>(
    work: (signal: AbortSignal) => Promise<T>,
    _ms: number,
  ): Promise<T> => {
    const index = this.fires.length;
    const controller = new AbortController();
    this.controllers.push(controller);
    this.fired.push(false);
    const timeout = new Promise<never>((_resolve, reject) => {
      this.fires.push(() => {
        this.fired[index] = true;
        controller.abort();
        reject(new TimeoutFiredError());
      });
    });
    return Promise.race([work(controller.signal), timeout]);
  };

  /** Fires the timeout of one call, aborting its signal. */
  fire(index: number): void {
    const fire = this.fires[index];
    if (fire === undefined) {
      throw new Error(`no timed call at index ${index}`);
    }
    fire();
  }

  /** Whether the signal of one call was aborted. */
  wasAborted(index: number): boolean {
    const controller = this.controllers[index];
    if (controller === undefined) {
      throw new Error(`no timed call at index ${index}`);
    }
    return controller.signal.aborted;
  }

  get count(): number {
    return this.fires.length;
  }
}
