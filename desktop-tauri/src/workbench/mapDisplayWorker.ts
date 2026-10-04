import { registerCrsDefinition } from "../domain";
import {
  createOutputDisplayChunkProcessor,
  prepareOutputDisplay,
  type OutputDisplayChunk,
  type OutputDisplay,
  type OutputDisplayLayer,
} from "./mapDisplay";

export type MapDisplayWorkerRequest =
  | {
      kind?: "all";
      revision: number;
      layers: OutputDisplayLayer[];
      crs_definitions?: Record<string, string>;
    }
  | ({
      kind: "chunk";
      revision: number;
      crs_definitions?: Record<string, string>;
    } & OutputDisplayChunk);

export type MapDisplayWorkerResponse =
  | { revision: number; value: OutputDisplay }
  | { revision: number; error: string }
  | {
      kind: "chunk";
      revision: number;
      layer_index: number;
      feature_start: number;
      value: OutputDisplay;
    }
  | { kind: "chunk"; revision: number; error: string };

export type MapDisplayChunkResponse = Extract<
  MapDisplayWorkerResponse,
  { kind: "chunk" }
>;

function registerDefinitions(
  definitions: Record<string, string> | undefined,
): void {
  for (const [crs, definition] of Object.entries(definitions ?? {})) {
    registerCrsDefinition(crs, definition);
  }
}

/** 可直接单测的 Worker 消息处理器；revision 原样带回以便调用方丢弃旧结果。 */
export function processMapDisplayWorkerMessage(
  request: MapDisplayWorkerRequest,
): MapDisplayWorkerResponse {
  try {
    if (request.kind === "chunk")
      throw new Error("分块消息须通过 createMapDisplayChunkProcessor 处理");
    registerDefinitions(request.crs_definitions);
    return {
      revision: request.revision,
      value: prepareOutputDisplay(request.layers),
    };
  } catch (error) {
    return {
      revision: request.revision,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 在单个 Worker 中逐块处理，工作线程不累计已完成块的数据。 */
export function createMapDisplayChunkProcessor(): (
  request: Extract<MapDisplayWorkerRequest, { kind: "chunk" }>,
) => MapDisplayChunkResponse {
  const processChunk = createOutputDisplayChunkProcessor();
  return (request) => {
    try {
      registerDefinitions(request.crs_definitions);
      return {
        kind: "chunk",
        revision: request.revision,
        layer_index: request.layer_index,
        feature_start: request.feature_start,
        value: processChunk(request),
      };
    } catch (error) {
      return {
        kind: "chunk",
        revision: request.revision,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

type WorkerScope = {
  onmessage: ((event: MessageEvent<MapDisplayWorkerRequest>) => void) | null;
  postMessage: (message: MapDisplayWorkerResponse) => void;
};

const workerScope = globalThis as unknown as WorkerScope;
const processChunk = createMapDisplayChunkProcessor();

workerScope.onmessage = (event) => {
  const response =
    event.data.kind === "chunk"
      ? processChunk(event.data)
      : processMapDisplayWorkerMessage(event.data);
  workerScope.postMessage(response);
};
