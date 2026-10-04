import type { RoadProject } from "../domain";

/** 工程更新采用不可变分支；撤销仅保存根快照，未变化的原始数据和成果共享，不逐次深拷贝。 */
export function projectHistorySnapshot(project: RoadProject): RoadProject {
  return { ...project };
}
