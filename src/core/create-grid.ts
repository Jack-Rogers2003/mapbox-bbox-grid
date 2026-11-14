import type { BBox, GridMode, GridOptions, LineFeatureCollection } from "../types";
import { BBoxGrid } from "./grid";

/** Options for {@link createGrid}, including the output feature mode. */
export type CreateGridOptions = GridOptions & { mode?: GridMode };

/**
 * Shortcut: bounding box and options in, GeoJSON FeatureCollection out.
 * @param bbox - `[west, south, east, north]` in degrees.
 * @param options - Grid options plus an optional `mode` (`"lines"` by default).
 * @throws {GridError} For invalid input.
 */
export function createGrid(bbox: BBox, options: CreateGridOptions): LineFeatureCollection {
  const { mode = "lines", ...gridOptions } = options;
  return new BBoxGrid(bbox, gridOptions).toGeoJSON(mode);
}
