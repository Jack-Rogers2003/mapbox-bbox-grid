import { DEFAULT_LAYER_ID, DEFAULT_LAYOUT, DEFAULT_PAINT } from "../constants";
import { BBoxGrid } from "../core/grid";
import {
  createProjectedGridFromBoundsFactory,
  fromGeoTransform,
  type GeoTransformGridSource,
  type ProjectedBoundsGridOptions,
} from "../core/projected-grid";
import { GridError } from "../errors";
import type {
  AddGridSettings,
  BBox,
  CellCounts,
  GridSettings,
  LayerStyle,
  LineFeatureCollection,
  MapLike,
  ProjectedBounds,
  Resolution,
} from "../types";
import { fitToBBox, removeGrid, restyleGrid, setGridVisibility, whenStyleReady } from "./layer";

const TILE_EXTENT = 4096;
const TILE_BUFFER = 128;
const MAX_SOURCE_ZOOM = 22;
const MAX_REQUEST_ZOOM = 30;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;

type TileGridShape = Omit<GridSettings, "maxCells"> &
  (
    | { resolution: Resolution; cells?: undefined }
    | { cells: CellCounts; resolution?: undefined }
  );

/** Options for drawing a bounding-box grid from on-demand vector tiles. */
export type AddBBoxGridTilesOptions = Omit<AddGridSettings, "maxCells"> &
  TileGridShape & {
    /** Maximum grid lines generated for one tile. Default 1000. */
    maxTileLines?: number;
  };

/** Options for drawing a projected grid from on-demand vector tiles. */
export type AddProjectedGridTilesOptions = Omit<
  ProjectedBoundsGridOptions,
  "maxLines" | "resolution"
> & {
  /** Cell size in the CRS's native linear units. Defaults to the GDAL pixel size for affine input. */
  resolution?: ProjectedBoundsGridOptions["resolution"];
  /** Maximum grid lines generated for one tile. Default 1000. */
  maxTileLines?: number;
  /** Id used by the map source and layer. Defaults to `"bboxgrid"`. */
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
};

/** Options for changing the style or placement of an existing tile grid. */
export type GridTileUpdateOptions = Partial<
  Pick<AddGridSettings, "paint" | "layout" | "beforeId" | "minzoom" | "maxzoom" | "slot">
>;

/** Handle for a grid backed by on-demand vector tiles. */
export interface GridTileHandle {
  /** Show the layer. */
  show(): void;
  /** Hide the layer without removing its source. */
  hide(): void;
  /** Update paint, layout or layer placement. */
  update(options: GridTileUpdateOptions): void;
  /** Remove the layer, source and tile generator. */
  remove(): void;
}

/** Resource returned by a custom Mapbox/MapLibre protocol handler. */
export interface GridTileResource {
  data: ArrayBuffer;
}

/** The custom-protocol API exposed by MapLibre GL JS. */
export interface GridTileProtocolHost {
  addProtocol(
    protocol: string,
    handler: (
      request: { url: string },
      abortController: AbortController,
    ) => Promise<GridTileResource>,
  ): void;
  removeProtocol(protocol: string): void;
}

/** Installed custom protocol and grid factory methods. */
export interface GridTileProtocol {
  /** Protocol scheme registered with Mapbox GL JS or MapLibre GL JS. */
  readonly protocol: string;
  /** Add a geographic bounding-box grid as a vector-tile source. */
  addBBoxGrid(map: MapLike, options: AddBBoxGridTilesOptions): GridTileHandle;
  /** Add a projected-CRS grid as a vector-tile source. */
  addProjectedGrid(
    map: MapLike,
    bounds: ProjectedBounds | GeoTransformGridSource,
    options: AddProjectedGridTilesOptions,
  ): GridTileHandle;
  /** Remove all grids registered by this protocol and unregister the scheme. */
  remove(): void;
}

type TileFeatureGenerator = (z: number, x: number, y: number) => LineFeatureCollection;
type Point = readonly [x: number, y: number];
const claimedLayerIds = new WeakMap<MapLike, Set<string>>();

/** A server-side generator for grid vector tiles. */
export interface GridTileGenerator {
  /** Generate one XYZ Mapbox Vector Tile as a protobuf ArrayBuffer. */
  getTile(z: number, x: number, y: number): ArrayBuffer;
}

/** Options for adding a remote vector-tile endpoint as a grid layer. */
export type AddVectorGridTileLayerOptions = Partial<
  Pick<AddGridSettings, "id" | "paint" | "layout" | "beforeId" | "minzoom" | "maxzoom" | "slot">
>;

/** Encode an unsigned protobuf varint. */
function varint(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GridError("vector-tile protobuf value is outside the safe integer range");
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return bytes;
}

/** Encode a protobuf field tag. */
function fieldTag(field: number, wireType: number): number[] {
  return varint(field * 8 + wireType);
}

/** Encode a length-delimited protobuf field. */
function bytesField(field: number, value: readonly number[]): number[] {
  return [...fieldTag(field, 2), ...varint(value.length), ...value];
}

/** Encode a protobuf integer field. */
function integerField(field: number, value: number): number[] {
  return [...fieldTag(field, 0), ...varint(value)];
}

/** Zig-zag encode an MVT coordinate delta. */
function zigZag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

/** Convert longitude/latitude to normalized Web Mercator world coordinates. */
function mercatorPoint(point: Point): Point {
  const longitude = point[0];
  const latitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, point[1]));
  const sine = Math.sin((latitude * Math.PI) / 180);
  return [
    (longitude + 180) / 360,
    0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI),
  ];
}

/** Convert an XYZ tile to its geographic bounds. */
function tileBounds(z: number, x: number, y: number): BBox {
  const scale = 2 ** z;
  const tileX = ((x % scale) + scale) % scale;
  const buffer = TILE_BUFFER / TILE_EXTENT;
  const longitude = (coordinate: number): number =>
    ((tileX + coordinate) / scale) * 360 - 180;
  const latitude = (coordinate: number): number => {
    const tileCoordinate = Math.max(0, Math.min(scale, y + coordinate));
    const n = Math.PI - (2 * Math.PI * tileCoordinate) / scale;
    return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  };
  return [
    longitude(-buffer),
    latitude(1 + buffer),
    longitude(1 + buffer),
    latitude(-buffer),
  ];
}

/** Project a geographic line into the requested tile's local MVT extent. */
function tilePoint(point: Point, z: number, x: number, y: number): Point {
  const scale = 2 ** z;
  const [worldX, worldY] = mercatorPoint(point);
  const tileX = ((x % scale) + scale) % scale;
  return [(worldX * scale - tileX) * TILE_EXTENT, (worldY * scale - y) * TILE_EXTENT];
}

/** Clip a line segment to the tile extent. */
function clipSegment(start: Point, end: Point): [Point, Point] | undefined {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let low = 0;
  let high = 1;
  const edges: readonly [number, number][] = [
    [-dx, start[0] + TILE_BUFFER],
    [dx, TILE_EXTENT + TILE_BUFFER - start[0]],
    [-dy, start[1] + TILE_BUFFER],
    [dy, TILE_EXTENT + TILE_BUFFER - start[1]],
  ];
  for (const [direction, distance] of edges) {
    if (direction === 0) {
      if (distance < 0) {
        return undefined;
      }
      continue;
    }
    const fraction = distance / direction;
    if (direction < 0) {
      low = Math.max(low, fraction);
    } else {
      high = Math.min(high, fraction);
    }
    if (low > high) {
      return undefined;
    }
  }
  return [
    [start[0] + low * dx, start[1] + low * dy],
    [start[0] + high * dx, start[1] + high * dy],
  ];
}

/** Join clipped segments into independent line paths. */
function clippedPaths(points: readonly Point[], z: number, x: number, y: number): Point[][] {
  const paths: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => {
    if (current.length > 1) {
      paths.push(current);
    }
    current = [];
  };
  for (let index = 1; index < points.length; index += 1) {
    const start = tilePoint(points[index - 1], z, x, y);
    const end = tilePoint(points[index], z, x, y);
    if (![...start, ...end].every(Number.isFinite)) {
      flush();
      continue;
    }
    const clipped = clipSegment(start, end);
    if (!clipped || clipped[0][0] === clipped[1][0] && clipped[0][1] === clipped[1][1]) {
      flush();
      continue;
    }
    const [clippedStart, clippedEnd] = clipped;
    const last = current[current.length - 1];
    if (
      last &&
      Math.abs(last[0] - clippedStart[0]) < 1e-6 &&
      Math.abs(last[1] - clippedStart[1]) < 1e-6
    ) {
      current.push(clippedEnd);
    } else {
      flush();
      current = [clippedStart, clippedEnd];
    }
  }
  flush();
  return paths;
}

/** Encode one grouped MultiLineString feature. */
function encodeLineFeature(paths: readonly Point[][], axisValue: number): number[] {
  const geometry: number[] = [];
  let cursorX = 0;
  let cursorY = 0;
  for (const path of paths) {
    const quantized = path.map(
      (point): [number, number] => [
        Math.max(-TILE_BUFFER, Math.min(TILE_EXTENT + TILE_BUFFER, Math.round(point[0]))),
        Math.max(-TILE_BUFFER, Math.min(TILE_EXTENT + TILE_BUFFER, Math.round(point[1]))),
      ],
    );
    const unique = quantized.filter(
      (point, index) => index === 0 || point[0] !== quantized[index - 1][0] || point[1] !== quantized[index - 1][1],
    );
    if (unique.length < 2) {
      continue;
    }
    geometry.push(...varint(9));
    geometry.push(...varint(zigZag(unique[0][0] - cursorX)));
    geometry.push(...varint(zigZag(unique[0][1] - cursorY)));
    cursorX = unique[0][0];
    cursorY = unique[0][1];
    geometry.push(...varint(((unique.length - 1) << 3) | 2));
    for (const point of unique.slice(1)) {
      geometry.push(...varint(zigZag(point[0] - cursorX)));
      geometry.push(...varint(zigZag(point[1] - cursorY)));
      cursorX = point[0];
      cursorY = point[1];
    }
  }
  if (geometry.length === 0) {
    return [];
  }
  return [
    ...bytesField(2, [0, axisValue]),
    ...integerField(3, 2),
    ...bytesField(4, geometry),
  ];
}

/** Encode viewport lines in Mapbox Vector Tile format. */
function encodeTile(data: LineFeatureCollection, z: number, x: number, y: number): ArrayBuffer {
  const paths: Record<"x" | "y", Point[][]> = { x: [], y: [] };
  for (const feature of data.features) {
    const axis = feature.properties.axis;
    if (axis !== "x" && axis !== "y") {
      continue;
    }
    if (feature.geometry.type === "LineString") {
      paths[axis].push(...clippedPaths(feature.geometry.coordinates, z, x, y));
    } else {
      for (const line of feature.geometry.coordinates) {
        paths[axis].push(...clippedPaths(line, z, x, y));
      }
    }
  }

  const features = [
    encodeLineFeature(paths.x, 0),
    encodeLineFeature(paths.y, 1),
  ].filter((feature) => feature.length > 0);
  if (features.length === 0) {
    return new ArrayBuffer(0);
  }
  const layer = [
    ...bytesField(1, [103, 114, 105, 100]),
    ...features.flatMap((feature) => bytesField(2, feature)),
    ...bytesField(3, [97, 120, 105, 115]),
    ...bytesField(4, bytesField(1, [120])),
    ...bytesField(4, bytesField(1, [121])),
    ...integerField(5, TILE_EXTENT),
    ...integerField(15, 2),
  ];
  const bytes = new Uint8Array(bytesField(3, layer));
  return bytes.buffer;
}

/** Validate a maximum tile line count. */
function resolveMaxTileLines(value: number | undefined): number {
  const maxTileLines = value ?? 1000;
  if (!Number.isSafeInteger(maxTileLines) || maxTileLines < 1) {
    throw new GridError("maxTileLines must be a positive safe integer");
  }
  return maxTileLines;
}

/** Whether tile-grid bounds are supplied as a GDAL transform. */
function isGeoTransformSource(
  bounds: ProjectedBounds | GeoTransformGridSource,
): bounds is GeoTransformGridSource {
  return !Array.isArray(bounds) && "affine_transform" in bounds;
}

/** Create the generator for a geographic grid's requested tiles. */
function bboxTileGenerator(options: AddBBoxGridTilesOptions): TileFeatureGenerator {
  const gridOptions =
    options.cells !== undefined
      ? {
          cells: options.cells,
          units: options.units,
          geodesic: options.geodesic,
          maxCells: Number.POSITIVE_INFINITY,
        }
      : {
          resolution: options.resolution,
          units: options.units,
          geodesic: options.geodesic,
          maxCells: Number.POSITIVE_INFINITY,
        };
  const grid = new BBoxGrid(options.bbox, gridOptions);
  const maxTileLines = resolveMaxTileLines(options.maxTileLines);
  return (z, x, y) => grid.linesInView(tileBounds(z, x, y), { padding: 0, maxLines: maxTileLines });
}

/** Create the generator for a projected grid's requested tiles. */
function projectedTileGenerator(
  bounds: ProjectedBounds | GeoTransformGridSource,
  options: AddProjectedGridTilesOptions,
): TileFeatureGenerator {
  let gridBounds: ProjectedBounds;
  let resolution = options.resolution;
  let origin = options.origin;
  if (isGeoTransformSource(bounds)) {
    const derived = fromGeoTransform(bounds.affine_transform, bounds.shape);
    gridBounds = derived.bounds;
    resolution ??= derived.resolution;
    origin ??= derived.origin;
  } else {
    gridBounds = bounds;
  }
  if (resolution === undefined) {
    throw new GridError("resolution is required when bounds are not a GDAL transform");
  }
  const generator = createProjectedGridFromBoundsFactory(gridBounds, {
    crs: options.crs,
    resolution,
    origin,
    maxSegmentLength: options.maxSegmentLength,
  });
  const maxTileLines = resolveMaxTileLines(options.maxTileLines);
  return (z, x, y) =>
    generator.viewport(tileBounds(z, x, y), { padding: 0, maxLines: maxTileLines });
}

/** Create a function that generates only the requested geographic grid tile. */
export function createBBoxGridTileGenerator(
  options: AddBBoxGridTilesOptions,
): GridTileGenerator {
  const generate = bboxTileGenerator(options);
  return {
    getTile(z, x, y): ArrayBuffer {
      validateTileCoordinates(z, x, y);
      return encodeTile(generate(z, x, y), z, x, y);
    },
  };
}

/** Create a function that generates only the requested projected grid tile. */
export function createProjectedGridTileGenerator(
  bounds: ProjectedBounds | GeoTransformGridSource,
  options: AddProjectedGridTilesOptions,
): GridTileGenerator {
  const generate = projectedTileGenerator(bounds, options);
  return {
    getTile(z, x, y): ArrayBuffer {
      validateTileCoordinates(z, x, y);
      return encodeTile(generate(z, x, y), z, x, y);
    },
  };
}

/** Validate an XYZ tile coordinate. X may wrap around the world. */
function validateTileCoordinates(z: number, x: number, y: number): void {
  const scale = 2 ** z;
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    z > MAX_REQUEST_ZOOM ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    y < 0 ||
    y >= scale
  ) {
    throw new GridError("grid tile coordinates are outside the supported XYZ range");
  }
}

/** Attach a vector-tile source and its line layer to a map. */
function attachVectorTileLayer(
  map: MapLike,
  tiles: string[],
  layerId: string,
  style: LayerStyle,
  onRemove: () => void = () => {},
): GridTileHandle {
  let claimed = claimedLayerIds.get(map);
  if (!claimed) {
    claimed = new Set();
    claimedLayerIds.set(map, claimed);
  }
  if (map.getSource(layerId) || map.getLayer(layerId) || claimed.has(layerId)) {
    throw new GridError(`map already has a source or layer named "${layerId}"`);
  }
  claimed.add(layerId);
  let visible = true;
  let isRemoved = false;
  let currentStyle = style;
  const handle: GridTileHandle = {
    show(): void {
      if (!isRemoved) {
        visible = true;
        whenStyleReady(map, () => setGridVisibility(map, layerId, visible));
      }
    },
    hide(): void {
      if (!isRemoved) {
        visible = false;
        whenStyleReady(map, () => setGridVisibility(map, layerId, visible));
      }
    },
    update(next): void {
      if (!isRemoved) {
        currentStyle = {
          paint: { ...currentStyle.paint, ...next.paint },
          layout: { ...currentStyle.layout, ...next.layout },
          minzoom: next.minzoom ?? currentStyle.minzoom,
          maxzoom: next.maxzoom ?? currentStyle.maxzoom,
          slot: next.slot ?? currentStyle.slot,
          beforeId: next.beforeId ?? currentStyle.beforeId,
        };
        whenStyleReady(map, () =>
          restyleGrid(map, layerId, currentStyle, next.beforeId !== undefined),
        );
      }
    },
    remove(): void {
      if (isRemoved) {
        return;
      }
      isRemoved = true;
      claimed?.delete(layerId);
      onRemove();
      whenStyleReady(map, () => removeGrid(map, layerId));
    },
  };
  whenStyleReady(map, () => {
    if (isRemoved) {
      return;
    }
    map.addSource(layerId, {
      type: "vector",
      tiles,
      minzoom: 0,
      maxzoom: MAX_SOURCE_ZOOM,
    });
    map.addLayer(
      {
        id: layerId,
        type: "line",
        source: layerId,
        "source-layer": "grid",
        layout: currentStyle.layout,
        paint: currentStyle.paint,
        minzoom: currentStyle.minzoom,
        maxzoom: currentStyle.maxzoom,
        slot: currentStyle.slot,
      },
      currentStyle.beforeId,
    );
    if (!visible) {
      setGridVisibility(map, layerId, false);
    }
  });
  return handle;
}

/** Add a remote vector-tile URL template to a map as a line-grid layer. */
export function addVectorGridTileLayer(
  map: MapLike,
  tiles: string | readonly string[],
  options: AddVectorGridTileLayerOptions = {},
): GridTileHandle {
  const layerId = options.id ?? DEFAULT_LAYER_ID;
  const tileUrls = typeof tiles === "string" ? [tiles] : [...tiles];
  if (tileUrls.length === 0 || tileUrls.some((url) => typeof url !== "string" || url.length === 0)) {
    throw new GridError("tiles must contain at least one non-empty URL template");
  }
  const style: LayerStyle = {
    paint: { ...DEFAULT_PAINT, ...options.paint },
    layout: { ...DEFAULT_LAYOUT, ...options.layout },
    beforeId: options.beforeId,
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
  };
  return attachVectorTileLayer(map, tileUrls, layerId, style);
}

/**
 * Register an on-demand vector-tile protocol with a MapLibre GL JS library.
 * The returned controller can attach and remove grid overlays. Each request generates an MVT
 * containing only the grid lines intersecting that XYZ tile.
 * @param host - The MapLibre GL JS namespace exposing `addProtocol` and `removeProtocol`.
 */
export function installGridTileProtocol(host: GridTileProtocolHost): GridTileProtocol {
  if (typeof host.addProtocol !== "function" || typeof host.removeProtocol !== "function") {
    throw new GridError("tile protocol host must provide addProtocol() and removeProtocol()");
  }
  const protocol = `bboxgrid${nextProtocolId++}`;
  const grids = new Map<string, GridTileGenerator>();
  const handles = new Set<GridTileHandle>();
  let nextGridId = 0;
  let removed = false;

  host.addProtocol(protocol, async (request, abortController) => {
    if (removed) {
      throw new GridError("grid tile protocol has been removed");
    }
    if (abortController.signal.aborted) {
      throw new GridError("grid tile request was aborted");
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new GridError("invalid grid tile request URL");
    }
    const match = /^\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
    if (url.protocol !== `${protocol}:` || !match) {
      throw new GridError("invalid grid tile request URL");
    }
    const generator = grids.get(url.hostname);
    if (!generator) {
      throw new GridError("grid tile request refers to an unknown grid");
    }
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    validateTileCoordinates(z, x, y);
    return { data: generator.getTile(z, x, y) };
  });

  const addGrid = (
    map: MapLike,
    id: string | undefined,
    generator: GridTileGenerator,
    style: LayerStyle,
  ): GridTileHandle => {
    if (removed) {
      throw new GridError("grid tile protocol has been removed");
    }
    const gridId = `g${nextGridId++}`;
    grids.set(gridId, generator);
    let handle: GridTileHandle;
    try {
      handle = attachVectorTileLayer(
        map,
        [`${protocol}://${gridId}/{z}/{x}/{y}.pbf`],
        id ?? DEFAULT_LAYER_ID,
        style,
        () => {
          grids.delete(gridId);
          handles.delete(handle);
        },
      );
    } catch (error) {
      grids.delete(gridId);
      throw error;
    }
    handles.add(handle);
    return handle;
  };

  const styleOf = (options: {
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
    beforeId?: string;
    minzoom?: number;
    maxzoom?: number;
    slot?: string;
  }): LayerStyle => ({
    paint: { ...DEFAULT_PAINT, ...options.paint },
    layout: { ...DEFAULT_LAYOUT, ...options.layout },
    beforeId: options.beforeId,
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
  });

  return {
    protocol,
    addBBoxGrid(map, options): GridTileHandle {
      const generator = createBBoxGridTileGenerator(options);
      const handle = addGrid(map, options.id, generator, styleOf(options));
      if (options.fit) {
        fitToBBox(map, options.bbox, options.fit);
      }
      return handle;
    },
    addProjectedGrid(map, bounds, options): GridTileHandle {
      const generator = createProjectedGridTileGenerator(bounds, options);
      return addGrid(map, options.id, generator, styleOf(options));
    },
    remove(): void {
      if (removed) {
        return;
      }
      removed = true;
      for (const handle of [...handles]) {
        handle.remove();
      }
      host.removeProtocol(protocol);
      grids.clear();
    },
  };
}

let nextProtocolId = 0;
