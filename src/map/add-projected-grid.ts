import { DEFAULT_LAYER_ID, DEFAULT_LAYOUT, DEFAULT_PAINT } from "../constants";
import {
  createProjectedGridFromBounds,
  type ProjectedBoundsGridOptions,
} from "../core/projected-grid";
import type { LayerStyle, MapLike, ProjectedBounds } from "../types";
import { drawGrid, removeGrid, whenStyleReady } from "./layer";

/** Options for drawing a chart-CRS grid directly on a Mapbox GL JS map. */
export interface AddProjectedGridOptions extends ProjectedBoundsGridOptions {
  /** Id used by the map source and layer. Default `"bboxgrid"`. */
  id?: string;
  /** Mapbox `line` paint properties, merged over the defaults. */
  paint?: Record<string, unknown>;
  /** Mapbox `line` layout properties, merged over the defaults. */
  layout?: Record<string, unknown>;
  /** Insert the layer below this layer id. Only applied when the layer is created. */
  beforeId?: string;
}

/** Handle for a projected grid overlay. */
export interface ProjectedGridOverlayHandle {
  /** Remove the grid layer and source from the map. */
  remove(): void;
}

/** Combine default and caller-provided layer style. */
function styleOf(options: AddProjectedGridOptions): LayerStyle {
  return {
    paint: { ...DEFAULT_PAINT, ...options.paint },
    layout: { ...DEFAULT_LAYOUT, ...options.layout },
    beforeId: options.beforeId,
  };
}

/**
 * Draw a grid aligned to bounds, resolution and origin in the chart's projected CRS.
 * The grid is generated in CRS coordinates and transformed to WGS84 GeoJSON for map rendering.
 * `resolution` and `origin` use the CRS's native linear units.
 * @param map - A Mapbox GL JS map or a structurally compatible map.
 * @param bounds - `[minX, minY, maxX, maxY]` in the chart CRS.
 * @param options - Grid CRS, spacing, origin, styles and generation limits.
 * @returns A handle that removes the overlay.
 * @throws {GridError} If bounds, CRS, resolution or generation limits are invalid.
 */
export function addProjectedGrid(
  map: MapLike,
  bounds: ProjectedBounds,
  options: AddProjectedGridOptions,
): ProjectedGridOverlayHandle {
  const data = createProjectedGridFromBounds(bounds, options);
  const id = options.id ?? DEFAULT_LAYER_ID;
  let removed = false;

  whenStyleReady(map, () => {
    if (removed) {
      removeGrid(map, id);
      return;
    }
    drawGrid(map, id, data, styleOf(options));
  });

  return {
    /** Remove the grid layer and source from the map. */
    remove(): void {
      removed = true;
      whenStyleReady(map, () => removeGrid(map, id));
    },
  };
}
