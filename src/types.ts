import type { BBoxGrid } from "./core/grid";

/** A bounding box as `[west, south, east, north]` in degrees (EPSG:4326). */
export type BBox = readonly [west: number, south: number, east: number, north: number];

/** Bounds as `[minX, minY, maxX, maxY]` in a projected CRS's coordinate units. */
export type ProjectedBounds = readonly [minX: number, minY: number, maxX: number, maxY: number];

/** Unit in which a grid resolution is expressed. British spellings are preferred; US aliases remain supported. */
export type Units = "degrees" | "metres" | "kilometres" | "meters" | "kilometers";

/** `"lines"`: one LineString per grid line. `"cells"`: one closed ring per cell. */
export type GridMode = "lines" | "cells";

/** Cell size: one number (square cells) or `[x, y]`. Interpreted using `units`. */
export type Resolution = number | readonly [x: number, y: number];

/** Cell counts: one number (same count on both axes) or `[columns, rows]`. */
export type CellCounts = number | readonly [columns: number, rows: number];

/** A GeoJSON Feature holding a single LineString. */
export interface LineFeature {
  type: "Feature";
  properties: Record<string, number | string>;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

/** A GeoJSON FeatureCollection of LineString features. */
export interface LineFeatureCollection {
  type: "FeatureCollection";
  features: LineFeature[];
}

/** Shared settings for a grid shape. */
export interface GridSettings {
  /** Unit of `resolution`. Default `"degrees"`. Metric sizes are converted at the bbox's centre latitude. */
  units?: Units;
  /** When `true` (default for metric resolutions), use a WGS84 ellipsoid approximation for metric-to-degree conversion. Set `false` for the legacy flat-Earth behaviour. */
  geodesic?: boolean;
  /** Optional safety limit on `cols * rows`. Unset by default. */
  maxCells?: number;
}

/**
 * Options that define the shape of a grid. Exactly one of `resolution` or `cells` is required.
 * The type prevents specifying both or neither for TypeScript callers.
 */
export type GridOptions = GridSettings &
  ({ resolution: Resolution; cells?: undefined } | { cells: CellCounts; resolution?: undefined });

/** Options for drawing only the visible part of a grid. */
export interface ViewportOptions {
  /** Extra area drawn around the view, as a fraction of its size. Default 0.25. */
  padding?: number;
  /**
   * Upper bound on the number of lines drawn at once. When more lines would be visible, every
   * n-th grid line is drawn instead (still aligned to the real grid). Default 1000.
   */
  maxLines?: number;
}

/** Shared options for drawing a grid on a map. */
export interface AddGridSettings extends GridSettings {
  /** Extent of the grid as `[west, south, east, north]`. */
  bbox: BBox;
  /** Id used for the map source and layer. Default `"bboxgrid"`. */
  id?: string;
  /** Mapbox `line` paint properties, merged over the defaults. */
  paint?: Record<string, unknown>;
  /** Mapbox `line` layout properties, merged over the defaults. */
  layout?: Record<string, unknown>;
  /** Insert the layer below this layer id. Only applied when the layer is first created. */
  beforeId?: string;
  /** Fit the map to the bbox. `true` uses 40px padding; pass an object for custom `fitBounds` options. */
  fit?: boolean | Record<string, unknown>;
}

/**
 * Options for {@link addBBoxGrid}. Exactly one grid shape is required; viewport mode is only
 * available for line grids.
 */
export type AddGridOptions = AddGridSettings &
  (
    | {
        resolution: Resolution;
        cells?: undefined;
        mode?: "lines";
        viewport?: boolean | ViewportOptions;
      }
    | {
        resolution: Resolution;
        cells?: undefined;
        mode: "cells";
        viewport?: false;
      }
    | {
        cells: CellCounts;
        resolution?: undefined;
        mode?: GridMode;
        viewport?: false;
      }
  );

/** Valid option changes for an existing grid layer. */
export type GridUpdateOptions = Partial<AddGridSettings> &
  (
    | {
        resolution: Resolution;
        cells?: undefined;
        mode?: "lines";
        viewport?: boolean | ViewportOptions;
      }
    | {
        resolution: Resolution;
        cells?: undefined;
        mode: "cells";
        viewport?: false;
      }
    | {
        cells: CellCounts;
        resolution?: undefined;
        mode?: GridMode;
        viewport?: false;
      }
    | {
        resolution?: undefined;
        cells?: undefined;
        mode?: GridMode;
        viewport?: boolean | ViewportOptions;
      }
  );

/** Controller returned by {@link addBBoxGrid}. */
export interface GridHandle {
  /** The grid currently in use. */
  readonly grid: BBoxGrid;
  /**
   * Redraw with new options, merged over the previous ones. Throws (and changes nothing) if the
   * merged options are invalid.
   */
  update(options: GridUpdateOptions): void;
  /** Remove the layer and source from the map and stop listening to map events. */
  remove(): void;
}

/** The corner accessors of a Mapbox `LngLatBounds`. */
export interface MapBoundsLike {
  /** Western longitude. */
  getWest(): number;
  /** Southern latitude. */
  getSouth(): number;
  /** Eastern longitude. */
  getEast(): number;
  /** Northern latitude. */
  getNorth(): number;
}

/**
 * The slice of the Mapbox GL JS `Map` API this plugin uses. Typed structurally so `mapbox-gl`
 * never has to be a hard dependency.
 */
export interface MapLike {
  /** Add a GeoJSON source. */
  addSource(id: string, source: { type: "geojson"; data: LineFeatureCollection }): unknown;
  /** Look up a source by id. */
  getSource(id: string): unknown;
  /** Remove a source by id. */
  removeSource(id: string): unknown;
  /** Add a layer, optionally below `beforeId`. */
  addLayer(layer: Record<string, unknown>, beforeId?: string): unknown;
  /** Look up a layer by id. */
  getLayer(id: string): unknown;
  /** Remove a layer by id. */
  removeLayer(id: string): unknown;
  /** Update one paint property of a layer. */
  setPaintProperty(layerId: string, name: string, value: unknown): unknown;
  /** Update one layout property of a layer. */
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
  /** Whether the current style has finished loading. */
  isStyleLoaded(): boolean;
  /** Run a listener once, when the map first loads. */
  once(type: "load", listener: () => void): unknown;
  /** Listen for the end of a pan, zoom or other camera movement. */
  on(type: "moveend", listener: () => void): unknown;
  /** Stop listening for the end of camera movements. */
  off(type: "moveend", listener: () => void): unknown;
  /** Current visible bounds. */
  getBounds(): MapBoundsLike;
  /** Move the camera to show the given bounds. */
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: Record<string, unknown>,
  ): unknown;
}

/** Styling and placement applied to the grid layer. */
export interface LayerStyle {
  /** Final `line` paint properties. */
  paint: Record<string, unknown>;
  /** Final `line` layout properties. */
  layout: Record<string, unknown>;
  /** Layer to insert below, when creating the layer. */
  beforeId?: string;
}
