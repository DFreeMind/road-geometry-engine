import { registerCrsDefinition } from "../domain";
import {
  prepareOutputDisplay,
  type OutputDisplay,
  type OutputDisplayLayer,
} from "./mapDisplay";

export type MapDisplayWorkerRequest = {
  revision: number;
  layers: OutputDisplayLayer[];
  crs_definitions?: Record<string, string>;
};

export type MapDisplayWorkerResponse =
  | { revision: number; value: OutputDisplay }
  | { revision: number; error: string };

/** 可直接单测的 Worker 消息处理器；revision 原样带回以便调用方丢弃旧结果。 */
export function processMapDisplayWorkerMessage(
  request: MapDisplayWorkerRequest,
): MapDisplayWorkerResponse {
  try {
    for (const [crs, definition] of Object.entries(
      request.crs_definitions ?? {},
    )) {
      registerCrsDefinition(crs, definition);
    }
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

type WorkerScope = {
  onmessage: ((event: MessageEvent<MapDisplayWorkerRequest>) => void) | null;
  postMessage: (message: MapDisplayWorkerResponse) => void;
};

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  workerScope.postMessage(processMapDisplayWorkerMessage(event.data));
};
