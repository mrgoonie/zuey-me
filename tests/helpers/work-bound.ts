/**
 * Helpers for performance tests that must not flake when the machine is busy. The guarantee is asserted as
 * a deterministic work bound (operations counted, the same on any machine), and wall-clock time is only a
 * generous smoke ceiling that a loaded runner still clears with plenty of room.
 */

/** Wall-clock budget for a smoke check: ~20x what the linear code needs, yet far below a quadratic or exponential path. */
export const SMOKE_CEILING_MS = 1_000;

/**
 * Regex match attempts `run` makes: every `exec` and `test` call, and every match step of `replace`,
 * `match`, `matchAll` and `split`, which all go through `RegExp.prototype.exec` once it is observed.
 * Deterministic for a given input, so a scan that restarts per character or per match shows up as a count
 * that grows with the square of the input. Backtracking inside a single match is invisible here; the
 * smoke ceiling (`elapsedMs` over several runs) covers it.
 */
export function regexRuns(run: () => void, bound: number): number {
  // A bare counter rather than a mock: a runaway scan makes millions of calls, too many to record. Past
  // twice the bound it stops the scan, so a quadratic regression fails at once instead of running for minutes.
  const exec = RegExp.prototype.exec;
  const limit = 2 * bound;
  let runs = 0;
  RegExp.prototype.exec = function countedExec(this: RegExp, input: string) {
    if (++runs > limit) throw new RangeError(`more than ${limit} regex runs (bound ${bound})`);
    return exec.call(this, input);
  };
  try {
    run();
    return runs;
  } finally {
    RegExp.prototype.exec = exec;
  }
}

/** Milliseconds `times` calls of `run` take, after one warm-up call. */
export function elapsedMs(run: () => void, times = 1): number {
  run();
  const started = performance.now();
  for (let i = 0; i < times; i++) run();
  return performance.now() - started;
}
