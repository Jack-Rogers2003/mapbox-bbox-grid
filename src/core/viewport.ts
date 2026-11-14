import { DEFAULT_MAX_LINES, DEFAULT_VIEWPORT_PADDING } from "../constants";
import { GridError } from "../errors";
import type { BBox, LineFeature, LineFeatureCollection, ViewportOptions } from "../types";
import { lineFeature } from "./features";
import { roundCoord } from "./ticks";

/** Random-access view of sorted grid-line coordinates. */
interface AxisTicks {
  length: number;
  /** Read a coordinate by grid-line index. */
  at(index: number): number;
}

/**
 * Find the last axis index whose coordinate is at most `value`.
 * @param ticks - Random-access axis coordinates.
 * @param value - Coordinate to locate.
 */
function lowerIndex(ticks: AxisTicks, value: number): number {
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ticks.at(mid) <= value) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Find the first axis index whose coordinate is at least `value`.
 * @param ticks - Random-access axis coordinates.
 * @param value - Coordinate to locate.
 */
function upperIndex(ticks: AxisTicks, value: number): number {
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ticks.at(mid) >= value) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * The part of `bbox` that is visible in `view`, grown by `padding`.
 * @param bbox - Extent of the whole grid.
 * @param view - Visible bounds. A view that wraps the antimeridian (west > east) or spans 360
 *   degrees or more is treated as covering the full longitude range of `bbox`.
 * @param padding - Fraction of the view size to add on every side.
 * @returns The clamped region, or `null` if it does not overlap `bbox`.
 */
function visibleRegion(bbox: BBox, view: BBox, padding: number): BBox | null {
  const [bboxWest, bboxSouth, bboxEast, bboxNorth] = bbox;
  const wraps = view[0] > view[2] || view[2] - view[0] >= 360;
  const viewWest = wraps ? bboxWest : view[0];
  const viewEast = wraps ? bboxEast : view[2];
  const padX = wraps ? 0 : (viewEast - viewWest) * padding;
  const padY = (view[3] - view[1]) * padding;
  const west = Math.max(bboxWest, viewWest - padX);
  const east = Math.min(bboxEast, viewEast + padX);
  const south = Math.max(bboxSouth, view[1] - padY);
  const north = Math.min(bboxNorth, view[3] + padY);
  return west < east && south < north ? [west, south, east, north] : null;
}

/**
 * Indices in `[first, last]` that lie on the lattice of multiples of `stride`. The final grid
 * line (`edge`) is always included when the range reaches it, so the grid's border stays closed.
 * @param first - First candidate index.
 * @param last - Last candidate index.
 * @param stride - Keep every `stride`-th index.
 * @param edge - Index of the last grid line on this axis.
 */
function strideIndices(first: number, last: number, stride: number, edge: number): number[] {
  const indices: number[] = [];
  for (let i = Math.ceil(first / stride) * stride; i <= last; i += stride) {
    indices.push(i);
  }
  if (last === edge && indices[indices.length - 1] !== edge) {
    indices.push(edge);
  }
  return indices;
}

/**
 * Grid lines for the visible part of the map only, thinned out if too many would be visible.
 * Lines are anchored to the full grid (never shifted by panning) and only span the visible area.
 * @param bbox - Extent of the whole grid.
 * @param xs - Longitudes of all vertical grid lines, ascending.
 * @param ys - Latitudes of all horizontal grid lines, ascending.
 * @param view - Visible bounds as `[west, south, east, north]`.
 * @param options - Padding and line cap.
 * @throws {GridError} If `padding` is negative or `maxLines` is not a positive integer.
 */
export function viewportLines(
  bbox: BBox,
  xs: readonly number[],
  ys: readonly number[],
  view: BBox,
  options: ViewportOptions = {},
): LineFeatureCollection {
  return viewportLinesFromAxes(
    bbox,
    {
      length: xs.length,
      /** Read the longitude at an index. */
      at: (index) => xs[index],
    },
    {
      length: ys.length,
      /** Read the latitude at an index. */
      at: (index) => ys[index],
    },
    view,
    options,
  );
}

/**
 * Generate viewport lines directly from grid steps without materializing every grid tick.
 * @param bbox - Extent of the whole grid.
 * @param xStep - Longitude step.
 * @param yStep - Latitude step.
 * @param cols - Number of grid columns.
 * @param rows - Number of grid rows.
 * @param view - Visible bounds as `[west, south, east, north]`.
 * @param options - Padding and line cap.
 */
export function viewportLinesByStep(
  bbox: BBox,
  xStep: number,
  yStep: number,
  cols: number,
  rows: number,
  view: BBox,
  options: ViewportOptions = {},
): LineFeatureCollection {
  const [west, south, east, north] = bbox;
  return viewportLinesFromAxes(
    bbox,
    {
      length: cols + 1,
      /** Calculate a longitude tick on demand. */
      at: (index) => roundCoord(index === cols ? east : west + index * xStep),
    },
    {
      length: rows + 1,
      /** Calculate a latitude tick on demand. */
      at: (index) => roundCoord(index === rows ? north : south + index * yStep),
    },
    view,
    options,
  );
}

/**
 * Find and build the subset of grid lines intersecting the padded viewport.
 * @param bbox - Extent of the full grid.
 * @param xs - Random-access longitude ticks.
 * @param ys - Random-access latitude ticks.
 * @param view - Visible map bounds.
 * @param options - Padding and line cap.
 */
function viewportLinesFromAxes(
  bbox: BBox,
  xs: AxisTicks,
  ys: AxisTicks,
  view: BBox,
  options: ViewportOptions,
): LineFeatureCollection {
  const { padding = DEFAULT_VIEWPORT_PADDING, maxLines = DEFAULT_MAX_LINES } = options;
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GridError("viewport padding must be >= 0");
  }
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new GridError("viewport maxLines must be a positive integer");
  }

  const region = visibleRegion(bbox, view, padding);
  if (region === null) {
    return { type: "FeatureCollection", features: [] };
  }
  const [west, south, east, north] = region;

  const xFirst = lowerIndex(xs, west);
  const xLast = upperIndex(xs, east);
  const yFirst = lowerIndex(ys, south);
  const yLast = upperIndex(ys, north);

  const visibleCount = xLast - xFirst + 1 + (yLast - yFirst + 1);
  const stride = Math.max(1, Math.ceil(visibleCount / maxLines));

  const features: LineFeature[] = [];
  const spanSouth = roundCoord(south);
  const spanNorth = roundCoord(north);
  const spanWest = roundCoord(west);
  const spanEast = roundCoord(east);
  for (const index of strideIndices(xFirst, xLast, stride, xs.length - 1)) {
    const x = xs.at(index);
    features.push(
      lineFeature(
        [
          [x, spanSouth],
          [x, spanNorth],
        ],
        { axis: "x", index },
      ),
    );
  }
  for (const index of strideIndices(yFirst, yLast, stride, ys.length - 1)) {
    const y = ys.at(index);
    features.push(
      lineFeature(
        [
          [spanWest, y],
          [spanEast, y],
        ],
        { axis: "y", index },
      ),
    );
  }
  return { type: "FeatureCollection", features };
}
