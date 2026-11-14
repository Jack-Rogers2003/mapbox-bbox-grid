import { DEFAULT_FIT_PADDING_PX } from "../constants";
import type { BBox, LayerStyle, LineFeatureCollection, MapLike } from "../types";

/** A GeoJSON source whose data can be replaced in place. */
interface UpdatableSource {
  /** Replace the source's data. */
  setData(data: LineFeatureCollection): void;
}

/**
 * Whether a value returned by `map.getSource` can be updated with `setData`.
 * @param source - Value to test.
 */
function isUpdatableSource(source: unknown): source is UpdatableSource {
  return (
    typeof source === "object" &&
    source !== null &&
    "setData" in source &&
    typeof source.setData === "function"
  );
}

/**
 * Run `callback` now if the style is loaded, otherwise once the map fires `load`.
 * @param map - Map to wait on.
 * @param callback - Work that needs a loaded style.
 */
export function whenStyleReady(map: MapLike, callback: () => void): void {
  if (map.isStyleLoaded()) {
    callback();
  } else {
    map.once("load", callback);
  }
}

/**
 * Show `data` on the map: update the source if it exists, otherwise create source and layer.
 * @param map - Target map.
 * @param id - Id shared by the source and the layer.
 * @param data - GeoJSON to display.
 * @param style - Paint, layout and placement used when the layer is created.
 */
export function drawGrid(
  map: MapLike,
  id: string,
  data: LineFeatureCollection,
  style: LayerStyle,
): void {
  const source = map.getSource(id);
  if (isUpdatableSource(source)) {
    source.setData(data);
    return;
  }
  map.addSource(id, { type: "geojson", data });
  map.addLayer(
    { id, type: "line", source: id, layout: style.layout, paint: style.paint },
    style.beforeId,
  );
}

/**
 * Apply paint and layout properties to an existing grid layer.
 * @param map - Target map.
 * @param id - Layer id.
 * @param style - Properties to apply.
 */
export function restyleGrid(map: MapLike, id: string, style: LayerStyle): void {
  if (!map.getLayer(id)) {
    return;
  }
  for (const [name, value] of Object.entries(style.paint)) {
    map.setPaintProperty(id, name, value);
  }
  for (const [name, value] of Object.entries(style.layout)) {
    map.setLayoutProperty(id, name, value);
  }
}

/**
 * Remove the grid layer and source if present.
 * @param map - Target map.
 * @param id - Id shared by the layer and the source.
 */
export function removeGrid(map: MapLike, id: string): void {
  if (map.getLayer(id)) {
    map.removeLayer(id);
  }
  if (map.getSource(id)) {
    map.removeSource(id);
  }
}

/**
 * Move the camera to show a bounding box.
 * @param map - Target map.
 * @param bbox - Box to show.
 * @param fit - `true` for default padding, or custom `fitBounds` options.
 */
export function fitToBBox(map: MapLike, bbox: BBox, fit: true | Record<string, unknown>): void {
  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    fit === true ? { padding: DEFAULT_FIT_PADDING_PX } : fit,
  );
}
