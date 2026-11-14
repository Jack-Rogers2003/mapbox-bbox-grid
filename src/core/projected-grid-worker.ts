import { GridError } from "../errors";
import type { LineFeatureCollection, ProjectedBounds } from "../types";
import {
  createProjectedGridFromBoundsFactory,
  type ProjectedBoundsGridOptions,
} from "./projected-grid";

/** Message event accepted by the projected-grid worker protocol. */
export interface ProjectedGridWorkerMessageEvent {
  data: unknown;
}

/** Worker interface consumed by `addProjectedGrid`. */
export interface ProjectedGridWorker {
  /** Send a grid-generation request. */
  postMessage(message: unknown): void;
  /** Listen for a result or error response. */
  addEventListener(
    type: "message",
    listener: (event: ProjectedGridWorkerMessageEvent) => void,
  ): void;
  /** Remove a result listener. */
  removeEventListener(
    type: "message",
    listener: (event: ProjectedGridWorkerMessageEvent) => void,
  ): void;
}

/** Worker-global interface needed by `installProjectedGridWorker`. */
export interface ProjectedGridWorkerScope {
  /** Listen for grid-generation requests. */
  addEventListener(
    type: "message",
    listener: (event: ProjectedGridWorkerMessageEvent) => void,
  ): void;
  /** Send a result or error response. */
  postMessage(message: unknown): void;
}

/** Handle worker-side grid-generation errors when using a custom worker. */
export type ProjectedGridWorkerErrorHandler = (error: Error) => void;

interface GridRequest {
  type: "projected-grid";
  requestId: number;
  bounds: ProjectedBounds;
  options: ProjectedBoundsGridOptions;
  view?: readonly [number, number, number, number];
  viewportOptions?: { padding?: number; maxLines?: number };
}

interface GridResponse {
  type: "projected-grid-result" | "projected-grid-error";
  requestId: number;
  data?: LineFeatureCollection;
  error?: string;
}

/** Whether an inbound message has the grid request shape. */
function isGridRequest(value: unknown): value is GridRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "projected-grid" &&
    "requestId" in value &&
    Number.isSafeInteger(value.requestId) &&
    "bounds" in value &&
    Array.isArray(value.bounds) &&
    "options" in value &&
    typeof value.options === "object" &&
    value.options !== null
  );
}

/**
 * Install the projected-grid request handler in a module worker.
 * Import and call this function from the worker entrypoint using `self`.
 * @param scope - Worker global scope.
 */
export function installProjectedGridWorker(scope: ProjectedGridWorkerScope): void {
  const generators = new Map<string, ReturnType<typeof createProjectedGridFromBoundsFactory>>();
  scope.addEventListener("message", (event) => {
    if (!isGridRequest(event.data)) {
      return;
    }
    const request = event.data;
    let response: GridResponse;
    try {
      const key = JSON.stringify([request.bounds, request.options]);
      let generator = generators.get(key);
      if (!generator) {
        generator = createProjectedGridFromBoundsFactory(request.bounds, request.options);
        generators.set(key, generator);
      }
      const data = request.view
        ? generator.viewport(request.view, request.viewportOptions)
        : generator.full();
      response = { type: "projected-grid-result", requestId: request.requestId, data };
    } catch (error) {
      response = {
        type: "projected-grid-error",
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    scope.postMessage(response);
  });
}

/** Return a validated worker response or `undefined` for an unrelated message. */
export function parseProjectedGridWorkerResponse(value: unknown): GridResponse | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(message.requestId) ||
    (message.type !== "projected-grid-result" && message.type !== "projected-grid-error")
  ) {
    return undefined;
  }
  if (message.type === "projected-grid-result") {
    const data = message.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== "FeatureCollection" ||
      !("features" in data) ||
      !Array.isArray(data.features)
    ) {
      throw new GridError("projected-grid worker returned an invalid grid response");
    }
    return {
      type: "projected-grid-result",
      requestId: Number(message.requestId),
      data: data as LineFeatureCollection,
    };
  }
  const error = message.error;
  if (typeof error !== "string") {
    throw new GridError("projected-grid worker returned an invalid error response");
  }
  return {
    type: "projected-grid-error",
    requestId: Number(message.requestId),
    error,
  };
}
