import type { LineFeature } from "../types";

/**
 * Build a GeoJSON LineString feature.
 * @param coordinates - `[lon, lat]` positions.
 * @param properties - Feature properties.
 */
export function lineFeature(
  coordinates: [number, number][],
  properties: Record<string, number | string>,
): LineFeature {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
}
