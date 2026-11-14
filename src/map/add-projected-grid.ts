import { DEFAULT_LAYER_ID, DEFAULT_LAYOUT, DEFAULT_PAINT } from "../constants";
import {
  createProjectedGridFromBoundsFactory,
  fromGeoTransform,
  type GeoTransformGridSource,
  type ProjectedBoundsGridOptions,
} from "../core/projected-grid";
import {
  type ProjectedGridWorker,
  type ProjectedGridWorkerErrorHandler,
  parseProjectedGridWorkerResponse,
} from "../core/projected-grid-worker";
import { GridError } from "../errors";
import type {
  BBox,
  LayerStyle,
  LineFeatureCollection,
  MapLike,
  ProjectedBounds,
  ViewportOptions,
} from "../types";
import { drawGrid, removeGrid, restyleGrid, setGridVisibility, whenStyleReady } from "./layer";

/** Options for drawing a chart-CRS grid directly on a map. */
export type AddProjectedGridOptions = Omit<ProjectedBoundsGridOptions, "resolution"> & {
  /** Cell size in the CRS's native linear units. Defaults to the GDAL pixel size for affine input. */
  resolution?: ProjectedBoundsGridOptions["resolution"];
  /** Draw only the visible area and refresh when map movement ends. */
  viewport?: boolean | ViewportOptions;
  /** Id used by the map source and layer. Default `"bboxgrid"`. */
  id?: string;
  /** Mapbox `line` paint properties, merged over the defaults. */
  paint?: Record<string, unknown>;
  /** Mapbox `line` layout properties, merged over the defaults. */
  layout?: Record<string, unknown>;
  /** Insert the layer below this layer id. */
  beforeId?: string;
  /** Minimum zoom at which the layer is visible. */
  minzoom?: number;
  /** Maximum zoom at which the layer is visible. */
  maxzoom?: number;
  /** Mapbox Standard style slot. */
  slot?: string;
  /** Optional module worker used for projected GeoJSON generation. */
  worker?: ProjectedGridWorker;
  /** Receives grid-generation errors returned by the worker. */
  onWorkerError?: ProjectedGridWorkerErrorHandler;
};

/** Handle for a projected grid overlay. */
export interface ProjectedGridOverlayHandle {
  /** Show the layer without rebuilding the grid. */
  show(): void;
  /** Hide the layer without rebuilding the grid. */
  hide(): void;
  /** Update grid or layer options. */
  update(options: Partial<AddProjectedGridOptions>): void;
  /** Remove the grid layer and source. */
  remove(): void;
}

/** Options for deriving a grid from a Mapbox Web Mercator tile-pixel lattice. */
export type TilePixelGridOptions = Omit<
  AddProjectedGridOptions,
  "crs" | "origin" | "resolution"
> & {
  /** Web Mercator zoom level. */
  zoom: number;
  /** Tile width in pixels. Default `256`. */
  tileSize?: number;
};

type ResolvedOptions = AddProjectedGridOptions & {
  resolution: ProjectedBoundsGridOptions["resolution"];
};

/** Combine default and caller-provided layer style. */
function styleOf(options: AddProjectedGridOptions): LayerStyle {
  return {
    paint: { ...DEFAULT_PAINT, ...options.paint },
    layout: { ...DEFAULT_LAYOUT, ...options.layout },
    beforeId: options.beforeId,
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
  };
}

/** Return whether a source is a GDAL transform object. */
function isGeoTransformSource(
  bounds: ProjectedBounds | GeoTransformGridSource,
): bounds is GeoTransformGridSource {
  return !Array.isArray(bounds) && "affine_transform" in bounds;
}

/** Round map bounds so sub-centimetre camera noise does not trigger a new source update. */
function snappedViewKey(view: BBox): string {
  return view.map((coordinate) => Math.round(coordinate * 1e7) / 1e7).join(",");
}

/**
 * Draw a projected-CRS grid on a Mapbox GL JS map.
 * Grid positions are calculated in the CRS and transformed to WGS84 GeoJSON.
 * Pass a Proj4 definition string as `crs` when registry names cannot be shared between copies of
 * Proj4js in the consumer bundle.
 * @param map - A Mapbox GL JS map or a structurally compatible map.
 * @param bounds - Projected `[minX, minY, maxX, maxY]` bounds or GDAL transform and raster shape.
 * @param options - Grid CRS, spacing, origin, styles and generation limits.
 * @returns A handle to show, hide, update or remove the overlay.
 * @throws {GridError} If bounds, CRS, resolution or generation limits are invalid.
 */
export function addProjectedGrid(
  map: MapLike,
  bounds: ProjectedBounds | GeoTransformGridSource,
  options: AddProjectedGridOptions,
): ProjectedGridOverlayHandle {
  let gridBounds: ProjectedBounds;
  let resolved: ResolvedOptions;
  if (isGeoTransformSource(bounds)) {
    const derived = fromGeoTransform(bounds.affine_transform, bounds.shape);
    gridBounds = derived.bounds;
    const resolution = options.resolution ?? derived.resolution;
    resolved = {
      ...options,
      resolution,
      origin: options.origin ?? derived.origin,
    };
  } else {
    gridBounds = bounds;
    if (options.resolution === undefined) {
      throw new GridError("resolution is required when bounds are not a GDAL transform");
    }
    resolved = { ...options, resolution: options.resolution };
  }
  let id = resolved.id ?? DEFAULT_LAYER_ID;
  let optionsState = resolved;
  let generator = createProjectedGridFromBoundsFactory(gridBounds, optionsState);
  let removed = false;
  let listening = false;
  let visible = true;
  let lastViewKey: string | undefined;
  let latestWorkerRequest = 0;

  const viewportOptions = (): ViewportOptions | undefined => {
    if (!optionsState.viewport) {
      return undefined;
    }
    return optionsState.viewport === true ? {} : optionsState.viewport;
  };
  const redraw = (force: boolean = false): void => {
    if (removed) {
      return;
    }
    const viewport = viewportOptions();
    let data: LineFeatureCollection;
    if (viewport) {
      const bounds = map.getBounds();
      const view: BBox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      const key = snappedViewKey(view);
      if (!force && key === lastViewKey) {
        return;
      }
      if (optionsState.worker) {
        const requestId = ++latestWorkerRequest;
        optionsState.worker.postMessage({
          type: "projected-grid",
          requestId,
          bounds: gridBounds,
          options: workerGridOptions(),
          view,
          viewportOptions: viewport,
        });
        lastViewKey = key;
        return;
      }
      data = generator.viewport(view, viewport);
      lastViewKey = key;
    } else {
      if (optionsState.worker) {
        const requestId = ++latestWorkerRequest;
        optionsState.worker.postMessage({
          type: "projected-grid",
          requestId,
          bounds: gridBounds,
          options: workerGridOptions(),
        });
        return;
      }
      data = generator.full();
      lastViewKey = undefined;
    }
    drawGrid(map, id, data, styleOf(optionsState));
    if (!visible) {
      setGridVisibility(map, id, false);
    }
  };
  const workerGridOptions = (): ProjectedBoundsGridOptions => ({
    crs: optionsState.crs,
    resolution: optionsState.resolution,
    origin: optionsState.origin,
    maxLines: optionsState.maxLines,
    maxSegmentLength: optionsState.maxSegmentLength,
  });
  const handleWorkerMessage = (event: { data: unknown }): void => {
    const response = parseProjectedGridWorkerResponse(event.data);
    if (!response || response.requestId !== latestWorkerRequest || removed) {
      return;
    }
    if (response.type === "projected-grid-error") {
      const error = new GridError(`projected-grid worker failed: ${response.error}`);
      if (optionsState.onWorkerError) {
        optionsState.onWorkerError(error);
      } else {
        throw error;
      }
      return;
    }
    whenStyleReady(map, () => {
      if (removed || !response.data) {
        return;
      }
      drawGrid(map, id, response.data, styleOf(optionsState));
      if (!visible) {
        setGridVisibility(map, id, false);
      }
    });
  };
  optionsState.worker?.addEventListener("message", handleWorkerMessage);
  const handleMoveEnd = (): void => {
    whenStyleReady(map, () => redraw());
  };
  const syncListener = (): void => {
    const shouldListen = !removed && viewportOptions() !== undefined;
    if (shouldListen && !listening) {
      map.on("moveend", handleMoveEnd);
      listening = true;
    } else if (!shouldListen && listening) {
      map.off("moveend", handleMoveEnd);
      listening = false;
    }
  };
  syncListener();
  whenStyleReady(map, () => redraw(true));

  return {
    show(): void {
      if (removed) {
        return;
      }
      visible = true;
      whenStyleReady(map, () => setGridVisibility(map, id, visible));
    },
    hide(): void {
      if (removed) {
        return;
      }
      visible = false;
      whenStyleReady(map, () => setGridVisibility(map, id, visible));
    },
    update(next): void {
      if (removed) {
        return;
      }
      const merged = { ...optionsState, ...next };
      if (next.worker !== undefined && next.worker !== optionsState.worker) {
        throw new GridError("the projected-grid worker cannot be changed after creation");
      }
      const resolution = merged.resolution;
      if (resolution === undefined) {
        throw new GridError("resolution is required");
      }
      const gridChanged =
        JSON.stringify([
          merged.crs,
          merged.origin,
          resolution,
          merged.maxLines,
          merged.maxSegmentLength,
        ]) !==
        JSON.stringify([
          optionsState.crs,
          optionsState.origin,
          optionsState.resolution,
          optionsState.maxLines,
          optionsState.maxSegmentLength,
        ]);
      const viewportChanged =
        JSON.stringify(merged.viewport) !== JSON.stringify(optionsState.viewport);
      const previousId = id;
      const nextId = merged.id ?? DEFAULT_LAYER_ID;
      const idChanged = nextId !== previousId;
      const nextGenerator = gridChanged
        ? createProjectedGridFromBoundsFactory(gridBounds, {
            crs: merged.crs,
            origin: merged.origin,
            resolution,
            maxLines: merged.maxLines,
            maxSegmentLength: merged.maxSegmentLength,
          })
        : generator;
      optionsState = { ...merged, resolution };
      generator = nextGenerator;
      id = nextId;
      if (gridChanged || viewportChanged) {
        lastViewKey = undefined;
      }
      syncListener();
      whenStyleReady(map, () => {
        if (idChanged) {
          removeGrid(map, previousId);
        }
        if (gridChanged || viewportChanged || idChanged) {
          redraw(true);
        } else if (
          next.paint !== undefined ||
          next.layout !== undefined ||
          next.minzoom !== undefined ||
          next.maxzoom !== undefined ||
          next.slot !== undefined ||
          next.beforeId !== undefined
        ) {
          restyleGrid(map, id, styleOf(optionsState), next.beforeId !== undefined);
        }
      });
    },
    remove(): void {
      removed = true;
      syncListener();
      optionsState.worker?.removeEventListener("message", handleWorkerMessage);
      whenStyleReady(map, () => removeGrid(map, id));
    },
  };
}

/**
 * Add a projected grid aligned to Web Mercator tile pixels at a zoom level.
 * `bounds` are EPSG:3857 coordinates, not longitude/latitude.
 * @param map - Map to draw on.
 * @param bounds - `[minX, minY, maxX, maxY]` in EPSG:3857 metres.
 * @param options - Zoom, tile size and ordinary projected-grid layer options.
 */
export function addTilePixelGrid(
  map: MapLike,
  bounds: ProjectedBounds,
  options: TilePixelGridOptions,
): ProjectedGridOverlayHandle {
  const { zoom, tileSize = 256, ...layerOptions } = options;
  if (!Number.isInteger(zoom) || zoom < 0 || !Number.isInteger(tileSize) || tileSize <= 0) {
    throw new GridError("zoom must be a non-negative integer and tileSize a positive integer");
  }
  const worldSize = 40_075_016.685_578_49;
  const halfWorld = worldSize / 2;
  const resolution = worldSize / (tileSize * 2 ** zoom);
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new GridError("tile zoom and size produce an invalid pixel resolution");
  }
  return addProjectedGrid(map, bounds, {
    ...layerOptions,
    crs: "EPSG:3857",
    origin: [-halfWorld, -halfWorld],
    resolution,
  });
}
