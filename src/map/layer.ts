import { DEFAULT_FIT_PADDING_PX, DEFAULT_MAX_LINES } from "../constants";
import { GridError } from "../errors";
import type {
  BBox,
  LayerStyle,
  LineFeature,
  LineFeatureCollection,
  MapLike,
  MapViewportOptions,
  ViewportOptions,
} from "../types";

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
 * Resolve map-specific viewport options into a bounded geometry-generation budget.
 * @param map - Target map.
 * @param view - Visible bounds.
 * @param options - Map viewport options.
 */
export function viewportGenerationOptions(
  map: MapLike,
  view: BBox,
  options: MapViewportOptions,
): ViewportOptions {
  const { minSpacingPx, ...generationOptions } = options;
  if (minSpacingPx === undefined) {
    return generationOptions;
  }
  if (!Number.isFinite(minSpacingPx) || minSpacingPx <= 0) {
    throw new GridError("viewport minSpacingPx must be positive and finite");
  }
  if (!map.project) {
    throw new GridError("viewport minSpacingPx requires map.project()");
  }

  const padding = options.padding ?? 0.25;
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GridError("viewport padding must be >= 0");
  }
  const padX = (view[2] - view[0]) * padding;
  const padY = (view[3] - view[1]) * padding;
  const west = view[0] - padX;
  const east = view[2] + padX;
  const south = view[1] - padY;
  const north = view[3] + padY;
  const centerX = (west + east) / 2;
  const centerY = (south + north) / 2;
  const left = map.project([west, centerY]);
  const right = map.project([east, centerY]);
  const bottom = map.project([centerX, south]);
  const top = map.project([centerX, north]);
  const width = Math.hypot(right.x - left.x, right.y - left.y);
  const height = Math.hypot(top.x - bottom.x, top.y - bottom.y);
  if (![width, height].every(Number.isFinite)) {
    throw new GridError("map.project() returned invalid viewport coordinates");
  }

  const pixelBudget = Math.max(
    1,
    Math.ceil(width / minSpacingPx) + Math.ceil(height / minSpacingPx) + 2,
  );
  return {
    ...generationOptions,
    maxLines:
      generationOptions.maxLines === undefined
        ? Math.max(DEFAULT_MAX_LINES, pixelBudget)
        : Math.min(generationOptions.maxLines, pixelBudget),
  };
}

/**
 * Thin viewport lines by measured screen-space spacing, preserving grid-index multiples.
 * @param map - Target map.
 * @param data - Generated viewport lines.
 * @param minSpacingPx - Minimum target spacing.
 */
export function thinGridByPixelSpacing(
  map: MapLike,
  data: LineFeatureCollection,
  minSpacingPx: number | undefined,
): LineFeatureCollection {
  if (minSpacingPx === undefined) {
    return data;
  }
  if (!Number.isFinite(minSpacingPx) || minSpacingPx <= 0) {
    throw new GridError("viewport minSpacingPx must be positive and finite");
  }
  if (!map.project) {
    throw new GridError("viewport minSpacingPx requires map.project()");
  }

  type Candidate = { axis: string; index: number; point: [number, number] };
  const candidates: Candidate[] = [];
  for (const feature of data.features) {
    const axis = feature.properties.axis;
    if (axis !== "x" && axis !== "y") {
      continue;
    }
    if (feature.geometry.type === "LineString") {
      const index = feature.properties.index;
      const point =
        feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)];
      if (typeof index === "number" && point) {
        candidates.push({ axis, index, point });
      }
    } else {
      const indices = feature.properties.indices;
      if (!Array.isArray(indices)) {
        continue;
      }
      feature.geometry.coordinates.forEach((line, component) => {
        const index = indices[component];
        const point = line[Math.floor(line.length / 2)];
        if (typeof index === "number" && point) {
          candidates.push({ axis, index, point });
        }
      });
    }
  }

  const retained = new Set<string>();
  for (const axis of ["x", "y"] as const) {
    const lines = candidates
      .filter((candidate) => candidate.axis === axis)
      .sort((a, b) => a.index - b.index);
    const unique = lines.filter(
      (line, index) => index === 0 || line.index !== lines[index - 1].index,
    );
    if (unique.length < 2) {
      for (const line of lines) {
        retained.add(`${axis}:${line.index}`);
      }
      continue;
    }

    const projected = unique.map((line) => {
      const point = map.project?.(line.point);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new GridError("map.project() returned invalid grid-line coordinates");
      }
      return { index: line.index, x: point.x, y: point.y };
    });
    let minDistance = Number.POSITIVE_INFINITY;
    let baseStride = Number.POSITIVE_INFINITY;
    for (let index = 1; index < projected.length; index += 1) {
      const previous = projected[index - 1];
      const current = projected[index];
      minDistance = Math.min(
        minDistance,
        Math.hypot(current.x - previous.x, current.y - previous.y),
      );
      baseStride = Math.min(baseStride, current.index - previous.index);
    }
    const multiplier =
      minDistance <= 0 ? lines.length : Math.max(1, Math.ceil(minSpacingPx / minDistance));
    const stride = baseStride * multiplier;
    const first = unique[0].index;
    const last = unique[unique.length - 1].index;
    for (const line of lines) {
      if (line.index === first || line.index === last || Math.abs(line.index % stride) === 0) {
        retained.add(`${axis}:${line.index}`);
      }
    }
  }

  const features: LineFeature[] = [];
  for (const feature of data.features) {
    const axis = feature.properties.axis;
    if (axis !== "x" && axis !== "y") {
      features.push(feature);
    } else if (feature.geometry.type === "LineString") {
      const index = feature.properties.index;
      if (typeof index !== "number" || retained.has(`${axis}:${index}`)) {
        features.push(feature);
      }
    } else {
      const indices = feature.properties.indices;
      if (!Array.isArray(indices)) {
        features.push(feature);
        continue;
      }
      const coordinates: [number, number][][] = [];
      const keptIndices: number[] = [];
      feature.geometry.coordinates.forEach((line, component) => {
        const index = indices[component];
        if (typeof index !== "number" || retained.has(`${axis}:${index}`)) {
          coordinates.push(line);
          if (typeof index === "number") {
            keptIndices.push(index);
          }
        }
      });
      if (coordinates.length > 0) {
        features.push({
          ...feature,
          properties: { ...feature.properties, indices: keptIndices },
          geometry: { type: "MultiLineString", coordinates },
        });
      }
    }
  }
  return { type: "FeatureCollection", features };
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
    {
      id,
      type: "line",
      source: id,
      layout: style.layout,
      paint: style.paint,
      minzoom: style.minzoom,
      maxzoom: style.maxzoom,
      slot: style.slot,
    },
    style.beforeId,
  );
}

/**
 * Apply paint and layout properties to an existing grid layer.
 * @param map - Target map.
 * @param id - Layer id.
 * @param style - Properties to apply.
 */
export function restyleGrid(
  map: MapLike,
  id: string,
  style: LayerStyle,
  placement: boolean = false,
): void {
  if (!map.getLayer(id)) {
    return;
  }
  for (const [name, value] of Object.entries(style.paint)) {
    map.setPaintProperty(id, name, value);
  }
  for (const [name, value] of Object.entries(style.layout)) {
    map.setLayoutProperty(id, name, value);
  }
  if (style.minzoom !== undefined || style.maxzoom !== undefined) {
    if (!map.setLayerZoomRange) {
      throw new GridError("map does not support updating layer zoom ranges");
    }
    map.setLayerZoomRange(id, style.minzoom, style.maxzoom);
  }
  if (style.slot !== undefined) {
    if (!map.setSlot) {
      throw new GridError("map does not support Mapbox Standard style slots");
    }
    map.setSlot(id, style.slot);
  }
  if (placement) {
    if (!map.moveLayer) {
      throw new GridError("map does not support updating layer order");
    }
    map.moveLayer(id, style.beforeId);
  }
}

/**
 * Change layer visibility without rebuilding its source.
 * @param map - Target map.
 * @param id - Layer id.
 * @param visible - Whether the layer should be visible.
 */
export function setGridVisibility(map: MapLike, id: string, visible: boolean): void {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
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
