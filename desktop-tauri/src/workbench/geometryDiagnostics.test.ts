import { expect, it } from "vitest";
import {
  geometryDiagnostics,
  responseGeometryCollections,
} from "./geometryDiagnostics";
it("流式坐标校验发现修改，不复制业务属性或几何", () => {
  const collection: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { large: "ignored" },
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 2],
            [3, 4],
          ],
        },
      },
    ],
  };
  const response = {
    feature_collection: collection,
    projected_crs: "EPSG:32650",
  };
  expect(responseGeometryCollections(response)[0]).toBe(collection);
  const first = geometryDiagnostics([collection]);
  expect(first.coordinate_count).toBe(2);
  (collection.features[0].geometry as GeoJSON.LineString).coordinates[1][0] = 5;
  expect(geometryDiagnostics([collection]).checksum).not.toBe(first.checksum);
});
