import {
  saveBindingMapping,
  type SourceBinding,
  type FieldMapping,
} from "./connections";
import { installMapWheelHandling } from "./MapInteraction";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import maplibregl, {
  addProtocol,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";
import type * as GeoJSON from "geojson";
import { isTauri } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Baseline,
  Box,
  Check,
  ChevronDown,
  CircleHelp,
  CloudOff,
  Copy,
  Crosshair,
  Database,
  Download,
  FileJson,
  FolderOpen,
  Layers3,
  Map as MapIcon,
  MapPinned,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  Move3D,
  PenLine,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  acceptGeneration,
  basicCatalog,
  defaultProject,
  facilityFeature,
  markInputEdited,
  hasCrsDefinition,
  normalizeProject,
  registerCrsDefinition,
  resolveMappedValue,
  routeToGeoJSON,
  transformPosition,
  utmCrsForWgs84,
  type CatalogEntry,
  type Facility,
  type GeometryType,
  type Position,
  type RoadProject,
} from "../domain";
import { chooseFile, chooseSave } from "../tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Redo2,
  ChevronRight,
} from "lucide-react";
import { NumericField, SpecificationForm } from "./EditorFields";
import { CrossSectionEditor } from "./CrossSectionEditor";
import { WorkbenchMenu } from "./WorkbenchMenu";
import { AlongRouteTools } from "./AlongRouteTools";
import { BasemapPicker } from "./BasemapPicker";
import { registerBasemapProtocols, type BasemapConfig } from "./basemaps";
import {
  DataSourceTools,
  FieldMappingTools,
  type Field,
} from "./DataSourceTools";
import {
  RouteFeatureSelector,
  type RouteFeature,
} from "./RouteFeatureSelector";

type Panel = "data" | "road" | "facility" | "layers";
type Tool = "pan" | "route" | "vertex" | "facility";
type Status = { text: string; tone?: "warn" | "ok" | "error" };
const emptyCollection: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const emptyOptions: Record<string, unknown> = {};
let rasterProtocolRegistered = false;
const invokeNative = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(command, args);

function lineLength(points: Position[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    );
  return length;
}
function makeId() {
  return `facility-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function geomCollection(
  items: Facility[],
  crs: string,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map((item) => facilityFeature(item, crs)),
  };
}
function responseLayers(
  response: any,
): { name: string; collection: GeoJSON.FeatureCollection; crs: string }[] {
  const layers: {
    name: string;
    collection: GeoJSON.FeatureCollection;
    crs: string;
  }[] = [];
  const value = response?.layers ?? response?.outputs?.layers;
  if (Array.isArray(value))
    for (const layer of value) {
      const collection =
        layer.collection ?? layer.geojson ?? layer.feature_collection;
      if (collection?.type === "FeatureCollection")
        layers.push({
          name: String(
            layer.name ?? layer.layer_name ?? `成果图层 ${layers.length + 1}`,
          ),
          collection,
          crs: String(layer.crs ?? response.crs ?? "EPSG:4326"),
        });
    }
  if (
    !layers.length &&
    response?.feature_collection?.type === "FeatureCollection"
  ) {
    const collection = response.feature_collection as GeoJSON.FeatureCollection;
    const crs = String(response.projected_crs ?? "EPSG:4326");
    const groups = new Map<string, GeoJSON.Feature[]>();
    for (const feature of collection.features) {
      const name = String(
        feature.properties?.component ??
          feature.properties?.layer ??
          feature.properties?.layer_name ??
          "道路成果",
      );
      groups.set(name, [...(groups.get(name) ?? []), feature]);
    }
    for (const [name, features] of groups)
      layers.push({
        name,
        collection: { type: "FeatureCollection", features },
        crs,
      });
  }
  if (!layers.length && response?.type === "FeatureCollection")
    layers.push({ name: "道路成果", collection: response, crs: "EPSG:4326" });
  for (const layer of response?.ancillary_layers ?? []) {
    if (layer.collection?.type === "FeatureCollection")
      layers.push({
        name: layer.name,
        collection: layer.collection,
        crs: String(layer.crs ?? response.projected_crs),
      });
  }
  return layers;
}

export function App() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapReady = useRef(false);
  const outputLayerIds = useRef<Set<string>>(new Set());
  const rasterLayerIds = useRef<Set<string>>(new Set());
  const vectorLayerIds = useRef<Set<string>>(new Set());
  const routeDrag = useRef<{ index: number; moved: boolean } | null>(null);
  const lastVertexDrag = useRef(0);
  const selectedVertex = useRef<number | null>(null);
  const [vertexSelection, setVertexSelection] = useState<number | null>(null);
  const onMapClickRef = useRef<(event: MapMouseEvent) => void>(() => undefined);
  const projectRef = useRef<RoadProject>(defaultProject());
  const historyRef = useRef<RoadProject[]>([]);
  const redoRef = useRef<RoadProject[]>([]);
  const textTransaction = useRef<Element | null>(null);
  const editRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const catalogRef = useRef<CatalogEntry[]>(basicCatalog);
  const allowCloseRef = useRef(false);
  const savingRef = useRef(false);
  const actionsRef = useRef({
    save: async () => false,
    leave: async () => false,
    cancel: async () => {},
    undo: () => {},
    redo: () => {},
    escape: () => {},
    open: () => {},
    generate: () => {},
    fit: () => {},
  });
  const leaveResolver = useRef<((allowed: boolean) => void) | null>(null);
  const jobRef = useRef<{ id: string; cancelled: boolean } | null>(null);
  const drawRef = useRef<{ tool: Tool; points: Position[] }>({
    tool: "pan",
    points: [],
  });
  const [project, setProject] = useState<RoadProject>(() => defaultProject());
  const [historyCount, setHistoryCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [editRevision, setEditRevision] = useState(0);
  const [savedRevision, setSavedRevision] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const [leaveDialog, setLeaveDialog] = useState(false);
  const [roadState, setRoadState] = useState<
    "empty" | "changed" | "ready" | "error"
  >("empty");
  const [layout, setLayout] = useState(() => readLayout());
  const [showLeft, setShowLeft] = useState(() => readLayout().leftVisible);
  const [showRouteSummary, setShowRouteSummary] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [templateEditor, setTemplateEditor] = useState<CatalogEntry | null>(
    null,
  );
  const [templateAction, setTemplateAction] = useState<{
    kind: "new" | "copy";
    template?: CatalogEntry;
  } | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [catalog, setCatalog] = useState<CatalogEntry[]>(basicCatalog);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [panel, setPanel] = useState<Panel>("data");
  const [tool, setTool] = useState<Tool>("pan");
  const [selectedFacility, setSelectedFacility] = useState<string | null>(null);
  const [layerVisible, setLayerVisible] = useState({
    route: true,
    generated: true,
    facilities: true,
    raster: true,
  });
  const [status, setStatusState] = useState<Status>({
    text: isTauri()
      ? "本地工程已就绪"
      : "浏览器预览 · 生成与文件操作需在桌面端运行",
  });
  const [working, setWorking] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<CatalogEntry | null>(
    null,
  );
  const [fileName, setFileName] = useState("未命名工程");
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [coordinateMode, setCoordinateMode] = useState<
    "geographic" | "project"
  >("geographic");
  const [showBasemap, setShowBasemap] = useState(false);
  const [showInspector, setShowInspector] = useState(
    () => window.innerWidth >= 1180 && readLayout().inspector,
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(true);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [comparing, setComparing] = useState(false);
  const compareBackup = useRef(layerVisible);
  const [activeBasemap, setActiveBasemap] = useState<BasemapConfig | null>(
    null,
  );
  const [basemapOpacity, setBasemapOpacity] = useState(1);
  const [mappingField, setMappingField] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const previousPanels = useRef<{ left: boolean; inspector: boolean } | null>(
    null,
  );
  const focusMap = !showLeft && !showInspector;
  const toggleMapFocus = () => {
    if (focusMap) {
      setShowLeft(previousPanels.current?.left ?? true);
      setShowInspector(previousPanels.current?.inspector ?? true);
      previousPanels.current = null;
    } else {
      previousPanels.current = { left: showLeft, inspector: showInspector };
      setShowLeft(false);
      setShowInspector(false);
    }
  };

  const touchDocument = useCallback(() => {
    editRevisionRef.current += 1;
    setEditRevision(editRevisionRef.current);
    setSaveState("idle");
    setStatusState((previous) =>
      previous.text.startsWith("项目已保存")
        ? { text: "编辑已更新，尚未保存。", tone: "warn" }
        : previous,
    );
  }, []);
  const changeCatalog = (
    recipe: (entries: CatalogEntry[]) => CatalogEntry[],
  ) => {
    const next = recipe(catalogRef.current);
    catalogRef.current = next;
    setCatalog(next);
    touchDocument();
  };
  const update = useCallback(
    (recipe: (current: RoadProject) => RoadProject, dirty = true) => {
      const current = projectRef.current;
      const next = recipe(current);
      if (dirty) {
        touchDocument();
        redoRef.current = [];
        setRedoCount(0);
        const active = document.activeElement;
        const coalesce =
          active instanceof HTMLInputElement &&
          active.type === "text" &&
          textTransaction.current === active;
        textTransaction.current =
          active instanceof HTMLInputElement && active.type === "text"
            ? active
            : null;
        if (!coalesce)
          historyRef.current = [
            ...historyRef.current.slice(-39),
            structuredClone(current),
          ];
        setHistoryCount(historyRef.current.length);
      }
      // 设施、图层和视图编辑不会改变道路输入，保留已生成的道路成果。
      const roadChanged =
        next.route_points !== current.route_points ||
        next.section !== current.section ||
        next.crs !== current.crs ||
        next.route_id !== current.route_id ||
        next.route_source !== current.route_source ||
        sceneInputKey(next) !== sceneInputKey(current);
      if (
        next.section !== current.section &&
        next.source_mapping === current.source_mapping &&
        next.manual_section === current.manual_section
      )
        next.manual_section = structuredClone(next.section);
      const value = dirty && roadChanged ? markInputEdited(next) : next;
      if (dirty && roadChanged)
        setRoadState((previous) =>
          current.output || previous !== "empty" ? "changed" : "empty",
        );
      projectRef.current = value;
      setProject(value);
    },
    [touchDocument],
  );

  const catalogEntries = useMemo(
    () =>
      catalog.filter((entry) =>
        `${entry.name} ${entry.subtype} ${entry.category}`
          .toLowerCase()
          .includes(catalogQuery.trim().toLowerCase()),
      ),
    [catalog, catalogQuery],
  );
  const selected =
    project.manual_facilities.find((item) => item.id === selectedFacility) ??
    null;
  const layers = useMemo(
    () =>
      project.output?.input_version === project.input_version
        ? responseLayers((project.output as any).response)
        : [],
    [project.output, project.input_version],
  );
  const stale = Boolean(
    project.output && project.output.input_version !== project.input_version,
  );
  const ready = project.route_points.length >= 2;
  const lengthMeters = useMemo(
    () => lineLength(project.route_points),
    [project.route_points],
  );

  const setToolMode = (next: Tool) => {
    setTool(next);
    selectedVertex.current = null;
    setVertexSelection(null);
    routeDrag.current = null;
    mapRef.current?.dragPan.enable();
    if (next === "pan") mapRef.current?.doubleClickZoom.enable();
    else mapRef.current?.doubleClickZoom.disable();
    if (next !== "pan") {
      setShowRouteSummary(false);
      setShowLegend(false);
    }
    drawRef.current = { tool: next, points: [] };
    setContextMenu(null);
    if (mapRef.current)
      mapRef.current.getCanvas().style.cursor =
        next === "pan" ? "" : next === "vertex" ? "grab" : "crosshair";
  };
  const deleteSelectedVertex = () => {
    const index = selectedVertex.current;
    if (index === null || index >= projectRef.current.route_points.length)
      return;
    if (projectRef.current.route_points.length <= 2) {
      setStatus("路线至少保留两个控制点；清空整条路线请使用清空路线。", "warn");
      return;
    }
    update((current) => ({
      ...current,
      route_points: current.route_points.filter((_, i) => i !== index),
    }));
    selectedVertex.current = null;
    setVertexSelection(null);
    setStatus(`已删除控制点 ${index + 1}，可撤销恢复。`);
  };
  const setStatus = (text: string, tone: Status["tone"] = undefined) =>
    setStatusState({ text, tone });

  useEffect(() => {
    let wasNarrow = window.innerWidth < 1180;
    const adjust = () => {
      const narrow = window.innerWidth < 1180;
      if (narrow && !wasNarrow && !selectedFacility) setShowInspector(false);
      wasNarrow = narrow;
    };
    window.addEventListener("resize", adjust);
    return () => window.removeEventListener("resize", adjust);
  }, [selectedFacility]);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(frame);
  }, [showInspector, showLeft, layout]);

  useEffect(() => {
    let alive = true;
    fetch("/catalog.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (
          alive &&
          data?.schema_version === 1 &&
          Array.isArray(data.entries) &&
          data.entries.length
        ) {
          setCatalog(data.entries);
          catalogRef.current = data.entries;
          setProject((current) => {
            const next = {
              ...current,
              catalog: { schema_version: 1 as const, entries: data.entries },
            };
            projectRef.current = next;
            return next;
          });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const handle = (event: Event) => {
      const entry = (event as CustomEvent<CatalogEntry>).detail;
      if (entry) changeCatalog((current) => [...current, entry]);
    };
    window.addEventListener("road-catalog-add", handle);
    return () => window.removeEventListener("road-catalog-add", handle);
  }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (
          document.querySelector(
            ".command-popup, .map-context, .workbench-dialog",
          )
        )
          return;
        if (leaveResolver.current) {
          resolveLeave(false);
          return;
        }
        setTemplateEditor(null);
        setTemplateAction(null);
        setShowBasemap(false);
        setToolMode("pan");
        setStatus("已退出绘制；已放置的设施保持不变。");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (document.querySelector(".workbench-dialog")) return;
        void actionsRef.current.save();
        return;
      }
      if (document.querySelector(".workbench-dialog")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        actionsRef.current.open();
        return;
      }
      if (event.key === "F5") {
        event.preventDefault();
        actionsRef.current.generate();
        return;
      }
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement;
      if (
        !typing &&
        event.key === "Delete" &&
        drawRef.current.tool === "vertex"
      ) {
        event.preventDefault();
        deleteSelectedVertex();
        return;
      }
      if (
        !typing &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        actionsRef.current.fit();
        return;
      }
      if (
        !typing &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setToolMode("pan");
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !typing &&
        (event.key.toLowerCase() === "y" ||
          (event.shiftKey && event.key.toLowerCase() === "z"))
      ) {
        event.preventDefault();
        redo();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (
          allowCloseRef.current ||
          (editRevisionRef.current === savedRevisionRef.current &&
            !jobRef.current)
        )
          return;
        event.preventDefault();
        if (await actionsRef.current.leave()) {
          await actionsRef.current.cancel();
          allowCloseRef.current = true;
          await getCurrentWindow().close();
        }
      })
      .then((remove) => {
        if (disposed) remove();
        else unlisten = remove;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "road-workbench-layout",
        JSON.stringify({
          ...layout,
          inspector: showInspector,
          leftVisible: showLeft,
        }),
      );
    } catch {}
    const timer = setTimeout(() => mapRef.current?.resize(), 50);
    return () => clearTimeout(timer);
  }, [layout, showInspector, showLeft]);

  const syncMap = useCallback(
    (map: MapLibreMap, current: RoadProject) => {
      const route = routeToGeoJSON(current.route_points, current.crs);
      const addOrSet = (id: string, data: GeoJSON.FeatureCollection) => {
        const source = map.getSource(id) as
          | maplibregl.GeoJSONSource
          | undefined;
        if (source) source.setData(data);
        else map.addSource(id, { type: "geojson", data });
      };
      addOrSet("road-route", route);
      addOrSet("road-route-vertices", {
        type: "FeatureCollection",
        features: current.route_points.map((point, index) => ({
          type: "Feature",
          id: index,
          properties: {
            index,
            current: index === current.route_points.length - 1,
          },
          geometry: {
            type: "Point",
            coordinates: transformPosition(point, current.crs, "EPSG:4326"),
          },
        })),
      });
      const facilities = geomCollection(current.manual_facilities, current.crs);
      facilities.features.forEach((feature, index) => {
        feature.properties = {
          ...feature.properties,
          icon_name: facilityIconName(
            current.manual_facilities[index]?.template,
          ),
        };
      });
      addOrSet("road-facilities", facilities);
      for (const [id, type, paint, layout] of [
        [
          "road-route-halo",
          "line",
          { "line-color": "#fff", "line-width": 10, "line-opacity": 0.88 },
          { "line-cap": "round", "line-join": "round" },
        ],
        [
          "road-route-line",
          "line",
          { "line-color": "#1677ff", "line-width": 5, "line-opacity": 0.95 },
          { "line-cap": "round", "line-join": "round" },
        ],
        [
          "road-route-points",
          "circle",
          {
            "circle-radius": 5,
            "circle-color": "#fff",
            "circle-stroke-color": "#1677ff",
            "circle-stroke-width": 2.5,
          },
          {},
        ],
        [
          "road-facility-points",
          "circle",
          {
            "circle-radius": [
              "case",
              ["==", ["get", "id"], selectedFacility ?? ""],
              8,
              5,
            ],
            "circle-color": [
              "case",
              ["==", ["get", "id"], selectedFacility ?? ""],
              "#f79009",
              "#f04438",
            ],
            "circle-stroke-color": "#fff",
            "circle-stroke-width": 2,
          },
          {},
        ],
        [
          "road-facility-icons",
          "symbol",
          { "icon-opacity": 0.98 },
          {
            "icon-image": ["get", "icon_name"],
            "icon-size": 0.48,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        ],
        [
          "road-facility-lines",
          "line",
          { "line-color": "#e5484d", "line-width": 3, "line-opacity": 0.92 },
          {},
        ],
        [
          "road-facility-fills",
          "fill",
          {
            "fill-color": "#ef444433",
            "fill-opacity": 0.3,
            "fill-outline-color": "#dc3b47",
          },
          {},
        ],
      ] as const) {
        const source = id.includes("facility")
          ? "road-facilities"
          : id.includes("points")
            ? "road-route-vertices"
            : "road-route";
        const filter =
          id === "road-facility-points" || id === "road-facility-icons"
            ? ["==", "$type", "Point"]
            : id === "road-facility-lines"
              ? ["==", "$type", "LineString"]
              : id === "road-facility-fills"
                ? ["==", "$type", "Polygon"]
                : undefined;
        if (!map.getLayer(id))
          map.addLayer({
            id,
            type,
            source,
            ...(filter ? { filter } : {}),
            paint,
            layout,
          } as any);
      }
      if (map.getLayer("road-route-line"))
        map.setLayoutProperty(
          "road-route-line",
          "visibility",
          layerVisible.route ? "visible" : "none",
        );
      if (map.getLayer("road-route-halo"))
        map.setLayoutProperty(
          "road-route-halo",
          "visibility",
          layerVisible.route ? "visible" : "none",
        );
      if (map.getLayer("road-route-points"))
        map.setLayoutProperty(
          "road-route-points",
          "visibility",
          tool === "vertex" && layerVisible.route ? "visible" : "none",
        );
      if (map.getLayer("road-route-points")) {
        map.setPaintProperty("road-route-points", "circle-color", [
          "case",
          ["==", ["get", "index"], vertexSelection ?? -1],
          "#f59e0b",
          "#ffffff",
        ]);
        map.setPaintProperty("road-route-points", "circle-radius", [
          "case",
          ["==", ["get", "index"], vertexSelection ?? -1],
          7,
          5,
        ]);
      }
      if (map.getLayer("road-facility-points"))
        map.setLayoutProperty(
          "road-facility-points",
          "visibility",
          layerVisible.facilities ? "visible" : "none",
        );
      for (const id of [
        "road-facility-icons",
        "road-facility-lines",
        "road-facility-fills",
      ])
        if (map.getLayer(id))
          map.setLayoutProperty(
            id,
            "visibility",
            layerVisible.facilities ? "visible" : "none",
          );
      ensurePavementTextures(map);
      const activeOutputIds = new Set<string>();
      for (const layer of layers) {
        const sourceId = `output-${slug(layer.name)}`;
        activeOutputIds.add(sourceId);
        let outputCollection = layer.collection;
        if (layer.crs !== "EPSG:4326" && layer.crs !== "WGS84")
          outputCollection = transformCollection(
            outputCollection,
            layer.crs,
            "EPSG:4326",
          );
        addOrSet(sourceId, outputCollection);
        const surface = String(
          current.scene_options?.surface_type ?? "asphalt",
        );
        const pavementColor =
          surface === "concrete"
            ? "#c5c3bb"
            : surface === "gravel"
              ? "#ae9b7c"
              : "#42464a";
        const components = current.scene_options?.render_mode === "components";
        const componentColor: any = [
          "match",
          ["get", "component"],
          "lane",
          components ? "#5d92aa" : pavementColor,
          "emergency",
          components ? "#7594bc" : pavementColor,
          "shoulder",
          "#b6c0c9",
          "median",
          "#72a878",
          "slope",
          "#bd9d6c",
          "markings",
          "#e6b830",
          "guardrail",
          "#465568",
          "#7790a5",
        ];
        if (!map.getLayer(`${sourceId}-fill`))
          map.addLayer({
            id: `${sourceId}-fill`,
            type: "fill",
            source: sourceId,
            filter: ["==", "$type", "Polygon"],
            paint: {
              "fill-color": componentColor,
              "fill-opacity": components ? 0.48 : 0.94,
            },
          });
        if (!map.getLayer(`${sourceId}-line`))
          map.addLayer({
            id: `${sourceId}-line`,
            type: "line",
            source: sourceId,
            paint: {
              "line-color": componentColor,
              "line-width": [
                "match",
                ["get", "component"],
                "markings",
                1.4,
                layer.collection.features.some((feature) =>
                  ["LineString", "MultiLineString"].includes(
                    feature.geometry?.type,
                  ),
                )
                  ? 2
                  : components
                    ? 1.2
                    : 0,
              ],
            },
          });
        if (!map.getLayer(`${sourceId}-circle`))
          map.addLayer({
            id: `${sourceId}-circle`,
            type: "circle",
            source: sourceId,
            filter: ["==", "$type", "Point"],
            paint: {
              "circle-radius": 4,
              "circle-color": componentColor,
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 1.5,
            },
          });
        map.setPaintProperty(`${sourceId}-fill`, "fill-color", componentColor);
        map.setPaintProperty(
          `${sourceId}-fill`,
          "fill-opacity",
          components ? 0.48 : 0.94,
        );
        map.setPaintProperty(`${sourceId}-line`, "line-color", componentColor);
        map.setPaintProperty(`${sourceId}-line`, "line-width", [
          "match",
          ["get", "component"],
          "markings",
          1.4,
          layer.collection.features.some((feature) =>
            ["LineString", "MultiLineString"].includes(feature.geometry?.type),
          )
            ? 2
            : components
              ? 1.2
              : 0,
        ]);
        const textureId = `${sourceId}-texture`;
        if (!map.getLayer(textureId))
          map.addLayer(
            {
              id: textureId,
              type: "fill",
              source: sourceId,
              filter: [
                "all",
                ["==", "$type", "Polygon"],
                ["in", "component", "lane", "emergency", "shoulder"],
              ],
              paint: {
                "fill-pattern": `pavement-${surface}`,
                "fill-opacity": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  13,
                  0,
                  16,
                  0.35,
                  19,
                  0.6,
                ],
              },
            },
            `${sourceId}-line`,
          );
        map.setPaintProperty(textureId, "fill-pattern", `pavement-${surface}`);
        map.setLayoutProperty(
          textureId,
          "visibility",
          layerVisible.generated && !components ? "visible" : "none",
        );
        for (const suffix of ["fill", "line", "circle"])
          if (map.getLayer(`${sourceId}-${suffix}`))
            map.setLayoutProperty(
              `${sourceId}-${suffix}`,
              "visibility",
              layerVisible.generated ? "visible" : "none",
            );
      }
      for (const previous of outputLayerIds.current)
        if (!activeOutputIds.has(previous)) {
          for (const suffix of ["fill", "texture", "line", "circle"])
            if (map.getLayer(`${previous}-${suffix}`))
              map.removeLayer(`${previous}-${suffix}`);
          if (map.getSource(previous)) map.removeSource(previous);
        }
      outputLayerIds.current = activeOutputIds;
      for (const entry of current.catalog.entries)
        void loadFacilityIcon(map, entry);
      const activeVectorIds = new Set<string>();
      for (const item of (current.vector_basemaps as any[]) ?? []) {
        const id = `background-${item.id}`;
        activeVectorIds.add(id);
        addOrSet(id, item.collection);
        for (const [suffix, type, filter, paint] of [
          [
            "fill",
            "fill",
            ["==", "$type", "Polygon"],
            { "fill-color": "#b9c8d5", "fill-opacity": 0.25 },
          ],
          [
            "line",
            "line",
            ["!=", "$type", "Point"],
            { "line-color": "#8499ad", "line-width": 1.3 },
          ],
          [
            "point",
            "circle",
            ["==", "$type", "Point"],
            { "circle-color": "#748da6", "circle-radius": 3 },
          ],
        ] as any[]) {
          if (!map.getLayer(`${id}-${suffix}`))
            map.addLayer(
              { id: `${id}-${suffix}`, type, source: id, filter, paint } as any,
              map.getLayer("road-route-halo") ? "road-route-halo" : undefined,
            );
          map.setLayoutProperty(
            `${id}-${suffix}`,
            "visibility",
            item.visible !== false ? "visible" : "none",
          );
        }
      }
      for (const id of vectorLayerIds.current)
        if (!activeVectorIds.has(id)) {
          for (const suffix of ["fill", "line", "point"])
            if (map.getLayer(`${id}-${suffix}`))
              map.removeLayer(`${id}-${suffix}`);
          if (map.getSource(id)) map.removeSource(id);
        }
      vectorLayerIds.current = activeVectorIds;
      const activeRasterIds = new Set<string>();
      for (const raster of current.rasters ?? []) {
        const item = raster as any;
        if (!item.id || item.unavailable) continue;
        const sourceId = `raster-${slug(String(item.id))}`;
        activeRasterIds.add(sourceId);
        const tiles = [`road-raster://${item.id}/{z}/{x}/{y}`];
        if (!map.getSource(sourceId))
          map.addSource(sourceId, {
            type: "raster",
            tiles,
            tileSize: 256,
            attribution: "本地栅格",
            ...(Array.isArray(item.bounds) ? { bounds: item.bounds } : {}),
            minzoom: 0,
            maxzoom: 20,
          });
        if (!map.getLayer(`${sourceId}-layer`))
          map.addLayer(
            {
              id: `${sourceId}-layer`,
              type: "raster",
              source: sourceId,
              paint: { "raster-opacity": 0.85 },
            },
            map.getLayer("road-route-halo") ? "road-route-halo" : undefined,
          );
        map.setLayoutProperty(
          `${sourceId}-layer`,
          "visibility",
          layerVisible.raster ? "visible" : "none",
        );
      }
      for (const item of current.rasters ?? []) {
        const raster = item as any;
        const id = `raster-${slug(String(raster.id))}-layer`;
        if (map.getLayer(id)) {
          map.setPaintProperty(id, "raster-opacity", raster.opacity ?? 0.85);
          if (raster.visible === false)
            map.setLayoutProperty(id, "visibility", "none");
        }
      }
      for (const previous of rasterLayerIds.current) {
        if (activeRasterIds.has(previous)) continue;
        if (map.getLayer(`${previous}-layer`))
          map.removeLayer(`${previous}-layer`);
        if (map.getSource(previous)) map.removeSource(previous);
      }
      rasterLayerIds.current = activeRasterIds;
    },
    [catalog, layerVisible, layers, selectedFacility, tool, vertexSelection],
  );

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    if (!rasterProtocolRegistered) {
      addProtocol("road-raster", async (params: any) => {
        const parts = String(params.url)
          .replace(/^road-raster:\/\//, "")
          .split("/");
        const [id, z, x, y] = parts;
        const result = await invokeNative<Uint8Array | number[]>(
          "raster_tile",
          {
            id,
            z: Number(z),
            x: Number(x),
            y: Number(y.replace(/\.png$/, "")),
          },
        );
        const bytes =
          result instanceof Uint8Array ? result : new Uint8Array(result);
        return { data: bytes.buffer };
      });
      rasterProtocolRegistered = true;
    }
    registerBasemapProtocols();
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#edf2f6", "background-opacity": 0 },
          },
        ],
      },
      center: project.view.center,
      zoom: project.view.zoom,
      pitch: project.view.pitch,
      bearing: project.view.bearing,
      attributionControl: false,
      maxPitch: 70,
      locale: {
        "NavigationControl.ZoomIn": "放大",
        "NavigationControl.ZoomOut": "缩小",
        "NavigationControl.ResetBearing": "拖动旋转地图，单击恢复正北",
        "Map.Title": "道路工程地图",
      },
    });
    mapRef.current = map;
    mapReady.current = false;
    const removeWheelHandling = installMapWheelHandling(map, () =>
      Boolean(routeDrag.current),
    );
    const releaseDrag = () => {
      if (!routeDrag.current) return;
      routeDrag.current = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor =
        drawRef.current.tool === "vertex" ? "grab" : "";
    };
    const releaseOutside = (event: MouseEvent) => {
      if (event.target !== map.getCanvas()) releaseDrag();
    };
    window.addEventListener("mouseup", releaseOutside);
    window.addEventListener("blur", releaseDrag);
    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: true,
        showZoom: true,
        visualizePitch: true,
      }),
      "top-right",
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }),
      "bottom-left",
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: false }),
      "bottom-right",
    );
    map.on("load", () => {
      mapReady.current = true;
      syncMap(map, projectRef.current);
      fitProject(map, projectRef.current);
    });
    map.on("error", (event) => {
      const reason = event.error?.message ?? "未知渲染错误";
      setStatus(`地图渲染错误：${reason}`, "error");
    });
    map.on("click", (event) => onMapClickRef.current(event));
    map.on("mousemove", (event) => {
      const ll = event.lngLat;
      setCursor([ll.lng, ll.lat]);
      if (routeDrag.current) routeDrag.current.moved = true;
    });
    map.on("mousedown", (event) => {
      if (drawRef.current.tool !== "vertex" || event.originalEvent.button !== 0)
        return;
      const feature = map.queryRenderedFeatures(event.point, {
        layers: ["road-route-points"],
      })[0];
      const index = Number(feature?.properties?.index);
      if (!Number.isInteger(index)) return;
      routeDrag.current = { index, moved: false };
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grabbing";
      event.preventDefault();
    });
    map.on("mouseup", (event) => {
      const drag = routeDrag.current;
      if (!drag) return;
      routeDrag.current = null;
      if (drag.moved) lastVertexDrag.current = Date.now();
      map.dragPan.enable();
      map.getCanvas().style.cursor = "grab";
      if (drag.moved) {
        const point = transformPosition(
          [event.lngLat.lng, event.lngLat.lat],
          "EPSG:4326",
          projectRef.current.crs,
        );
        update((current) => ({
          ...current,
          route_points: current.route_points.map((value, index) =>
            index === drag.index ? point : value,
          ),
        }));
        setStatus(`已移动路线控制点 ${drag.index + 1}`);
      }
    });
    map.on("contextmenu", (event) => {
      event.preventDefault();
      setContextMenu({ x: event.point.x, y: event.point.y });
    });
    map.on("moveend", () => {
      const center = map.getCenter();
      update(
        (current) => ({
          ...current,
          view: {
            center: [center.lng, center.lat],
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing(),
          },
        }),
        false,
      );
    });
    return () => {
      removeWheelHandling();
      window.removeEventListener("mouseup", releaseOutside);
      window.removeEventListener("blur", releaseDrag);
      map.remove();
      mapRef.current = null;
    };
    // 地图容器只在初次渲染时创建，后续数据通过独立同步 effect 更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMapClick = useCallback(
    (event: MapMouseEvent) => {
      const map = mapRef.current;
      if (!map) return;
      const state = drawRef.current;
      if (state.tool !== "pan" && event.originalEvent.detail > 1) return;
      const coordinates = transformPosition(
        [event.lngLat.lng, event.lngLat.lat],
        "EPSG:4326",
        projectRef.current.crs,
      );
      if (state.tool === "route") {
        update((current) => ({
          ...current,
          route_points: [...current.route_points, coordinates],
          route_source: "manual",
        }));
        setStatus(
          `已添加路线点 ${projectRef.current.route_points.length} · ${projectRef.current.crs} 米制坐标`,
        );
      } else if (state.tool === "facility" && activeTemplate) {
        const point = coordinates;
        if (activeTemplate.geometry === "Point")
          void addFacility(point, activeTemplate).catch((error) =>
            setStatus(errorMessage(error), "error"),
          );
        else {
          const points = [...state.points, point];
          drawRef.current = { ...state, points };
          setStatus(
            activeTemplate.geometry === "LineString"
              ? `线设施已选 ${points.length}/2 个点`
              : `区域边界已选 ${points.length} 个点；右键或“完成”提交`,
          );
          if (activeTemplate.geometry === "LineString" && points.length === 2) {
            void addFacility(points[0], activeTemplate, points).catch((error) =>
              setStatus(errorMessage(error), "error"),
            );
            drawRef.current = { tool: "facility", points: [] };
          }
        }
      } else if (state.tool === "vertex") {
        if (Date.now() - lastVertexDrag.current < 300) return;
        const features = map.queryRenderedFeatures(event.point, {
          layers: ["road-route-points"],
        });
        const index = features.length
          ? Number(features[0].properties?.index)
          : null;
        selectedVertex.current = index;
        setVertexSelection(index);
        setStatus(
          index === null
            ? "单击选择控制点；拖动调整位置。"
            : `已选中控制点 ${index + 1} · 拖动调整，Delete 或工具栏删除`,
        );
      } else {
        const features = map.queryRenderedFeatures(event.point, {
          layers: [
            "road-facility-points",
            "road-facility-lines",
            "road-facility-fills",
          ],
        });
        if (features.length)
          setSelectedFacility(String(features[0].properties?.id ?? ""));
        else setSelectedFacility(null);
      }
      setContextMenu(null);
    },
    [activeTemplate, update],
  );
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;
    syncMap(map, project);
    mapReady.current = true;
  }, [project, syncMap]);

  useEffect(() => {
    if (!mapRef.current || !mapRef.current.isStyleLoaded()) return;
    if (project.route_points.length > 1 && !mapReady.current)
      fitProject(mapRef.current, project);
  }, [project.route_points.length]);

  async function addFacility(
    point: Position,
    template: CatalogEntry,
    otherPoints?: Position[],
  ) {
    const kind = await facilityKind(template);
    const item: Facility = {
      id: makeId(),
      kind,
      x: point[0],
      y: point[1],
      route_id: projectRef.current.route_id,
      template: structuredClone(template),
      confirmed: false,
    };
    if (otherPoints && template.geometry === "LineString") {
      item.end_x = otherPoints[1][0];
      item.end_y = otherPoints[1][1];
    }
    if (otherPoints && template.geometry === "Polygon")
      item.vertices = otherPoints;
    if (template.geometry === "Polygon") {
      const points = otherPoints ?? [];
      if (points.length < 3) {
        setStatus("区域设施至少需要三个边界点。", "warn");
        return;
      }
      item.vertices = points;
      item.x = points[0][0];
      item.y = points[0][1];
    }
    if (
      ![
        item.x,
        item.y,
        ...(item.end_x === undefined ? [] : [item.end_x, item.end_y!]),
        ...(item.vertices ?? []).flat(),
      ].every(Number.isFinite)
    ) {
      setStatus("设施坐标必须为有限数值。", "error");
      return;
    }
    if (item.template.geometry === "LineString") {
      const length = Math.hypot(item.end_x! - item.x, item.end_y! - item.y);
      if (length <= 0 || length > 100000) {
        setStatus("线设施长度必须大于 0 且不超过 100 km。", "error");
        return;
      }
    }
    if (item.template.geometry === "Polygon") {
      if (!isTauri()) {
        setStatus(
          "区域边界自交校验需要桌面端本地 GEOS；浏览器预览不会保存未经校验的面设施。",
          "warn",
        );
        return;
      }
      const checked: any = await invokeNative("validate_geometry", {
        collection: projectedFacilityCollection(item),
        crs: projectRef.current.crs,
      });
      if (checked?.valid !== true)
        throw new Error(checked?.error ?? "区域设施几何校验失败");
    }
    update((current) => ({
      ...current,
      manual_facilities: [...current.manual_facilities, item],
    }));
    setSelectedFacility(item.id);
    setPanel("facility");
    setStatus("设施已放置 · 来源为人工编辑，尚未核验", "warn");
  }

  function finishFacilityPolygon() {
    if (!activeTemplate || drawRef.current.points.length < 3) {
      setStatus("区域设施至少需要三个边界点。", "warn");
      return;
    }
    const points = drawRef.current.points;
    void addFacility(points[0], activeTemplate, points).catch((error) =>
      setStatus(errorMessage(error), "error"),
    );
    drawRef.current = { tool: "facility", points: [] };
  }

  function undo() {
    const previous = historyRef.current.pop();
    if (!previous) return;
    redoRef.current.push(structuredClone(projectRef.current));
    restoreHistory(previous);
    setRedoCount(redoRef.current.length);
    setHistoryCount(historyRef.current.length);
    setStatus("已撤销上一步编辑");
  }
  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(structuredClone(projectRef.current));
    restoreHistory(next);
    setRedoCount(redoRef.current.length);
    setHistoryCount(historyRef.current.length);
    setStatus("已重做上一步编辑");
  }
  function restoreHistory(snapshot: RoadProject) {
    const current = projectRef.current;
    const roadChanged = !sameRoadInputs(current, snapshot);
    const restored = {
      ...snapshot,
      input_version: roadChanged
        ? current.input_version + 1
        : current.input_version,
      output:
        roadChanged || snapshot.road_output_cleared === true
          ? null
          : snapshot.output?.input_version === current.input_version
            ? snapshot.output
            : current.output,
    };
    if (roadChanged || !restored.output) setRoadState("changed");
    else setRoadState("ready");
    projectRef.current = restored;
    setProject(restored);
    touchDocument();
  }
  function removeLastRoutePoint() {
    update((current) => ({
      ...current,
      route_points: current.route_points.slice(0, -1),
    }));
    setStatus("已移除最近一个路线点");
  }
  function removeFacility() {
    if (!selectedFacility) return;
    update((current) => ({
      ...current,
      manual_facilities: current.manual_facilities.filter(
        (item) => item.id !== selectedFacility,
      ),
    }));
    setSelectedFacility(null);
    setStatus("设施已删除");
  }

  const [layerChoices, setLayerChoices] = useState<any[] | null>(null);
  const layerResolver = useRef<((name: string | null) => void) | null>(null);
  async function readVectorFile(path: string) {
    const metadata: any = await invokeNative("list_vector_layers", { path });
    const available = metadata.layers ?? [];
    if (!available.length) throw new Error("文件中没有可读取图层。");
    let layerName: string | null = available[0].name;
    if (available.length > 1)
      layerName = await new Promise((resolve) => {
        layerResolver.current = resolve;
        setLayerChoices(available);
      });
    if (layerName === null) return null;
    return invokeNative("import_vector", { path, layerName });
  }
  function finishLayerChoice(name: string | null) {
    layerResolver.current?.(name);
    layerResolver.current = null;
    setLayerChoices(null);
  }
  const [routeChoices, setRouteChoices] = useState<{
    features: RouteFeature[];
    label: string;
    binding?: SourceBinding;
    fields: Field[];
    revision: number;
  } | null>(null);
  const routeChoiceRevision = useRef(0);
  async function acceptVector(
    imported: any,
    label: string,
    binding?: SourceBinding,
  ) {
    if (!binding && imported.layer_name)
      label = `${label} · ${imported.layer_name}`;
    const features =
      (imported.collection?.features?.filter((feature: any) =>
        ["LineString", "MultiLineString"].includes(feature.geometry?.type),
      ) as RouteFeature[] | undefined) ?? [];
    if (!features.length) throw new Error("所选图层没有可用线要素。");
    const fields: Field[] =
      Array.isArray(imported.fields) && imported.fields.length
        ? imported.fields
        : Object.keys(features[0].properties ?? {});
    if (features.length > 1) {
      setRouteChoices({
        features,
        label,
        binding,
        fields,
        revision: ++routeChoiceRevision.current,
      });
      return;
    }
    await selectSourceFeature(features[0], label, binding, fields);
  }
  async function selectSourceFeature(
    feature: any,
    label: string,
    binding?: SourceBinding,
    sourceFields?: Field[],
  ) {
    try {
      const coords = pickLinePart(feature.geometry);
      if (coords.length < 2 || coords.length > 2000)
        throw new Error(
          "路线须包含 2～2,000 个控制点；多部件路线请先明确要使用的连续线段。",
        );
      const targetCrs = utmCrsForWgs84(coords[Math.floor(coords.length / 2)]);
      await ensureCrs(projectRef.current.crs);
      const converted = reprojectProject(projectRef.current, targetCrs);
      const attributes = feature.properties ?? {};
      const sourceMapping = binding
        ? (binding.mapping ?? {})
        : projectRef.current.source_label === label &&
            !projectRef.current.source_binding
          ? ((projectRef.current.source_mapping as FieldMapping) ?? {})
          : {};
      const validMapping = Object.fromEntries(
        Object.entries(sourceMapping).filter(
          ([_key, value]) =>
            typeof value !== "string" || Object.hasOwn(attributes, value),
        ),
      ) as FieldMapping;
      const mappedField = Object.hasOwn(validMapping, "route_id")
        ? typeof validMapping.route_id === "string"
          ? validMapping.route_id
          : null
        : attributes.route_id != null
          ? "route_id"
          : attributes.name != null
            ? "name"
            : null;
      const mappedRoute = resolveMappedValue(
        attributes,
        mappedField,
        validMapping.mapping_null_fallback === true,
        projectRef.current.route_id,
      );
      update((current) => ({
        ...converted,
        route_points: coords.map((point) =>
          transformPosition(point, "EPSG:4326", targetCrs),
        ),
        route_source: label,
        mapped_attributes: attributes,
        source_fields: sourceFields?.length
          ? sourceFields
          : Object.keys(attributes),
        source_label: label,
        source_binding: binding ?? null,
        section:
          (current.manual_section as RoadProject["section"] | undefined) ??
          converted.section,
        mapping_null_fallback: validMapping.mapping_null_fallback === true,
        source_mapping: {
          ...validMapping,
          route_id: mappedField,
        },
        route_id:
          mappedRoute.value == null
            ? current.route_id
            : String(mappedRoute.value),
      }));
      const mappingOkay = !binding?.mapping || applyFieldMapping(validMapping);
      setRouteChoices(null);
      setToolMode("pan");
      fitProject(mapRef.current, projectRef.current);
      if (mappingOkay)
        setStatus(
          Object.keys(validMapping).length < Object.keys(sourceMapping).length
            ? "已读取路线；源字段发生变化，失效映射已解除，请复核字段规则。"
            : `已选择路线 · ${coords.length} 点 · 工程 ${targetCrs}`,
          Object.keys(validMapping).length < Object.keys(sourceMapping).length
            ? "warn"
            : "ok",
        );
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }
  async function importRoute() {
    try {
      if (isTauri()) {
        const path = await chooseFile([
          {
            name: "矢量数据",
            extensions: ["geojson", "json", "gpkg", "shp", "kml"],
          },
        ]);
        if (!path) return;
        const imported = await readVectorFile(path);
        if (imported) await acceptVector(imported, path);
      } else {
        const file = await browserOpenFile(".geojson,.json");
        if (!file) return;
        const data = JSON.parse(await file.text());
        await acceptVector(
          {
            collection:
              data.type === "FeatureCollection" ? data : { features: [data] },
          },
          file.name,
        );
      }
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }
  async function importVectorBackground() {
    try {
      const path = await chooseFile([
        {
          name: "矢量底图",
          extensions: ["geojson", "json", "gpkg", "shp", "kml"],
        },
      ]);
      if (!path) return;
      const imported: any = await readVectorFile(path);
      if (!imported) return;
      update((current) => ({
        ...current,
        vector_basemaps: [
          ...((current.vector_basemaps as any[]) ?? []),
          {
            id: makeId(),
            label: path.split(/[\\/]/).pop(),
            path,
            layer: imported.layer_name,
            collection: imported.collection,
            visible: true,
          },
        ],
      }));
      setStatus("已添加矢量底图；制图线宽不代表道路实际宽度。", "ok");
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }
  async function importRaster() {
    try {
      if (!isTauri()) {
        setStatus("本地栅格导入需要桌面端运行。", "warn");
        return;
      }
      const path = await chooseFile([
        {
          name: "栅格影像",
          extensions: ["tif", "tiff", "vrt", "png", "jpg", "jpeg"],
        },
      ]);
      if (!path) return;
      const raster: any = await invokeNative("import_raster", { path });
      update((current) => ({
        ...current,
        rasters: [...(current.rasters ?? []), raster],
      }));
      setStatus(`已载入栅格 ${raster.name} · ${raster.source_crs}`, "ok");
      if (raster.bounds) fitBounds(mapRef.current, raster.bounds);
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }

  async function saveProject() {
    if (savingRef.current) return false;
    savingRef.current = true;
    try {
      // 快捷键保存先提交当前输入草稿，再等待校验提示完成渲染。
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      )
        active.blur();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (document.querySelector('.editor-field [aria-invalid="true"]')) {
        setStatus("请先修正表单中标出的错误，再保存项目。", "warn");
        return false;
      }
      let path = projectPath.current;
      if (!path)
        path = await chooseSave(`${project.route_id || "road-project"}.json`, [
          { name: "路境项目", extensions: ["json"] },
        ]);
      if (!path) {
        if (!isTauri()) {
          const blob = new Blob([JSON.stringify(project, null, 2)], {
            type: "application/json",
          });
          downloadBlob(blob, `${project.route_id}.json`);
          setStatus("已下载本地项目 JSON", "ok");
        }
        return false;
      }
      setSaveState("saving");
      const capturedRevision = editRevisionRef.current;
      await invokeNative("save_project", {
        path,
        project: serializeProject(projectRef.current, catalogRef.current),
      });
      savedRevisionRef.current = capturedRevision;
      setSavedRevision(capturedRevision);
      setSaveState("idle");
      projectPath.current = path;
      setFileName(path.split(/[\\/]/).pop() ?? fileName);
      setStatus("项目已保存 · 投影坐标、目录快照与来源字段均保留", "ok");
      return capturedRevision === editRevisionRef.current;
    } catch (error) {
      setSaveState("error");
      setStatus(errorMessage(error), "error");
      return false;
    } finally {
      savingRef.current = false;
    }
  }
  const projectPath = useRef<string | null>(null);
  async function confirmLeave() {
    if (editRevisionRef.current === savedRevisionRef.current && !jobRef.current)
      return true;
    if (leaveResolver.current) return false;
    return new Promise<boolean>((resolve) => {
      leaveResolver.current = resolve;
      setLeaveDialog(true);
    });
  }
  function resolveLeave(allowed: boolean) {
    const resolver = leaveResolver.current;
    leaveResolver.current = null;
    setLeaveDialog(false);
    resolver?.(allowed);
  }
  async function loadProject() {
    if (!(await confirmLeave())) return;
    if (jobRef.current) await cancelGenerate();
    try {
      let data: unknown;
      let path: string | null = null;
      if (isTauri()) {
        path = await chooseFile([{ name: "路境项目", extensions: ["json"] }]);
        if (!path) return;
        data = await invokeNative("load_project", { path });
      } else {
        const file = await browserOpenFile(".json");
        if (!file) return;
        path = file.name;
        data = JSON.parse(await file.text());
      }
      const normalized = normalizeProject(data);
      if (!(data as Record<string, unknown>).catalog) {
        normalized.catalog = {
          schema_version: 1,
          entries: structuredClone(catalog),
        };
      }
      await ensureCrs(normalized.crs);
      projectPath.current = isTauri() ? path : null;
      historyRef.current = [];
      redoRef.current = [];
      setRedoCount(0);
      setHistoryCount(0);
      if (normalized.catalog?.entries?.length) {
        setCatalog(normalized.catalog.entries);
        catalogRef.current = normalized.catalog.entries;
      }
      let failedRasters = 0;
      if (isTauri() && Array.isArray(normalized.rasters)) {
        const restored: unknown[] = [];
        for (const source of normalized.rasters as any[]) {
          const rasterPath = typeof source === "string" ? source : source?.path;
          if (!rasterPath) {
            restored.push(
              typeof source === "object"
                ? { ...source, unavailable: true }
                : source,
            );
            failedRasters++;
            continue;
          }
          try {
            restored.push({
              ...(typeof source === "object" ? source : {}),
              ...(await invokeNative<any>("import_raster", {
                path: rasterPath,
              })),
              unavailable: false,
            });
          } catch {
            restored.push(
              typeof source === "object"
                ? { ...source, unavailable: true }
                : source,
            );
            failedRasters++;
          }
        }
        normalized.rasters = restored;
      }
      if (
        isTauri() &&
        Array.isArray(normalized.file_basemaps) &&
        normalized.legacy_file_basemaps_imported !== true
      ) {
        const backgrounds = (
          (normalized.vector_basemaps as any[]) ?? []
        ).slice();
        let failedLegacyVectors = 0;
        for (const descriptor of normalized.file_basemaps as any[]) {
          if (
            !descriptor?.path ||
            backgrounds.some(
              (item) =>
                item.path === descriptor.path &&
                item.layer === descriptor.layer,
            )
          )
            continue;
          try {
            const imported: any = await invokeNative("import_vector", {
              path: descriptor.path,
              layerName: descriptor.layer ?? null,
            });
            backgrounds.push({
              id: makeId(),
              path: descriptor.path,
              layer: descriptor.layer,
              label: descriptor.path.split(/[\\/]/).pop(),
              collection: imported.collection,
              visible: true,
            });
          } catch {
            failedRasters++;
            failedLegacyVectors++;
          }
        }
        normalized.vector_basemaps = backgrounds;
        normalized.legacy_file_basemaps_imported = failedLegacyVectors === 0;
      }
      if (mapRef.current?.getLayer("user-xyz-layer"))
        mapRef.current.removeLayer("user-xyz-layer");
      if (mapRef.current?.getSource("user-xyz"))
        mapRef.current.removeSource("user-xyz");
      setActiveBasemap(null);
      setProject(normalized);
      projectRef.current = normalized;
      editRevisionRef.current += 1;
      savedRevisionRef.current = editRevisionRef.current;
      setEditRevision(editRevisionRef.current);
      setSavedRevision(savedRevisionRef.current);
      setSaveState("idle");
      setRoadState(
        normalized.output
          ? "ready"
          : normalized.last_generated_input_version !== undefined
            ? "changed"
            : "empty",
      );
      setMappingField(
        String((normalized.source_mapping as any)?.route_id ?? ""),
      );
      setFileName(path?.split(/[\\/]/).pop() ?? normalized.route_id);
      setSelectedFacility(null);
      fitProject(mapRef.current, normalized);
      setStatus(
        `已打开项目 · ${normalized.crs} · ${normalized.route_points.length} 个路线点${(data as any).schema_version === 1 ? " · 已从 schema 1 迁移" : ""}${failedRasters ? ` · ${failedRasters} 个底图未能载入，原始路径记录仍已保留` : ""}`,
        failedRasters ? "warn" : "ok",
      );
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }

  async function generate() {
    if (!ready) {
      setStatus("请先导入或绘制至少两个路线点。", "warn");
      return;
    }
    if (!isTauri()) {
      setStatus(
        "道路几何生成只在本地桌面引擎执行；浏览器预览不会生成伪成果。",
        "warn",
      );
      return;
    }
    if (jobRef.current) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    )
      active.blur();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (document.querySelector('.editor-field [aria-invalid="true"]')) {
      setStatus("请先修正表单错误，再生成道路。", "warn");
      return;
    }
    if (jobRef.current) return;
    const jobId = makeId();
    const job = { id: jobId, cancelled: false };
    jobRef.current = job;
    setWorking(true);
    setRoadState("changed");
    setStatus("正在生成道路成果…");
    try {
      const input = projectRef.current;
      const request = {
        route_id: input.route_id,
        points: input.route_points,
        crs: input.crs,
        source: input.route_source,
        section: input.section,
        scene_options: input.scene_options ?? {},
      };
      const startVersion = projectRef.current.input_version;
      const response = await invokeNative<unknown>("generate_road", {
        request,
        jobId,
      });
      if (job.cancelled || jobRef.current?.id !== jobId) return;
      const accepted = acceptGeneration(
        projectRef.current,
        jobId,
        jobRef.current?.id ?? null,
        response,
        startVersion,
      );
      if (accepted === projectRef.current) {
        setStatus("输入在生成期间发生变更，已丢弃旧版本结果。", "warn");
        return;
      }
      const generated = {
        ...accepted,
        last_generated_input_version: accepted.input_version,
        road_output_cleared: false,
      };
      setProject(generated);
      projectRef.current = generated;
      touchDocument();
      setRoadState("ready");
      setStatus("道路几何生成完成 · 结果已绑定当前输入版本", "ok");
    } catch (error) {
      if (!job.cancelled) {
        setStatus(errorMessage(error), "error");
        setRoadState("error");
      }
    } finally {
      if (jobRef.current?.id === jobId) {
        jobRef.current = null;
        setWorking(false);
      }
    }
  }
  async function cancelGenerate() {
    const job = jobRef.current;
    if (!job) return;
    job.cancelled = true;
    jobRef.current = null;
    setWorking(false);
    if (isTauri())
      try {
        await invokeNative("cancel_generation", { jobId: job.id });
      } catch {
        /* 迟到的响应也会由 jobId 检查丢弃 */
      }
    setStatus("已请求取消生成；迟到结果不会写入项目。", "warn");
  }

  async function exportGeoPackage() {
    try {
      if (!isTauri()) {
        setStatus("GeoPackage 导出需要本地桌面引擎。", "warn");
        return;
      }
      if (!project.output && !project.manual_facilities.length)
        throw new Error("请先生成道路成果或放置人工设施。");
      const path = await chooseSave(`${project.route_id}.gpkg`, [
        { name: "GeoPackage", extensions: ["gpkg"] },
      ]);
      if (!path) return;
      const collections = [
        ...layers,
        {
          name: "参考线",
          collection: routeToGeoJSON(project.route_points, project.crs),
          crs: "EPSG:4326",
        },
        {
          name: "手动设施",
          collection: geomCollection(project.manual_facilities, project.crs),
          crs: "EPSG:4326",
        },
      ].filter((item) => item.collection.features.length);
      const projected = collections.map((item) =>
        item.crs === project.crs
          ? item
          : {
              ...item,
              collection: transformCollection(
                item.collection,
                "EPSG:4326",
                project.crs,
              ),
              crs: project.crs,
            },
      );
      await invokeNative("export_geopackage", { path, layers: projected });
      setStatus(
        "GeoPackage 已导出 · 道路、参考线和人工设施按项目 CRS 输出",
        "ok",
      );
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }
  async function exportGeoJSON() {
    try {
      const features: GeoJSON.Feature[] = [
        ...layers.flatMap((item) =>
          item.collection.features.map((feature) =>
            item.crs === "EPSG:4326" || item.crs === "WGS84"
              ? feature
              : transformFeature(feature, item.crs, "EPSG:4326"),
          ),
        ),
        ...project.manual_facilities.map((item) =>
          facilityFeature(item, project.crs),
        ),
        ...routeToGeoJSON(project.route_points, project.crs).features,
      ];
      const collection: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features,
      };
      if (isTauri()) {
        const path = await chooseSave(`${project.route_id}.geojson`, [
          { name: "GeoJSON · WGS84", extensions: ["geojson"] },
        ]);
        if (!path) return;
        await invokeNative("write_geojson", { path, collection });
      } else
        downloadBlob(
          new Blob([JSON.stringify(collection, null, 2)], {
            type: "application/geo+json",
          }),
          `${project.route_id}.geojson`,
        );
      setStatus("WGS84 GeoJSON 已导出；文件中的坐标为经纬度", "ok");
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }

  function selectBasemap(config: BasemapConfig) {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer("user-xyz-layer")) map.removeLayer("user-xyz-layer");
    if (map.getSource("user-xyz")) map.removeSource("user-xyz");
    if (config.id === "none") {
      setActiveBasemap(null);
      setStatus("已切换为空白工程画布；本地影像可继续使用。", "ok");
      return;
    }
    map.addSource("user-xyz", {
      type: "raster",
      tiles: [config.url],
      tileSize: 256,
      attribution: config.attribution,
      maxzoom: config.maxZoom,
    });
    map.addLayer(
      {
        id: "user-xyz-layer",
        type: "raster",
        source: "user-xyz",
        paint: { "raster-opacity": basemapOpacity },
      },
      map.getStyle().layers?.find((layer) => layer.id !== "background")?.id,
    );
    setActiveBasemap(config);
    setShowBasemap(false);
    setStatus(
      `底图已切换：${config.label}${config.adapt ? " · GCJ-02 近似纠偏显示" : ""}；瓦片加载取决于网络与服务。`,
      "ok",
    );
  }
  function applyFieldMapping(mapping: Record<string, string | null | boolean>) {
    try {
      const current = projectRef.current;
      const preserved = current.manual_section as any;
      const manual =
        Array.isArray(preserved?.left_lanes) &&
        Array.isArray(preserved?.right_lanes)
          ? preserved
          : current.section;
      const attributes = (current.mapped_attributes as any) ?? {};
      const fallback = mapping.mapping_null_fallback === true;
      const section = { ...current.section };
      const number = (key: string, defaultValue: number) => {
        const resolved = resolveMappedValue(
          attributes,
          typeof mapping[key] === "string" ? mapping[key] : null,
          fallback,
          defaultValue,
        );
        const value = resolved.value ?? defaultValue;
        if (
          (typeof value !== "number" && typeof value !== "string") ||
          String(value).trim() === "" ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0
        )
          throw new Error(`${key} 映射必须是有效非负数值。`);
        return Number(value);
      };
      for (const side of ["left", "right"] as const) {
        const count = number(
          `${side}_lane_count`,
          manual[`${side}_lanes`].length,
        );
        if (!Number.isInteger(count) || count > 8)
          throw new Error("每侧车道数必须为0～8的整数。");
        const width = number(
          `${side}_lane_width`,
          manual[`${side}_lanes`][0] ?? 3.5,
        );
        section[`${side}_lanes`] =
          mapping[`${side}_lane_count`] || mapping[`${side}_lane_width`]
            ? Array.from({ length: count }, () => width)
            : manual[`${side}_lanes`];
      }
      for (const key of [
        "median_width",
        "left_emergency_width",
        "right_emergency_width",
        "left_shoulder_width",
        "right_shoulder_width",
        "left_slope_width",
        "right_slope_width",
      ] as const)
        section[key] = number(key, manual[key]);
      const id = resolveMappedValue(
        attributes,
        typeof mapping.route_id === "string" ? mapping.route_id : null,
        fallback,
        current.route_id,
      );
      update((value) => ({
        ...value,
        source_mapping: mapping,
        mapping_null_fallback: fallback,
        manual_section: manual,
        section,
        route_id: String(id.value ?? value.route_id),
      }));
      setStatus("字段映射已应用；请检查横断面并重新生成。", "ok");
      return true;
    } catch (error) {
      // 保存字段选择，避免数值校验失败时下拉框回退到旧映射。
      update((value) => ({
        ...value,
        source_mapping: mapping,
        mapping_null_fallback: mapping.mapping_null_fallback === true,
      }));
      setStatus(errorMessage(error), "error");
      return false;
    }
  }
  async function importCatalog() {
    try {
      let incoming: any;
      if (isTauri()) {
        const path = await chooseFile([
          { name: "设施模板库", extensions: ["json"] },
        ]);
        if (!path) return;
        incoming = await invokeNative("read_catalog", { path });
      } else {
        const file = await browserOpenFile(".json");
        if (!file) return;
        incoming = JSON.parse(await file.text());
      }
      if (incoming.schema_version !== 1 || !Array.isArray(incoming.entries))
        throw new Error("设施模板格式无效");
      const ids = new Set(catalog.map((item) => item.id));
      const additions = incoming.entries.map(
        (entry: CatalogEntry, index: number) => ({
          ...entry,
          id: ids.has(entry.id)
            ? `custom.import.${Date.now()}.${index}`
            : entry.id,
          origin: "imported",
        }),
      );
      changeCatalog((current) => [...current, ...additions]);
      setStatus(
        `已导入 ${additions.length} 个模板，重复 ID 已生成新的本地标识`,
        "ok",
      );
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }
  async function exportCatalog() {
    try {
      const value = { schema_version: 1, entries: catalog };
      if (isTauri()) {
        const path = await chooseSave("road-facility-catalog.json", [
          { name: "设施模板库", extensions: ["json"] },
        ]);
        if (path) await invokeNative("save_catalog", { path, catalog: value });
      } else
        downloadBlob(
          new Blob([JSON.stringify(value, null, 2)], {
            type: "application/json",
          }),
          "road-facility-catalog.json",
        );
      setStatus("设施模板库已导出", "ok");
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }

  const qa = useMemo(
    () => ({
      getProject: () => structuredClone(projectRef.current),
      loadProject: (data: unknown) => {
        const normalized = normalizeProject(data);
        setProject(normalized);
        projectRef.current = normalized;
      },
      getMap: () => mapRef.current,
      requestClose: () => getCurrentWindow().close(),
      dialogs: { open: [] as string[], save: [] as string[] },
    }),
    [],
  );
  useEffect(() => {
    if (import.meta.env.DEV || import.meta.env.TAURI_ENV_DEBUG === "true")
      (window as any).__ROAD_WORKBENCH__ = qa;
    return () => {
      if ((window as any).__ROAD_WORKBENCH__ === qa)
        delete (window as any).__ROAD_WORKBENCH__;
    };
  }, [qa]);

  const fit = () => fitProject(mapRef.current, projectRef.current);
  actionsRef.current = {
    save: saveProject,
    leave: confirmLeave,
    cancel: cancelGenerate,
    undo,
    redo,
    escape: () => setToolMode("pan"),
    open: () => {
      void loadProject();
    },
    generate: () => {
      if (!jobRef.current) void generate();
    },
    fit: () => fitProject(mapRef.current, projectRef.current),
  };
  const documentDirty = editRevision !== savedRevision;
  const saveLabel =
    saveState === "saving"
      ? "保存中"
      : saveState === "error"
        ? "保存失败"
        : documentDirty
          ? "未保存"
          : projectPath.current
            ? "已保存"
            : "新建项目";
  const roadLabel = working
    ? "生成中"
    : !ready
      ? "待绘制"
      : project.output
        ? "已生成"
        : roadState === "error"
          ? "生成失败"
          : roadState === "changed"
            ? "需要重新生成"
            : "未生成";
  const toolHint =
    tool === "route"
      ? "单击添加路线点，拖动顶点调整位置；Esc 完成绘制。"
      : tool === "vertex"
        ? "拖动控制点调整位置，单击顶点删除；Esc 返回选择。"
        : activeTemplate?.geometry === "Polygon"
          ? "单击添加边界点，右键完成区域；Esc 取消未完成边界。"
          : activeTemplate?.geometry === "LineString"
            ? "依次点击起点与终点布设；Esc 退出布设。"
            : "单击放置设施；Esc 退出布设。";
  function toggleCompare() {
    if (!comparing) {
      compareBackup.current = layerVisible;
      setLayerVisible((current) => ({
        ...current,
        route: false,
        generated: false,
        facilities: false,
      }));
    } else setLayerVisible(compareBackup.current);
    setComparing(!comparing);
  }
  async function loadExample(real: boolean) {
    if (!(await confirmLeave())) return;
    if (jobRef.current) await cancelGenerate();
    try {
      if (!real)
        update((current) => ({
          ...defaultProject(),
          manual_facilities: current.manual_facilities,
          rasters: current.rasters,
          catalog: current.catalog,
        }));
      else {
        const collection = await fetch("/real-route.geojson").then(
          (response) => {
            if (!response.ok) throw new Error("示例文件读取失败");
            return response.json();
          },
        );
        const feature = collection.features[0];
        const points = pickLinePart(feature.geometry);
        const targetCrs = utmCrsForWgs84(points[Math.floor(points.length / 2)]);
        await ensureCrs(projectRef.current.crs);
        const converted = reprojectProject(projectRef.current, targetCrs);
        update(() => ({
          ...converted,
          route_id: String(feature.properties?.name ?? "西长安街参考线"),
          route_source: "OSM 真实参考线 · 宽度待核验",
          route_points: points.map((point) =>
            transformPosition(point, "EPSG:4326", targetCrs),
          ),
          mapped_attributes: feature.properties ?? {},
          source_fields: Object.keys(feature.properties ?? {}),
        }));
      }
      setToolMode("pan");
      fit();
      setStatus(
        real
          ? "已载入真实 OSM 参考线；道路宽度仍为人工模板。"
          : "已载入合成演示线路",
        "warn",
      );
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }
  function clearBasemaps() {
    const map = mapRef.current;
    if (map?.getLayer("user-xyz-layer")) map.removeLayer("user-xyz-layer");
    if (map?.getSource("user-xyz")) map.removeSource("user-xyz");
    setActiveBasemap(null);
    update((current) => ({
      ...current,
      rasters: [],
      vector_basemaps: [],
      file_basemaps: [],
    }));
    setStatus("已清除底图；磁盘原文件保留。", "ok");
  }
  const menuGroups = [
    {
      label: "文件",
      items: [
        {
          label: "打开项目…",
          shortcut: "Ctrl+O",
          run: () => void loadProject(),
        },
        {
          label: "保存项目",
          shortcut: "Ctrl+S",
          run: () => void saveProject(),
        },
        {
          label: "另存为…",
          run: () => {
            const previousPath = projectPath.current;
            projectPath.current = null;
            void saveProject().then((saved) => {
              if (!saved && projectPath.current === null)
                projectPath.current = previousPath;
            });
          },
        },
        {
          label: "导出 GeoPackage…",
          separator: true,
          disabled: !project.output && !project.manual_facilities.length,
          run: () => void exportGeoPackage(),
        },
        {
          label: "导出 GeoJSON（WGS84）…",
          disabled: !project.output && !project.manual_facilities.length,
          run: () => void exportGeoJSON(),
        },
        {
          label: "退出",
          separator: true,
          run: () => isTauri() && void getCurrentWindow().close(),
        },
      ],
    },
    {
      label: "编辑",
      items: [
        {
          label: "撤销",
          shortcut: "Ctrl+Z",
          disabled: !historyCount,
          run: undo,
        },
        { label: "重做", shortcut: "Ctrl+Y", disabled: !redoCount, run: redo },
        {
          label: "删除选中设施",
          disabled: !selectedFacility,
          separator: true,
          run: removeFacility,
        },
        {
          label: "清除道路成果",
          disabled: !project.output,
          run: () => {
            update((current) => ({
              ...current,
              output: null,
              road_output_cleared: true,
            }));
            setRoadState("changed");
          },
        },
        {
          label: "删除当前路线及成果",
          disabled: !ready,
          run: () => {
            update((current) => ({
              ...current,
              route_points: [],
              output: null,
            }));
            setToolMode("pan");
          },
        },
      ],
    },
    {
      label: "数据",
      items: [
        { label: "导入本地路线…", run: () => void importRoute() },
        {
          label: "连接远程数据…",
          run: () => {
            setPanel("data");
            setShowLeft(true);
            setSourceOpen(true);
          },
        },
        {
          label: "配置字段映射…",
          run: () => {
            setPanel("data");
            setShowLeft(true);
            setMappingOpen(true);
          },
        },
        {
          label: "选择底图…",
          separator: true,
          run: () => setShowBasemap(true),
        },
        { label: "添加本地影像…", run: () => void importRaster() },
        { label: "添加矢量底图…", run: () => void importVectorBackground() },
        {
          label: "载入真实路线示例",
          separator: true,
          run: () => void loadExample(true),
        },
        { label: "载入合成演示线路", run: () => void loadExample(false) },
        { label: "清除全部底图", separator: true, run: clearBasemaps },
      ],
    },
    {
      label: "道路",
      items: [
        {
          label: "绘制参考线",
          run: () => setToolMode("route"),
          checked: tool === "route",
        },
        {
          label: "编辑路线顶点",
          run: () => setToolMode("vertex"),
          checked: tool === "vertex",
        },
        {
          label: "编辑横断面",
          run: () => {
            setPanel("road");
            setShowLeft(true);
          },
        },
        {
          label: "放置设施",
          run: () => {
            setPanel("facility");
            setShowLeft(true);
          },
        },
        {
          label: "生成二维路面",
          shortcut: "F5",
          disabled: !ready || working || !isTauri(),
          separator: true,
          run: () => void generate(),
        },
        {
          label: "取消生成",
          disabled: !working,
          run: () => void cancelGenerate(),
        },
        {
          label: "设施库管理",
          separator: true,
          run: () => {
            setPanel("facility");
            setShowLeft(true);
          },
        },
        { label: "导入设施库…", run: () => void importCatalog() },
        { label: "导出设施库…", run: () => void exportCatalog() },
      ],
    },
    {
      label: "视图",
      items: [
        { label: "适配当前范围", shortcut: "F", run: fit },
        { label: "对比原始底图", checked: comparing, run: toggleCompare },
        { label: "专注地图", checked: focusMap, run: toggleMapFocus },
        {
          label: "工具面板",
          checked: showLeft,
          separator: true,
          run: () => setShowLeft(!showLeft),
        },
        {
          label: "属性面板",
          checked: showInspector,
          run: () => setShowInspector(!showInspector),
        },
        {
          label: "图层面板",
          run: () => {
            setPanel("layers");
            setShowLeft(true);
          },
        },
        {
          label: "地图图例",
          checked: showLegend,
          run: () => setShowLegend(!showLegend),
        },
        {
          label: "路线摘要",
          checked: showRouteSummary,
          run: () => setShowRouteSummary(!showRouteSummary),
        },
        {
          label: "恢复默认布局",
          separator: true,
          run: () => {
            setLayout({ ...layout, left: 300, right: 300 });
            setShowLeft(true);
            setShowInspector(true);
          },
        },
      ],
    },
    {
      label: "帮助",
      items: [
        { label: "操作与快捷键说明", run: () => setHelpOpen(true) },
        { label: "关于路境工作台", run: () => setHelpOpen(true) },
      ],
    },
  ];
  function startResize(side: "left" | "right", event: React.PointerEvent) {
    event.preventDefault();
    const start = event.clientX;
    const width = layout[side];
    const move = (e: PointerEvent) =>
      setLayout((current) => ({
        ...current,
        [side]: Math.max(
          side === "left" ? 240 : 256,
          Math.min(
            440,
            width + (e.clientX - start) * (side === "left" ? 1 : -1),
          ),
        ),
      }));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  return (
    <div
      className="app-shell"
      data-testid="road-workbench"
      onBlurCapture={() => {
        textTransaction.current = null;
      }}
    >
      <header className="topbar">
        <div
          className="brand"
          title="路境 · 道路设计工作台"
          aria-label="路境工作台"
        >
          <div className="brand-mark">
            <MapPinned size={19} />
          </div>
        </div>
        <WorkbenchMenu groups={menuGroups} />
        <div className="project-title">
          <span className={`project-dot ${documentDirty ? "dirty" : ""}`} />
          <span title={fileName}>{fileName}</span>
          <span
            className={`save-badge ${saveState === "error" ? "error" : documentDirty ? "dirty" : ""}`}
            role="status"
            aria-live="polite"
          >
            {saveLabel}
          </span>

          <span className="road-state-badge">{roadLabel}</span>
        </div>
        <div className="top-actions">
          <button
            className="button quiet"
            onClick={loadProject}
            aria-label="打开项目"
          >
            <FolderOpen size={16} />
            打开
          </button>
          <button
            className="button quiet"
            onClick={saveProject}
            aria-label="保存项目"
          >
            <Save size={16} />
            保存项目
          </button>
          <span
            className={`environment ${isTauri() ? "native" : ""}`}
            title={isTauri() ? "本地桌面模式" : "浏览器预览模式"}
          >
            <span />
            {isTauri() ? "本地运行" : "预览模式"}
          </span>
        </div>
      </header>

      <div
        className={`workspace ${showInspector ? "" : "inspector-hidden"} ${showLeft ? "" : "left-hidden"}`}
        style={{
          gridTemplateColumns: `56px ${showLeft ? `clamp(240px, ${layout.left}px, 30vw) ` : ""}minmax(0, 1fr)${showInspector ? ` clamp(256px, ${layout.right}px, 30vw)` : ""}`,
        }}
      >
        <aside className="left-rail" aria-label="工作区导航">
          {(
            [
              ["data", Database, "数据"],
              ["road", Baseline, "道路"],
              ["facility", Box, "设施"],
              ["layers", Layers3, "图层"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              className={`rail-item ${panel === id ? "active" : ""}`}
              onClick={() => {
                setPanel(id);
                setShowLeft(true);
              }}
              aria-label={label}
              aria-pressed={panel === id}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
          <div className="rail-bottom">
            <button
              className="rail-item"
              onClick={() =>
                setStatus(
                  "路线与设施坐标以项目投影 CRS 米制坐标保存；地图视图使用 WGS84。",
                )
              }
              aria-label="坐标帮助"
            >
              <CircleHelp size={19} />
              <span>帮助</span>
            </button>
            <button
              className="rail-item"
              aria-label={showLeft ? "折叠工具面板" : "展开工具面板"}
              onClick={() => setShowLeft((value) => !value)}
            >
              {showLeft ? (
                <PanelLeftClose size={19} />
              ) : (
                <PanelLeftOpen size={19} />
              )}
              <span>{showLeft ? "收起" : "展开"}</span>
            </button>
          </div>
        </aside>

        <aside className="side-panel" aria-label={`${panelLabel(panel)}面板`}>
          <div
            className="panel-resizer"
            role="separator"
            aria-label="调整左侧面板宽度"
            aria-orientation="vertical"
            tabIndex={0}
            aria-valuenow={layout.left}
            onPointerDown={(event) => startResize("left", event)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setLayout((current) => ({
                  ...current,
                  left: Math.max(
                    240,
                    Math.min(
                      440,
                      current.left + (event.key === "ArrowRight" ? 16 : -16),
                    ),
                  ),
                }));
              }
            }}
          />
          <div className="panel-heading">
            <div>
              <div className="eyebrow">项目工作区</div>
              <h1>{panelLabel(panel)}</h1>
            </div>
            <button
              className="icon-button"
              title="收起当前工作面板"
              aria-label="收起当前工作面板"
              onClick={() => setShowLeft(false)}
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
          {panel === "data" && (
            <DataPanel
              project={project}
              status={status}
              importRoute={importRoute}
              importRaster={importRaster}
              onFieldMap={(field) => {
                setMappingField(field);
                try {
                  const mapped = resolveMappedValue(
                    (project.mapped_attributes as Record<string, unknown>) ??
                      {},
                    field || null,
                    project.mapping_null_fallback === true,
                    project.route_id,
                  );
                  update((current) => ({
                    ...current,
                    source_mapping: {
                      ...((current.source_mapping as object) ?? {}),
                      route_id: field || null,
                    },
                    route_id:
                      mapped.value == null
                        ? current.route_id
                        : String(mapped.value),
                  }));
                  setStatus(
                    `路线 ID 映射已更新：${field || "手动路线 ID"}`,
                    "ok",
                  );
                } catch (error) {
                  setStatus(errorMessage(error), "error");
                }
              }}
              onNullFallback={(enabled) => {
                update((current) => ({
                  ...current,
                  mapping_null_fallback: enabled,
                }));
                setStatus(
                  enabled
                    ? "已明确启用空值手动回退。"
                    : "空值回退已关闭，空字段将阻止后续生成。",
                  "warn",
                );
              }}
              mappingField={mappingField}
              primarySource={
                <details
                  className="data-tool-details data-source-primary"
                  open={sourceOpen}
                  onToggle={(event) => setSourceOpen(event.currentTarget.open)}
                >
                  <summary>数据源连接</summary>
                  <DataSourceTools
                    onImport={(result, label, binding) => {
                      void acceptVector(result, label, binding).catch((error) =>
                        setStatus(errorMessage(error), "error"),
                      );
                    }}
                  />
                </details>
              }
              extras={
                <>
                  <details
                    className="data-tool-details"
                    open={mappingOpen}
                    onToggle={(event) =>
                      setMappingOpen(event.currentTarget.open)
                    }
                  >
                    <summary>
                      字段映射
                      <span className="mapping-summary">
                        {(project.source_fields as string[] | undefined)
                          ?.length ?? 0}{" "}
                        个字段
                      </span>
                    </summary>
                    <FieldMappingTools
                      fields={(project.source_fields as Field[]) ?? []}
                      attributes={
                        (project.mapped_attributes as Record<
                          string,
                          unknown
                        >) ?? {}
                      }
                      value={{
                        ...((project.source_mapping as any) ?? {}),
                        mapping_null_fallback:
                          project.mapping_null_fallback === true,
                      }}
                      context={String(
                        (project.source_binding as SourceBinding | null)
                          ?.label ??
                          project.source_label ??
                          "当前本地路线 · 独立映射",
                      )}
                      onSaveRule={
                        project.source_binding
                          ? () => {
                              try {
                                saveBindingMapping(
                                  project.source_binding as SourceBinding,
                                  {
                                    ...((project.source_mapping as FieldMapping) ??
                                      {}),
                                    mapping_null_fallback:
                                      project.mapping_null_fallback === true,
                                  },
                                );
                                setStatus(
                                  "已保存此图层的字段规则；其他连接与图层不受影响。",
                                  "ok",
                                );
                              } catch (error) {
                                setStatus(errorMessage(error), "warn");
                              }
                            }
                          : undefined
                      }
                      onChange={applyFieldMapping}
                    />
                  </details>
                </>
              }
            />
          )}
          {panel === "road" && (
            <RoadPanel
              project={project}
              update={update}
              status={status}
              busy={working}
              onApplyAuto={(options) => {
                update((current) => ({ ...current, scene_options: options }));
                void generate();
              }}
              onClearAuto={() => {
                update((current) => ({
                  ...current,
                  scene_options: { ...current.scene_options, enabled: [] },
                }));
                void generate();
              }}
            />
          )}
          {panel === "facility" && (
            <FacilityPanel
              catalog={catalogEntries}
              allCount={catalog.length}
              query={catalogQuery}
              setQuery={setCatalogQuery}
              selected={selected}
              facilities={project.manual_facilities}
              setTemplate={(template) => {
                setActiveTemplate(template);
                setToolMode("facility");
                setPanel("facility");
                setStatus(
                  `${template.name}：点击地图放置${template.geometry === "Point" ? "位置" : template.geometry === "LineString" ? "起点和终点" : "边界顶点"}`,
                );
              }}
              activeId={
                tool === "facility" ? (activeTemplate?.id ?? null) : null
              }
              categories={[...new Set(catalog.map((entry) => entry.category))]}
              onNew={() => {
                setTemplateAction({ kind: "new" });
                setTemplateName("");
              }}
              onSelect={(id) => {
                setSelectedFacility(id);
                setShowInspector(true);
                setToolMode("pan");
              }}
              onClone={(template) => {
                setTemplateAction({ kind: "copy", template });
                setTemplateName(`${template.subtype}（副本）`);
              }}
              onEdit={(template) =>
                setTemplateEditor(structuredClone(template))
              }
              onImport={importCatalog}
              onExport={exportCatalog}
            />
          )}
          {panel === "layers" && (
            <LayerPanel
              visible={layerVisible}
              setVisible={setLayerVisible}
              rasters={project.rasters ?? []}
              outputLayers={layers}
              facilities={project.manual_facilities}
              hasRoute={ready}
              onImportRaster={importRaster}
              onExportGpkg={exportGeoPackage}
              onExportGeoJSON={exportGeoJSON}
              fresh={Boolean(project.output && !stale)}
              children={
                <section className="section-block">
                  <h3>底图管理</h3>
                  {activeBasemap && (
                    <label className="background-opacity">
                      {activeBasemap.label}
                      <input
                        aria-label="在线底图不透明度"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={basemapOpacity}
                        onChange={(event) => {
                          const opacity = Number(event.target.value);
                          setBasemapOpacity(opacity);
                          if (mapRef.current?.getLayer("user-xyz-layer"))
                            mapRef.current.setPaintProperty(
                              "user-xyz-layer",
                              "raster-opacity",
                              opacity,
                            );
                        }}
                      />
                    </label>
                  )}
                  <button
                    className="button outline full"
                    onClick={importVectorBackground}
                  >
                    添加矢量底图
                  </button>
                  {((project.vector_basemaps as any[]) ?? []).map((item) => (
                    <div className="background-row" key={item.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={item.visible !== false}
                          onChange={(event) =>
                            update((current) => ({
                              ...current,
                              vector_basemaps: (
                                current.vector_basemaps as any[]
                              ).map((row) =>
                                row.id === item.id
                                  ? { ...row, visible: event.target.checked }
                                  : row,
                              ),
                            }))
                          }
                        />
                        {item.label}
                      </label>
                      <button
                        aria-label={`移除矢量底图 ${item.label}`}
                        onClick={() =>
                          update((current) => ({
                            ...current,
                            vector_basemaps: (
                              current.vector_basemaps as any[]
                            ).filter((row) => row.id !== item.id),
                          }))
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {((project.rasters as any[]) ?? []).map((item) => (
                    <div className="background-row" key={item.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={item.visible !== false}
                          onChange={(event) =>
                            update((current) => ({
                              ...current,
                              rasters: (current.rasters as any[]).map((row) =>
                                row.id === item.id
                                  ? { ...row, visible: event.target.checked }
                                  : row,
                              ),
                            }))
                          }
                        />
                        {item.name ??
                          item.path?.split(/[\\/]/).pop() ??
                          "本地影像"}
                      </label>
                      <input
                        aria-label="本地影像不透明度"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={item.opacity ?? 0.85}
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            rasters: (current.rasters as any[]).map((row) =>
                              row.id === item.id
                                ? {
                                    ...row,
                                    opacity: Number(event.target.value),
                                  }
                                : row,
                            ),
                          }))
                        }
                      />
                      <button
                        aria-label="移除本地影像"
                        onClick={() =>
                          update((current) => ({
                            ...current,
                            rasters: (current.rasters as any[]).filter(
                              (row) => row.id !== item.id,
                            ),
                          }))
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </section>
              }
            />
          )}
        </aside>

        <main className="map-workspace">
          <div
            ref={mapNode}
            className="map-canvas"
            data-testid="map-canvas"
            aria-label="道路工程地图"
          />
          <div className="map-top-controls">
            <div
              className="tool-group"
              role="toolbar"
              aria-label="地图绘制工具"
            >
              <button
                className={tool === "pan" ? "selected" : ""}
                onClick={() => setToolMode("pan")}
                title="选择与平移"
                aria-label="选择与平移"
              >
                <MousePointer2 size={17} />
              </button>
              <button
                className={tool === "route" ? "selected" : ""}
                onClick={() => setToolMode("route")}
                title="绘制路线"
                aria-label="绘制路线"
              >
                <PenLine size={17} />
              </button>
              <button
                className={tool === "vertex" ? "selected" : ""}
                onClick={() => setToolMode("vertex")}
                title="编辑顶点：单击选择，拖动调整，Delete 删除"
                aria-label="编辑路线顶点"
              >
                <Crosshair size={17} />
              </button>
              {tool === "vertex" && (
                <button
                  onClick={deleteSelectedVertex}
                  disabled={vertexSelection === null}
                  aria-label="删除选中控制点"
                  title="删除选中控制点（Delete，可撤销）"
                >
                  <Trash2 size={16} />
                </button>
              )}
              {tool === "route" && (
                <>
                  <span className="toolbar-divider" />
                  <button
                    onClick={removeLastRoutePoint}
                    title="撤销一个路线点"
                    aria-label="撤销一个路线点"
                  >
                    <Undo2 size={16} />
                  </button>
                  <button
                    onClick={() => {
                      update((current) => ({ ...current, route_points: [] }));
                      setToolMode("pan");
                    }}
                    title="清空路线"
                    aria-label="清空路线"
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              )}
              {tool === "facility" &&
                activeTemplate?.geometry === "Polygon" && (
                  <>
                    <span className="toolbar-divider" />
                    <button
                      onClick={finishFacilityPolygon}
                      title="完成区域边界"
                      aria-label="完成区域边界"
                    >
                      <Check size={16} />
                    </button>
                  </>
                )}
              <span className="toolbar-divider" />
              <button
                disabled={!historyCount}
                onClick={undo}
                title="撤销上一步（Ctrl+Z）"
                aria-label="撤销上一步"
              >
                <Undo2 size={16} />
              </button>
              <button
                disabled={!redoCount}
                onClick={redo}
                title="重做（Ctrl+Y / Ctrl+Shift+Z）"
                aria-label="重做上一步"
              >
                <Redo2 size={16} />
              </button>
            </div>
            <div className="map-actions">
              <button
                className={`map-action ${focusMap ? "selected" : ""}`}
                aria-label={focusMap ? "恢复面板布局" : "专注地图"}
                aria-pressed={focusMap}
                title={
                  focusMap
                    ? "恢复进入专注模式前的面板布局"
                    : "隐藏两侧面板，扩大地图"
                }
                onClick={toggleMapFocus}
              >
                {focusMap ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                className="map-action"
                aria-label="切换属性面板"
                title="显示或隐藏属性面板"
                onClick={() => setShowInspector((value) => !value)}
              >
                <Settings2 size={16} />
              </button>
              <button
                className="map-action"
                onClick={fit}
                aria-label="缩放到路线"
                title="缩放到路线"
              >
                <Crosshair size={16} />
              </button>
              <button
                className={`map-action ${showBasemap ? "selected" : ""}`}
                onClick={() => setShowBasemap((value) => !value)}
                aria-label="底图设置"
                title="底图设置"
              >
                <MapIcon size={16} />
                <ChevronDown size={12} />
              </button>
              <button
                className="map-action"
                onClick={() => {
                  const map = mapRef.current;
                  if (!map) return;
                  const pitch = map.getPitch() > 0 ? 0 : 48;
                  map.easeTo({
                    pitch,
                    bearing: pitch ? -22 : 0,
                    duration: 500,
                  });
                  setStatus(
                    pitch
                      ? "已启用倾斜视角示意；未加载高程或真实地形。"
                      : "已切换到二维视角",
                  );
                }}
                aria-label="倾斜视角示意（无高程）"
                title="倾斜视角示意（无高程地形）"
              >
                <Move3D size={16} />
              </button>
            </div>
          </div>
          {showBasemap && (
            <BasemapPicker
              activeId={activeBasemap?.id ?? "none"}
              onSelect={selectBasemap}
              onClose={() => setShowBasemap(false)}
              onImportLocal={() => {
                setShowBasemap(false);
                void importRaster();
              }}
            />
          )}
          <button
            className="basemap-chip"
            aria-label="选择地图底图"
            title="选择街道、卫星或本地影像底图"
            onClick={() => setShowBasemap(true)}
          >
            <MapIcon size={18} />
            <span>
              <strong>{activeBasemap?.label ?? "选择地图底图"}</strong>
              <small>选择街道 / 卫星 / 本地影像</small>
            </span>
            <ChevronDown size={14} />
          </button>
          <div className="map-overlays">
            <div
              className={`route-map-card ${showRouteSummary ? "" : "compact"}`}
            >
              <button
                className="route-summary-toggle"
                aria-label="切换路线摘要"
                aria-expanded={showRouteSummary}
                onClick={() => setShowRouteSummary((value) => !value)}
              >
                <Baseline size={15} />
                <strong>{project.route_id || "未命名路线"}</strong>
                <ChevronDown size={13} />
              </button>
              {showRouteSummary && (
                <>
                  <div className="route-card-top">
                    <span className="route-symbol">
                      <Baseline size={15} />
                    </span>
                    <span>
                      <strong>{project.route_id || "未命名路线"}</strong>
                      <small>
                        {project.route_points.length} 个控制点 · {project.crs}
                      </small>
                    </span>
                    <button
                      className="icon-button"
                      onClick={fit}
                      aria-label="定位路线"
                    >
                      <Crosshair size={15} />
                    </button>
                  </div>
                  <div className="route-card-stats">
                    <div>
                      <span>几何长度</span>
                      <strong>
                        {lengthMeters >= 1000
                          ? `${(lengthMeters / 1000).toFixed(2)} km`
                          : `${lengthMeters.toFixed(0)} m`}
                      </strong>
                    </div>
                    <div>
                      <span>路线状态</span>
                      <strong className={project.output ? "good-text" : ""}>
                        {roadLabel}{" "}
                      </strong>
                    </div>
                  </div>
                </>
              )}{" "}
            </div>
            <div className="legend-card">
              <button
                className="legend-title"
                aria-expanded={showLegend}
                aria-label="切换图例"
                onClick={() => setShowLegend((value) => !value)}
              >
                图例 <ChevronDown size={13} />
              </button>
              {showLegend && (
                <>
                  {layerVisible.route && ready && (
                    <div>
                      <span className="legend-line" />
                      参考线
                    </div>
                  )}
                  {layerVisible.generated && Boolean(project.output) && (
                    <div>
                      <span className="legend-road" />
                      道路成果
                    </div>
                  )}
                  {layerVisible.facilities &&
                    project.manual_facilities.length > 0 && (
                      <div>
                        <span className="legend-point" />
                        设施 ·{" "}
                        {
                          project.manual_facilities.filter(
                            (item) => !item.confirmed,
                          ).length
                        }{" "}
                        待核验
                      </div>
                    )}
                  {layerVisible.raster &&
                    (project.rasters?.length ?? 0) > 0 && (
                      <div>
                        <span className="swatch green" />
                        本地影像
                      </div>
                    )}
                  {!ready && !project.manual_facilities.length && (
                    <div>暂无可见成果</div>
                  )}
                </>
              )}
            </div>
            {tool !== "pan" && (
              <div className="drawing-hint">
                <PenLine size={15} />
                <span>{toolHint}</span>
                {tool === "facility" &&
                  activeTemplate?.geometry === "Polygon" && (
                    <button
                      className="button outline"
                      onClick={finishFacilityPolygon}
                    >
                      完成区域
                    </button>
                  )}
                <button
                  className="icon-button"
                  aria-label="退出绘制"
                  onClick={() => setToolMode("pan")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {comparing && (
              <button className="compare-banner" onClick={toggleCompare}>
                正在对比原始底图 · 点击恢复成果
              </button>
            )}
          </div>
          {contextMenu && (
            <MapContextMenu
              point={contextMenu}
              onClose={() => setContextMenu(null)}
              commands={[
                ...(tool === "facility" &&
                activeTemplate?.geometry === "Polygon"
                  ? [
                      {
                        label: "完成区域设施",
                        run: finishFacilityPolygon,
                        disabled: drawRef.current.points.length < 3,
                      },
                    ]
                  : []),
                ...(tool !== "pan"
                  ? [
                      {
                        label:
                          tool === "route"
                            ? "完成路线绘制"
                            : tool === "vertex"
                              ? "完成顶点编辑"
                              : "退出设施布设",
                        run: () => setToolMode("pan"),
                      },
                    ]
                  : []),
                { label: "缩放到路线", run: fit, disabled: !ready },
                {
                  label: focusMap ? "恢复面板布局" : "专注地图",
                  run: toggleMapFocus,
                },
              ]}
            />
          )}
          <div className="map-statusbar">
            <div className="map-coordinate">
              <MapPinned size={14} />
              <button
                className="coordinate-system"
                aria-label="切换坐标显示"
                aria-pressed={coordinateMode === "project"}
                title="切换经纬度与工程米制坐标"
                onClick={() =>
                  setCoordinateMode((value) =>
                    value === "geographic" ? "project" : "geographic",
                  )
                }
              >
                {coordinateMode === "geographic" ? "WGS84" : "工程 XY"}
                <ChevronDown size={11} />
              </button>
              <span
                className="coordinate-value"
                title={`工程 CRS：${project.crs}`}
              >
                {cursor
                  ? coordinateMode === "geographic"
                    ? `${cursor[0].toFixed(6)}°, ${cursor[1].toFixed(6)}°`
                    : `${transformPosition(cursor, "EPSG:4326", project.crs)
                        .map((value) => value.toFixed(2))
                        .join(", ")} m`
                  : "移动指针查看坐标"}
              </span>
            </div>
            <div
              className="map-status"
              title={status.text}
              role="status"
              aria-live="polite"
            >
              <span className={`status-dot ${status.tone ?? ""}`} />
              <span className="status-message">{status.text}</span>
              <span className="active-tool">
                {tool === "route"
                  ? "绘制路线"
                  : tool === "vertex"
                    ? "编辑顶点"
                    : tool === "facility"
                      ? "布设设施"
                      : "选择 / 平移"}
              </span>
            </div>
          </div>
          <div className="generation-card">
            <div className="generation-icon">
              <Activity size={18} />
            </div>
            <div className="generation-copy">
              <strong>{working ? "几何处理中" : "道路几何"}</strong>
              <span>
                {!isTauri()
                  ? "预览模式"
                  : ready
                    ? roadLabel
                    : "先准备参考线与横断面"}
              </span>
            </div>
            {working ? (
              <button className="button danger" onClick={cancelGenerate}>
                <X size={15} />
                取消
              </button>
            ) : (
              <button
                className="button primary"
                disabled={!ready || !isTauri()}
                onClick={generate}
                title={
                  !isTauri()
                    ? "请在 Tauri 桌面端运行生成"
                    : !ready
                      ? "至少需要两个路线点"
                      : ""
                }
              >
                <Activity size={15} />
                生成道路
              </button>
            )}
          </div>
        </main>

        <aside className="inspector" aria-label="属性检查器">
          <div
            className="panel-resizer right"
            role="separator"
            aria-label="调整属性面板宽度"
            aria-orientation="vertical"
            tabIndex={0}
            aria-valuenow={layout.right}
            onPointerDown={(event) => startResize("right", event)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setLayout((current) => ({
                  ...current,
                  right: Math.max(
                    256,
                    Math.min(
                      440,
                      current.right + (event.key === "ArrowLeft" ? 16 : -16),
                    ),
                  ),
                }));
              }
            }}
          />
          <div className="inspector-head">
            <div>
              <div className="eyebrow">属性面板</div>
              <h2>{selected ? "设施属性" : "工程属性"}</h2>
            </div>
            <button
              className="icon-button"
              title="折叠检查器"
              aria-label="折叠检查器"
              onClick={() => setShowInspector(false)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {selected ? (
            <FacilityInspector
              item={selected}
              update={update}
              onDelete={removeFacility}
            />
          ) : (
            <ProjectInspector
              project={project}
              update={update}
              status={status}
              roadLabel={roadLabel}
            />
          )}
        </aside>
      </div>
      {layerChoices && (
        <Modal title="选择数据图层" onCancel={() => finishLayerChoice(null)}>
          <p>先选择需要的图层，再读取有界要素快照。</p>
          <div className="route-choice-list">
            {layerChoices.map((layer) => (
              <button
                className="button outline full"
                key={layer.name}
                onClick={() => finishLayerChoice(layer.name)}
              >
                {layer.name} · {layer.feature_count ?? "未知"} 个要素
              </button>
            ))}
          </div>
          <div className="dialog-actions">
            <button
              className="button outline"
              onClick={() => finishLayerChoice(null)}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
      {routeChoices && (
        <Modal
          title={`选择路线 · ${routeChoices.features.length} 条`}
          onCancel={() => setRouteChoices(null)}
        >
          <RouteFeatureSelector
            key={routeChoices.revision}
            features={routeChoices.features}
            fields={routeChoices.fields}
            onCancel={() => setRouteChoices(null)}
            onRead={(features) => {
              if (features.length === 1) {
                void selectSourceFeature(
                  features[0],
                  routeChoices.label,
                  routeChoices.binding,
                  routeChoices.fields,
                );
                return;
              }
              setRouteChoices({
                ...routeChoices,
                features,
                fields: routeChoices.fields,
                revision: ++routeChoiceRevision.current,
              });
              setStatus(
                `已将 ${features.length} 条路线带入选择集；请从集合中勾选一条作为当前参考线。`,
                "ok",
              );
            }}
          />
        </Modal>
      )}
      {helpOpen && (
        <Modal
          title="路境工作台 · 操作说明"
          onCancel={() => setHelpOpen(false)}
        >
          <p>
            连接或导入参考线 → 配置字段与横断面 → 生成二维道路 → 人工放置设施 →
            保存和导出。
          </p>
          <p>
            Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+Z 撤销 · Ctrl+Y 重做 · F5 生成 · F
            适配范围 · P 平移 · Esc 退出绘制。
          </p>
          <p>
            地图底图入口位于画布左下角，也可从数据菜单打开。在线底图只用于浏览；道路宽度、位置与设施规格需要独立核验。
          </p>
          <p>
            真实三维、影像 AI 提取和截图配准尚未实现；倾斜视角仅为二维成果示意。
          </p>
        </Modal>
      )}
      {leaveDialog && (
        <Modal title="离开当前项目？" onCancel={() => resolveLeave(false)}>
          <p>
            {working
              ? "当前任务仍在运行。离开后会取消任务。"
              : "当前项目有尚未保存的编辑。"}
          </p>
          <div className="dialog-actions">
            <button
              className="button outline"
              onClick={() => resolveLeave(false)}
            >
              取消
            </button>
            <button
              className="button outline"
              disabled={saveState === "saving"}
              onClick={() => resolveLeave(true)}
            >
              放弃更改
            </button>
            <button
              className="button primary"
              disabled={saveState === "saving"}
              onClick={async () => {
                if (await saveProject()) resolveLeave(true);
              }}
            >
              保存并继续
            </button>
          </div>
          {saveState === "error" && (
            <p role="alert" className="field-error">
              保存失败，请检查状态栏或选择其他路径后重试。
            </p>
          )}
        </Modal>
      )}
      {templateEditor && (
        <Modal
          title={`编辑模板 · ${templateEditor.subtype}`}
          onCancel={() => setTemplateEditor(null)}
        >
          <p>修改用于之后布设的新实例；已放置设施保留原规格。</p>
          <SpecificationForm
            specification={templateEditor.specification}
            onChange={(specification) =>
              setTemplateEditor((current) =>
                current ? { ...current, specification } : null,
              )
            }
          />
          <div className="dialog-actions">
            <button
              className="button outline"
              onClick={() => setTemplateEditor(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              onClick={() => {
                if (
                  document.querySelector(
                    '.workbench-dialog [aria-invalid="true"]',
                  )
                )
                  return;
                const revised = {
                  ...templateEditor,
                  revision: templateEditor.revision + 1,
                };
                changeCatalog((current) =>
                  current.map((entry) =>
                    entry.id === revised.id ? revised : entry,
                  ),
                );
                setTemplateEditor(null);
                setStatus("模板已更新；已放置设施保持原规格。", "ok");
              }}
            >
              保存模板
            </button>
          </div>
        </Modal>
      )}
      {templateAction && (
        <Modal
          title={
            templateAction.kind === "new" ? "新建设施模板" : "复制设施模板"
          }
          onCancel={() => setTemplateAction(null)}
        >
          <label className="field-label" htmlFor="template-name">
            模板名称
          </label>
          <input
            className="text-input"
            id="template-name"
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
          />
          <div className="dialog-actions">
            <button
              className="button outline"
              onClick={() => setTemplateAction(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={!templateName.trim()}
              onClick={() => {
                const template =
                  templateAction.template ?? catalogRef.current[0];
                const entry: CatalogEntry = {
                  ...structuredClone(template),
                  id: `custom.user.${Date.now()}`,
                  revision: 1,
                  name: `${templateName.trim()} · 用户模板`,
                  subtype: templateName.trim(),
                  origin: "custom",
                  ...(templateAction.kind === "new"
                    ? {
                        category: "自定义",
                        geometry: "Point",
                        specification: {},
                        placement: { layout: "manual" },
                      }
                    : {}),
                };
                changeCatalog((current) => [...current, entry]);
                setTemplateAction(null);
                setTemplateEditor(entry);
              }}
            >
              创建模板
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DataPanel({
  project,
  status,
  importRoute,
  importRaster,
  onFieldMap,
  onNullFallback,
  mappingField,
  extras,
  primarySource,
}: {
  project: RoadProject;
  status: Status;
  importRoute: () => void;
  importRaster: () => void;
  onFieldMap: (field: string) => void;
  onNullFallback: (enabled: boolean) => void;
  mappingField: string;
  extras?: React.ReactNode;
  primarySource?: React.ReactNode;
}) {
  return (
    <div className="panel-content data-panel">
      {primarySource}
      {extras}
      <section className="section-block">
        <div className="section-head">
          <h3>其他输入方式</h3>
          <span className="count-tag">{project.crs}</span>
        </div>

        <div className="data-secondary-actions">
          <button
            className="button outline"
            onClick={importRoute}
            aria-label="导入本地路线"
          >
            <Upload size={15} />
            本地路线文件
          </button>
          <button className="button outline" onClick={importRaster}>
            <Plus size={15} />
            添加栅格
          </button>
          <button
            className="button outline"
            onClick={() =>
              document
                .querySelector<HTMLButtonElement>('[aria-label="绘制路线"]')
                ?.click()
            }
          >
            <PenLine size={15} />
            在地图上绘制
          </button>
        </div>
      </section>
      <section className="section-block">
        <div className="section-head">
          <h3>当前路线</h3>
          <span className="count-tag">{project.route_points.length} 点</span>
        </div>
        <div className="route-summary">
          <div className="route-thumb">
            <span />
          </div>
          <div className="route-details">
            <strong>{project.route_id}</strong>
            <span>{sourceLabel(project.route_source)}</span>
            <small>
              {project.route_points.length > 1
                ? `长度 ${(lineLength(project.route_points) / 1000).toFixed(2)} km`
                : "尚无可用路线"}
            </small>
          </div>
        </div>
      </section>
      <details className="section-block project-card project-details">
        <summary>
          <FileJson size={15} />
          项目详情<span>{project.crs}</span>
        </summary>
        <div className="file-row">
          <span>格式</span>
          <strong>路境项目</strong>
        </div>
        <div className="file-row">
          <span>工程 CRS</span>
          <strong>{project.crs} · 米</strong>
        </div>
        <div className="file-row">
          <span>输入版本</span>
          <strong>v{project.input_version}</strong>
        </div>
      </details>
      <div className={`panel-message ${status.tone ?? ""}`}>
        <span className="status-dot" />
        {status.text}
      </div>
    </div>
  );
}

function RoadPanel({
  project,
  update,
  busy,
  onApplyAuto,
  onClearAuto,
}: {
  project: RoadProject;
  update: (fn: (current: RoadProject) => RoadProject) => void;
  busy: boolean;
  onApplyAuto: (options: Record<string, unknown>) => void;
  onClearAuto: () => void;
  [key: string]: unknown;
}) {
  const [roadTab, setRoadTab] = useState<"section" | "display" | "along">(
    "section",
  );
  return (
    <div className="panel-content road-panel">
      <div
        className="panel-tabs road-tabs"
        role="tablist"
        aria-label="道路设置分类"
      >
        {(
          [
            ["section", "横断面"],
            ["display", "成果显示"],
            ["along", "沿线布设"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`road-tab-${id}`}
            role="tab"
            aria-selected={roadTab === id}
            aria-controls={`road-page-${id}`}
            onClick={() => setRoadTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="road-page-section"
        className="road-tab-panel"
        role="tabpanel"
        aria-labelledby="road-tab-section"
        hidden={roadTab !== "section"}
      >
        <CrossSectionEditor
          section={project.section}
          onChange={(section) => update((current) => ({ ...current, section }))}
        />
      </div>
      <section
        id="road-page-display"
        className="section-block road-tab-panel"
        role="tabpanel"
        aria-labelledby="road-tab-display"
        hidden={roadTab !== "display"}
      >
        <p className="section-intro">材质和表达切换即时生效，无需重新生成。</p>
        <label className="field-label" htmlFor="surface-type">
          路面材质（显示）
        </label>
        <select
          id="surface-type"
          className="text-input"
          value={String(project.scene_options?.surface_type ?? "asphalt")}
          onChange={(event) =>
            update((current) => ({
              ...current,
              scene_options: {
                ...current.scene_options,
                surface_type: event.target.value,
              },
            }))
          }
        >
          <option value="asphalt">沥青</option>
          <option value="concrete">混凝土</option>
          <option value="gravel">碎石</option>
        </select>
        <label className="field-label" htmlFor="render-mode">
          成果表达
        </label>
        <select
          id="render-mode"
          className="text-input"
          value={String(project.scene_options?.render_mode ?? "realistic")}
          onChange={(event) =>
            update((current) => ({
              ...current,
              scene_options: {
                ...current.scene_options,
                render_mode: event.target.value,
              },
            }))
          }
        >
          <option value="realistic">整体路面</option>
          <option value="components">分组成果</option>
        </select>
      </section>
      <div
        id="road-page-along"
        className="road-tab-panel"
        role="tabpanel"
        aria-labelledby="road-tab-along"
        hidden={roadTab !== "along"}
      >
        <AlongRouteTools
          value={project.scene_options ?? emptyOptions}
          ready={project.route_points.length > 1}
          busy={busy}
          onApply={onApplyAuto}
          onClear={onClearAuto}
        />
      </div>
    </div>
  );
}

function FacilityPanel({
  catalog,
  allCount,
  query,
  setQuery,
  selected,
  facilities,
  setTemplate,
  onClone,
  onEdit,
  onImport,
  onExport,
  onNew,
  onSelect,
  activeId,
  categories,
}: {
  catalog: CatalogEntry[];
  allCount: number;
  query: string;
  setQuery: (value: string) => void;
  selected: Facility | null;
  facilities: Facility[];
  setTemplate: (template: CatalogEntry) => void;
  onClone: (template: CatalogEntry) => void;
  onEdit: (template: CatalogEntry) => void;
  onImport: () => void;
  onExport: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  activeId: string | null;
  categories: string[];
}) {
  const [mode, setMode] = useState<"library" | "instances">("library");
  const [category, setCategory] = useState("");
  useEffect(() => {
    const menus = () => [
      ...document.querySelectorAll<HTMLDetailsElement>(".template-menu[open]"),
    ];
    const dismiss = (event: PointerEvent) => {
      menus().forEach((menu) => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menus().length) return;
      event.preventDefault();
      event.stopPropagation();
      menus().forEach((menu) => {
        menu.open = false;
        menu.querySelector<HTMLElement>("summary")?.focus();
      });
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);
  const filtered = catalog.filter(
    (entry) => !category || entry.category === category,
  );
  return (
    <div className="panel-content">
      <div className="panel-tabs" role="tablist" aria-label="设施工作区">
        <button
          role="tab"
          aria-selected={mode === "library"}
          onClick={() => setMode("library")}
        >
          模板库
        </button>
        <button
          role="tab"
          aria-selected={mode === "instances"}
          onClick={() => setMode("instances")}
        >
          已放置 · {facilities.length}
        </button>
      </div>
      {mode === "library" ? (
        <section className="section-block">
          <div className="section-head">
            <h3>选择布设模板</h3>
            <span className="count-tag">{allCount} 项</span>
          </div>
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label="搜索设施模板"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索设施名称"
            />
          </div>
          <label className="field-label" htmlFor="facility-category">
            设施分类
          </label>
          <select
            className="text-input"
            id="facility-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">全部分类</option>
            {categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <div className="catalog-actions">
            <button className="text-action" onClick={onNew}>
              <Plus size={14} />
              新建
            </button>
            <button className="text-action" onClick={onImport}>
              <Upload size={14} />
              导入
            </button>
            <button className="text-action" onClick={onExport}>
              <Download size={14} />
              导出
            </button>
          </div>
          <div className="template-list">
            {filtered.map((template) => (
              <div
                key={template.id}
                className={`template-card ${activeId === template.id ? "active" : ""}`}
              >
                <button
                  className="template-place"
                  onClick={() => setTemplate(template)}
                  aria-label={`放置${template.subtype}`}
                  aria-pressed={activeId === template.id}
                >
                  <TemplatePreview template={template} />
                  <span>
                    <strong>{template.subtype}</strong>
                    <small>
                      {template.category} · {geometryLabel(template.geometry)}
                    </small>
                  </span>
                  <Plus size={15} />
                </button>
                <details
                  className="template-menu"
                  onToggle={(event) => {
                    const menu = event.currentTarget;
                    if (!menu.open) return;
                    menu.removeAttribute("data-placement");
                    const panel = menu
                      .closest(".side-panel")
                      ?.getBoundingClientRect();
                    const popup = menu
                      .querySelector("div")
                      ?.getBoundingClientRect();
                    if (panel && popup && popup.bottom > panel.bottom - 8)
                      menu.dataset.placement = "above";
                  }}
                >
                  <summary aria-label={`更多模板操作 ${template.subtype}`}>
                    <Settings2 size={15} />
                  </summary>
                  <div>
                    <button
                      onClick={(event) => {
                        event.currentTarget
                          .closest("details")
                          ?.removeAttribute("open");
                        onClone(template);
                      }}
                    >
                      <Copy size={14} />
                      复制模板
                    </button>
                    <button
                      onClick={(event) => {
                        event.currentTarget
                          .closest("details")
                          ?.removeAttribute("open");
                        onEdit(template);
                      }}
                    >
                      <Pencil size={14} />
                      编辑模板
                    </button>
                  </div>
                </details>
              </div>
            ))}
          </div>
          {!filtered.length && (
            <p className="empty-state">没有匹配模板，试试其他分类或关键词。</p>
          )}
          <small className="catalog-count">
            展示 {filtered.length} / {allCount} 项 · 点击模板后在地图布设
          </small>
        </section>
      ) : (
        <section className="section-block">
          <div className="section-head">
            <h3>已放置设施</h3>
            <span className="count-tag">{facilities.length} 项</span>
          </div>
          <p className="section-intro">
            选择实例，在右侧编辑其位置和规格；模板库修改不会覆盖实例。
          </p>
          {facilities.map((item) => (
            <button
              className={`instance-row ${selected?.id === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => onSelect(item.id)}
            >
              <TemplatePreview template={item.template} />
              <span>
                <strong>{item.template.subtype}</strong>
                <small>
                  {item.confirmed ? "已人工确认" : "待人工核验"} ·{" "}
                  {item.x.toFixed(2)}, {item.y.toFixed(2)} m
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
          {!facilities.length && (
            <p className="empty-state">
              暂无设施，先从模板库选择并在地图布设。
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function FacilityInspector({
  item,
  update,
  onDelete,
}: {
  item: Facility;
  update: (fn: (current: RoadProject) => RoadProject) => void;
  onDelete: () => void;
}) {
  const patch = (changes: Partial<Facility>) =>
    update((current) => ({
      ...current,
      manual_facilities: current.manual_facilities.map((facility) =>
        facility.id === item.id ? { ...facility, ...changes } : facility,
      ),
    }));
  return (
    <div className="inspector-content">
      <div className="inspected-title">
        <div
          className={`inspected-icon ${geometryClass(item.template.geometry)}`}
        >
          <TemplatePreview template={item.template} />
        </div>
        <div>
          <strong>{item.template.subtype}</strong>
          <small>
            {item.template.category} · {geometryLabel(item.template.geometry)}
          </small>
        </div>
      </div>
      <div className="inspector-field">
        <span>来源</span>
        <strong>人工放置</strong>
      </div>
      <div className="inspector-field">
        <span>核验状态</span>
        <select
          className="text-input select-input"
          value={item.confirmed ? "confirmed" : "unconfirmed"}
          onChange={(event) =>
            patch({ confirmed: event.target.value === "confirmed" })
          }
        >
          <option value="unconfirmed">待核验</option>
          <option value="confirmed">已人工确认</option>
        </select>
      </div>
      <div className="coordinate-fields">
        <NumericField
          label="坐标 X"
          value={item.x}
          nullable={false}
          precision={2}
          unit="m"
          onCommit={(value) => {
            if (value !== null) patch({ x: value });
          }}
        />
        <NumericField
          label="坐标 Y"
          value={item.y}
          nullable={false}
          precision={2}
          unit="m"
          onCommit={(value) => {
            if (value !== null) patch({ y: value });
          }}
        />
        {item.end_x !== undefined && (
          <NumericField
            label="终点 X"
            value={item.end_x}
            nullable={false}
            precision={2}
            unit="m"
            onCommit={(value) => {
              if (value !== null) patch({ end_x: value });
            }}
          />
        )}
        {item.end_y !== undefined && (
          <NumericField
            label="终点 Y"
            value={item.end_y}
            nullable={false}
            precision={2}
            unit="m"
            onCommit={(value) => {
              if (value !== null) patch({ end_y: value });
            }}
          />
        )}
      </div>
      <div className="property-heading">
        <strong>实例规格</strong>
      </div>
      <SpecificationForm
        specification={item.template.specification}
        onChange={(specification) =>
          patch({ template: { ...item.template, specification } })
        }
      />
      <div className="compat-note">
        <CircleHelp size={14} />
        本设施以模板快照保存，不关联实时目录修改；“已人工确认”只记录人工状态，不构成规范校核。
      </div>
      <button className="button danger full" onClick={onDelete}>
        <Trash2 size={15} />
        删除设施
      </button>
    </div>
  );
}

function ProjectInspector({
  project,
  update,
  roadLabel,
}: {
  project: RoadProject;
  update: (fn: (current: RoadProject) => RoadProject) => void;
  status: Status;
  roadLabel: string;
}) {
  return (
    <div className="inspector-content">
      <div className="property-group">
        <div className="property-heading">
          <strong>路线基本信息</strong>
        </div>
        <label className="inspector-field">
          <span>业务路线 ID</span>
          <CommittedTextField
            label="业务路线 ID"
            value={project.route_id}
            onCommit={(route_id) =>
              update((current) => ({ ...current, route_id }))
            }
          />
        </label>
        <div className="inspector-field">
          <span>路线来源</span>
          <strong>{sourceLabel(project.route_source)}</strong>
        </div>
        <div className="inspector-field">
          <span>道路成果</span>
          <strong className="road-status-text">{roadLabel}</strong>
        </div>
        <div className="inspector-field">
          <span>路线控制点</span>
          <strong>{project.route_points.length} 个</strong>
        </div>
      </div>
      <details className="property-group technical-details">
        <summary>工程详情与兼容信息</summary>
        <div className="file-row">
          <span>工程坐标系</span>
          <strong>{project.crs}</strong>
        </div>
        <div className="file-row">
          <span>输入版本</span>
          <strong>v{project.input_version}</strong>
        </div>
        <div className="file-row">
          <span>成果版本</span>
          <strong>
            {project.output ? `v${project.output.input_version}` : "暂无"}
          </strong>
        </div>
        <p className="compat-copy">
          工程计算使用投影米制坐标，地图显示和地理导出使用
          WGS84。旧字段和自动设施设置随项目保留；尚未迁移的自动布设规则仍需旧版客户端。
        </p>
        {project.mapping_null_fallback !== undefined && (
          <div className="file-row">
            <span>空值回退</span>
            <strong>{String(project.mapping_null_fallback ?? "null")}</strong>
          </div>
        )}
      </details>
    </div>
  );
}

function LayerPanel({
  visible,
  setVisible,
  rasters,
  outputLayers,
  facilities,
  hasRoute,
  onImportRaster,
  onExportGpkg,
  onExportGeoJSON,
  fresh,
  children,
}: {
  visible: Record<string, boolean>;
  setVisible: (value: any) => void;
  rasters: unknown[];
  outputLayers: { name: string; collection: GeoJSON.FeatureCollection }[];
  facilities: Facility[];
  hasRoute: boolean;
  onImportRaster: () => void;
  onExportGpkg: () => void;
  onExportGeoJSON: () => void;
  fresh: boolean;
  children?: React.ReactNode;
}) {
  const toggle = (id: string) =>
    setVisible((current: any) => ({ ...current, [id]: !current[id] }));
  return (
    <div className="panel-content">
      {children}
      <section className="section-block">
        <div className="section-head">
          <h3>地图图层</h3>
          <span className="count-tag">
            {outputLayers.length +
              rasters.length +
              facilities.length +
              Number(hasRoute)}{" "}
            个
          </span>
        </div>
        <LayerRow
          color="blue"
          name="参考线"
          detail={hasRoute ? "投影米制输入 · WGS84 显示" : "等待路线输入"}
          visible={visible.route}
          onToggle={() => toggle("route")}
        />
        <LayerRow
          color="purple"
          name="道路成果"
          detail={
            fresh
              ? `${outputLayers.length} 个道路成果图层`
              : "未生成或输入已变更"
          }
          visible={visible.generated}
          onToggle={() => toggle("generated")}
          disabled={!fresh}
        />
        <LayerRow
          color="red"
          name="手动设施"
          detail={`${facilities.length} 项 · 来源及确认状态已记录`}
          visible={visible.facilities}
          onToggle={() => toggle("facilities")}
        />
        <LayerRow
          color="green"
          name="栅格影像"
          detail={`${rasters.length} 个本地栅格`}
          visible={visible.raster}
          onToggle={() => toggle("raster")}
        />
        <button
          className="button outline full import-layer"
          onClick={onImportRaster}
        >
          <Plus size={15} />
          添加本地栅格
        </button>
      </section>
      <section className="section-block">
        <div className="section-head">
          <h3>成果导出</h3>
          <span className="count-tag">WGS84 / 工程 CRS</span>
        </div>
        <div className="export-option">
          <div className="export-icon">
            <Database size={16} />
          </div>
          <div>
            <strong>GeoPackage</strong>
            <span>按项目 CRS 输出图层</span>
          </div>
          <button
            className="icon-button"
            onClick={onExportGpkg}
            aria-label="导出GeoPackage"
          >
            <Download size={16} />
          </button>
        </div>
        <div className="export-option">
          <div className="export-icon json">
            <FileJson size={16} />
          </div>
          <div>
            <strong>GeoJSON</strong>
            <span>标准 WGS84 经纬度</span>
          </div>
          <button
            className="icon-button"
            onClick={onExportGeoJSON}
            aria-label="导出WGS84 GeoJSON"
          >
            <Download size={16} />
          </button>
        </div>
        <div className="compat-note">
          <CircleHelp size={14} />
          GeoJSON 只接受 WGS84 经纬度；工程投影坐标不会冒充经纬度。
        </div>
      </section>
      <section className="section-block">
        <div className="section-head">
          <h3>图层列表</h3>
        </div>
        {outputLayers.map((layer, index) => (
          <div className="layer-subrow" key={`${layer.name}-${index}`}>
            <span className="swatch purple" />
            <span>{layer.name}</span>
            <small>{layer.collection.features.length} 要素</small>
          </div>
        ))}
      </section>
    </div>
  );
}
function LayerRow({
  color,
  name,
  detail,
  visible,
  onToggle,
  disabled = false,
}: {
  color: string;
  name: string;
  detail: string;
  visible: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={`layer-row ${disabled ? "disabled" : ""}`}>
      <span className={`swatch ${color}`} />
      <div>
        <strong>{name}</strong>
        <small>{detail}</small>
      </div>
      <button
        className={`switch ${visible ? "on" : ""}`}
        disabled={disabled}
        onClick={onToggle}
        aria-label={`${visible ? "隐藏" : "显示"}${name}`}
        aria-pressed={visible}
      >
        <span />
      </button>
    </div>
  );
}

function TemplateSymbol({ geometry }: { geometry: GeometryType }) {
  if (geometry === "Point") return <MapPinned size={16} />;
  if (geometry === "LineString") return <Baseline size={17} />;
  return <Box size={16} />;
}
function geometryClass(type: GeometryType) {
  return type === "Point"
    ? "point-geom"
    : type === "LineString"
      ? "line-geom"
      : "polygon-geom";
}
function geometryLabel(type: GeometryType) {
  return type === "Point"
    ? "点设施"
    : type === "LineString"
      ? "线设施"
      : "面设施";
}
function panelLabel(panel: Panel) {
  return {
    data: "数据",
    road: "道路",
    facility: "设施库",
    layers: "图层与成果",
  }[panel];
}
function slug(name: string) {
  return (
    name
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 40) || "layer"
  );
}
function fitProject(map: MapLibreMap | null, project: RoadProject) {
  if (!map || !project.route_points.length) return;
  const coords = project.route_points.map((point) =>
    transformPosition(point, project.crs, "EPSG:4326"),
  );
  if (coords.length === 1) {
    map.easeTo({ center: coords[0], zoom: Math.max(14, map.getZoom()) });
    return;
  }
  const bounds = coords.reduce(
    (value, point) => value.extend(point as [number, number]),
    new maplibregl.LngLatBounds(coords[0], coords[0]),
  );
  map.fitBounds(bounds, {
    padding: {
      top: Math.min(112, map.getContainer().clientHeight * 0.16),
      bottom: Math.min(110, map.getContainer().clientHeight * 0.16),
      left: Math.min(80, map.getContainer().clientWidth * 0.12),
      right: Math.min(80, map.getContainer().clientWidth * 0.12),
    },
    maxZoom: 17,
    duration: 450,
  });
}
function fitBounds(map: MapLibreMap | null, bounds: number[]) {
  if (!map || bounds.length !== 4 || !bounds.every(Number.isFinite)) return;
  map.fitBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    { padding: 80, duration: 500 },
  );
}
function transformCollection(
  collection: GeoJSON.FeatureCollection,
  from: string,
  to: string,
): GeoJSON.FeatureCollection {
  return {
    ...collection,
    features: collection.features.map((feature) =>
      transformFeature(feature, from, to),
    ),
  };
}
function transformFeature(
  feature: GeoJSON.Feature,
  from: string,
  to: string,
): GeoJSON.Feature {
  if (!feature.geometry) return feature;
  const coordinates = (value: any): any =>
    Array.isArray(value) && typeof value[0] === "number"
      ? transformPosition(value as Position, from, to)
      : value.map(coordinates);
  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: coordinates((feature.geometry as any).coordinates),
    } as GeoJSON.Geometry,
  };
}
function itemCrs(feature: GeoJSON.Feature) {
  return String(feature.properties?.crs ?? "EPSG:4326");
}
function serializeProject(
  project: RoadProject,
  catalog: CatalogEntry[],
): RoadProject {
  return { ...project, catalog: { schema_version: 1, entries: catalog } };
}
function pickLinePart(geometry: any): Position[] {
  if (geometry.type === "LineString") return geometry.coordinates;
  if (
    geometry.type !== "MultiLineString" ||
    !Array.isArray(geometry.coordinates) ||
    !geometry.coordinates.length
  )
    throw new Error("不支持的路线几何类型。");
  if (geometry.coordinates.length === 1) return geometry.coordinates[0];
  const index =
    Number(
      window.prompt(
        `路线包含 ${geometry.coordinates.length} 个独立部件；请选择一个部件（1-${geometry.coordinates.length}），不会连接不连续线段`,
        "1",
      ),
    ) - 1;
  if (!Number.isInteger(index) || !geometry.coordinates[index]) return [];
  return geometry.coordinates[index];
}
async function ensureCrs(crs: string) {
  if (hasCrsDefinition(crs)) return;
  if (!isTauri())
    throw new Error(
      `坐标系 ${crs} 尚无离线投影定义；浏览器预览仅支持内置 UTM 坐标系。`,
    );
  const definition = await invokeNative<string>("crs_definition", { crs });
  if (typeof definition !== "string" || !definition.trim())
    throw new Error(`本地引擎没有返回 ${crs} 的 proj4 定义`);
  registerCrsDefinition(crs, definition);
}
function reprojectProject(
  project: RoadProject,
  targetCrs: string,
): RoadProject {
  const transform = (point: Position): Position =>
    transformPosition(point, project.crs, targetCrs);
  return {
    ...project,
    crs: targetCrs,
    route_points: project.route_points.map(transform),
    manual_facilities: project.manual_facilities.map((item) => {
      const [x, y] = transform([item.x, item.y]);
      const next: Facility = { ...item, x, y };
      if (item.end_x !== undefined && item.end_y !== undefined)
        [next.end_x, next.end_y] = transform([item.end_x, item.end_y]);
      if (item.vertices) next.vertices = item.vertices.map(transform);
      return next;
    }),
  };
}
function projectedFacilityCollection(
  item: Facility,
): GeoJSON.FeatureCollection {
  const geometry: GeoJSON.Geometry =
    item.template.geometry === "Point"
      ? { type: "Point", coordinates: [item.x, item.y] }
      : item.template.geometry === "LineString"
        ? {
            type: "LineString",
            coordinates: [
              [item.x, item.y],
              [item.end_x!, item.end_y!],
            ],
          }
        : {
            type: "Polygon",
            coordinates: [
              [...(item.vertices ?? []), (item.vertices ?? [])[0]].map(
                (point) => [point[0], point[1]],
              ),
            ],
          };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: item.id,
        properties: { kind: item.kind, template_id: item.template.id },
        geometry,
      },
    ],
  };
}
function facilityIconName(template: CatalogEntry | undefined) {
  if (!template) return "facility-custom-Point";
  const match = template.id.match(/^system\.f(\d+)\.t(\d+)$/);
  return match
    ? `facility-f${match[1]}-t${match[2]}`
    : `facility-custom-${template.geometry}`;
}
async function loadFacilityIcon(map: MapLibreMap, template: CatalogEntry) {
  const name = facilityIconName(template);
  if (map.hasImage(name)) return;
  const match = template.id.match(/^system\.f(\d+)\.t(\d+)$/);
  const asset = match
    ? `/assets/catalog/f${match[1]}-t${match[2]}.svg`
    : `/assets/catalog/custom-${template.geometry}.svg`;
  try {
    const response = await fetch(asset);
    if (!response.ok) return;
    const image = new Image();
    const url = URL.createObjectURL(await response.blob());
    image.src = url;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("设施符号加载失败"));
    });
    if (!map.hasImage(name) && map.getStyle()) {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(image, 3, 3, 58, 58);
        map.addImage(name, context.getImageData(0, 0, 64, 64), {
          pixelRatio: 2,
        });
      }
    }
    URL.revokeObjectURL(url);
  } catch {
    /* 缺失图标时保留圆点符号作为可见回退 */
  }
}
async function facilityKind(template: CatalogEntry) {
  const legacy: Record<string, string> = {
    警告标志: "sign",
    单臂路灯: "lighting",
    里程牌: "milestone",
    轮廓标: "delineator",
    波形梁护栏: "guardrail",
  };
  if (template.id.startsWith("system.") && legacy[template.subtype])
    return legacy[template.subtype];
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(template.id),
  );
  const hash = [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  return `catalog_${hash}`;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sceneInputKey(project: RoadProject) {
  const options = project.scene_options ?? {};
  return JSON.stringify([
    options.enabled ?? [],
    options.spacing_m ?? 50,
    options.offset_m ?? 1,
    options.side ?? "both",
  ]);
}
function sameRoadInputs(a: RoadProject, b: RoadProject) {
  if (sceneInputKey(a) !== sceneInputKey(b)) return false;
  const input = (p: RoadProject) => ({
    route_id: p.route_id,
    route_source: p.route_source,
    crs: p.crs,
    route_points: p.route_points,
    section: p.section,
  });
  return JSON.stringify(input(a)) === JSON.stringify(input(b));
}
function readLayout(): {
  left: number;
  right: number;
  inspector: boolean;
  leftVisible: boolean;
} {
  try {
    const value = JSON.parse(
      localStorage.getItem("road-workbench-layout") ?? "null",
    );
    return {
      left: Math.max(240, Math.min(440, Number(value?.left) || 300)),
      right: Math.max(256, Math.min(440, Number(value?.right) || 300)),
      inspector: value?.inspector !== false,
      leftVisible: value?.leftVisible !== false,
    };
  } catch {
    return { left: 300, right: 300, inspector: true, leftVisible: true };
  }
}
function TemplatePreview({ template }: { template: CatalogEntry }) {
  const match = template.id.match(/^system\.f(\d+)\.t(\d+)$/);
  const asset = match
    ? `/assets/catalog/f${match[1]}-t${match[2]}.svg`
    : `/assets/catalog/custom-${template.geometry}.svg`;
  return (
    <img
      className="template-preview"
      src={asset}
      alt={`${template.subtype}示意`}
      loading="lazy"
    />
  );
}
function CommittedTextField({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const cancel = useRef(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  return (
    <input
      className="text-input"
      value={draft}
      aria-label={label}
      onFocus={() => {
        cancel.current = false;
        setFocused(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!cancel.current && draft !== value) onCommit(draft);
        setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
function MapContextMenu({
  point,
  commands,
  onClose,
}: {
  point: { x: number; y: number };
  commands: { label: string; run: () => void; disabled?: boolean }[];
  onClose: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(point);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const menu = node.current;
    const area = menu?.parentElement;
    if (!menu || !area) return;
    const footerHeight =
      area.querySelector(".map-statusbar")?.getBoundingClientRect().height ??
      56;
    setPosition({
      x: Math.max(
        8,
        Math.min(point.x, area.clientWidth - menu.offsetWidth - 8),
      ),
      y: Math.max(
        8,
        Math.min(
          point.y,
          area.clientHeight - footerHeight - menu.offsetHeight - 8,
        ),
      ),
    });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [point]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!node.current?.contains(event.target as Node)) close.current();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return (
    <div
      ref={node}
      className="map-context"
      role="menu"
      aria-label="地图操作"
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          buttons[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                  buttons.length
          ]?.focus();
        }
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          node.current?.parentElement
            ?.querySelector<HTMLCanvasElement>("canvas")
            ?.focus({ preventScroll: true });
          close.current();
        }
      }}
    >
      {commands.map((command) => (
        <button
          key={command.label}
          role="menuitem"
          disabled={command.disabled}
          onClick={() => {
            close.current();
            command.run();
          }}
        >
          {command.label}
        </button>
      ))}
    </div>
  );
}
function Modal({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const input = node.current?.querySelector<HTMLElement>(
      "input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
    );
    (
      input ?? node.current?.querySelector<HTMLElement>("button:not(:disabled)")
    )?.focus();
    return () => {
      const target = previous?.getClientRects().length
        ? previous
        : previous?.closest("details")?.querySelector<HTMLElement>("summary");
      target?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="dialog-backdrop">
      <div
        ref={node}
        className="workbench-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
          if (event.key === "Tab") {
            const nodes = [
              ...node.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),textarea,select,summary,[tabindex="0"]',
              ),
            ].filter((item) => item.getClientRects().length);
            const first = nodes[0],
              last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="dialog-title">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="关闭对话框"
            onClick={onCancel}
          >
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

function downloadBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
async function browserOpenFile(accept: string) {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function sourceLabel(value: string) {
  return value === "synthetic_fixture"
    ? "示例路线"
    : value === "manual"
      ? "人工绘制"
      : value || "未指定";
}

function ensurePavementTextures(map: MapLibreMap) {
  const palettes = {
    asphalt: [66, 70, 74],
    concrete: [197, 195, 187],
    gravel: [174, 155, 124],
  } as const;
  for (const [surface, base] of Object.entries(palettes)) {
    const id = `pavement-${surface}`;
    if (map.hasImage(id)) continue;
    const data = new Uint8Array(64 * 64 * 4);
    let seed = 421;
    for (let pixel = 0; pixel < 64 * 64; pixel++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise =
        ((seed >>> 24) / 255 - 0.5) *
        (surface === "gravel" ? 42 : surface === "concrete" ? 12 : 20);
      for (let channel = 0; channel < 3; channel++)
        data[pixel * 4 + channel] = Math.max(
          0,
          Math.min(255, base[channel] + noise),
        );
      data[pixel * 4 + 3] = 255;
    }
    map.addImage(id, { width: 64, height: 64, data });
  }
}
