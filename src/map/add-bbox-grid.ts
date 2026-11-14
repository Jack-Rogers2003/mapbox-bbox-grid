import { DEFAULT_LAYER_ID, DEFAULT_LAYOUT, DEFAULT_PAINT } from "../constants";
import { BBoxGrid } from "../core/grid";
import { GridError } from "../errors";
import type {
  AddGridOptions,
  BBox,
  GridHandle,
  GridOptions,
  GridUpdateOptions,
  LayerStyle,
  MapBoundsLike,
  MapLike,
  ViewportOptions,
} from "../types";
import {
  drawGrid,
  fitToBBox,
  removeGrid,
  restyleGrid,
  setGridVisibility,
  whenStyleReady,
} from "./layer";

/**
 * Normalise the `viewport` option.
 * @param viewport - The raw option value.
 * @returns Viewport options, or `undefined` when viewport mode is off.
 */
function resolveViewport(viewport: AddGridOptions["viewport"]): ViewportOptions | undefined {
  if (!viewport) {
    return undefined;
  }
  return viewport === true ? {} : viewport;
}

/**
 * Convert Mapbox bounds to a bounding box tuple.
 * @param bounds - Bounds from `map.getBounds()`.
 */
function boundsToBBox(bounds: MapBoundsLike): BBox {
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

/**
 * Merge new options over old ones. `resolution` and `cells` are alternatives: setting one
 * clears the other.
 * @param previous - Current options.
 * @param next - Changes to apply.
 */
function mergeOptions(previous: AddGridOptions, next: GridUpdateOptions): AddGridOptions {
  const merged = { ...previous, ...next };
  if (next.resolution !== undefined && next.cells === undefined) {
    merged.cells = undefined;
  }
  if (next.cells !== undefined && next.resolution === undefined) {
    merged.resolution = undefined;
  }

  const { resolution, cells, mode, viewport, ...shared } = merged;
  if (cells !== undefined) {
    if (viewport) {
      throw new GridError("viewport mode only supports mode: 'lines'");
    }
    return { ...shared, cells, mode, viewport };
  }
  if (resolution === undefined) {
    throw new GridError("provide exactly one of `resolution` or `cells`");
  }
  if (mode === "cells") {
    if (viewport) {
      throw new GridError("viewport mode only supports mode: 'lines'");
    }
    return { ...shared, resolution, mode, viewport };
  }
  return { ...shared, resolution, mode, viewport };
}

/**
 * Build (and thereby validate) the grid for a set of options.
 * @param options - Layer options.
 * @throws {GridError} For invalid options, or viewport mode combined with `mode: "cells"`.
 */
function buildGrid(options: AddGridOptions): BBoxGrid {
  const viewport = resolveViewport(options.viewport);
  if (viewport && (options.mode ?? "lines") === "cells") {
    throw new GridError("viewport mode only supports mode: 'lines'");
  }
  const sharedOptions = {
    units: options.units,
    geodesic: options.geodesic,
    // Viewport mode only ever draws a bounded number of lines, so the cell cap doesn't apply.
    maxCells: viewport ? Number.POSITIVE_INFINITY : options.maxCells,
  };
  const gridOptions: GridOptions =
    options.cells !== undefined
      ? { ...sharedOptions, cells: options.cells }
      : { ...sharedOptions, resolution: options.resolution };
  return new BBoxGrid(options.bbox, gridOptions);
}

/**
 * Final paint, layout and placement for a set of options.
 * @param options - Layer options.
 */
function styleOf(options: AddGridOptions): LayerStyle {
  return {
    paint: { ...DEFAULT_PAINT, ...options.paint },
    layout: { ...DEFAULT_LAYOUT, ...options.layout },
    beforeId: options.beforeId,
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
  };
}

/** A bbox grid drawn on a Mapbox map. */
class BBoxGridLayer implements GridHandle {
  private readonly map: MapLike;
  private options: AddGridOptions;
  private current: BBoxGrid;
  private removed: boolean = false;
  private listening: boolean = false;
  private visible: boolean = true;

  /** Redraws the visible part of the grid when the camera stops moving. */
  private readonly handleMoveEnd = (): void => {
    whenStyleReady(this.map, () => this.redraw());
  };

  /**
   * Create the layer and draw it as soon as the style is ready.
   * @param map - Target map.
   * @param options - Layer options.
   * @throws {GridError} For invalid options (before anything is added to the map).
   */
  public constructor(map: MapLike, options: AddGridOptions) {
    this.map = map;
    this.options = { ...options };
    this.current = buildGrid(this.options);
    this.syncListener();
    whenStyleReady(map, () => this.redraw());
    if (options.fit) {
      fitToBBox(map, this.current.bbox, options.fit);
    }
  }

  /** The grid currently in use. */
  public get grid(): BBoxGrid {
    return this.current;
  }

  /**
   * Redraw with new options merged over the old ones.
   * @param next - Options to change.
   * @throws {GridError} If the merged options are invalid; the map is left untouched.
   */
  public update(next: GridUpdateOptions): void {
    if (this.removed) {
      return;
    }
    const merged = mergeOptions(this.options, next);
    const nextGrid = buildGrid(merged); // validate before changing anything
    const previousId = this.options.id ?? DEFAULT_LAYER_ID;
    this.options = merged;
    this.current = nextGrid;
    const id = merged.id ?? DEFAULT_LAYER_ID;
    this.syncListener();
    whenStyleReady(this.map, () => {
      if (id !== previousId) {
        removeGrid(this.map, previousId);
      }
      this.redraw();
      if (
        next.paint ||
        next.layout ||
        next.minzoom !== undefined ||
        next.maxzoom !== undefined ||
        next.slot !== undefined ||
        next.beforeId !== undefined
      ) {
        restyleGrid(this.map, id, styleOf(merged), next.beforeId !== undefined);
      }
    });
    if (next.fit) {
      fitToBBox(this.map, nextGrid.bbox, next.fit);
    }
  }

  /** Remove the layer and source and stop listening to map events. */
  public remove(): void {
    this.removed = true;
    this.syncListener();
    removeGrid(this.map, this.options.id ?? DEFAULT_LAYER_ID);
  }

  /** Show the layer without rebuilding its source. */
  public show(): void {
    if (this.removed) {
      return;
    }
    this.visible = true;
    whenStyleReady(this.map, () =>
      setGridVisibility(this.map, this.options.id ?? DEFAULT_LAYER_ID, this.visible),
    );
  }

  /** Hide the layer without removing its source. */
  public hide(): void {
    if (this.removed) {
      return;
    }
    this.visible = false;
    whenStyleReady(this.map, () =>
      setGridVisibility(this.map, this.options.id ?? DEFAULT_LAYER_ID, this.visible),
    );
  }

  /** Generate the GeoJSON for the current options and send it to the map. */
  private redraw(): void {
    if (this.removed) {
      return;
    }
    const viewport = resolveViewport(this.options.viewport);
    const data = viewport
      ? this.current.linesInView(boundsToBBox(this.map.getBounds()), viewport)
      : this.current.toGeoJSON(this.options.mode ?? "lines");
    drawGrid(this.map, this.options.id ?? DEFAULT_LAYER_ID, data, styleOf(this.options));
    if (!this.visible) {
      setGridVisibility(this.map, this.options.id ?? DEFAULT_LAYER_ID, false);
    }
  }

  /** Subscribe to `moveend` only while viewport mode is on and the layer is not removed. */
  private syncListener(): void {
    const wanted = !this.removed && resolveViewport(this.options.viewport) !== undefined;
    if (wanted && !this.listening) {
      this.map.on("moveend", this.handleMoveEnd);
      this.listening = true;
    } else if (!wanted && this.listening) {
      this.map.off("moveend", this.handleMoveEnd);
      this.listening = false;
    }
  }
}

/**
 * Draw a bounding-box grid on a Mapbox GL JS map. Safe to call before the style has loaded.
 * @param map - A `mapboxgl.Map` (or anything matching {@link MapLike}).
 * @param options - Grid shape, styling and behaviour.
 * @returns A handle to update or remove the grid.
 * @throws {GridError} For invalid options.
 * @example
 * const handle = addBBoxGrid(map, {
 *   bbox: [-2.7, 51.4, -2.5, 51.5],
 *   resolution: 2,
 *   units: "kilometres",
 *   viewport: true,
 *   fit: true,
 * });
 * handle.update({ resolution: 1 });
 * handle.remove();
 */
export function addBBoxGrid(map: MapLike, options: AddGridOptions): GridHandle {
  return new BBoxGridLayer(map, options);
}
