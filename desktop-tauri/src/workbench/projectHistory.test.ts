import { describe, expect, it } from "vitest";
import { defaultProject } from "../domain";
import { projectHistorySnapshot } from "./projectHistory";

describe("不可变工程撤销快照", () => {
  it("共享大型数据分支，根及修改后的分支互不覆盖", () => {
    const project = { ...defaultProject(), vector_basemaps: [{ id: "large" }] };
    const snapshot = projectHistorySnapshot(project);
    expect(snapshot).not.toBe(project);
    expect(snapshot.vector_basemaps).toBe(project.vector_basemaps);
    expect(snapshot.route_points).toBe(project.route_points);
    const edited = { ...project, route_points: [[1, 2] as [number, number]] };
    expect(snapshot.route_points).toEqual(project.route_points);
    expect(edited.route_points).toHaveLength(1);
    project.route_id = "changed";
    expect(snapshot.route_id).not.toBe("changed");
  });
});
