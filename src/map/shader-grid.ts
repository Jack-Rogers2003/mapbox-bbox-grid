import { DEFAULT_LAYER_ID } from "../constants";
import { BBoxGrid } from "../core/grid";
import { createProjectedGridFromBounds } from "../core/projected-grid";
import { GridError } from "../errors";
import type {
  AddGridSettings,
  BBox,
  CellCounts,
  GridSettings,
  MapLike,
  MapViewportOptions,
  ProjectedBounds,
  Resolution,
} from "../types";
import { addBBoxGrid } from "./add-bbox-grid";
import {
  type AddProjectedGridOptions,
  addProjectedGrid,
  type ProjectedGridOverlayHandle,
} from "./add-projected-grid";
import { whenStyleReady } from "./layer";

type ShaderGridShape = GridSettings &
  ({ resolution: Resolution; cells?: undefined } | { cells: CellCounts; resolution?: undefined });

/** Options for drawing a geographic grid directly in a WebGL fragment shader. */
export type ShaderGridOptions = Omit<AddGridSettings, "paint" | "layout" | "maxCells"> &
  ShaderGridShape & {
    /** Viewport-limited GeoJSON fallback settings for unsupported projections; defaults to `true`. */
    viewport?: boolean | MapViewportOptions;
    /** Fallback renderer for projections other than Mercator and globe. Defaults to `"geojson"`. */
    fallback?: "geojson" | "error";
    /** Solid CSS hex color. Default `"#e63946"`. */
    lineColor?: string;
    /** Screen-space line width. Default `1`. */
    lineWidth?: number;
    /** Line opacity from 0 to 1. Default `0.9`. */
    lineOpacity?: number;
  };

/** Style values that can be changed without rebuilding the shader grid. */
export type ShaderGridStyleUpdate = Partial<
  Pick<ShaderGridOptions, "lineColor" | "lineWidth" | "lineOpacity">
>;

/** Mutable layer placement and zoom settings accepted by a shader-grid handle. */
export type ShaderGridLayerUpdate = Pick<
  ShaderGridOptions,
  "beforeId" | "minzoom" | "maxzoom" | "slot"
>;

/** Handle for a shader grid or its GeoJSON fallback. */
export interface ShaderGridHandle {
  /** Renderer currently in use. */
  readonly renderer: "webgl" | "geojson";
  /** Update shader line styling. */
  update(options: ShaderGridStyleUpdate & ShaderGridLayerUpdate): void;
  /** Show the grid. */
  show(): void;
  /** Hide the grid. */
  hide(): void;
  /** Remove the grid layer and release WebGL resources. */
  remove(): void;
}

/** Apply mutable placement and zoom settings to a shader layer. */
function updateLayerSettings(
  map: MapLike,
  id: string,
  settings: ShaderGridLayerUpdate,
  updateZoom: (minzoom: number | undefined, maxzoom: number | undefined) => void,
): void {
  if (settings.minzoom !== undefined || settings.maxzoom !== undefined) {
    updateZoom(settings.minzoom, settings.maxzoom);
  }
  if (settings.slot !== undefined) {
    if (!map.setSlot) {
      throw new GridError("map does not support updating layer slots");
    }
    map.setSlot(id, settings.slot);
  }
  if (settings.beforeId !== undefined) {
    if (!map.moveLayer) {
      throw new GridError("map does not support updating layer placement");
    }
    map.moveLayer(id, settings.beforeId);
  }
}

/** Options for a projected-CRS shader grid on Mercator or globe maps. */
export type ShaderProjectedGridOptions = Omit<
  AddProjectedGridOptions,
  "worker" | "onWorkerError" | "viewport" | "paint" | "layout"
> & {
  resolution: Resolution;
  /** Draw only currently visible lines in unsupported-projection fallback mode. */
  viewport?: boolean | MapViewportOptions;
  /** Optional mesh line limit; exceeding it throws. */
  maxLines?: number;
  /** Color, width and opacity for the shader path (hex color only). */
  lineColor?: string;
  lineWidth?: number;
  lineOpacity?: number;
  /** Fallback renderer for projections other than Mercator and globe. Defaults to `"geojson"`. */
  fallback?: "geojson" | "error";
};

/** Options for a Web Mercator grid aligned to a slippy-map tile-pixel lattice. */
export type ShaderTilePixelGridOptions = Omit<
  ShaderProjectedGridOptions,
  "crs" | "origin" | "resolution"
> & {
  /** Web Mercator zoom level. */
  zoom: number;
  /** Tile width in pixels. Default `256`. */
  tileSize?: number;
};

interface ShaderResources {
  program: object;
  buffer: object;
  position: number;
  other: number;
  side: number;
  globePosition: number;
  globeOther: number;
  grid: number;
  matrix: object;
  globeMatrix: object;
  transition: object;
  viewport: object;
  bbox: object;
  steps: object;
  origin: object;
  edgeBorders: object;
  clippingPlane: object;
  clippingActive: object;
  color: object;
  width: object;
  opacity: object;
}

interface ShaderGl {
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  readonly ARRAY_BUFFER: number;
  readonly STATIC_DRAW: number;
  readonly CURRENT_PROGRAM: number;
  readonly ARRAY_BUFFER_BINDING: number;
  readonly BLEND: number;
  readonly DEPTH_TEST: number;
  readonly BLEND_SRC_RGB: number;
  readonly BLEND_DST_RGB: number;
  readonly BLEND_SRC_ALPHA: number;
  readonly BLEND_DST_ALPHA: number;
  readonly BLEND_EQUATION_RGB: number;
  readonly BLEND_EQUATION_ALPHA: number;
  readonly DEPTH_WRITEMASK: number;
  readonly VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: number;
  readonly VERTEX_ATTRIB_ARRAY_ENABLED: number;
  readonly VERTEX_ATTRIB_ARRAY_SIZE: number;
  readonly VERTEX_ATTRIB_ARRAY_TYPE: number;
  readonly VERTEX_ATTRIB_ARRAY_NORMALIZED: number;
  readonly VERTEX_ATTRIB_ARRAY_STRIDE: number;
  readonly VERTEX_ATTRIB_ARRAY_POINTER: number;
  readonly FLOAT: number;
  readonly FUNC_ADD: number;
  readonly SRC_ALPHA: number;
  readonly ONE_MINUS_SRC_ALPHA: number;
  readonly ONE: number;
  readonly TRIANGLE_STRIP: number;
  readonly TRIANGLES: number;
  readonly VIEWPORT: number;
  readonly VERSION: number;
  createShader(type: number): object | null;
  shaderSource(shader: object, source: string): void;
  compileShader(shader: object): void;
  getShaderParameter(shader: object, parameter: number): unknown;
  getShaderInfoLog(shader: object): string | null;
  deleteShader(shader: object): void;
  createProgram(): object | null;
  attachShader(program: object, shader: object): void;
  linkProgram(program: object): void;
  getProgramParameter(program: object, parameter: number): unknown;
  getProgramInfoLog(program: object): string | null;
  deleteProgram(program: object | null): void;
  getAttribLocation(program: object, name: string): number;
  getUniformLocation(program: object, name: string): object | null;
  createBuffer(): object | null;
  bindBuffer(target: number, buffer: object | null): void;
  bufferData(target: number, data: Float32Array, usage: number): void;
  deleteBuffer(buffer: object | null): void;
  getVertexAttrib(index: number, parameter: number): unknown;
  getVertexAttribOffset(index: number, parameter: number): number;
  getParameter(parameter: number): unknown;
  isEnabled(capability: number): boolean;
  enable(capability: number): void;
  disable(capability: number): void;
  useProgram(program: object | null): void;
  blendEquationSeparate(modeRgb: number, modeAlpha: number): void;
  blendFuncSeparate(srcRgb: number, dstRgb: number, srcAlpha: number, dstAlpha: number): void;
  depthMask(flag: boolean): void;
  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void;
  enableVertexAttribArray(index: number): void;
  disableVertexAttribArray(index: number): void;
  uniformMatrix4fv(location: object, transpose: boolean, value: Float32Array): void;
  uniform4f(location: object, x: number, y: number, z: number, w: number): void;
  uniform2f(location: object, x: number, y: number): void;
  uniform1i(location: object, value: number): void;
  uniform1f(location: object, value: number): void;
  drawArrays(mode: number, first: number, count: number): void;
}

interface ShaderRenderParameters {
  projectionMatrix?: ArrayLike<number>;
  viewMatrix?: ArrayLike<number>;
  globeClippingPlane?: readonly [number, number, number, number] | null;
}

type ShaderProjection = { name?: string };

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_other;
attribute float a_side;
attribute vec3 a_globe_pos;
attribute vec3 a_globe_other;
attribute vec2 a_grid;
uniform mat4 u_matrix;
uniform mat4 u_globe_matrix;
uniform float u_transition;
uniform float u_line_width;
uniform vec2 u_viewport;
varying vec2 v_grid;
varying vec3 v_globe;
void main() {
  v_grid = a_grid;
  vec4 mercatorPosition = u_matrix * vec4(a_pos, 0.0, 1.0);
  vec4 globePosition = u_globe_matrix * vec4(a_globe_pos, 1.0);
  vec4 mercatorOther = u_matrix * vec4(a_other, 0.0, 1.0);
  vec4 globeOther = u_globe_matrix * vec4(a_globe_other, 1.0);
  vec4 position = mix(globePosition, mercatorPosition, u_transition);
  vec4 other = mix(globeOther, mercatorOther, u_transition);
  vec2 direction = (other.xy / max(other.w, 0.000001) - position.xy / max(position.w, 0.000001)) * u_viewport;
  float magnitude = max(length(direction), 0.000001);
  vec2 normal = vec2(-direction.y, direction.x) / magnitude;
  position.xy += normal * a_side * u_line_width / u_viewport * position.w;
  gl_Position = position;
  v_globe = a_globe_pos;
}`;

const FRAGMENT_SHADER = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec4 u_bbox;
uniform vec2 u_steps;
uniform vec2 u_origin;
uniform int u_edge_borders;
uniform vec4 u_color;
uniform float u_line_width;
uniform float u_opacity;
uniform vec4 u_globe_clipping_plane;
uniform float u_globe_clipping_active;
uniform float u_transition;
varying vec2 v_grid;
varying vec3 v_globe;

float lineCoverage(float coordinate) {
  float distanceToLine = abs(fract(coordinate + 0.5) - 0.5);
  float pixelWidth = max(fwidth(coordinate), 0.000001);
  float edge = u_line_width * pixelWidth * 0.5;
  return 1.0 - smoothstep(edge, edge + pixelWidth, distanceToLine);
}

void main() {
  float xCoordinate = v_grid.x;
  float yCoordinate = v_grid.y;
  float inside = step(u_bbox.x, xCoordinate) * step(xCoordinate, u_bbox.z)
    * step(u_bbox.y, yCoordinate) * step(yCoordinate, u_bbox.w);
  float vertical = lineCoverage(xCoordinate / u_steps.x + u_origin.x);
  float horizontal = lineCoverage(yCoordinate / u_steps.y + u_origin.y);
  if (u_edge_borders == 1) {
    vertical = max(vertical, lineCoverage((xCoordinate - u_bbox.z) / u_steps.x));
    horizontal = max(horizontal, lineCoverage((yCoordinate - u_bbox.w) / u_steps.y));
  }
  float alpha = max(vertical, horizontal) * inside * u_opacity * u_color.a;
  if (u_globe_clipping_active > 0.5 && u_transition < 1.0) {
    float signedDistance = dot(u_globe_clipping_plane.xyz, v_globe)
      + u_globe_clipping_plane.w;
    float visibility = step(0.0, signedDistance);
    alpha *= mix(visibility, 1.0, u_transition);
  }
  if (alpha <= 0.001) {
    discard;
  }
  gl_FragColor = vec4(u_color.rgb, alpha);
}`;

/** Parse a supported CSS hex color to normalized RGBA. */
function parseHexColor(value: string): [number, number, number, number] {
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  const hex = short ? [...short[1]].map((digit) => digit + digit).join("") : long?.[1];
  if (!hex) {
    throw new GridError("shader lineColor must be a #rgb or #rrggbb hex color");
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
    1,
  ];
}

/** Validate shader-specific style options. */
function validateStyle(options: ShaderGridStyleUpdate): void {
  if (options.lineColor !== undefined) {
    parseHexColor(options.lineColor);
  }
  if (
    options.lineWidth !== undefined &&
    (!Number.isFinite(options.lineWidth) || options.lineWidth <= 0)
  ) {
    throw new GridError("shader lineWidth must be positive and finite");
  }
  if (
    options.lineOpacity !== undefined &&
    (!Number.isFinite(options.lineOpacity) || options.lineOpacity < 0 || options.lineOpacity > 1)
  ) {
    throw new GridError("shader lineOpacity must be between 0 and 1");
  }
}

/** Compile a shader and report compiler diagnostics as a grid error. */
function compileShader(gl: ShaderGl, type: number, source: string): object {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new GridError("WebGL could not allocate a grid shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "unknown shader compiler error";
    gl.deleteShader(shader);
    throw new GridError(`grid shader compilation failed: ${message}`);
  }
  return shader;
}

/** Use GLSL ES 3 syntax for Mapbox GL JS's WebGL2 context. */
function shaderSources(gl: ShaderGl): { vertex: string; fragment: string } {
  const version = gl.getParameter(gl.VERSION);
  if (typeof version !== "string" || !version.includes("WebGL 2")) {
    return { vertex: VERTEX_SHADER, fragment: FRAGMENT_SHADER };
  }
  return {
    vertex: `#version 300 es
in vec2 a_pos;
in vec2 a_other;
in float a_side;
in vec3 a_globe_pos;
in vec3 a_globe_other;
in vec2 a_grid;
uniform mat4 u_matrix;
uniform mat4 u_globe_matrix;
uniform float u_transition;
uniform float u_line_width;
uniform vec2 u_viewport;
out vec2 v_grid;
out vec3 v_globe;
void main() {
  v_grid = a_grid;
  vec4 mercatorPosition = u_matrix * vec4(a_pos, 0.0, 1.0);
  vec4 globePosition = u_globe_matrix * vec4(a_globe_pos, 1.0);
  vec4 mercatorOther = u_matrix * vec4(a_other, 0.0, 1.0);
  vec4 globeOther = u_globe_matrix * vec4(a_globe_other, 1.0);
  vec4 position = mix(globePosition, mercatorPosition, u_transition);
  vec4 other = mix(globeOther, mercatorOther, u_transition);
  vec2 direction = (other.xy / max(other.w, 0.000001) - position.xy / max(position.w, 0.000001)) * u_viewport;
  float magnitude = max(length(direction), 0.000001);
  vec2 normal = vec2(-direction.y, direction.x) / magnitude;
  position.xy += normal * a_side * u_line_width / u_viewport * position.w;
  gl_Position = position;
  v_globe = a_globe_pos;
}`,
    fragment: `#version 300 es
precision highp float;
uniform vec4 u_bbox;
uniform vec2 u_steps;
uniform vec2 u_origin;
uniform vec4 u_globe_clipping_plane;
uniform float u_globe_clipping_active;
uniform float u_transition;
uniform int u_edge_borders;
uniform vec4 u_color;
uniform float u_line_width;
uniform float u_opacity;
in vec2 v_grid;
in vec3 v_globe;
out vec4 fragColor;
${FRAGMENT_SHADER.slice(FRAGMENT_SHADER.indexOf("float lineCoverage"))}`.replace(
      "gl_FragColor",
      "fragColor",
    ),
  };
}

/** Initialize shader program and world-quad buffer. */
function createResources(gl: ShaderGl, quad: Float32Array): ShaderResources {
  const sources = shaderSources(gl);
  const vertex = compileShader(gl, gl.VERTEX_SHADER, sources.vertex);
  let fragment: object | undefined;
  let program: object | null = null;
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, sources.fragment);
    program = gl.createProgram();
    if (!program) {
      throw new GridError("WebGL could not allocate a grid program");
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new GridError(
        `grid shader linking failed: ${gl.getProgramInfoLog(program) ?? "unknown link error"}`,
      );
    }
    const position = gl.getAttribLocation(program, "a_pos");
    const other = gl.getAttribLocation(program, "a_other");
    const side = gl.getAttribLocation(program, "a_side");
    const globePosition = gl.getAttribLocation(program, "a_globe_pos");
    const globeOther = gl.getAttribLocation(program, "a_globe_other");
    const grid = gl.getAttribLocation(program, "a_grid");
    const matrix = gl.getUniformLocation(program, "u_matrix");
    const globeMatrix = gl.getUniformLocation(program, "u_globe_matrix");
    const transition = gl.getUniformLocation(program, "u_transition");
    const viewport = gl.getUniformLocation(program, "u_viewport");
    const bbox = gl.getUniformLocation(program, "u_bbox");
    const steps = gl.getUniformLocation(program, "u_steps");
    const origin = gl.getUniformLocation(program, "u_origin");
    const edgeBorders = gl.getUniformLocation(program, "u_edge_borders");
    const clippingPlane = gl.getUniformLocation(program, "u_globe_clipping_plane");
    const clippingActive = gl.getUniformLocation(program, "u_globe_clipping_active");
    const color = gl.getUniformLocation(program, "u_color");
    const width = gl.getUniformLocation(program, "u_line_width");
    const opacity = gl.getUniformLocation(program, "u_opacity");
    if (
      position < 0 ||
      other < 0 ||
      side < 0 ||
      globePosition < 0 ||
      globeOther < 0 ||
      grid < 0 ||
      !matrix ||
      !globeMatrix ||
      !transition ||
      !viewport ||
      !bbox ||
      !steps ||
      !origin ||
      !edgeBorders ||
      !clippingPlane ||
      !clippingActive ||
      !color ||
      !width ||
      !opacity
    ) {
      throw new GridError("grid shader program is missing a required attribute or uniform");
    }
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new GridError("WebGL could not allocate a grid buffer");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    return {
      program,
      buffer,
      position,
      other,
      side,
      globePosition,
      globeOther,
      grid,
      matrix,
      globeMatrix,
      transition,
      viewport,
      bbox,
      steps,
      origin,
      edgeBorders,
      clippingPlane,
      clippingActive,
      color,
      width,
      opacity,
    };
  } catch (error) {
    if (program) {
      gl.deleteProgram(program);
    }
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) {
      gl.deleteShader(fragment);
    }
  }
}

/** Save mutable GL state used by the grid layer. */
function captureGlState(gl: ShaderGl, positions: readonly number[]) {
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM) as object | null,
    buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as object | null,
    blend: gl.isEnabled(gl.BLEND),
    depth: gl.isEnabled(gl.DEPTH_TEST),
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB) as number,
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number,
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
    attributes: positions.map((index) => ({
      index,
      enabled: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean,
      buffer: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as object | null,
      size: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_SIZE) as number,
      type: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_TYPE) as number,
      normalized: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED) as boolean,
      stride: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_STRIDE) as number,
      offset: gl.getVertexAttribOffset(index, gl.VERTEX_ATTRIB_ARRAY_POINTER),
    })),
  };
}

/** Restore GL state after drawing into Mapbox/MapLibre's shared context. */
function restoreGlState(gl: ShaderGl, state: ReturnType<typeof captureGlState>): void {
  for (const attribute of state.attributes) {
    gl.bindBuffer(gl.ARRAY_BUFFER, attribute.buffer);
    if (attribute.buffer) {
      gl.vertexAttribPointer(
        attribute.index,
        attribute.size,
        attribute.type,
        attribute.normalized,
        attribute.stride,
        attribute.offset,
      );
    }
    if (attribute.enabled) {
      gl.enableVertexAttribArray(attribute.index);
    } else {
      gl.disableVertexAttribArray(attribute.index);
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
  gl.useProgram(state.program);
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  gl.blendFuncSeparate(
    state.blendSrcRgb,
    state.blendDstRgb,
    state.blendSrcAlpha,
    state.blendDstAlpha,
  );
  gl.depthMask(state.depthMask);
  if (state.blend) {
    gl.enable(gl.BLEND);
  } else {
    gl.disable(gl.BLEND);
  }
  if (state.depth) {
    gl.enable(gl.DEPTH_TEST);
  } else {
    gl.disable(gl.DEPTH_TEST);
  }
}

/** Fold a normalized-world reference point into the view matrix using JS double precision. */
function matrixRelativeToAnchor(
  matrix: readonly number[],
  anchor: readonly [number, number],
): Float32Array {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) {
    throw new GridError("map provided an invalid custom-layer matrix");
  }
  const relative = [...matrix];
  relative[12] = matrix[0] * anchor[0] + matrix[4] * anchor[1] + matrix[12];
  relative[13] = matrix[1] * anchor[0] + matrix[5] * anchor[1] + matrix[13];
  relative[14] = matrix[2] * anchor[0] + matrix[6] * anchor[1] + matrix[14];
  relative[15] = matrix[3] * anchor[0] + matrix[7] * anchor[1] + matrix[15];
  return new Float32Array(relative);
}

const GLOBE_RADIUS = 8192 / (2 * Math.PI);
const WORLD_SIZE = 40_075_016.68557849;

/** Convert normalized Mercator world coordinates to Mapbox's globe ECEF coordinate space. */
function worldToGlobe(x: number, y: number): [number, number, number] {
  const longitude = (x - 0.5) * 360;
  const latitude = (Math.atan(Math.sinh((0.5 - y) * 2 * Math.PI)) * 180) / Math.PI;
  return longitudeLatitudeToGlobe(longitude, latitude);
}

function longitudeLatitudeToGlobe(longitude: number, latitude: number): [number, number, number] {
  const longitudeRadians = (longitude * Math.PI) / 180;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const cosLatitude = Math.cos(latitudeRadians);
  return [
    cosLatitude * Math.sin(longitudeRadians) * GLOBE_RADIUS,
    -Math.sin(latitudeRadians) * GLOBE_RADIUS,
    cosLatitude * Math.cos(longitudeRadians) * GLOBE_RADIUS,
  ];
}

/** Multiply column-major 4x4 matrices. */
function multiplyMatrices(left: ArrayLike<number>, right: ArrayLike<number>): number[] {
  if (left.length !== 16 || right.length !== 16) {
    throw new GridError("map provided an invalid projection matrix");
  }
  const result = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let inner = 0; inner < 4; inner += 1) {
        result[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
      }
    }
  }
  if (!result.every(Number.isFinite)) {
    throw new GridError("map provided an invalid projection matrix");
  }
  return result;
}

/** Translate a column-major matrix by a CPU-precision reference point. */
function matrixRelativeToPoint(
  matrix: readonly number[],
  anchor: readonly [number, number, number],
): Float32Array {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) {
    throw new GridError("map provided an invalid custom-layer matrix");
  }
  const relative = [...matrix];
  relative[12] = matrix[0] * anchor[0] + matrix[4] * anchor[1] + matrix[8] * anchor[2] + matrix[12];
  relative[13] = matrix[1] * anchor[0] + matrix[5] * anchor[1] + matrix[9] * anchor[2] + matrix[13];
  relative[14] =
    matrix[2] * anchor[0] + matrix[6] * anchor[1] + matrix[10] * anchor[2] + matrix[14];
  relative[15] =
    matrix[3] * anchor[0] + matrix[7] * anchor[1] + matrix[11] * anchor[2] + matrix[15];
  return new Float32Array(relative);
}

/** Create a tessellated surface over geographic or EPSG:3857 bounds. */
function createSurfaceMesh(
  bounds: BBox | ProjectedBounds,
  projected: boolean,
  anchor: readonly [number, number],
): { vertices: Float32Array; globeAnchor: readonly [number, number, number] } {
  const [minX, minY, maxX, maxY] = bounds;
  const toWorld = (x: number, y: number): [number, number] => {
    if (projected) {
      return [x / WORLD_SIZE + 0.5, 0.5 - y / WORLD_SIZE];
    }
    const latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066, y));
    return [
      x / 360 + 0.5,
      0.5 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / (2 * Math.PI),
    ];
  };
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const globeAnchor = projected
    ? worldToGlobe(anchor[0], anchor[1])
    : longitudeLatitudeToGlobe(centerX, centerY);
  const subdivisions = 48;
  const vertices: number[] = [];
  const append = (x: number, y: number): void => {
    const world = toWorld(x, y);
    const globe = projected ? worldToGlobe(world[0], world[1]) : longitudeLatitudeToGlobe(x, y);
    const localX = world[0] - anchor[0];
    const localY = world[1] - anchor[1];
    vertices.push(
      localX,
      localY,
      localX,
      localY,
      0,
      globe[0] - globeAnchor[0],
      globe[1] - globeAnchor[1],
      globe[2] - globeAnchor[2],
      globe[0] - globeAnchor[0],
      globe[1] - globeAnchor[1],
      globe[2] - globeAnchor[2],
      x - centerX,
      y - centerY,
    );
  };
  for (let row = 0; row < subdivisions; row += 1) {
    const y0 = minY + ((maxY - minY) * row) / subdivisions;
    const y1 = minY + ((maxY - minY) * (row + 1)) / subdivisions;
    for (let column = 0; column < subdivisions; column += 1) {
      const x0 = minX + ((maxX - minX) * column) / subdivisions;
      const x1 = minX + ((maxX - minX) * (column + 1)) / subdivisions;
      append(x0, y0);
      append(x1, y0);
      append(x0, y1);
      append(x1, y0);
      append(x1, y1);
      append(x0, y1);
    }
  }
  return { vertices: new Float32Array(vertices), globeAnchor };
}

/** Create a handle that renders a coordinate lattice through a shader. */
function createShaderGrid(
  map: MapLike,
  options: Pick<ShaderGridOptions, "id" | "beforeId" | "minzoom" | "maxzoom" | "slot" | "fit"> &
    ShaderGridStyleUpdate,
  bbox: BBox,
  steps: readonly [number, number],
  origin: readonly [number, number],
  projected: boolean,
  edgeBorders: boolean,
): ShaderGridHandle {
  const worldSize = 40_075_016.68557849;
  const centerX = (bbox[0] + bbox[2]) / 2;
  const centerY = (bbox[1] + bbox[3]) / 2;
  const centerLatitude =
    (Math.max(-85.0511287798066, Math.min(85.0511287798066, centerY)) * Math.PI) / 180;
  const anchor: [number, number] = projected
    ? [centerX / worldSize + 0.5, 0.5 - centerY / worldSize]
    : [
        centerX / 360 + 0.5,
        0.5 - Math.log(Math.tan(Math.PI / 4 + centerLatitude / 2)) / (2 * Math.PI),
      ];
  const localBounds: BBox = [
    bbox[0] - centerX,
    bbox[1] - centerY,
    bbox[2] - centerX,
    bbox[3] - centerY,
  ];
  const phase = (coordinate: number, anchorCoordinate: number, step: number): number => {
    const value = (anchorCoordinate - coordinate) / step;
    return value - Math.floor(value);
  };
  const localOrigin: [number, number] = [
    phase(origin[0], centerX, steps[0]),
    phase(origin[1], centerY, steps[1]),
  ];
  const surface = createSurfaceMesh(bbox, projected, anchor);
  if (!surface.vertices.every(Number.isFinite)) {
    throw new GridError("grid bounds cannot be represented in Web Mercator coordinates");
  }
  const style: Required<ShaderGridStyleUpdate> = {
    lineColor: options.lineColor ?? "#e63946",
    lineWidth: options.lineWidth ?? 1,
    lineOpacity: options.lineOpacity ?? 0.9,
  };
  validateStyle(style);
  const layerSettings: ShaderGridLayerUpdate = {
    beforeId: options.beforeId,
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
  };
  const id = options.id ?? DEFAULT_LAYER_ID;
  let removed = false;
  let visible = true;
  let gl: ShaderGl | undefined;
  let resources: ShaderResources | undefined;
  const handle: ShaderGridHandle = {
    renderer: "webgl",
    update(next): void {
      validateStyle(next);
      if (
        next.beforeId !== undefined ||
        next.minzoom !== undefined ||
        next.maxzoom !== undefined ||
        next.slot !== undefined
      ) {
        if (next.beforeId !== undefined) layerSettings.beforeId = next.beforeId;
        if (next.minzoom !== undefined) layerSettings.minzoom = next.minzoom;
        if (next.maxzoom !== undefined) layerSettings.maxzoom = next.maxzoom;
        if (next.slot !== undefined) layerSettings.slot = next.slot;
        whenStyleReady(map, () => {
          if (!removed && map.getLayer(id)) {
            updateLayerSettings(map, id, next, () => {});
          }
        });
      }
      if (next.lineColor !== undefined) style.lineColor = next.lineColor;
      if (next.lineWidth !== undefined) style.lineWidth = next.lineWidth;
      if (next.lineOpacity !== undefined) style.lineOpacity = next.lineOpacity;
      map.triggerRepaint?.();
    },
    show(): void {
      if (!removed) {
        visible = true;
        map.triggerRepaint?.();
      }
    },
    hide(): void {
      if (!removed) {
        visible = false;
        map.triggerRepaint?.();
      }
    },
    remove(): void {
      if (removed) {
        return;
      }
      removed = true;
      map.off("webglcontextlost", handleContextLost);
      map.off("webglcontextrestored", handleContextRestored);
      whenStyleReady(map, () => {
        if (map.getLayer(id)) {
          map.removeLayer(id);
        }
      });
    },
  };

  const releaseResources = (): void => {
    if (gl && resources) {
      gl.deleteBuffer(resources.buffer);
      gl.deleteProgram(resources.program);
    }
    resources = undefined;
  };
  const initialize = (context: ShaderGl): void => {
    releaseResources();
    gl = context;
    resources = createResources(context, surface.vertices);
  };
  const handleContextRestored = (): void => {
    if (gl && !removed) {
      initialize(gl);
      map.triggerRepaint?.();
    }
  };
  const handleContextLost = (): void => {
    resources = undefined;
  };
  const customLayer = {
    id,
    type: "custom",
    renderingMode: "2d",
    slot: options.slot,
    onAdd(_map: unknown, context: ShaderGl): void {
      initialize(context);
    },
    render(
      context: ShaderGl,
      matrix: number[],
      projection?: ShaderProjection,
      projectionToMercatorMatrix?: number[],
      projectionToMercatorTransition?: number,
      _centerInMercator?: number[],
      _pixelsPerMeterRatio?: number,
      renderParameters?: ShaderRenderParameters,
    ): void {
      const zoom = map.getZoom?.();
      if (
        removed ||
        !visible ||
        !resources ||
        (zoom !== undefined &&
          ((layerSettings.minzoom !== undefined && zoom < layerSettings.minzoom) ||
            (layerSettings.maxzoom !== undefined && zoom >= layerSettings.maxzoom)))
      ) {
        return;
      }
      const viewport = context.getParameter(context.VIEWPORT) as ArrayLike<number> | null;
      if (!viewport || viewport.length < 4 || viewport[2] <= 0 || viewport[3] <= 0) {
        throw new GridError("WebGL returned an invalid viewport for the shader grid");
      }
      const isGlobe = projection?.name === "globe";
      if (
        isGlobe &&
        (!projectionToMercatorMatrix || projectionToMercatorTransition === undefined)
      ) {
        throw new GridError("globe shader rendering requires Mapbox's globe projection matrices");
      }
      const mercatorMatrix = matrixRelativeToAnchor(matrix, anchor);
      const globeMatrix =
        isGlobe && projectionToMercatorMatrix
          ? matrixRelativeToPoint(
              multiplyMatrices(matrix, projectionToMercatorMatrix),
              surface.globeAnchor,
            )
          : mercatorMatrix;
      const transition = isGlobe ? (projectionToMercatorTransition ?? 0) : 1;
      const clippingPlane = isGlobe ? renderParameters?.globeClippingPlane : undefined;
      const localClippingPlane: [number, number, number, number] = clippingPlane
        ? [
            clippingPlane[0],
            clippingPlane[1],
            clippingPlane[2],
            clippingPlane[3] +
              clippingPlane[0] * surface.globeAnchor[0] +
              clippingPlane[1] * surface.globeAnchor[1] +
              clippingPlane[2] * surface.globeAnchor[2],
          ]
        : [0, 0, 1, 0];
      const attributes = [
        resources.position,
        resources.other,
        resources.side,
        resources.globePosition,
        resources.globeOther,
        resources.grid,
      ];
      const state = captureGlState(context, attributes);
      try {
        context.useProgram(resources.program);
        context.bindBuffer(context.ARRAY_BUFFER, resources.buffer);
        context.enableVertexAttribArray(resources.position);
        context.vertexAttribPointer(resources.position, 2, context.FLOAT, false, 52, 0);
        context.enableVertexAttribArray(resources.other);
        context.vertexAttribPointer(resources.other, 2, context.FLOAT, false, 52, 8);
        context.enableVertexAttribArray(resources.side);
        context.vertexAttribPointer(resources.side, 1, context.FLOAT, false, 52, 16);
        context.enableVertexAttribArray(resources.globePosition);
        context.vertexAttribPointer(resources.globePosition, 3, context.FLOAT, false, 52, 20);
        context.enableVertexAttribArray(resources.globeOther);
        context.vertexAttribPointer(resources.globeOther, 3, context.FLOAT, false, 52, 32);
        context.enableVertexAttribArray(resources.grid);
        context.vertexAttribPointer(resources.grid, 2, context.FLOAT, false, 52, 44);
        context.uniformMatrix4fv(resources.matrix, false, mercatorMatrix);
        context.uniformMatrix4fv(resources.globeMatrix, false, globeMatrix);
        context.uniform1f(resources.transition, transition);
        context.uniform2f(resources.viewport, viewport[2], viewport[3]);
        context.uniform4f(
          resources.bbox,
          localBounds[0],
          localBounds[1],
          localBounds[2],
          localBounds[3],
        );
        context.uniform2f(resources.steps, steps[0], steps[1]);
        context.uniform2f(resources.origin, localOrigin[0], localOrigin[1]);
        context.uniform1i(resources.edgeBorders, edgeBorders ? 1 : 0);
        const color = parseHexColor(style.lineColor);
        context.uniform4f(resources.color, color[0], color[1], color[2], color[3]);
        context.uniform1f(resources.width, style.lineWidth * (map.getPixelRatio?.() ?? 1));
        context.uniform1f(resources.opacity, style.lineOpacity);
        context.uniform4f(resources.clippingPlane, ...localClippingPlane);
        context.uniform1f(resources.clippingActive, clippingPlane ? 1 : 0);
        context.disable(context.DEPTH_TEST);
        context.depthMask(false);
        context.enable(context.BLEND);
        context.blendEquationSeparate(context.FUNC_ADD, context.FUNC_ADD);
        context.blendFuncSeparate(
          context.SRC_ALPHA,
          context.ONE_MINUS_SRC_ALPHA,
          context.ONE,
          context.ONE_MINUS_SRC_ALPHA,
        );
        context.drawArrays(context.TRIANGLES, 0, surface.vertices.length / 13);
      } finally {
        restoreGlState(context, state);
      }
    },
    onRemove(_map: unknown, context: ShaderGl): void {
      removed = true;
      map.off("webglcontextlost", handleContextLost);
      map.off("webglcontextrestored", handleContextRestored);
      context.deleteBuffer(resources?.buffer ?? null);
      context.deleteProgram(resources?.program ?? null);
      resources = undefined;
      gl = undefined;
    },
  };

  map.on("webglcontextlost", handleContextLost);
  map.on("webglcontextrestored", handleContextRestored);
  whenStyleReady(map, () => {
    if (!removed) {
      map.addLayer(customLayer, options.beforeId);
    }
  });
  if (options.fit) {
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      options.fit === true ? { padding: 40 } : options.fit,
    );
  }
  return handle;
}

/** Create a GeoJSON fallback handle with shader-style paint values. */
function createGeoJsonFallback(
  map: MapLike,
  id: string,
  handle: {
    update(options: { paint: Record<string, unknown> }): void;
    show(): void;
    hide(): void;
    remove(): void;
  },
  fallbackReason: string,
  initial: ShaderGridStyleUpdate,
  initialLayerSettings: ShaderGridLayerUpdate,
): ShaderGridHandle {
  console.warn(`[mapbox-bbox-grid] Using the GeoJSON renderer: ${fallbackReason}`);
  const style = {
    lineColor: initial.lineColor ?? "#e63946",
    lineWidth: initial.lineWidth ?? 1,
    lineOpacity: initial.lineOpacity ?? 0.9,
  };
  const layerSettings = { ...initialLayerSettings };
  return {
    renderer: "geojson",
    update(next): void {
      validateStyle(next);
      const paint: Record<string, unknown> = {};
      if (next.lineColor !== undefined) {
        style.lineColor = next.lineColor;
        paint["line-color"] = next.lineColor;
      }
      if (next.lineWidth !== undefined) {
        style.lineWidth = next.lineWidth;
        paint["line-width"] = next.lineWidth;
      }
      if (next.lineOpacity !== undefined) {
        style.lineOpacity = next.lineOpacity;
        paint["line-opacity"] = next.lineOpacity;
      }
      if (Object.keys(paint).length > 0) {
        handle.update({ paint });
      }
      if (
        next.beforeId !== undefined ||
        next.minzoom !== undefined ||
        next.maxzoom !== undefined ||
        next.slot !== undefined
      ) {
        const mergedSettings = { ...layerSettings, ...next };
        if (next.beforeId !== undefined) layerSettings.beforeId = next.beforeId;
        if (next.minzoom !== undefined) layerSettings.minzoom = next.minzoom;
        if (next.maxzoom !== undefined) layerSettings.maxzoom = next.maxzoom;
        if (next.slot !== undefined) layerSettings.slot = next.slot;
        whenStyleReady(map, () => {
          if (!map.getLayer(id)) {
            return;
          }
          updateLayerSettings(map, id, next, () => {
            if (!map.setLayerZoomRange) {
              throw new GridError("map does not support updating layer zoom ranges");
            }
            map.setLayerZoomRange(id, mergedSettings.minzoom, mergedSettings.maxzoom);
          });
        });
      }
    },
    show: () => handle.show(),
    hide: () => handle.hide(),
    remove: () => handle.remove(),
  };
}

const PROJECTED_LINE_VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_other;
attribute float a_side;
attribute vec3 a_globe_pos;
attribute vec3 a_globe_other;
uniform mat4 u_matrix;
uniform mat4 u_globe_matrix;
uniform vec2 u_viewport;
uniform float u_line_width;
uniform float u_transition;
varying vec3 v_globe;
void main() {
  vec4 position = mix(
    u_globe_matrix * vec4(a_globe_pos, 1.0),
    u_matrix * vec4(a_pos, 0.0, 1.0),
    u_transition
  );
  vec4 other = mix(
    u_globe_matrix * vec4(a_globe_other, 1.0),
    u_matrix * vec4(a_other, 0.0, 1.0),
    u_transition
  );
  vec2 direction = (other.xy / max(other.w, 0.000001) - position.xy / max(position.w, 0.000001)) * u_viewport;
  float magnitude = max(length(direction), 0.000001);
  vec2 normal = vec2(-direction.y, direction.x) / magnitude;
  position.xy += normal * a_side * u_line_width / u_viewport * position.w;
  gl_Position = position;
  v_globe = a_globe_pos;
}`;

const PROJECTED_LINE_FRAGMENT_SHADER = `
precision highp float;
uniform vec4 u_color;
uniform float u_opacity;
uniform vec4 u_globe_clipping_plane;
uniform float u_globe_clipping_active;
uniform float u_transition;
varying vec3 v_globe;
void main() {
  float alpha = u_color.a * u_opacity;
  if (u_globe_clipping_active > 0.5 && u_transition < 1.0) {
    float signedDistance = dot(u_globe_clipping_plane.xyz, v_globe)
      + u_globe_clipping_plane.w;
    alpha *= mix(step(0.0, signedDistance), 1.0, u_transition);
  }
  gl_FragColor = vec4(u_color.rgb, alpha);
}`;

/** Convert WGS84 line features to triangle ribbons in normalized Web Mercator coordinates. */
function projectedGridVertices(
  bounds: ProjectedBounds,
  options: ShaderProjectedGridOptions,
): {
  vertices: Float32Array;
  anchor: readonly [number, number];
  globeAnchor: readonly [number, number, number];
} {
  const grid = createProjectedGridFromBounds(bounds, {
    crs: options.crs,
    resolution: options.resolution,
    origin: options.origin,
    maxLines: options.maxLines,
    maxSegmentLength: options.maxSegmentLength,
  });
  const segments: {
    start: [number, number];
    end: [number, number];
  }[] = [];
  const maxLatitude = 85.0511287798066;
  const toWorld = (longitude: number, latitude: number): [number, number] => {
    const lat = (Math.max(-maxLatitude, Math.min(maxLatitude, latitude)) * Math.PI) / 180;
    return [longitude / 360 + 0.5, 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)];
  };
  for (const feature of grid.features) {
    if (feature.geometry.type !== "MultiLineString") {
      continue;
    }
    for (const line of feature.geometry.coordinates) {
      for (let index = 0; index + 1 < line.length; index += 1) {
        const start = toWorld(line[index][0], line[index][1]);
        const end = toWorld(line[index + 1][0], line[index + 1][1]);
        if (![...start, ...end].every(Number.isFinite)) {
          throw new GridError("grid cannot be represented in Web Mercator coordinates");
        }
        segments.push({ start, end });
      }
    }
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { start, end } of segments) {
    minX = Math.min(minX, start[0], end[0]);
    minY = Math.min(minY, start[1], end[1]);
    maxX = Math.max(maxX, start[0], end[0]);
    maxY = Math.max(maxY, start[1], end[1]);
  }
  const anchor: [number, number] = segments.length
    ? [(minX + maxX) / 2, (minY + maxY) / 2]
    : [0.5, 0.5];
  const globeAnchor = worldToGlobe(anchor[0], anchor[1]);
  const vertices: number[] = [];
  const appendVertex = (
    position: readonly [number, number],
    other: readonly [number, number],
    side: number,
  ): void => {
    const globePosition = worldToGlobe(position[0], position[1]);
    const globeOther = worldToGlobe(other[0], other[1]);
    vertices.push(
      position[0] - anchor[0],
      position[1] - anchor[1],
      other[0] - anchor[0],
      other[1] - anchor[1],
      side,
      globePosition[0] - globeAnchor[0],
      globePosition[1] - globeAnchor[1],
      globePosition[2] - globeAnchor[2],
      globeOther[0] - globeAnchor[0],
      globeOther[1] - globeAnchor[1],
      globeOther[2] - globeAnchor[2],
    );
  };
  for (const { start, end } of segments) {
    appendVertex(start, end, -1);
    appendVertex(start, end, 1);
    appendVertex(end, start, 1);
    appendVertex(start, end, 1);
    appendVertex(end, start, -1);
    appendVertex(end, start, 1);
  }
  return { vertices: new Float32Array(vertices), anchor, globeAnchor };
}

interface ProjectedShaderResources {
  program: object;
  buffer: object;
  position: number;
  other: number;
  side: number;
  globePosition: number;
  globeOther: number;
  matrix: object;
  globeMatrix: object;
  transition: object;
  viewport: object;
  clippingPlane: object;
  clippingActive: object;
  color: object;
  width: object;
  opacity: object;
}

/** Create shader resources and upload the projected grid's triangle mesh. */
function createProjectedShaderResources(
  gl: ShaderGl,
  vertices: Float32Array,
): ProjectedShaderResources {
  const isWebGL2 = String(gl.getParameter(gl.VERSION)).includes("WebGL 2");
  const vertexSource = isWebGL2
    ? `#version 300 es
in vec2 a_pos;
in vec2 a_other;
in float a_side;
in vec3 a_globe_pos;
in vec3 a_globe_other;
uniform mat4 u_matrix;
uniform mat4 u_globe_matrix;
uniform vec2 u_viewport;
uniform float u_line_width;
uniform float u_transition;
out vec3 v_globe;
void main() {
  vec4 position = mix(
    u_globe_matrix * vec4(a_globe_pos, 1.0),
    u_matrix * vec4(a_pos, 0.0, 1.0),
    u_transition
  );
  vec4 other = mix(
    u_globe_matrix * vec4(a_globe_other, 1.0),
    u_matrix * vec4(a_other, 0.0, 1.0),
    u_transition
  );
  vec2 direction = (other.xy / max(other.w, 0.000001) - position.xy / max(position.w, 0.000001)) * u_viewport;
  float magnitude = max(length(direction), 0.000001);
  vec2 normal = vec2(-direction.y, direction.x) / magnitude;
  position.xy += normal * a_side * u_line_width / u_viewport * position.w;
  gl_Position = position;
  v_globe = a_globe_pos;
}`
    : PROJECTED_LINE_VERTEX_SHADER;
  const fragmentSource = isWebGL2
    ? `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform float u_opacity;
uniform vec4 u_globe_clipping_plane;
uniform float u_globe_clipping_active;
uniform float u_transition;
in vec3 v_globe;
out vec4 fragColor;
void main() {
  float alpha = u_color.a * u_opacity;
  if (u_globe_clipping_active > 0.5 && u_transition < 1.0) {
    float signedDistance = dot(u_globe_clipping_plane.xyz, v_globe)
      + u_globe_clipping_plane.w;
    alpha *= mix(step(0.0, signedDistance), 1.0, u_transition);
  }
  fragColor = vec4(u_color.rgb, alpha);
}`
    : PROJECTED_LINE_FRAGMENT_SHADER;
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  let fragment: object | undefined;
  let program: object | null = null;
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) {
      throw new GridError("WebGL could not allocate a projected-grid program");
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new GridError(
        `projected-grid shader linking failed: ${gl.getProgramInfoLog(program) ?? "unknown link error"}`,
      );
    }
    const position = gl.getAttribLocation(program, "a_pos");
    const other = gl.getAttribLocation(program, "a_other");
    const side = gl.getAttribLocation(program, "a_side");
    const globePosition = gl.getAttribLocation(program, "a_globe_pos");
    const globeOther = gl.getAttribLocation(program, "a_globe_other");
    const matrix = gl.getUniformLocation(program, "u_matrix");
    const globeMatrix = gl.getUniformLocation(program, "u_globe_matrix");
    const transition = gl.getUniformLocation(program, "u_transition");
    const viewport = gl.getUniformLocation(program, "u_viewport");
    const clippingPlane = gl.getUniformLocation(program, "u_globe_clipping_plane");
    const clippingActive = gl.getUniformLocation(program, "u_globe_clipping_active");
    const color = gl.getUniformLocation(program, "u_color");
    const width = gl.getUniformLocation(program, "u_line_width");
    const opacity = gl.getUniformLocation(program, "u_opacity");
    if (
      position < 0 ||
      other < 0 ||
      side < 0 ||
      globePosition < 0 ||
      globeOther < 0 ||
      !matrix ||
      !globeMatrix ||
      !transition ||
      !viewport ||
      !clippingPlane ||
      !clippingActive ||
      !color ||
      !width ||
      !opacity
    ) {
      throw new GridError("projected-grid shader is missing a required attribute or uniform");
    }
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new GridError("WebGL could not allocate a projected-grid buffer");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return {
      program,
      buffer,
      position,
      other,
      side,
      globePosition,
      globeOther,
      matrix,
      globeMatrix,
      transition,
      viewport,
      clippingPlane,
      clippingActive,
      color,
      width,
      opacity,
    };
  } catch (error) {
    if (program) {
      gl.deleteProgram(program);
    }
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) {
      gl.deleteShader(fragment);
    }
  }
}

/** Draw a projected-CRS line mesh with screen-space-width shader ribbons. */
function createProjectedGeometryGrid(
  map: MapLike,
  options: ShaderProjectedGridOptions,
  vertices: Float32Array,
  anchor: readonly [number, number],
  globeAnchor: readonly [number, number, number],
): ShaderGridHandle {
  const style: Required<ShaderGridStyleUpdate> = {
    lineColor: options.lineColor ?? "#e63946",
    lineWidth: options.lineWidth ?? 1,
    lineOpacity: options.lineOpacity ?? 0.9,
  };
  validateStyle(style);
  const layerSettings: ShaderGridLayerUpdate = {
    beforeId: options.beforeId,
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
  };
  const id = options.id ?? DEFAULT_LAYER_ID;
  let removed = false;
  let visible = true;
  let gl: ShaderGl | undefined;
  let resources: ProjectedShaderResources | undefined;
  const releaseResources = (): void => {
    if (gl && resources) {
      gl.deleteBuffer(resources.buffer);
      gl.deleteProgram(resources.program);
    }
    resources = undefined;
  };
  const initialize = (context: ShaderGl): void => {
    releaseResources();
    gl = context;
    resources = createProjectedShaderResources(context, vertices);
  };
  const handleContextLost = (): void => {
    resources = undefined;
  };
  const handleContextRestored = (): void => {
    if (gl && !removed) {
      initialize(gl);
      map.triggerRepaint?.();
    }
  };
  const handle: ShaderGridHandle = {
    renderer: "webgl",
    update(next): void {
      validateStyle(next);
      if (
        next.beforeId !== undefined ||
        next.minzoom !== undefined ||
        next.maxzoom !== undefined ||
        next.slot !== undefined
      ) {
        updateLayerSettings(map, id, next, (minzoom, maxzoom) => {
          layerSettings.minzoom = minzoom;
          layerSettings.maxzoom = maxzoom;
        });
        Object.assign(layerSettings, next);
      }
      if (next.lineColor !== undefined) style.lineColor = next.lineColor;
      if (next.lineWidth !== undefined) style.lineWidth = next.lineWidth;
      if (next.lineOpacity !== undefined) style.lineOpacity = next.lineOpacity;
      map.triggerRepaint?.();
    },
    show(): void {
      if (!removed) {
        visible = true;
        map.triggerRepaint?.();
      }
    },
    hide(): void {
      if (!removed) {
        visible = false;
        map.triggerRepaint?.();
      }
    },
    remove(): void {
      if (!removed) {
        removed = true;
        map.off("webglcontextlost", handleContextLost);
        map.off("webglcontextrestored", handleContextRestored);
        whenStyleReady(map, () => {
          if (map.getLayer(id)) {
            map.removeLayer(id);
          }
        });
      }
    },
  };
  const customLayer = {
    id,
    type: "custom",
    renderingMode: "2d",
    slot: options.slot,
    onAdd(_map: unknown, context: ShaderGl): void {
      initialize(context);
    },
    render(
      context: ShaderGl,
      matrix: number[],
      projection?: ShaderProjection,
      projectionToMercatorMatrix?: number[],
      projectionToMercatorTransition?: number,
      _centerInMercator?: number[],
      _pixelsPerMeterRatio?: number,
      renderParameters?: ShaderRenderParameters,
    ): void {
      const zoom = map.getZoom?.();
      if (
        removed ||
        !visible ||
        !resources ||
        vertices.length === 0 ||
        (zoom !== undefined &&
          ((layerSettings.minzoom !== undefined && zoom < layerSettings.minzoom) ||
            (layerSettings.maxzoom !== undefined && zoom >= layerSettings.maxzoom)))
      ) {
        return;
      }
      const viewport = context.getParameter(context.VIEWPORT) as ArrayLike<number> | null;
      if (!viewport || viewport.length < 4 || viewport[2] <= 0 || viewport[3] <= 0) {
        throw new GridError("WebGL returned an invalid viewport for the projected grid");
      }
      const isGlobe = projection?.name === "globe";
      if (
        isGlobe &&
        (!projectionToMercatorMatrix || projectionToMercatorTransition === undefined)
      ) {
        throw new GridError("globe shader rendering requires Mapbox's globe projection matrices");
      }
      const mercatorMatrix = matrixRelativeToAnchor(matrix, anchor);
      const globeMatrix =
        isGlobe && projectionToMercatorMatrix
          ? matrixRelativeToPoint(multiplyMatrices(matrix, projectionToMercatorMatrix), globeAnchor)
          : mercatorMatrix;
      const transition = isGlobe ? (projectionToMercatorTransition ?? 0) : 1;
      const clippingPlane = isGlobe ? renderParameters?.globeClippingPlane : undefined;
      const localClippingPlane: [number, number, number, number] = clippingPlane
        ? [
            clippingPlane[0],
            clippingPlane[1],
            clippingPlane[2],
            clippingPlane[3] +
              clippingPlane[0] * globeAnchor[0] +
              clippingPlane[1] * globeAnchor[1] +
              clippingPlane[2] * globeAnchor[2],
          ]
        : [0, 0, 1, 0];
      const state = captureGlState(context, [
        resources.position,
        resources.other,
        resources.side,
        resources.globePosition,
        resources.globeOther,
      ]);
      try {
        context.useProgram(resources.program);
        context.bindBuffer(context.ARRAY_BUFFER, resources.buffer);
        context.enableVertexAttribArray(resources.position);
        context.vertexAttribPointer(resources.position, 2, context.FLOAT, false, 44, 0);
        context.enableVertexAttribArray(resources.other);
        context.vertexAttribPointer(resources.other, 2, context.FLOAT, false, 44, 8);
        context.enableVertexAttribArray(resources.side);
        context.vertexAttribPointer(resources.side, 1, context.FLOAT, false, 44, 16);
        context.enableVertexAttribArray(resources.globePosition);
        context.vertexAttribPointer(resources.globePosition, 3, context.FLOAT, false, 44, 20);
        context.enableVertexAttribArray(resources.globeOther);
        context.vertexAttribPointer(resources.globeOther, 3, context.FLOAT, false, 44, 32);
        context.uniformMatrix4fv(resources.matrix, false, mercatorMatrix);
        context.uniformMatrix4fv(resources.globeMatrix, false, globeMatrix);
        context.uniform1f(resources.transition, transition);
        context.uniform2f(resources.viewport, viewport[2], viewport[3]);
        context.uniform4f(resources.clippingPlane, ...localClippingPlane);
        context.uniform1f(resources.clippingActive, clippingPlane ? 1 : 0);
        const color = parseHexColor(style.lineColor);
        context.uniform4f(resources.color, color[0], color[1], color[2], color[3]);
        context.uniform1f(resources.width, style.lineWidth * (map.getPixelRatio?.() ?? 1));
        context.uniform1f(resources.opacity, style.lineOpacity);
        context.disable(context.DEPTH_TEST);
        context.depthMask(false);
        context.enable(context.BLEND);
        context.blendEquationSeparate(context.FUNC_ADD, context.FUNC_ADD);
        context.blendFuncSeparate(
          context.SRC_ALPHA,
          context.ONE_MINUS_SRC_ALPHA,
          context.ONE,
          context.ONE_MINUS_SRC_ALPHA,
        );
        context.drawArrays(context.TRIANGLES, 0, vertices.length / 11);
      } finally {
        restoreGlState(context, state);
      }
    },
    onRemove(_map: unknown, context: ShaderGl): void {
      removed = true;
      map.off("webglcontextlost", handleContextLost);
      map.off("webglcontextrestored", handleContextRestored);
      context.deleteBuffer(resources?.buffer ?? null);
      context.deleteProgram(resources?.program ?? null);
      resources = undefined;
      gl = undefined;
    },
  };
  map.on("webglcontextlost", handleContextLost);
  map.on("webglcontextrestored", handleContextRestored);
  whenStyleReady(map, () => {
    if (!removed) {
      map.addLayer(customLayer, options.beforeId);
    }
  });
  return handle;
}

/** Draw a geographic grid as a fragment-shader pattern over the Mercator world. */
export function addShaderBBoxGrid(map: MapLike, options: ShaderGridOptions): ShaderGridHandle {
  const shapeOptions =
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
  const grid = new BBoxGrid(options.bbox, shapeOptions);
  const projection = map.getProjection?.().name;
  const supportsShader = projection === "mercator" || projection === "globe";
  if (!supportsShader) {
    if (options.fallback === "error") {
      throw new GridError("WebGL grid shaders require a Mercator or globe map projection");
    }
    const { lineColor, lineWidth, lineOpacity, fallback: _fallback, ...geojsonOptions } = options;
    const paint = {
      "line-color": lineColor ?? "#e63946",
      "line-width": lineWidth ?? 1,
      "line-opacity": lineOpacity ?? 0.9,
    };
    const handle =
      geojsonOptions.cells !== undefined
        ? addBBoxGrid(map, {
            ...geojsonOptions,
            cells: geojsonOptions.cells,
            viewport: false,
            paint,
          })
        : addBBoxGrid(map, {
            ...geojsonOptions,
            resolution: geojsonOptions.resolution,
            viewport: geojsonOptions.viewport ?? true,
            paint,
          });
    return createGeoJsonFallback(
      map,
      options.id ?? DEFAULT_LAYER_ID,
      handle,
      `custom shader layers do not support the "${projection ?? "unknown"}" projection`,
      { lineColor, lineWidth, lineOpacity },
      options,
    );
  }
  return createShaderGrid(
    map,
    options,
    grid.bbox,
    [grid.xStep, grid.yStep],
    [grid.bbox[0], grid.bbox[1]],
    false,
    true,
  );
}

/**
 * Draw a projected-CRS grid with WebGL on Mercator and globe maps.
 * EPSG:3857 uses a fragment shader; other CRSs use Proj4-generated line meshes.
 * Unsupported map projections use the viewport-aware GeoJSON fallback unless `fallback: "error"` is set.
 */
export function addShaderProjectedGrid(
  map: MapLike,
  bounds: ProjectedBounds,
  options: ShaderProjectedGridOptions,
): ShaderGridHandle {
  if (!Array.isArray(bounds) || bounds.length !== 4) {
    throw new GridError("projected bounds must contain four coordinates");
  }
  const [minX, minY, maxX, maxY] = bounds;
  if (!bounds.every(Number.isFinite) || minX >= maxX || minY >= maxY) {
    throw new GridError("projected bounds must be finite and increasing");
  }
  if (options.resolution === undefined) {
    throw new GridError("resolution is required for shader projected grids");
  }
  const [xStep, yStep] = Array.isArray(options.resolution)
    ? options.resolution
    : [options.resolution, options.resolution];
  if (![xStep, yStep].every((step) => Number.isFinite(step) && step > 0)) {
    throw new GridError("resolution must be positive and finite");
  }
  const halfWorld = 20_037_508.342789244;
  const projection = map.getProjection?.().name;
  const supportsShader = projection === "mercator" || projection === "globe";
  const canShader =
    options.crs === "EPSG:3857" &&
    minX >= -halfWorld &&
    maxX <= halfWorld &&
    minY >= -halfWorld &&
    maxY <= halfWorld &&
    supportsShader &&
    options.maxLines === undefined;
  if (
    options.origin !== undefined &&
    (!Array.isArray(options.origin) ||
      options.origin.length !== 2 ||
      !options.origin.every(Number.isFinite))
  ) {
    throw new GridError("origin must contain two finite coordinates");
  }
  if (!supportsShader) {
    if (options.fallback === "error") {
      throw new GridError("WebGL projected grids require a Mercator or globe map projection");
    }
    const { lineColor, lineWidth, lineOpacity, fallback: _fallback, ...projectedOptions } = options;
    const handle: ProjectedGridOverlayHandle = addProjectedGrid(map, bounds, {
      ...projectedOptions,
      viewport: projectedOptions.viewport ?? true,
      paint: {
        "line-color": lineColor ?? "#e63946",
        "line-width": lineWidth ?? 1,
        "line-opacity": lineOpacity ?? 0.9,
      },
    });
    return createGeoJsonFallback(
      map,
      options.id ?? DEFAULT_LAYER_ID,
      handle,
      `custom shader layers do not support the "${projection ?? "unknown"}" projection`,
      { lineColor, lineWidth, lineOpacity },
      options,
    );
  }
  if (!canShader) {
    const mesh = projectedGridVertices(bounds, options);
    return createProjectedGeometryGrid(map, options, mesh.vertices, mesh.anchor, mesh.globeAnchor);
  }
  const { lineColor, lineWidth, lineOpacity, fallback: _fallback, ...layerOptions } = options;
  return createShaderGrid(
    map,
    { ...layerOptions, lineColor, lineWidth, lineOpacity },
    bounds,
    [xStep, yStep],
    options.origin ?? [0, 0],
    true,
    false,
  );
}

/** Draw a Web Mercator tile-pixel lattice with spacing derived from zoom and tile size. */
export function addShaderTilePixelGrid(
  map: MapLike,
  bounds: ProjectedBounds,
  options: ShaderTilePixelGridOptions,
): ShaderGridHandle {
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
  return addShaderProjectedGrid(map, bounds, {
    ...layerOptions,
    crs: "EPSG:3857",
    origin: [-halfWorld, -halfWorld],
    resolution,
  });
}
