/** Token bucket: refills at `rate` per second up to `burst`; take() fails when empty. */
export class TokenBucket {
  readonly #rate: number;
  readonly #burst: number;
  #tokens: number;
  #last: number;

  constructor(rate: number, burst: number, now = performance.now()) {
    this.#rate = rate;
    this.#burst = burst;
    this.#tokens = burst;
    this.#last = now;
  }

  /** Spend n tokens if available. */
  take(n: number, now = performance.now()): boolean {
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#last) / 1000) * this.#rate);
    this.#last = now;
    if (n > this.#tokens) return false;
    this.#tokens -= n;
    return true;
  }
}
