import { prepareSourceBatch } from "./sourceBatch";
import type { SourceDataset } from "./sourceBatch";
import type { RoadProject } from "../domain";

// 投影转换与逐行映射在工作线程完成，避免大批量任务阻塞地图交互。
self.onmessage = (
  event: MessageEvent<{ datasets: SourceDataset[]; project: RoadProject }>,
) => {
  try {
    self.postMessage({
      value: prepareSourceBatch(event.data.datasets, event.data.project),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
