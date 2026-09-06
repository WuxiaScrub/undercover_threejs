/**
 * Fisher-Yates shuffle — unbiased, in place, returns the array.
 *
 * `rand` is injectable so tests can pin a deal. It must behave like
 * `Math.random`: uniform over [0, 1).
 */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
