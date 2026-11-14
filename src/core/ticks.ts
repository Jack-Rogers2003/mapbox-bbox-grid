import { COORD_SCALE, EPSILON } from "../constants";

/**
 * Round a coordinate to 8 decimal places.
 * @param value - Coordinate in degrees.
 */
export function roundCoord(value: number): number {
  return Math.round(value * COORD_SCALE) / COORD_SCALE;
}

/**
 * Number of cells needed to cover `[lo, hi]` with cells of size `step` (the last may be partial).
 * @param lo - Start of the range.
 * @param hi - End of the range.
 * @param step - Cell size, same unit as the range.
 */
export function countCells(lo: number, hi: number, step: number): number {
  return Math.max(1, Math.ceil((hi - lo) / step - EPSILON));
}

/**
 * Grid-line positions from `lo` to `hi`; the final cell is clipped to `hi`.
 * @param lo - Start of the range.
 * @param hi - End of the range.
 * @param step - Cell size, same unit as the range.
 */
export function buildTicks(lo: number, hi: number, step: number): number[] {
  const count = countCells(lo, hi, step);
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(roundCoord(lo + i * step));
  }
  ticks.push(roundCoord(hi));
  return ticks;
}

/**
 * Largest index `i` with `ticks[i] <= value`, clamped to 0. `ticks` must be ascending.
 * @param ticks - Ascending grid-line positions.
 * @param value - Position to look up.
 */
export function lowerIndex(ticks: readonly number[], value: number): number {
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ticks[mid] <= value) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Smallest index `i` with `ticks[i] >= value`, clamped to the last index. `ticks` must be ascending.
 * @param ticks - Ascending grid-line positions.
 * @param value - Position to look up.
 */
export function upperIndex(ticks: readonly number[], value: number): number {
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ticks[mid] >= value) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}
