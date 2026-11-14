import { GridError } from "../errors";
import type { BBox, CellCounts } from "../types";

/**
 * Validate a bounding box and return it as a typed tuple.
 * @param bbox - Candidate `[west, south, east, north]`.
 * @throws {GridError} If it is malformed, out of range or crosses the antimeridian.
 */
export function validateBBox(bbox: readonly number[]): BBox {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((v) => Number.isFinite(v))) {
    throw new GridError("bbox must be four finite numbers: [west, south, east, north]");
  }
  const [west, south, east, north] = bbox;
  if (!(-180 <= west && west < east && east <= 180)) {
    throw new GridError(
      "need -180 <= west < east <= 180 (boxes crossing the antimeridian are not supported; split them in two)",
    );
  }
  if (!(-90 <= south && south < north && north <= 90)) {
    throw new GridError("need -90 <= south < north <= 90");
  }
  return [west, south, east, north];
}

/**
 * Normalise a `cells` option to `[cols, rows]`.
 * @param cells - One integer (used for both axes) or `[cols, rows]`.
 * @throws {GridError} If either count is not an integer >= 1.
 */
export function normaliseCells(cells: CellCounts): [number, number] {
  const [cols, rows] = Array.isArray(cells) ? cells : [cells, cells];
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new GridError("cells must be integers >= 1");
  }
  return [cols, rows];
}
