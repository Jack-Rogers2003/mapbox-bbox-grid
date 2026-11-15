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
    /** Fallback renderer for non-Mercator maps. Defaults to `"geojson"`. */
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

/** Handle for a shader grid or its GeoJSON fallback. */
export interface ShaderGridHandle {
  /** Renderer currently in use. */
  readonly renderer: "webgl" | "geojson";
  /** Update shader line styling. */
  update(options: ShaderGridStyleUpdate): void;
  /** Show the grid. */
  show(): void;
  /** Hide the grid. */
  hide(): void;
  /** Remove the grid layer and release WebGL resources. */
  remove(): void;
}

/** Options for a WebGL shader grid in EPSG:3857 coordinates. */
export type ShaderProjectedGridOptions = Omit<
  AddProjectedGridOptions,
  "worker" | "onWorkerError" | "viewport" | "paint" | "layout"
> & {
  resolution: Resolution;
  /** Optional mesh line limit; exceeding it throws. Supplying it uses the mesh renderer. */
  maxLines?: number;
  /** Color, width and opacity for the shader path (hex color only). */
  lineColor?: string;
  lineWidth?: number;
  lineOpacity?: number;
  /** Fallback renderer for non-Mercator map projections. Defaults to `"geojson"`. */
  fallback?: "geojson" | "error";
};

interface ShaderResources {
  program: object;
  buffer: object;
  position: number;
  matrix: object;
  bbox: object;
  steps: object;
  origin: object;
  projected: object;
  edgeBorders: object;
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

const VERTEX_SHADER = `
attribute vec2 a_pos;
uniform mat4 u_matrix;
varying vec2 v_world;
void main() {
  v_world = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec4 u_bbox;
uniform vec2 u_steps;
uniform vec2 u_origin;
uniform int u_projected;
uniform int u_edge_borders;
uniform vec4 u_color;
uniform float u_line_width;
uniform float u_opacity;
varying vec2 v_world;

float lineCoverage(float coordinate) {
  float distanceToLine = abs(fract(coordinate + 0.5) - 0.5);
  float pixelWidth = max(fwidth(coordinate), 0.000001);
  float edge = u_line_width * pixelWidth * 0.5;
  return 1.0 - smoothstep(edge, edge + pixelWidth, distanceToLine);
}

void main() {
  float xCoordinate = mod(v_world.x, 1.0) * 360.0 - 180.0;
  float mercatorY = clamp(v_world.y, 0.000001, 0.999999);
  float mercatorRadians = 3.141592653589793 * (1.0 - 2.0 * mercatorY);
  float yCoordinate = degrees(atan(0.5 * (exp(mercatorRadians) - exp(-mercatorRadians))));
  if (u_projected == 1) {
    xCoordinate = mod(v_world.x, 1.0) * 40075016.68557849 - 20037508.342789244;
    yCoordinate = (0.5 - v_world.y) * 40075016.68557849;
  }
  float inside = step(u_bbox.x, xCoordinate) * step(xCoordinate, u_bbox.z)
    * step(u_bbox.y, yCoordinate) * step(yCoordinate, u_bbox.w);
  float vertical = lineCoverage((xCoordinate - u_origin.x) / u_steps.x);
  float horizontal = lineCoverage((yCoordinate - u_origin.y) / u_steps.y);
  if (u_edge_borders == 1) {
    vertical = max(vertical, lineCoverage((xCoordinate - u_bbox.z) / u_steps.x));
    horizontal = max(horizontal, lineCoverage((yCoordinate - u_bbox.w) / u_steps.y));
  }
  float alpha = max(vertical, horizontal) * inside * u_opacity * u_color.a;
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
uniform mat4 u_matrix;
out vec2 v_world;
void main() {
  v_world = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`,
    fragment: `#version 300 es
precision highp float;
uniform vec4 u_bbox;
uniform vec2 u_steps;
uniform vec2 u_origin;
uniform int u_projected;
uniform int u_edge_borders;
uniform vec4 u_color;
uniform float u_line_width;
uniform float u_opacity;
in vec2 v_world;
out vec4 fragColor;
${FRAGMENT_SHADER.slice(FRAGMENT_SHADER.indexOf("float lineCoverage"))}`.replace(
      "gl_FragColor",
      "fragColor",
    ),
  };
}

/** Initialize shader program and world-quad buffer. */
function createResources(gl: ShaderGl): ShaderResources {
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
    const matrix = gl.getUniformLocation(program, "u_matrix");
    const bbox = gl.getUniformLocation(program, "u_bbox");
    const steps = gl.getUniformLocation(program, "u_steps");
    const origin = gl.getUniformLocation(program, "u_origin");
    const projected = gl.getUniformLocation(program, "u_projected");
    const edgeBorders = gl.getUniformLocation(program, "u_edge_borders");
    const color = gl.getUniformLocation(program, "u_color");
    const width = gl.getUniformLocation(program, "u_line_width");
    const opacity = gl.getUniformLocation(program, "u_opacity");
    if (
      position < 0 ||
      !matrix ||
      !bbox ||
      !steps ||
      !origin ||
      !projected ||
      !edgeBorders ||
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
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 0, 2, 0, -1, 1, 2, 1]), gl.STATIC_DRAW);
    return {
      program,
      buffer,
      position,
      matrix,
      bbox,
      steps,
      origin,
      projected,
      edgeBorders,
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
  const style: Required<ShaderGridStyleUpdate> = {
    lineColor: options.lineColor ?? "#e63946",
    lineWidth: options.lineWidth ?? 1,
    lineOpacity: options.lineOpacity ?? 0.9,
  };
  validateStyle(style);
  const id = options.id ?? DEFAULT_LAYER_ID;
  let removed = false;
  let visible = true;
  let gl: ShaderGl | undefined;
  let resources: ShaderResources | undefined;
  const handle: ShaderGridHandle = {
    renderer: "webgl",
    update(next): void {
      validateStyle(next);
      Object.assign(style, next);
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
    resources = createResources(context);
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
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
    onAdd(_map: unknown, context: ShaderGl): void {
      initialize(context);
    },
    render(context: ShaderGl, matrix: number[]): void {
      if (removed || !visible || !resources) {
        return;
      }
      const state = captureGlState(context, [resources.position]);
      try {
        context.useProgram(resources.program);
        context.bindBuffer(context.ARRAY_BUFFER, resources.buffer);
        context.enableVertexAttribArray(resources.position);
        context.vertexAttribPointer(resources.position, 2, context.FLOAT, false, 0, 0);
        context.uniformMatrix4fv(resources.matrix, false, new Float32Array(matrix));
        context.uniform4f(resources.bbox, bbox[0], bbox[1], bbox[2], bbox[3]);
        context.uniform2f(resources.steps, steps[0], steps[1]);
        context.uniform2f(resources.origin, origin[0], origin[1]);
        context.uniform1i(resources.projected, projected ? 1 : 0);
        context.uniform1i(resources.edgeBorders, edgeBorders ? 1 : 0);
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
        context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
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
  handle: {
    update(options: { paint: Record<string, unknown> }): void;
    show(): void;
    hide(): void;
    remove(): void;
  },
  initial: ShaderGridStyleUpdate,
): ShaderGridHandle {
  const style = {
    lineColor: initial.lineColor ?? "#e63946",
    lineWidth: initial.lineWidth ?? 1,
    lineOpacity: initial.lineOpacity ?? 0.9,
  };
  return {
    renderer: "geojson",
    update(next): void {
      validateStyle(next);
      Object.assign(style, next);
      const paint: Record<string, unknown> = {};
      if (next.lineColor !== undefined) {
        paint["line-color"] = style.lineColor;
      }
      if (next.lineWidth !== undefined) {
        paint["line-width"] = style.lineWidth;
      }
      if (next.lineOpacity !== undefined) {
        paint["line-opacity"] = style.lineOpacity;
      }
      handle.update({ paint });
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
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_line_width;
void main() {
  vec4 position = u_matrix * vec4(a_pos, 0.0, 1.0);
  vec4 other = u_matrix * vec4(a_other, 0.0, 1.0);
  vec2 direction = (other.xy / max(other.w, 0.000001) - position.xy / max(position.w, 0.000001)) * u_viewport;
  float magnitude = max(length(direction), 0.000001);
  vec2 normal = vec2(-direction.y, direction.x) / magnitude;
  position.xy += normal * a_side * u_line_width / u_viewport * position.w;
  gl_Position = position;
}`;

const PROJECTED_LINE_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 u_color;
uniform float u_opacity;
void main() {
  gl_FragColor = vec4(u_color.rgb, u_color.a * u_opacity);
}`;

/** Convert WGS84 line features to triangle ribbons in normalized Web Mercator coordinates. */
function projectedGridVertices(
  bounds: ProjectedBounds,
  options: ShaderProjectedGridOptions,
): Float32Array {
  const grid = createProjectedGridFromBounds(bounds, {
    crs: options.crs,
    resolution: options.resolution,
    origin: options.origin,
    maxLines: options.maxLines,
    maxSegmentLength: options.maxSegmentLength,
  });
  const vertices: number[] = [];
  const maxLatitude = 85.0511287798066;
  const toWorld = (longitude: number, latitude: number): [number, number] => {
    const lat = (Math.max(-maxLatitude, Math.min(maxLatitude, latitude)) * Math.PI) / 180;
    return [longitude / 360 + 0.5, 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)];
  };
  const appendVertex = (
    position: readonly [number, number],
    other: readonly [number, number],
    side: number,
  ): void => {
    vertices.push(position[0], position[1], other[0], other[1], side);
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
        appendVertex(start, end, -1);
        appendVertex(start, end, 1);
        appendVertex(end, start, 1);
        appendVertex(start, end, 1);
        appendVertex(end, start, -1);
        appendVertex(end, start, 1);
      }
    }
  }
  return new Float32Array(vertices);
}

interface ProjectedShaderResources {
  program: object;
  buffer: object;
  position: number;
  other: number;
  side: number;
  matrix: object;
  viewport: object;
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
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_line_width;
void main() {
  vec4 position = u_matrix * vec4(a_pos, 0.0, 1.0);
  vec4 other = u_matrix * vec4(a_other, 0.0, 1.0);
  vec2 direction = (other.xy / max(other.w, 0.000001) - position.xy / max(position.w, 0.000001)) * u_viewport;
  float magnitude = max(length(direction), 0.000001);
  vec2 normal = vec2(-direction.y, direction.x) / magnitude;
  position.xy += normal * a_side * u_line_width / u_viewport * position.w;
  gl_Position = position;
}`
    : PROJECTED_LINE_VERTEX_SHADER;
  const fragmentSource = isWebGL2
    ? `#version 300 es
precision mediump float;
uniform vec4 u_color;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_color.rgb, u_color.a * u_opacity);
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
    const matrix = gl.getUniformLocation(program, "u_matrix");
    const viewport = gl.getUniformLocation(program, "u_viewport");
    const color = gl.getUniformLocation(program, "u_color");
    const width = gl.getUniformLocation(program, "u_line_width");
    const opacity = gl.getUniformLocation(program, "u_opacity");
    if (
      position < 0 ||
      other < 0 ||
      side < 0 ||
      !matrix ||
      !viewport ||
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
    return { program, buffer, position, other, side, matrix, viewport, color, width, opacity };
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
): ShaderGridHandle {
  const style: Required<ShaderGridStyleUpdate> = {
    lineColor: options.lineColor ?? "#e63946",
    lineWidth: options.lineWidth ?? 1,
    lineOpacity: options.lineOpacity ?? 0.9,
  };
  validateStyle(style);
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
      Object.assign(style, next);
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
    minzoom: options.minzoom,
    maxzoom: options.maxzoom,
    slot: options.slot,
    onAdd(_map: unknown, context: ShaderGl): void {
      initialize(context);
    },
    render(context: ShaderGl, matrix: number[]): void {
      if (removed || !visible || !resources || vertices.length === 0) {
        return;
      }
      const viewport = context.getParameter(context.VIEWPORT) as ArrayLike<number> | null;
      if (!viewport || viewport.length < 4 || viewport[2] <= 0 || viewport[3] <= 0) {
        throw new GridError("WebGL returned an invalid viewport for the projected grid");
      }
      const state = captureGlState(context, [resources.position, resources.other, resources.side]);
      try {
        context.useProgram(resources.program);
        context.bindBuffer(context.ARRAY_BUFFER, resources.buffer);
        context.enableVertexAttribArray(resources.position);
        context.vertexAttribPointer(resources.position, 2, context.FLOAT, false, 20, 0);
        context.enableVertexAttribArray(resources.other);
        context.vertexAttribPointer(resources.other, 2, context.FLOAT, false, 20, 8);
        context.enableVertexAttribArray(resources.side);
        context.vertexAttribPointer(resources.side, 1, context.FLOAT, false, 20, 16);
        context.uniformMatrix4fv(resources.matrix, false, new Float32Array(matrix));
        context.uniform2f(resources.viewport, viewport[2], viewport[3]);
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
        context.drawArrays(context.TRIANGLES, 0, vertices.length / 5);
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
  if (map.getProjection?.().name !== "mercator") {
    if (options.fallback === "error") {
      throw new GridError("WebGL grid shaders require the Mercator map projection");
    }
    const { lineColor, lineWidth, lineOpacity, fallback: _fallback, ...geojsonOptions } = options;
    const fallbackOptions =
      geojsonOptions.cells !== undefined
        ? { ...geojsonOptions, cells: geojsonOptions.cells }
        : { ...geojsonOptions, resolution: geojsonOptions.resolution };
    const handle = addBBoxGrid(map, {
      ...fallbackOptions,
      paint: {
        "line-color": lineColor ?? "#e63946",
        "line-width": lineWidth ?? 1,
        "line-opacity": lineOpacity ?? 0.9,
      },
    });
    return createGeoJsonFallback(handle, { lineColor, lineWidth, lineOpacity });
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

/** Draw an EPSG:3857 grid in a fragment shader, falling back for other CRSs/projections. */
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
  const isMercatorMap = map.getProjection?.().name === "mercator";
  const canShader =
    options.crs === "EPSG:3857" &&
    minX >= -halfWorld &&
    maxX <= halfWorld &&
    minY >= -halfWorld &&
    maxY <= halfWorld &&
    isMercatorMap &&
    options.maxLines === undefined;
  if (
    options.origin !== undefined &&
    (!Array.isArray(options.origin) ||
      options.origin.length !== 2 ||
      !options.origin.every(Number.isFinite))
  ) {
    throw new GridError("origin must contain two finite coordinates");
  }
  if (!isMercatorMap) {
    if (options.fallback === "error") {
      throw new GridError("WebGL projected grids require a Mercator map projection");
    }
    const { lineColor, lineWidth, lineOpacity, fallback: _fallback, ...projectedOptions } = options;
    const handle: ProjectedGridOverlayHandle = addProjectedGrid(map, bounds, {
      ...projectedOptions,
      paint: {
        "line-color": lineColor ?? "#e63946",
        "line-width": lineWidth ?? 1,
        "line-opacity": lineOpacity ?? 0.9,
      },
    });
    return createGeoJsonFallback(handle, { lineColor, lineWidth, lineOpacity });
  }
  if (!canShader) {
    return createProjectedGeometryGrid(map, options, projectedGridVertices(bounds, options));
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
