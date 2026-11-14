import { METRES_PER_DEGREE_LAT } from "../constants";
import { GridError } from "../errors";
import type { BBox, GridOptions, Resolution, Units } from "../types";
import { normaliseCells } from "./validate";

const WGS84_A = 6_378_137;
const WGS84_E2 = 0.00669438;

/**
 * Approximate the ground length of one degree at latitude `lat` using the WGS84 ellipsoid.
 * @param lat - Latitude in degrees.
 * @returns `{ latitude: metres per degree of latitude, longitude: metres per degree of longitude }`.
 */
function metresPerDegree(lat: number): { latitude: number; longitude: number } {
  const radians = (lat * Math.PI) / 180;
  const sinLat = Math.sin(radians);
  const cosLat = Math.cos(radians);
  if (Math.abs(cosLat) < 1e-12) {
    throw new GridError("metric resolution is undefined at the poles; use units: 'degrees'");
  }

  const primeVertical = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const meridional = (WGS84_A * (1 - WGS84_E2)) / (1 - WGS84_E2 * sinLat * sinLat) ** 1.5;

  return {
    latitude: (Math.PI / 180) * meridional,
    longitude: (Math.PI / 180) * primeVertical * cosLat,
  };
}

/**
 * Convert a resolution in `units` to cell sizes in degrees. Metric sizes use the bbox's centre
 * latitude and the WGS84 ellipsoid, so cells are only exactly square on the ground there.
 * @param bbox - Validated bounding box.
 * @param resolution - One number or `[x, y]`.
 * @param units - Unit of `resolution`.
 * @returns `[xStep, yStep]` in degrees.
 * @throws {GridError} For non-positive resolutions, unknown units, or metric units at the poles.
 */
export function resolutionToSteps(
  bbox: BBox,
  resolution: Resolution,
  units: Units,
  geodesic = true,
): [number, number] {
  const [rx, ry] = Array.isArray(resolution) ? resolution : [resolution, resolution];
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= 0 || ry <= 0) {
    throw new GridError("resolution must be positive and finite");
  }
  if (units === "degrees") {
    return [rx, ry];
  }
  if (
    units !== "metres" &&
    units !== "kilometres" &&
    units !== "meters" &&
    units !== "kilometers"
  ) {
    throw new GridError("units must be 'degrees', 'metres'/'meters' or 'kilometres'/'kilometers'");
  }
  const scale = units === "kilometres" || units === "kilometers" ? 1000 : 1;
  const centreLat = (bbox[1] + bbox[3]) / 2;

  if (!geodesic) {
    return [
      (rx * scale) / (METRES_PER_DEGREE_LAT * Math.cos((centreLat * Math.PI) / 180)),
      (ry * scale) / METRES_PER_DEGREE_LAT,
    ];
  }

  const lengths = metresPerDegree(centreLat);
  return [(rx * scale) / lengths.longitude, (ry * scale) / lengths.latitude];
}

/**
 * Work out the cell size in degrees from either `resolution` or `cells`.
 * @param bbox - Validated bounding box.
 * @param options - Grid options; exactly one of `resolution` / `cells` must be set.
 * @returns `[xStep, yStep]` in degrees.
 * @throws {GridError} If neither or both are provided, or a value is invalid.
 */
export function resolveSteps(bbox: BBox, options: GridOptions): [number, number] {
  const { resolution, cells, units = "degrees", geodesic = true } = options;
  if (cells !== undefined && resolution === undefined) {
    const [cols, rows] = normaliseCells(cells);
    return [(bbox[2] - bbox[0]) / cols, (bbox[3] - bbox[1]) / rows];
  }
  if (resolution !== undefined && cells === undefined) {
    return resolutionToSteps(bbox, resolution, units, geodesic);
  }
  throw new GridError("provide exactly one of `resolution` or `cells`");
}
