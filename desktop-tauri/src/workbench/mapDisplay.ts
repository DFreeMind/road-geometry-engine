import proj4, { type Converter } from "proj4";
import { hasCrsDefinition, registerCrsDefinition } from "../domain";

/** 用于绘制的成果图层；collection 保持工程内原始投影坐标。 */
export type OutputDisplayLayer = {
  name: string;
  crs: string;
  collection: GeoJSON.FeatureCollection;
};

export type OutputDisplayMetrics = {
  feature_count: number;
  coordinate_count: number;
  source_layer_count: number;
};

export type OutputDisplay = {
  collection: GeoJSON.FeatureCollection;
  metrics: OutputDisplayMetrics;
};

const DISPLAY_PROPERTY_KEYS = [
  "component",
  "side",
  "lane_index",
  "source_dataset_id",
  "source_feature_key",
  "part_index",
  "route_id",
] as const;

type CoordinatePosition = number[];

function registerWgs84UtmDefinitionIfNeeded(crs: string): void {
  const match = /^EPSG:(326|327)(\d{2})$/i.exec(crs);
  if (!match || hasCrsDefinition(crs)) return;
  const series = Number(match[1]);
  const zone = Number(match[2]);
  if (zone < 1 || zone > 60) return;
  registerCrsDefinition(
    crs,
    `+proj=utm +zone=${zone}${series === 327 ? " +south" : ""} +datum=WGS84 +units=m +no_defs +type=crs`,
  );
}

function getForwardConverter(
  crs: string,
  converters: Map<string, Converter>,
): Converter | null {
  if (crs === "EPSG:4326") return null;
  const cached = converters.get(crs);
  if (cached) return cached;
  registerWgs84UtmDefinitionIfNeeded(crs);
  const converter = proj4(crs, "EPSG:4326");
  converters.set(crs, converter);
  return converter;
}

function transformPositionWithDimensions(
  position: CoordinatePosition,
  crs: string,
  converters: Map<string, Converter>,
): CoordinatePosition {
  if (position.length < 2) {
    throw new Error("成果几何坐标至少需要包含 X、Y 两个值");
  }
  if (!position.every(Number.isFinite)) {
    throw new Error("成果几何包含无效坐标值");
  }
  const xy: [number, number] = [position[0], position[1]];
  const converter = getForwardConverter(crs, converters);
  const transformed = converter ? converter.forward(xy) : xy;
  if (!transformed.every(Number.isFinite)) throw new Error("坐标转换结果无效");
  return [...transformed, ...position.slice(2)];
}

function transformCoordinateTree(
  value: unknown,
  crs: string,
  counter: { coordinate_count: number },
  converters: Map<string, Converter>,
): unknown {
  if (!Array.isArray(value)) {
    throw new Error("成果几何坐标结构无效");
  }
  if (value.length === 0) return [];
  if (value.every((item) => typeof item === "number")) {
    counter.coordinate_count += 1;
    return transformPositionWithDimensions(
      value as CoordinatePosition,
      crs,
      converters,
    );
  }
  return value.map((item) =>
    transformCoordinateTree(item, crs, counter, converters),
  );
}

function transformGeometry(
  geometry: GeoJSON.Geometry,
  crs: string,
  counter: { coordinate_count: number },
  converters: Map<string, Converter>,
): GeoJSON.Geometry {
  if (geometry.type === "GeometryCollection") {
    return {
      ...geometry,
      geometries: geometry.geometries.map((item) =>
        transformGeometry(item, crs, counter, converters),
      ),
    };
  }

  const coordinates = transformCoordinateTree(
    geometry.coordinates,
    crs,
    counter,
    converters,
  );
  return { ...geometry, coordinates } as GeoJSON.Geometry;
}

function displayProperties(
  properties: GeoJSON.GeoJsonProperties,
  layerIndex: number,
  featureIndex: number,
): GeoJSON.GeoJsonProperties {
  const display: Record<string, unknown> = {};
  if (properties) {
    for (const key of DISPLAY_PROPERTY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        display[key] = properties[key];
      }
    }
  }
  display.__output_layer = layerIndex;
  display.__output_feature = featureIndex;
  return display;
}

/**
 * 把多成果图层转换为单个 WGS84 地图副本；不简化顶点，也不修改输入成果。
 * 空几何要素只从地图副本跳过，仍保留在原生产图层中。
 */
export function prepareOutputDisplay(
  layers: OutputDisplayLayer[],
): OutputDisplay {
  const features: GeoJSON.Feature[] = [];
  const coordinateCounter = { coordinate_count: 0 };
  const converters = new Map<string, Converter>();

  layers.forEach((layer, layerIndex) => {
    layer.collection.features.forEach((feature, featureIndex) => {
      if (!feature.geometry) return;
      features.push({
        type: "Feature",
        ...(feature.id === undefined ? {} : { id: feature.id }),
        properties: displayProperties(
          feature.properties,
          layerIndex,
          featureIndex,
        ),
        geometry: transformGeometry(
          feature.geometry,
          layer.crs,
          coordinateCounter,
          converters,
        ),
      });
    });
  });

  return {
    collection: {
      type: "FeatureCollection",
      features,
    },
    metrics: {
      feature_count: features.length,
      coordinate_count: coordinateCounter.coordinate_count,
      source_layer_count: layers.length,
    },
  };
}
