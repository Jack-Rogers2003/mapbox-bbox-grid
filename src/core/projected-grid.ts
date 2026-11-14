import proj4 from "proj4";
import { DEFAULT_MAX_LINES } from "../constants";
import { GridError } from "../errors";
import type {
  BBox,
  LineFeature,
  LineFeatureCollection,
  ProjectedBounds,
  Resolution,
  ViewportOptions,
} from "../types";
import { validateBBox } from "./validate";

const BOUNDARY_STEP_DEGREES = 0.1;
const DEFAULT_MAX_SEGMENT_LENGTH = 10_000;
const METRES_PER_UNIT: Readonly<Record<string, number>> = {
  m: 1,
  mm: 0.001,
  cm: 0.01,
  dm: 0.1,
  km: 1000,
  ft: 0.3048,
  "us-ft": 1200 / 3937,
  "ind-ft": 0.30479841,
  in: 0.0254,
  "us-in": 0.025400050800101,
  yd: 0.9144,
  "us-yd": 0.914401828803658,
  "ind-yd": 0.91439523,
  mi: 1609.344,
  "us-mi": 1609.34721869444,
  kmi: 1852,
  fath: 1.8288,
  ch: 20.1168,
  "us-ch": 20.1168402336805,
  "ind-ch": 20.11669506,
  link: 0.201168,
};

/** Options for a metre-spaced grid in a user-selected projected CRS. */
export interface ProjectedGridOptions {
  /** Cell size in metres in the target CRS: one number or `[x, y]`. */
  resolution: Resolution;
  /** A registered Proj4 CRS name or a Proj4 definition string with metre units. */
  crs: string;
  /** Grid origin in target CRS coordinates. Defaults to `[0, 0]`. */
  origin?: readonly [x: number, y: number];
  /** Optional maximum number of grid lines to emit. Unset by default. */
  maxLines?: number;
  /** Maximum projected length between output vertices, in metres. Default `10000`. */
  maxSegmentLength?: number;
}

/** Options for a grid whose bounds are already expressed in the grid CRS. */
export interface ProjectedBoundsGridOptions {
  /** Cell size in the CRS's native linear units: one number or `[x, y]`. */
  resolution: Resolution;
  /** A registered Proj4 CRS name or a Proj4 definition string with linear units. */
  crs: string;
  /** Grid origin in target CRS coordinates. Defaults to `[0, 0]`. */
  origin?: readonly [x: number, y: number];
  /** Optional maximum number of grid lines for full-grid generation. */
  maxLines?: number;
  /** Maximum length between output vertices, in the CRS's native linear units. */
  maxSegmentLength?: number;
}

/** A GDAL affine transform `[originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight]`. */
export type GeoTransform = readonly [
  originX: number,
  pixelWidth: number,
  rowRotation: number,
  originY: number,
  columnRotation: number,
  pixelHeight: number,
];

/** Raster extent described by a GDAL geotransform and `[rows, columns]` shape. */
export interface GeoTransformGridSource {
  affine_transform: GeoTransform;
  shape: readonly [rows: number, columns: number];
}

/** Bounds, pixel resolution and grid origin derived from a north-up GDAL transform. */
export interface GeoTransformGridDefinition {
  bounds: ProjectedBounds;
  origin: readonly [x: number, y: number];
  resolution: readonly [x: number, y: number];
}

/** A cell's integer grid indices, counted from the configured origin. */
export interface ProjectedCellIndex {
  /** Column index, increasing in the positive x direction. */
  col: number;
  /** Row index, increasing in the positive y direction. */
  row: number;
}

type Point = [number, number];
type Forward = (point: Point) => Point;
type Inverse = (point: Point) => Point;
type ProjectedGridFactory = {
  /** Generate the full chart grid. */
  full(): LineFeatureCollection;
  /** Generate only grid lines intersecting a WGS84 view. */
  viewport(view: BBox, options?: ViewportOptions): LineFeatureCollection;
};

/**
 * Convert a north-up GDAL affine transform and raster shape to grid bounds and pixel spacing.
 * @param affine_transform - GDAL geotransform tuple.
 * @param shape - Raster dimensions as `[rows, columns]`.
 * @throws {GridError} If the transform or shape is invalid or rotated.
 */
export function fromGeoTransform(
  affine_transform: GeoTransform,
  shape: readonly [rows: number, columns: number],
): GeoTransformGridDefinition {
  if (
    !Array.isArray(affine_transform) ||
    affine_transform.length !== 6 ||
    !affine_transform.every(Number.isFinite)
  ) {
    throw new GridError("affine_transform must contain six finite GDAL transform values");
  }
  if (
    !Array.isArray(shape) ||
    shape.length !== 2 ||
    !shape.every((value) => Number.isInteger(value) && value > 0)
  ) {
    throw new GridError("shape must contain positive integer [rows, columns]");
  }
  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = affine_transform;
  if (rowRotation !== 0 || columnRotation !== 0) {
    throw new GridError("rotated GDAL transforms are not supported for axis-aligned grids");
  }
  if (pixelWidth === 0 || pixelHeight === 0) {
    throw new GridError("GDAL pixel dimensions must be non-zero");
  }
  const oppositeX = originX + shape[1] * pixelWidth;
  const oppositeY = originY + shape[0] * pixelHeight;
  return {
    bounds: [
      Math.min(originX, oppositeX),
      Math.min(originY, oppositeY),
      Math.max(originX, oppositeX),
      Math.max(originY, oppositeY),
    ],
    origin: [originX, originY],
    resolution: [Math.abs(pixelWidth), Math.abs(pixelHeight)],
  };
}

/** Return the metre conversion factor for a projected CRS's linear units. */
function linearUnitScale(crs: string): number | undefined {
  if (typeof crs !== "string" || crs.length === 0) {
    return undefined;
  }
  const definition = proj4.defs(crs);
  const units =
    (typeof definition === "object" ? definition?.units : undefined) ??
    (crs.includes("+proj=") ? /\+units=([^\s]+)/.exec(crs)?.[1] : undefined);
  return units === undefined ? undefined : METRES_PER_UNIT[units];
}

/** Whether both coordinates are finite. */
function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

/** Normalize and validate cell spacing in metres. */
function getSteps(resolution: Resolution): [number, number] {
  const [xStep, yStep] = Array.isArray(resolution) ? resolution : [resolution, resolution];
  if (!Number.isFinite(xStep) || !Number.isFinite(yStep) || xStep <= 0 || yStep <= 0) {
    throw new GridError("resolution must be positive and finite");
  }
  return [xStep, yStep];
}

/** Validate finite, strictly increasing bounds in projected CRS coordinates. */
function validateProjectedBounds(bounds: ProjectedBounds): ProjectedBounds {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
    throw new GridError("bounds must be four finite CRS coordinates: [west, south, east, north]");
  }
  const [minX, minY, maxX, maxY] = bounds;
  if (!(minX < maxX && minY < maxY)) {
    throw new GridError("projected bounds must satisfy minX < maxX and minY < maxY");
  }
  return [minX, minY, maxX, maxY];
}

/** Validate a CRS definition and create WGS84 forward/inverse transforms. */
function createTransforms(
  crs: string,
  requireMetres = true,
): { forward: Forward; inverse: Inverse; straight: boolean } {
  if (typeof crs !== "string" || crs.length === 0) {
    throw new GridError("crs must be a registered projected CRS or a Proj4 definition");
  }

  const definition = proj4.defs(crs);
  const isDefinitionString = crs.includes("+proj=");
  const definitionUnits = typeof definition === "object" ? definition?.units : undefined;
  const projectionName =
    typeof definition === "object" ? definition?.projName : /\+proj=([^\s]+)/.exec(crs)?.[1];
  const units =
    definitionUnits ?? (isDefinitionString ? /\+units=([^\s]+)/.exec(crs)?.[1] : undefined);
  const unitsAreMetres = units === "m";
  const unitsAreSupportedLinear = units !== undefined && METRES_PER_UNIT[units] !== undefined;
  if (
    (requireMetres ? !unitsAreMetres : !unitsAreSupportedLinear) ||
    projectionName === undefined ||
    projectionName === "longlat" ||
    projectionName === "latlong" ||
    projectionName === "geocent"
  ) {
    throw new GridError(
      requireMetres
        ? "crs must be a projected CRS whose units are metres"
        : "crs must be a projected CRS with supported linear units",
    );
  }

  try {
    const projection = proj4("EPSG:4326", crs);
    return {
      /** Project longitude/latitude coordinates into the target CRS. */
      forward: (point) => projection.forward(point) as Point,
      /** Convert target CRS coordinates back to longitude/latitude. */
      inverse: (point) => projection.inverse(point) as Point,
      straight: projectionName === "merc",
    };
  } catch (error) {
    throw new GridError(
      `unable to use CRS: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Validate the grid origin, defaulting to the CRS coordinate origin. */
function getOrigin(origin: readonly [number, number] | undefined): Point {
  const value = origin ?? [0, 0];
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    throw new GridError("origin must contain two finite coordinates");
  }
  return [value[0], value[1]];
}

/** Project a sampled outline of the geographic bbox to approximate its boundary polygon. */
function projectBoundary(bbox: BBox, forward: Forward): Point[] {
  const [west, south, east, north] = bbox;
  const points: Point[] = [];
  /** Add projected samples along one geographic bbox edge. */
  const addEdge = (start: Point, end: Point): void => {
    const steps = Math.max(
      1,
      Math.ceil(
        Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1])) / BOUNDARY_STEP_DEGREES,
      ),
    );
    for (let i = 0; i < steps; i++) {
      const ratio = i / steps;
      const projected = forward([
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
      ]);
      if (!isFinitePoint(projected)) {
        throw new GridError("bbox cannot be represented by the selected CRS");
      }
      points.push(projected);
    }
  };
  addEdge([west, south], [east, south]);
  addEdge([east, south], [east, north]);
  addEdge([east, north], [west, north]);
  addEdge([west, north], [west, south]);
  return points;
}

/** Find sorted intersections of a grid line and the projected bbox polygon. */
function intersections(polygon: readonly Point[], axis: "x" | "y", value: number): number[] {
  const found: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const av = a[axis === "x" ? 0 : 1];
    const bv = b[axis === "x" ? 0 : 1];
    if ((av <= value && bv > value) || (bv <= value && av > value)) {
      const otherA = a[axis === "x" ? 1 : 0];
      const otherB = b[axis === "x" ? 1 : 0];
      found.push(otherA + ((value - av) / (bv - av)) * (otherB - otherA));
    }
  }
  return found.sort((a, b) => a - b);
}

/** Test whether a projected point lies inside the bbox polygon. */
function containsPoint(polygon: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Return the portions of a projected grid line that fall inside the bbox polygon. */
function lineSegments(polygon: readonly Point[], axis: "x" | "y", value: number): [Point, Point][] {
  const crossings = intersections(polygon, axis, value);
  const segments: [Point, Point][] = [];
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const lo = crossings[i];
    const hi = crossings[i + 1];
    const midpoint = (lo + hi) / 2;
    const testPoint: Point = axis === "x" ? [value, midpoint] : [midpoint, value];
    if (hi > lo && containsPoint(polygon, testPoint)) {
      segments.push(
        axis === "x"
          ? [
              [value, lo],
              [value, hi],
            ]
          : [
              [lo, value],
              [hi, value],
            ],
      );
    }
  }
  const axisIndex = axis === "x" ? 0 : 1;
  const otherIndex = axis === "x" ? 1 : 0;
  const tolerance = Number.EPSILON * 64 * Math.max(1, Math.abs(value));
  const boundaryIntervals: [number, number][] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (
      Math.abs(a[axisIndex] - value) <= tolerance &&
      Math.abs(b[axisIndex] - value) <= tolerance
    ) {
      const lo = Math.min(a[otherIndex], b[otherIndex]);
      const hi = Math.max(a[otherIndex], b[otherIndex]);
      if (hi > lo) {
        boundaryIntervals.push([lo, hi]);
      }
    }
  }
  boundaryIntervals.sort((a, b) => a[0] - b[0]);
  const boundarySegments: [Point, Point][] = [];
  for (let i = 0; i < boundaryIntervals.length; i++) {
    const [lo, hi] = boundaryIntervals[i];
    const previous = boundarySegments[boundarySegments.length - 1];
    if (previous) {
      const previousHi = axis === "x" ? previous[1][1] : previous[1][0];
      if (Math.abs(previousHi - lo) <= tolerance) {
        if (axis === "x") {
          previous[1][1] = hi;
        } else {
          previous[1][0] = hi;
        }
        continue;
      }
    }
    segments.push(
      axis === "x"
        ? [
            [value, lo],
            [value, hi],
          ]
        : [
            [lo, value],
            [hi, value],
          ],
    );
  }
  segments.push(...boundarySegments);
  const intervals = segments
    .map(([start, end]) =>
      axis === "x"
        ? [Math.min(start[1], end[1]), Math.max(start[1], end[1])]
        : [Math.min(start[0], end[0]), Math.max(start[0], end[0])],
    )
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && lo <= previous[1] + tolerance) {
      previous[1] = Math.max(previous[1], hi);
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged.map(([lo, hi]) =>
    axis === "x"
      ? [
          [value, lo],
          [value, hi],
        ]
      : [
          [lo, value],
          [hi, value],
        ],
  );
}

/** Densify one projected segment and convert its vertices back to GeoJSON coordinates. */
function makeCoordinates(
  segment: [Point, Point],
  maxSegmentLength: number | undefined,
  inverse: Inverse,
): Point[] {
  const [start, end] = segment;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const steps =
    maxSegmentLength === undefined ? 1 : Math.max(1, Math.ceil(length / maxSegmentLength));
  const coordinates: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps;
    const point = inverse([
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio,
    ]);
    if (!isFinitePoint(point) || Math.abs(point[1]) > 90) {
      throw new GridError("grid cannot be represented by the selected CRS");
    }
    coordinates.push(point);
  }
  return coordinates;
}

/** Return an integer index for a coordinate, assigning grid-line points to the positive side. */
function cellIndex(coordinate: number, origin: number, step: number): number {
  const value = (coordinate - origin) / step;
  const nearest = Math.round(value);
  const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(value));
  return Math.floor(Math.abs(value - nearest) <= tolerance ? nearest : value);
}

/**
 * Generate grid features from a polygon already expressed in the grid CRS.
 * @param polygon - Projected bbox boundary.
 * @param options - Grid spacing and origin.
 * @param inverse - Convert projected coordinates to WGS84.
 * @param defaultSegmentLength - Default densification distance in CRS units.
 */
function gridFromProjectedPolygon(
  polygon: readonly Point[],
  options: ProjectedBoundsGridOptions,
  inverse: Inverse,
  defaultSegmentLength: number | undefined,
  stride: number = 1,
): LineFeatureCollection {
  const {
    resolution,
    origin: requestedOrigin,
    maxSegmentLength = defaultSegmentLength,
    maxLines,
  } = options;
  if (
    maxLines !== undefined &&
    (!Number.isFinite(maxLines) || !Number.isInteger(maxLines) || maxLines < 1)
  ) {
    throw new GridError("maxLines must be a positive integer");
  }
  if (
    maxSegmentLength !== undefined &&
    (!Number.isFinite(maxSegmentLength) || maxSegmentLength <= 0)
  ) {
    throw new GridError("maxSegmentLength must be positive and finite");
  }
  if (!Number.isSafeInteger(stride) || stride < 1) {
    throw new GridError("line thinning stride must be a positive integer");
  }
  const [xStep, yStep] = getSteps(resolution);
  const origin = getOrigin(requestedOrigin);

  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  const firstX = Math.ceil((Math.min(...xs) - origin[0]) / xStep);
  const lastX = Math.floor((Math.max(...xs) - origin[0]) / xStep);
  const firstY = Math.ceil((Math.min(...ys) - origin[1]) / yStep);
  const lastY = Math.floor((Math.max(...ys) - origin[1]) / yStep);
  if (![firstX, lastX, firstY, lastY].every(Number.isSafeInteger)) {
    throw new GridError("grid line indices exceed the safe integer range");
  }
  const alignedFirstX = Math.ceil(firstX / stride) * stride;
  const alignedFirstY = Math.ceil(firstY / stride) * stride;
  const lineCount =
    Math.max(0, Math.floor((lastX - alignedFirstX) / stride) + 1) +
    Math.max(0, Math.floor((lastY - alignedFirstY) / stride) + 1);
  if (!Number.isSafeInteger(lineCount)) {
    throw new GridError("grid line count exceeds the safe integer range");
  }
  if (maxLines !== undefined && lineCount > maxLines) {
    throw new GridError(`grid would have more than ${maxLines.toLocaleString("en-US")} lines`);
  }

  const xCoordinates: Point[][] = [];
  const xIndices: number[] = [];
  const yCoordinates: Point[][] = [];
  const yIndices: number[] = [];
  for (let index = alignedFirstX; index <= lastX; index += stride) {
    const position = origin[0] + index * xStep;
    for (const segment of lineSegments(polygon, "x", position)) {
      xCoordinates.push(makeCoordinates(segment, maxSegmentLength, inverse));
      xIndices.push(index);
      if (maxLines !== undefined && xIndices.length + yIndices.length > maxLines) {
        throw new GridError(`grid would have more than ${maxLines.toLocaleString("en-US")} lines`);
      }
    }
  }
  for (let index = alignedFirstY; index <= lastY; index += stride) {
    const position = origin[1] + index * yStep;
    for (const segment of lineSegments(polygon, "y", position)) {
      yCoordinates.push(makeCoordinates(segment, maxSegmentLength, inverse));
      yIndices.push(index);
      if (maxLines !== undefined && xIndices.length + yIndices.length > maxLines) {
        throw new GridError(`grid would have more than ${maxLines.toLocaleString("en-US")} lines`);
      }
    }
  }
  const features: LineFeature[] = [];
  if (xCoordinates.length > 0) {
    features.push({
      type: "Feature",
      properties: { axis: "x", indices: xIndices },
      geometry: { type: "MultiLineString", coordinates: xCoordinates },
    });
  }
  if (yCoordinates.length > 0) {
    features.push({
      type: "Feature",
      properties: { axis: "y", indices: yIndices },
      geometry: { type: "MultiLineString", coordinates: yCoordinates },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Clip a polygon to a rectangle with the Sutherland-Hodgman algorithm.
 * @param polygon - Polygon in projected coordinates.
 * @param bounds - Rectangle in projected coordinates.
 */
function clipToBounds(polygon: readonly Point[], bounds: ProjectedBounds): Point[] {
  let output = [...polygon];
  const edges: {
    inside(point: Point): boolean;
    intersect(start: Point, end: Point): Point;
  }[] = [
    {
      inside: (point) => point[0] >= bounds[0],
      intersect: (a, b) => [bounds[0], a[1] + ((bounds[0] - a[0]) / (b[0] - a[0])) * (b[1] - a[1])],
    },
    {
      inside: (point) => point[0] <= bounds[2],
      intersect: (a, b) => [bounds[2], a[1] + ((bounds[2] - a[0]) / (b[0] - a[0])) * (b[1] - a[1])],
    },
    {
      inside: (point) => point[1] >= bounds[1],
      intersect: (a, b) => [a[0] + ((bounds[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), bounds[1]],
    },
    {
      inside: (point) => point[1] <= bounds[3],
      intersect: (a, b) => [a[0] + ((bounds[3] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), bounds[3]],
    },
  ];
  for (const edge of edges) {
    const input = output;
    output = [];
    if (input.length === 0) {
      break;
    }
    let start = input[input.length - 1];
    for (const end of input) {
      const startInside = edge.inside(start);
      const endInside = edge.inside(end);
      if (endInside) {
        if (!startInside) {
          output.push(edge.intersect(start, end));
        }
        output.push(end);
      } else if (startInside) {
        output.push(edge.intersect(start, end));
      }
      start = end;
    }
  }
  return output;
}

/**
 * Prepare a projected grid generator, retaining its transforms for viewport refreshes.
 * @param bounds - `[minX, minY, maxX, maxY]` in the projected CRS.
 * @param options - CRS, resolution, origin and generation limits.
 * @returns Cached full-grid and viewport generation functions.
 */
export function createProjectedGridFromBoundsFactory(
  bounds: ProjectedBounds,
  options: ProjectedBoundsGridOptions,
): ProjectedGridFactory {
  const [minX, minY, maxX, maxY] = validateProjectedBounds(bounds);
  const unitScale = linearUnitScale(options.crs);
  if (unitScale === undefined) {
    throw new GridError("crs must be a supported projected CRS with linear units");
  }
  const transforms = createTransforms(options.crs, false);
  const defaultSegmentLength = transforms.straight
    ? undefined
    : DEFAULT_MAX_SEGMENT_LENGTH / unitScale;
  const polygon: Point[] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  const generate = (
    area: readonly Point[],
    stride = 1,
    viewportMode: boolean = false,
  ): LineFeatureCollection =>
    gridFromProjectedPolygon(
      area,
      viewportMode ? { ...options, maxLines: undefined } : options,
      transforms.inverse,
      defaultSegmentLength,
      stride,
    );
  return {
    full: () => generate(polygon),
    viewport: (view, viewportOptions = {}) => {
      const { padding = 0.25, maxLines = DEFAULT_MAX_LINES } = viewportOptions;
      if (!Number.isFinite(padding) || padding < 0) {
        throw new GridError("viewport padding must be >= 0");
      }
      if (!Number.isInteger(maxLines) || maxLines < 1) {
        throw new GridError("viewport maxLines must be a positive integer");
      }
      if (
        !Array.isArray(view) ||
        view.length !== 4 ||
        !view.every(Number.isFinite) ||
        view[0] >= view[2] ||
        view[1] >= view[3]
      ) {
        throw new GridError("view must be a finite [west, south, east, north] bbox");
      }
      const padX = (view[2] - view[0]) * padding;
      const padY = (view[3] - view[1]) * padding;
      const geographicView: BBox = [
        Math.max(-180, view[0] - padX),
        Math.max(-90, view[1] - padY),
        Math.min(180, view[2] + padX),
        Math.min(90, view[3] + padY),
      ];
      if (geographicView[0] >= geographicView[2] || geographicView[1] >= geographicView[3]) {
        return { type: "FeatureCollection", features: [] };
      }
      const projectedView = clipToBounds(
        projectBoundary(geographicView, transforms.forward),
        bounds,
      );
      if (projectedView.length < 3) {
        return { type: "FeatureCollection", features: [] };
      }
      const [xStep, yStep] = getSteps(options.resolution);
      const origin = getOrigin(options.origin);
      const xs = projectedView.map((point) => point[0]);
      const ys = projectedView.map((point) => point[1]);
      const firstX = Math.ceil((Math.min(...xs) - origin[0]) / xStep);
      const lastX = Math.floor((Math.max(...xs) - origin[0]) / xStep);
      const firstY = Math.ceil((Math.min(...ys) - origin[1]) / yStep);
      const lastY = Math.floor((Math.max(...ys) - origin[1]) / yStep);
      if (![firstX, lastX, firstY, lastY].every(Number.isSafeInteger)) {
        throw new GridError("viewport line indices exceed the safe integer range");
      }
      const candidateCount = Math.max(0, lastX - firstX + 1) + Math.max(0, lastY - firstY + 1);
      if (!Number.isSafeInteger(candidateCount)) {
        throw new GridError("viewport line count exceeds the safe integer range");
      }
      const stride = Math.max(1, Math.ceil(candidateCount / maxLines));
      return generate(projectedView, stride, true);
    },
  };
}

/**
 * Create a grid from bounds already expressed in the chart's projected CRS.
 * Grid lines are exact multiples of `resolution` from `origin` in that CRS; the output is WGS84
 * GeoJSON for Mapbox/MapLibre. `resolution` and `origin` use the CRS's native linear units.
 * @param bounds - `[minX, minY, maxX, maxY]` in the projected CRS.
 * @param options - CRS, resolution, origin and generation limits.
 * @throws {GridError} If bounds, units, CRS or limits are invalid.
 */
export function createProjectedGridFromBounds(
  bounds: ProjectedBounds,
  options: ProjectedBoundsGridOptions,
): LineFeatureCollection {
  return createProjectedGridFromBoundsFactory(bounds, options).full();
}

/**
 * Find the fixed-origin grid cell containing a WGS84 coordinate.
 * Grid-line points are assigned to the cell on the positive x/y side.
 * @param point - `[longitude, latitude]` in degrees.
 * @param options - The target CRS, cell resolution in its native linear units and optional origin.
 */
export function projectedCellAt(
  point: readonly [longitude: number, latitude: number],
  options: Pick<ProjectedBoundsGridOptions, "crs" | "resolution" | "origin">,
): ProjectedCellIndex {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    point[0] < -180 ||
    point[0] > 180 ||
    point[1] < -90 ||
    point[1] > 90
  ) {
    throw new GridError("point must be a valid [longitude, latitude] coordinate");
  }
  const [xStep, yStep] = getSteps(options.resolution);
  const origin = getOrigin(options.origin);
  const { forward } = createTransforms(options.crs, false);
  const projected = forward([point[0], point[1]]);
  if (!isFinitePoint(projected)) {
    throw new GridError("point cannot be represented by the selected CRS");
  }
  return {
    col: cellIndex(projected[0], origin[0], xStep),
    row: cellIndex(projected[1], origin[1], yStep),
  };
}

/**
 * Create a metre-spaced, globally aligned grid in a user-selected projected CRS.
 * The default origin is `[0, 0]` in that CRS. The bbox is clipped to its projected boundary;
 * transformed lines are densified for map display and returned as WGS84 GeoJSON.
 * @param bbox - `[west, south, east, north]` in longitude/latitude degrees.
 * @param options - Resolution in metres and the target projected CRS.
 * @throws {GridError} If the CRS, bbox or grid limits are invalid.
 */
export function createProjectedGrid(
  bbox: BBox,
  options: ProjectedGridOptions,
): LineFeatureCollection {
  const validatedBBox = validateBBox(bbox);
  const { crs } = options;
  const transforms = createTransforms(crs);
  const polygon = projectBoundary(validatedBBox, transforms.forward);
  const maxSegmentLength =
    options.maxSegmentLength ?? (transforms.straight ? undefined : DEFAULT_MAX_SEGMENT_LENGTH);
  return gridFromProjectedPolygon(
    polygon,
    { ...options, maxSegmentLength },
    transforms.inverse,
    transforms.straight ? undefined : DEFAULT_MAX_SEGMENT_LENGTH,
  );
}
