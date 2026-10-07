import {
  saveBindingMapping,
  readConnections,
  type SourceBinding,
  type FieldMapping,
} from "./connections";
import {
  installMapWheelHandling,
  installPageZoomGuard,
} from "./MapInteraction";
import { MapScaleZoomControl } from "./MapScaleZoomControl";
import { MapCoordinateReadout } from "./MapCoordinateReadout";
import type { OutputDisplayLayer } from "./mapDisplay";
import { projectHistorySnapshot } from "./projectHistory";
import { routeVertexDisplay } from "./routeVertexDisplay";
import { outputDisplayChunks } from "./displayChunks";
import { laneMarkingLayers } from "./laneMarkings";
import { useGenerationIssuesBridge } from "./GenerationIssuesBridge";
import {
  geometryDiagnostics,
  responseGeometryCollections,
} from "./geometryDiagnostics";
const displayCrsDefinitions: Record<string, string> = {};
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
  CircleAlert,
  CircleCheck,
  LoaderCircle,
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
  type RouteSection,
} from "../domain";
import { FacilityDisplaySettings } from "./FacilityDisplaySettings";
import {
  clampFacilityDisplayScale,
  facilityIconSizeExpression,
  facilityMarkerRadiusExpression,
} from "./facilityDisplay";
import { GeneratedSurfaceEditor } from "./GeneratedSurfaceEditor";
import {
  filterGeneratedComponentLayers,
  featureMatchesSelector,
  setPartSection,
  setPartComponentExclusion,
  setPartExcluded,
  resetPartEdits,
  type ComponentSelector,
} from "./generatedSurfaceEdits";
import { chooseFile, chooseSave } from "../tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { SourceDatasetManager } from "./SourceDatasetManager";
import {
  GenerationIssuesPanel,
  type GenerationIssueRow,
} from "./GenerationIssuesPanel";
import {
  generationIssueRows,
  generationReviewIssues,
  generationTargetMatcher,
  mergeGenerationFailures,
  type GenerationTarget,
} from "./generationIssues";
import { exportLayerNames } from "./exportLayerNames";
import {
  appendDataset,
  normalizeSourceDatasets,
  findSourceFeatureIndex,
  removeDatasetFeatures,
  setDatasetIncluded,
  prepareSourceBatch,
  makeSourceBatchOutput,
  batchOutputLayers,
  mappedSectionForFeature,
  sourceBatchInputSignature,
  type SourceDataset,
  type SourceBatchOutput,
  type SourceBatchResult,
  type SourceBatchTask,
  type SourceBatchIssue,
} from "./sourceBatch";
import { generationChunks, reusableResults } from "./batchScheduling";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Redo2,
  ChevronRight,
} from "lucide-react";
import { NumericField, SpecificationForm } from "./EditorFields";
import {
  EditorValidationProvider,
  useEditorValidation,
} from "./EditorValidation";
import { sectionFormIssue } from "./sectionFormValidation";
import { isImeComposing } from "./imeKeyboard";
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
  type RoutePageLoad,
} from "./RouteFeatureSelector";
import { routeSourceCollection } from "./routeSourceLayer";
import {
  readSourcePage,
  type RouteDataSource,
  type SourceCapabilities,
} from "./sourceAccess";

type Panel = "data" | "road" | "facility" | "layers";
type Tool = "pan" | "route" | "vertex" | "surface" | "facility";
type SurfaceSelection = {
  dataset_id?: string;
  feature_key?: string;
  part_index: number;
  selector: ComponentSelector;
  label: string;
  componentLabel: string;
};
type Status = { text: string; tone?: "warn" | "ok" | "error" };
const emptyCollection: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
const emptyOptions: Record<string, unknown> = {};
const emptyOutputLayers: OutputDisplayLayer[] = [];
let rasterProtocolRegistered = false;
const invokeNative = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(command, args);
const sourceDefaults = (project: RoadProject) => ({
  manual_section:
    (project.manual_section as RoadProject["section"] | undefined) ??
    // 旧工程缺少模板时，不能把当前已映射记录的断面当作全来源默认值。
    (Object.values(
      (project.source_mapping as FieldMapping | undefined) ?? {},
    ).some((value) => typeof value === "string" && value)
      ? defaultProject().section
      : project.section),
});

/** 重生成沿用已保存的人工规则，不提供未经实现的全局覆盖操作。 */
function hasManualSurfaceEdits(project: RoadProject, allSources = false) {
  if (!allSources && !project.active_source_ref)
    return Boolean(
      project.surface_original_section ||
        (
          project.surface_component_exclusions as
            | ComponentSelector[]
            | undefined
        )?.length,
    );
  const active = project.active_source_ref as
    | { dataset_id: string; feature_key: string }
    | undefined;
  return ((project.vector_basemaps as SourceDataset[] | undefined) ?? []).some(
    (dataset) =>
      (allSources || dataset.id === active?.dataset_id) &&
      Object.entries(dataset.route_overrides ?? {}).some(
        ([key, edit]) =>
          (allSources || key === active?.feature_key) &&
          Boolean(
            edit.section ||
              Object.keys(edit.part_sections ?? {}).length ||
              edit.component_exclusions?.length,
          ),
      ),
  );
}
function retainUnchangedSourceResults(
  current: RoadProject,
  next: RoadProject,
  id: string,
  changedKeys: string[] = [],
  changedPartIndex?: number,
) {
  const output = current.source_batch_output as SourceBatchOutput | undefined;
  const before = ((current.vector_basemaps as any[]) ?? []).find(
    (item) => item.id === id,
  );
  const after = ((next.vector_basemaps as any[]) ?? []).find(
    (item) => item.id === id,
  );
  if (
    !output ||
    !before ||
    !after ||
    output.dataset_revisions[id] !== (before.revision ?? 1)
  )
    return next;
  return {
    ...next,
    source_batch_output: {
      ...output,
      dataset_revisions: {
        ...output.dataset_revisions,
        [id]: after.revision ?? 1,
      },
      results: output.results.filter(
        (result) =>
          result.dataset_id !== id ||
          !changedKeys.includes(result.feature_key) ||
          (changedPartIndex !== undefined &&
            result.part_index !== changedPartIndex),
      ),
    },
  };
}

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
      const group = groups.get(name);
      if (group) group.push(feature);
      else groups.set(name, [feature]);
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
function singleSurfaceExclusions(project: RoadProject): ComponentSelector[] {
  const active = project.active_source_ref as
    | { dataset_id: string; feature_key: string; part_index: number }
    | undefined;
  if (active) {
    const dataset = ((project.vector_basemaps as SourceDataset[]) ?? []).find(
      (item) => item.id === active.dataset_id,
    );
    return (
      dataset?.route_overrides?.[active.feature_key]?.component_exclusions ?? []
    )
      .filter((item) => item.part_index === active.part_index)
      .map((item) => ({ ...item, part_index: 0 }));
  }
  return (
    (project.surface_component_exclusions as ComponentSelector[] | undefined) ??
    []
  );
}

export function App() {
  return (
    <EditorValidationProvider>
      <Workbench />
    </EditorValidationProvider>
  );
}

function Workbench() {
  const { hasInvalidFields, isInvalid } = useEditorValidation();
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapReady = useRef(false);
  const outputLayerIds = useRef<Set<string>>(new Set());
  const rasterLayerIds = useRef<Set<string>>(new Set());
  const vectorLayerIds = useRef<Set<string>>(new Set());
  const sourceDataCache = useRef(new Map<string, GeoJSON.FeatureCollection>());
  const selectedRouteDisplay = useRef<{
    points: Position[];
    crs: string;
    collection: GeoJSON.FeatureCollection;
  } | null>(null);
  const refreshRouteVertices = useRef<() => void>(() => {});
  const routeDisplayCache = useRef(
    new WeakMap<GeoJSON.FeatureCollection, GeoJSON.FeatureCollection>(),
  );
  const displayRevision = useRef(0);
  const displayMetrics = useRef<Record<string, number>>({});
  const [displayPreparing, setDisplayPreparing] = useState(false);
  const [outputDisplay, setOutputDisplay] =
    useState<GeoJSON.FeatureCollection | null>(null);
  const routeDrag = useRef<{ index: number; moved: boolean } | null>(null);
  const lastVertexDrag = useRef(0);
  const selectedVertex = useRef<number | null>(null);
  const [vertexSelection, setVertexSelection] = useState<number | null>(null);
  const onMapClickRef = useRef<(event: MapMouseEvent) => void>(() => undefined);
  const projectRef = useRef<RoadProject>(defaultProject());
  const historyRef = useRef<RoadProject[]>([]);
  const redoRef = useRef<RoadProject[]>([]);
  const textTransaction = useRef<Element | null>(null);
  const routeEditPreparation = useRef<{ cancel: () => void } | null>(null);
  const qaEditSource = useRef<(id: string, key: string) => Promise<void>>(
    async () => {},
  );
  useEffect(() => () => routeEditPreparation.current?.cancel(), []);
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
  const jobRef = useRef<{
    id: string;
    cancelled: boolean;
    cancelPreparation?: () => void;
  } | null>(null);
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
  const [surfaceSelection, setSurfaceSelection] =
    useState<SurfaceSelection | null>(null);
  const [surfaceDelete, setSurfaceDelete] = useState<
    "component" | "part" | null
  >(null);
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
  const [exportOpen, setExportOpen] = useState(false);
  const [regenerateRequest, setRegenerateRequest] = useState<{
    kind: "current" | "batch";
    retryTargets?: GenerationTarget[];
  } | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    completed: number;
    total: number;
    succeeded: number;
    failed: number;
  }>();
  const [mappingDatasetId, setMappingDatasetId] = useState<string | null>(null);
  const [sourceReading, setSourceReading] = useState(false);
  const sourceReadingRef = useRef(false);
  const [sourceEntry, setSourceEntry] = useState<"file" | "connection">(() => {
    try {
      return readConnections().length ? "connection" : "file";
    } catch {
      return "connection";
    }
  });
  const [activeTemplate, setActiveTemplate] = useState<CatalogEntry | null>(
    null,
  );
  const [fileName, setFileName] = useState("未命名工程");
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
    (
      recipe: (current: RoadProject) => RoadProject,
      dirty = true,
      generatedResponse?: unknown,
    ) => {
      const current = projectRef.current;
      const next = recipe(current);
      if (next.route_points !== current.route_points) {
        next.surface_original_section = undefined;
        next.surface_component_exclusions = [];
      }
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
            projectHistorySnapshot(current),
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
      // 当前路线的人工编辑单独覆盖来源记录；原始几何及属性不被改写。
      const activeRef = current.active_source_ref as
        | { dataset_id: string; feature_key: string; part_index: number }
        | undefined;
      if (
        dirty &&
        activeRef &&
        current.active_source_ref === next.active_source_ref
      ) {
        const pointsChanged =
          next.route_points !== current.route_points &&
          next.crs === current.crs;
        const sectionChanged =
          next.section !== current.section &&
          next.source_mapping === current.source_mapping;
        if (pointsChanged || sectionChanged) {
          next.vector_basemaps = ((next.vector_basemaps as any[]) ?? []).map(
            (layer) => {
              if (layer.id !== activeRef.dataset_id) return layer;
              const old = layer.route_overrides?.[activeRef.feature_key] ?? {};
              return {
                ...layer,
                revision: (layer.revision ?? 1) + 1,
                route_overrides: {
                  ...layer.route_overrides,
                  [activeRef.feature_key]: {
                    ...old,
                    ...(pointsChanged
                      ? {
                          parts: {
                            ...old.parts,
                            [String(activeRef.part_index)]:
                              next.route_points.map((point) =>
                                transformPosition(point, next.crs, "EPSG:4326"),
                              ),
                          },
                        }
                      : {}),
                    ...(sectionChanged
                      ? {
                          part_sections: {
                            ...old.part_sections,
                            [String(activeRef.part_index)]: structuredClone(
                              next.section,
                            ),
                          },
                        }
                      : {}),
                  },
                },
              };
            },
          );
          next.source_batch_output = retainUnchangedSourceResults(
            current,
            next,
            activeRef.dataset_id,
            [activeRef.feature_key],
            activeRef.part_index,
          ).source_batch_output;
        }
      }
      let value = dirty && roadChanged ? markInputEdited(next) : next;
      // 成果编辑先在原生引擎成功计算，再与输入作为一个可撤销事务提交。
      if (generatedResponse !== undefined)
        value = {
          ...value,
          output: {
            input_version: value.input_version,
            response: generatedResponse,
          },
        };
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
  const sourceDatasets = useMemo(
    () =>
      normalizeSourceDatasets(project.vector_basemaps, sourceDefaults(project)),
    // 来源保存独立模板；切换当前编辑路线不重新规范化整表或重建批量显示成果。
    [project.vector_basemaps],
  );
  const geometrySceneKey = sceneInputKey(project);
  const generationRows = useMemo(
    () =>
      generationIssueRows(
        sourceDatasets,
        (project.source_batch_issues as SourceBatchIssue[] | undefined) ?? [],
        (project.source_batch_failures as SourceBatchIssue[] | undefined) ??
          (
            (project.source_batch_output as SourceBatchOutput | undefined)
              ?.results ?? []
          )
            .filter((result) => result.error)
            .map((result) => ({
              ...result,
              code: "engine_error",
              message: result.error!,
            })),
        (project.source_batch_output as SourceBatchOutput | undefined)
          ?.scene_key === geometrySceneKey
          ? generationReviewIssues(
              project.source_batch_output as SourceBatchOutput,
              sourceDatasets,
            )
          : [],
      ),
    [
      sourceDatasets,
      project.source_batch_issues,
      project.source_batch_failures,
      project.source_batch_output,
      geometrySceneKey,
    ],
  );
  useGenerationIssuesBridge(generationRows, working, {
    onRetry: (rows) => void generateAllSources(rows),
    onLocate: locateGenerationIssue,
    onEdit: (row) => void editGenerationIssue(row),
    onMapping: (row) => setMappingDatasetId(row.dataset_id),
  });
  const validBatchOutput = useMemo(() => {
    const output = project.source_batch_output as SourceBatchOutput | undefined;
    if (!output || output.scene_key !== geometrySceneKey) return undefined;
    const valid = new Map(
      sourceDatasets.map((dataset) => [
        dataset.id,
        {
          revision: dataset.revision,
          keys: new Set(dataset.feature_keys),
          excluded: new Set(dataset.excluded_keys ?? []),
        },
      ]),
    );
    return {
      ...output,
      results: output.results.filter((result) => {
        const dataset = valid.get(result.dataset_id);
        return (
          dataset &&
          output.dataset_revisions[result.dataset_id] === dataset.revision &&
          dataset.keys.has(result.feature_key) &&
          !dataset.excluded.has(result.feature_key)
        );
      }),
    };
  }, [project.source_batch_output, geometrySceneKey, sourceDatasets]);
  const singleOutput =
    project.output?.input_version === project.input_version
      ? project.output
      : null;
  const singleLayers = useMemo(
    () =>
      singleOutput
        ? filterGeneratedComponentLayers(
            responseLayers(singleOutput.response),
            singleSurfaceExclusions(project),
          )
        : emptyOutputLayers,
    [
      singleOutput,
      project.surface_component_exclusions,
      project.active_source_ref,
      project.vector_basemaps,
    ],
  );
  const batchLayers = useMemo(
    () => batchOutputLayers(validBatchOutput, sourceDatasets),
    [validBatchOutput, sourceDatasets],
  );
  const layers = useMemo(
    () => [...singleLayers, ...batchLayers],
    [singleLayers, batchLayers],
  );
  const productionLayersRef = useRef(layers);
  productionLayersRef.current = layers;
  const facilityDisplayScale = clampFacilityDisplayScale(
    Number(project.facility_display_scale),
  );
  const surfaceDataset = surfaceSelection?.dataset_id
    ? sourceDatasets.find(
        (dataset) => dataset.id === surfaceSelection.dataset_id,
      )
    : undefined;
  const surfaceSection = useMemo(
    () =>
      surfaceDataset && surfaceSelection?.feature_key
        ? (surfaceDataset.route_overrides?.[surfaceSelection.feature_key]
            ?.part_sections?.[String(surfaceSelection.part_index)] ??
          surfaceDataset.route_overrides?.[surfaceSelection.feature_key]
            ?.section ??
          (() => {
            const index = surfaceDataset.feature_keys.indexOf(
              surfaceSelection.feature_key!,
            );
            try {
              return index >= 0
                ? mappedSectionForFeature(
                    surfaceDataset.collection.features[index],
                    surfaceDataset.mapping ?? {},
                    surfaceDataset.manual_section ?? project.section,
                  )
                : project.section;
            } catch {
              return project.section;
            }
          })())
        : project.section,
    [surfaceDataset, surfaceSelection, project.section],
  );
  const savedSurfaceTargets = useMemo(
    () =>
      sourceDatasets.flatMap((dataset) =>
        Object.entries(dataset.route_overrides ?? {}).flatMap(
          ([featureKey, override]) => {
            const indices = new Set([
              ...Object.keys(override.part_sections ?? {}).map(Number),
              ...(override.component_exclusions ?? []).map(
                (item) => item.part_index,
              ),
            ]);
            return [...indices].map(
              (partIndex) =>
                ({
                  dataset_id: dataset.id,
                  feature_key: featureKey,
                  part_index: partIndex,
                  selector: { part_index: partIndex },
                  label: `${dataset.label} · ${featureKey}`,
                  componentLabel: "已保存的路段编辑",
                }) satisfies SurfaceSelection,
            );
          },
        ),
      ),
    [sourceDatasets],
  );
  const surfaceHighlight = useMemo(() => {
    if (!surfaceSelection || !outputDisplay) return emptyCollection;
    const found = outputDisplay.features.find((display) => {
      const properties = display.properties;
      const layer = layers[Number(properties?.__output_layer)];
      const feature =
        layer?.collection.features[Number(properties?.__output_feature)];
      if (
        !feature ||
        !["Polygon", "MultiPolygon"].includes(feature.geometry?.type)
      )
        return false;
      return surfaceSelection.dataset_id
        ? feature.properties?.source_dataset_id ===
            surfaceSelection.dataset_id &&
            feature.properties?.source_feature_key ===
              surfaceSelection.feature_key &&
            featureMatchesSelector(
              feature,
              surfaceSelection.selector,
              layer.name,
            )
        : !feature.properties?.source_dataset_id &&
            featureMatchesSelector(
              feature,
              surfaceSelection.selector,
              layer.name,
            );
    });
    return found
      ? { type: "FeatureCollection" as const, features: [found] }
      : emptyCollection;
  }, [surfaceSelection, layers, outputDisplay]);
  useEffect(() => {
    const revision = ++displayRevision.current;
    if (!layers.length) {
      setOutputDisplay(null);
      setDisplayPreparing(false);
      displayMetrics.current = {};
      return;
    }
    // 显示副本仅在成果变更时准备；生产属性和投影几何继续用于保存、编辑与导出。
    const worker = new Worker(
      new URL("./mapDisplayWorker.ts", import.meta.url),
      { type: "module" },
    );
    setOutputDisplay(null);
    setDisplayPreparing(true);
    const started = performance.now();
    const chunks = outputDisplayChunks(layers as OutputDisplayLayer[]);
    const features: GeoJSON.Feature[] = [];
    let coordinateCount = 0;
    let cancelled = false;
    const pump = () => {
      if (cancelled || displayRevision.current !== revision) return;
      const next = chunks.next();
      if (next.done) {
        setOutputDisplay({ type: "FeatureCollection", features });
        setDisplayPreparing(false);
        displayMetrics.current = {
          feature_count: features.length,
          coordinate_count: coordinateCount,
          source_layer_count: layers.length,
          preparation_ms: performance.now() - started,
          revision,
        };
        worker.terminate();
      } else
        worker.postMessage({
          kind: "chunk",
          revision,
          ...next.value,
          crs_definitions: displayCrsDefinitions,
        });
    };
    worker.onmessage = (event) => {
      if (
        displayRevision.current !== revision ||
        event.data.revision !== revision
      )
        return;
      if (event.data.error) {
        setDisplayPreparing(false);
        setStatus(
          `地图显示副本准备失败：${event.data.error}；生产成果仍保留。`,
          "error",
        );
        worker.terminate();
      } else {
        for (const feature of event.data.value.collection.features)
          features.push(feature);
        coordinateCount += event.data.value.metrics.coordinate_count;
        // 每次只保留一块线程输入，主动让出界面事件处理机会。
        setTimeout(pump, 0);
      }
    };
    worker.onerror = (event) => {
      if (displayRevision.current !== revision) return;
      setDisplayPreparing(false);
      setStatus(
        `地图显示处理失败：${event.message}；生产成果仍保留。`,
        "error",
      );
      worker.terminate();
    };
    pump();
    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [layers]);
  const mapOutputLayers = useMemo(
    () =>
      outputDisplay
        ? [
            {
              name: "道路成果显示",
              crs: "EPSG:4326",
              collection: outputDisplay,
            },
          ]
        : [],
    [outputDisplay],
  );
  const mappingDataset = sourceDatasets.find(
    (dataset) => dataset.id === mappingDatasetId,
  );
  const generatedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const result of validBatchOutput?.results ?? [])
      if (result.response && !result.error)
        counts[result.dataset_id] = (counts[result.dataset_id] ?? 0) + 1;
    return counts;
  }, [validBatchOutput]);
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
        next === "pan"
          ? ""
          : next === "vertex"
            ? "grab"
            : next === "surface"
              ? "pointer"
              : "crosshair";
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
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented)
        return;
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
      let cachedRoute = selectedRouteDisplay.current;
      if (
        cachedRoute?.points !== current.route_points ||
        cachedRoute.crs !== current.crs
      ) {
        cachedRoute = {
          points: current.route_points,
          crs: current.crs,
          collection: routeToGeoJSON(current.route_points, current.crs),
        };
        selectedRouteDisplay.current = cachedRoute;
      }
      const route = cachedRoute.collection;
      const addOrSet = (id: string, data: GeoJSON.FeatureCollection) => {
        const source = map.getSource(id) as
          | maplibregl.GeoJSONSource
          | undefined;
        if (source) {
          // 视图和可见性变化不重新序列化未修改的源图层。
          if (sourceDataCache.current.get(id) !== data) source.setData(data);
        } else
          map.addSource(id, {
            type: "geojson",
            data,
            buffer: 64,
            maxzoom: 16,
            tolerance: 0.375,
          });
        sourceDataCache.current.set(id, data);
      };
      addOrSet("road-route", route);
      const syncVertices = () => {
        const bounds = map.getBounds();
        const canvas = map.getCanvas();
        const coordinates =
          (route.features[0]?.geometry as GeoJSON.LineString | undefined)
            ?.coordinates ?? [];
        addOrSet(
          "road-route-vertices",
          tool === "vertex" && layerVisible.route
            ? routeVertexDisplay(
                coordinates,
                [
                  bounds.getWest(),
                  bounds.getSouth(),
                  bounds.getEast(),
                  bounds.getNorth(),
                ],
                { width: canvas.clientWidth, height: canvas.clientHeight },
                selectedVertex.current,
              )
            : emptyCollection,
        );
      };
      refreshRouteVertices.current = syncVertices;
      syncVertices();
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
            "circle-radius": facilityMarkerRadiusExpression(
              facilityDisplayScale,
              selectedFacility,
            ),
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
            "icon-size": facilityIconSizeExpression(facilityDisplayScale),
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
      map.setLayoutProperty(
        "road-facility-icons",
        "icon-size",
        facilityIconSizeExpression(facilityDisplayScale) as any,
      );
      map.setPaintProperty(
        "road-facility-points",
        "circle-radius",
        facilityMarkerRadiusExpression(facilityDisplayScale, selectedFacility),
      );
      map.setPaintProperty("road-facility-points", "circle-color", [
        "case",
        ["==", ["get", "id"], selectedFacility ?? ""],
        "#f79009",
        "#f04438",
      ]);
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
      for (const [layerIndex, layer] of mapOutputLayers.entries()) {
        // 来源名称可能很长或完全为中文，序号避免截短 slug 后图层互相覆盖。
        const sourceId = `output-${layerIndex}-${slug(layer.name)}`;
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
            minzoom: 12,
            filter: ["==", "$type", "LineString"],
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
            minzoom: 14,
            paint: {
              "circle-radius": facilityMarkerRadiusExpression(
                facilityDisplayScale,
              ) as any,
              "circle-color": componentColor,
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 1.5,
            },
          });
        map.setPaintProperty(`${sourceId}-fill`, "fill-color", componentColor);
        map.setPaintProperty(
          `${sourceId}-circle`,
          "circle-radius",
          facilityMarkerRadiusExpression(facilityDisplayScale),
        );
        map.setPaintProperty(
          `${sourceId}-fill`,
          "fill-opacity",
          components ? 0.48 : 0.94,
        );
        map.setPaintProperty(`${sourceId}-line`, "line-color", componentColor);
        map.setFilter(`${sourceId}-line`, [
          "all",
          components ? ["!=", "$type", "Point"] : ["==", "$type", "LineString"],
          ["!=", "component", "markings"],
        ]);
        for (const marking of laneMarkingLayers(sourceId)) {
          if (!map.getLayer(marking.id)) map.addLayer(marking);
          map.setLayoutProperty(
            marking.id,
            "visibility",
            layerVisible.generated ? "visible" : "none",
          );
        }
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
              minzoom: 14,
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
          for (const suffix of [
            "fill",
            "texture",
            "line",
            "circle",
            "markings-solid",
            "markings-dashed",
          ])
            if (map.getLayer(`${previous}-${suffix}`))
              map.removeLayer(`${previous}-${suffix}`);
          if (map.getSource(previous)) map.removeSource(previous);
          sourceDataCache.current.delete(previous);
        }
      outputLayerIds.current = activeOutputIds;
      for (const entry of current.catalog.entries)
        void loadFacilityIcon(map, entry);
      const activeVectorIds = new Set<string>();
      for (const item of (current.vector_basemaps as any[]) ?? []) {
        const id = `background-${item.id}`;
        activeVectorIds.add(id);
        let display = item.collection as GeoJSON.FeatureCollection;
        if (item.kind === "route-source") {
          let cached = routeDisplayCache.current.get(display);
          if (!cached) {
            // 地图副本只携带点击索引，完整业务属性仍保留在工程源图层中。
            cached = {
              type: "FeatureCollection",
              features: display.features.map((feature, index) => ({
                ...feature,
                id: index,
                properties: { __source_index: index },
              })),
            };
            routeDisplayCache.current.set(display, cached);
          }
          display = cached;
        }
        addOrSet(id, display);
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
            {
              "line-color":
                item.kind === "route-source" ? "#2587bd" : "#8499ad",
              "line-width": item.kind === "route-source" ? 2.5 : 1.3,
            },
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
          sourceDataCache.current.delete(id);
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
      addOrSet("road-surface-selection", surfaceHighlight);
      if (!map.getLayer("road-surface-selection-fill"))
        map.addLayer({
          id: "road-surface-selection-fill",
          source: "road-surface-selection",
          type: "fill",
          paint: {
            "fill-color": "#f59e0b",
            "fill-opacity": 0.32,
            "fill-outline-color": "#b45309",
          },
        });
      map.setLayoutProperty(
        "road-surface-selection-fill",
        "visibility",
        layerVisible.generated && tool === "surface" ? "visible" : "none",
      );
      // 成果数据源重建后仍把选择高亮置顶，避免被新添加的路面材质遮住。
      map.moveLayer("road-surface-selection-fill");
    },
    [
      catalog,
      layerVisible,
      mapOutputLayers,
      selectedFacility,
      tool,
      vertexSelection,
      surfaceHighlight,
      facilityDisplayScale,
    ],
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
    const removePageZoomGuard = installPageZoomGuard(window);
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
    map.addControl(new MapScaleZoomControl(), "bottom-left");
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
      refreshRouteVertices.current();
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
      removePageZoomGuard();
      window.removeEventListener("mouseup", releaseOutside);
      window.removeEventListener("blur", releaseDrag);
      map.remove();
      mapRef.current = null;
      sourceDataCache.current.clear();
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
          active_source_ref: undefined,
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
      } else if (state.tool === "surface") {
        const ids = [...outputLayerIds.current]
          .map((id) => `${id}-fill`)
          .filter((id) => map.getLayer(id));
        const hit = ids.length
          ? map.queryRenderedFeatures(event.point, { layers: ids })[0]
          : undefined;
        const layer =
          productionLayersRef.current[Number(hit?.properties?.__output_layer)];
        const feature =
          layer?.collection.features[Number(hit?.properties?.__output_feature)];
        if (
          feature &&
          ["Polygon", "MultiPolygon"].includes(feature.geometry?.type)
        ) {
          const properties = feature.properties ?? {};
          const active = !properties.source_dataset_id
            ? (projectRef.current.active_source_ref as
                | {
                    dataset_id: string;
                    feature_key: string;
                    part_index: number;
                  }
                | undefined)
            : undefined;
          const partIndex = Number(
            properties.part_index ?? active?.part_index ?? 0,
          );
          const component = String(properties.component ?? layer.name);
          setSurfaceSelection({
            dataset_id: properties.source_dataset_id ?? active?.dataset_id,
            feature_key: properties.source_feature_key ?? active?.feature_key,
            part_index: partIndex,
            selector: {
              part_index: partIndex,
              component,
              ...(properties.side == null
                ? {}
                : { side: String(properties.side) }),
              ...(properties.lane_index == null
                ? {}
                : { lane_index: Number(properties.lane_index) }),
            },
            label: String(properties.route_id ?? projectRef.current.route_id),
            componentLabel: `${({ lane: "车道", median: "中央隔离带", shoulder: "路肩", emergency: "应急车道", slope: "边坡投影" } as Record<string, string>)[component] ?? component}${properties.side == null ? "" : ` · ${properties.side === "left" ? "左侧" : properties.side === "right" ? "右侧" : properties.side}`}${properties.lane_index == null ? "" : ` · 车道 ${properties.lane_index}`}`,
          });
          setSelectedFacility(null);
          setPanel("road");
          setShowLeft(true);
          setStatus(
            "已选中路面成果；可调整所在路段宽度或删除选中组成，原始参考线保持不变。",
            "ok",
          );
        } else
          setStatus(
            "请点击已生成的路面；放大地图可更准确地选择车道、路肩等组成。",
            "warn",
          );
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
        else {
          setSelectedFacility(null);
          const sourceLayers = (
            (projectRef.current.vector_basemaps as any[]) ?? []
          ).filter(
            (item) => item.kind === "route-source" && item.visible !== false,
          );
          const ids = sourceLayers
            .map((item) => `background-${item.id}-line`)
            .filter((id) => map.getLayer(id));
          const hit = ids.length
            ? map.queryRenderedFeatures(
                [
                  [event.point.x - 5, event.point.y - 5],
                  [event.point.x + 5, event.point.y + 5],
                ],
                { layers: ids },
              )[0]
            : undefined;
          if (hit) {
            const item = sourceLayers.find(
              (row) => `background-${row.id}-line` === hit.layer.id,
            );
            const feature =
              item?.collection.features[Number(hit.properties?.__source_index)];
            if (feature)
              void selectSourceFeature(
                feature,
                item.source_label,
                item.binding,
                item.fields,
                item.id,
              );
          }
        }
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
    // 相机位置仅持久化视图，不重新上传生产几何或重建 GeoJSON 瓦片索引。
  }, [
    project.route_points,
    project.crs,
    project.manual_facilities,
    project.vector_basemaps,
    project.rasters,
    project.catalog,
    project.scene_options,
    syncMap,
  ]);

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
    redoRef.current.push(projectHistorySnapshot(projectRef.current));
    restoreHistory(previous);
    setRedoCount(redoRef.current.length);
    setHistoryCount(historyRef.current.length);
    setStatus("已撤销上一步编辑");
  }
  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(projectHistorySnapshot(projectRef.current));
    restoreHistory(next);
    setRedoCount(redoRef.current.length);
    setHistoryCount(historyRef.current.length);
    setStatus("已重做上一步编辑");
  }
  function restoreHistory(snapshot: RoadProject) {
    const current = projectRef.current;
    const roadChanged = !sameRoadInputs(current, snapshot);
    const restoredVersion = roadChanged
      ? current.input_version + 1
      : current.input_version;
    const snapshotOutput =
      snapshot.output?.input_version === snapshot.input_version
        ? snapshot.output
        : null;
    const restored = {
      ...snapshot,
      input_version: restoredVersion,
      output:
        snapshot.road_output_cleared === true
          ? null
          : snapshotOutput
            ? // 有效快照成果与其原输入一起恢复，并绑定新的版本以拒绝迟到任务。
              { ...snapshotOutput, input_version: restoredVersion }
            : roadChanged
              ? null
              : current.output,
    };
    if (!restored.output) setRoadState("changed");
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
  async function chooseVectorLayer(path: string) {
    const metadata: any = await invokeNative("list_vector_layers", { path });
    const available = metadata.layers ?? [];
    if (!available.length) throw new Error("文件中没有可读取图层。");
    let layerName: string | null = available[0].name;
    if (available.length > 1)
      layerName = await new Promise((resolve) => {
        layerResolver.current = resolve;
        setLayerChoices(available);
      });
    return layerName;
  }
  async function readVectorFile(path: string) {
    const layerName = await chooseVectorLayer(path);
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
    loadPage?: RoutePageLoad;
    capabilities?: SourceCapabilities;
    pageInfo?: {
      offset: number;
      limit: number;
      hasMore: boolean;
      expression: string;
      warning?: string;
    };
  } | null>(null);
  const routeChoiceRevision = useRef(0);
  const bulkReadRef = useRef<{ revision: number; started: boolean }>({
    revision: -1,
    started: false,
  });
  async function acceptVector(
    imported: any,
    label: string,
    binding?: SourceBinding,
    loadPage?: RoutePageLoad,
  ) {
    if (!binding && imported.layer_name)
      label = `${label} · ${imported.layer_name}`;
    const features =
      (imported.collection?.features?.filter((feature: any) =>
        ["LineString", "MultiLineString"].includes(feature.geometry?.type),
      ) as RouteFeature[] | undefined) ?? [];
    if (!features.length && !loadPage)
      throw new Error("所选图层没有可用线要素。");
    const fields: Field[] =
      Array.isArray(imported.fields) && imported.fields.length
        ? imported.fields
        : Object.keys(features[0]?.properties ?? {});
    const hasMore = imported.has_more ?? imported.truncated ?? false;
    if (features.length > 1 || loadPage || hasMore) {
      setRouteChoices({
        features,
        label,
        binding,
        fields,
        revision: ++routeChoiceRevision.current,
        loadPage,
        capabilities: imported.capabilities,
        pageInfo: {
          offset: imported.offset ?? 0,
          limit: imported.page_size ?? features.length,
          hasMore,
          expression: imported.filter_expression ?? "",
          warning: imported.pagination_warning,
        },
      });
      return;
    }
    if (loadSelectedRoutes(features, label, fields, binding))
      await selectSourceFeature(features[0], label, binding, fields);
  }
  function loadSelectedRoutes(
    features: RouteFeature[],
    label: string,
    fields: Field[],
    binding?: SourceBinding,
    options?: { streaming: boolean; recordHistory: boolean },
  ) {
    try {
      const { collection, bounds } = routeSourceCollection(features);
      update((current) => {
        const all = (current.vector_basemaps as any[]) ?? [];
        const existing = all.find(
          (layer) =>
            layer.kind === "route-source" &&
            (binding?.fingerprint
              ? layer.binding?.fingerprint === binding.fingerprint
              : !layer.binding && layer.source_label === label),
        );
        const dataset = appendDataset(
          existing,
          collection.features,
          label,
          fields,
          binding,
          {
            ...sourceDefaults(current),
            mapping: binding?.mapping ?? {},
          },
          makeId,
        );
        if (/^(?:[A-Za-z]:[\\/]|\/)/.test(label))
          dataset.label = label.split(/[\\/]/).pop() || label;
        const next = {
          ...current,
          vector_basemaps: existing
            ? all.map((layer) => (layer.id === existing.id ? dataset : layer))
            : [...all, dataset],
        };
        return existing
          ? retainUnchangedSourceResults(current, next, dataset.id)
          : next;
      }, options?.recordHistory ?? true);
      if (options?.streaming) {
        // 后续页不复制撤销快照，但仍标记为未保存，避免读取途中保存后漏记变更。
        if (!options.recordHistory) touchDocument();
        return true;
      }
      setRouteChoices(null);
      setToolMode("pan");
      fitBounds(mapRef.current, bounds);
      setStatus(
        `已追加所选路线到地图（重复记录自动跳过）；在“参与生成的数据”中统一映射、管理和生成。`,
        "ok",
      );
      return true;
    } catch (error) {
      setStatus(errorMessage(error), "error");
      return false;
    }
  }
  async function selectSourceFeature(
    feature: any,
    label: string,
    binding?: SourceBinding,
    sourceFields?: Field[],
    datasetId?: string,
    requestedPart?: number,
    requestedFeatureKey?: string,
  ) {
    try {
      const initialProject = projectRef.current;
      const datasets = sourceDatasets;
      const dataset = datasets.find((item) =>
        datasetId
          ? item.id === datasetId
          : binding?.fingerprint
            ? item.binding?.fingerprint === binding.fingerprint
            : !item.binding && item.source_label === label,
      );
      const featureIndex = dataset
        ? findSourceFeatureIndex(dataset, feature, requestedFeatureKey)
        : -1;
      const featureKey = dataset?.feature_keys[featureIndex];
      let coords =
        requestedPart !== undefined &&
        feature.geometry?.type === "MultiLineString"
          ? feature.geometry.coordinates[requestedPart]
          : pickLinePart(feature.geometry);
      if (!Array.isArray(coords)) throw new Error("找不到需要编辑的线部件。");
      const partIndex =
        feature.geometry?.type === "MultiLineString"
          ? feature.geometry.coordinates.indexOf(coords)
          : 0;
      const override = featureKey
        ? dataset?.route_overrides?.[featureKey]
        : undefined;
      coords = override?.parts?.[String(partIndex)] ?? coords;
      if (coords.length < 2)
        throw new Error(
          "路线须包含至少 2 个控制点；多部件路线请先明确要使用的连续线段。",
        );
      const targetCrs = utmCrsForWgs84(coords[Math.floor(coords.length / 2)]);
      await ensureCrs(projectRef.current.crs);
      routeEditPreparation.current?.cancel();
      setStatus(`正在准备路线编辑 · ${coords.length} 个控制点…`);
      const points = await new Promise<Position[]>((resolve, reject) => {
        const worker = new Worker(
          new URL("./routeEditWorker.ts", import.meta.url),
          { type: "module" },
        );
        const task = {
          cancel: () => {
            worker.terminate();
            reject(new Error("路线编辑准备已取消。"));
          },
        };
        routeEditPreparation.current = task;
        const finish = () => {
          worker.terminate();
          if (routeEditPreparation.current === task)
            routeEditPreparation.current = null;
        };
        worker.onmessage = ({ data }) => {
          finish();
          if (data.error) reject(new Error(data.error));
          else resolve(data.points);
        };
        worker.onerror = (event) => {
          finish();
          reject(new Error(event.message));
        };
        worker.postMessage({ coordinates: coords, crs: targetCrs });
      });
      if (
        projectRef.current.vector_basemaps !== initialProject.vector_basemaps ||
        projectRef.current.input_version !== initialProject.input_version ||
        projectRef.current.manual_facilities !==
          initialProject.manual_facilities
      ) {
        setStatus("准备期间工程已变更，请重新选择要编辑的路线。", "warn");
        return;
      }
      // 旧参考线即将替换，不转换它；只重投影保留的人工设施。
      const converted = reprojectProject(
        { ...projectRef.current, route_points: [] },
        targetCrs,
      );
      selectedRouteDisplay.current = {
        points,
        crs: targetCrs,
        collection: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { layer: "参考线" },
              geometry: { type: "LineString", coordinates: coords },
            },
          ],
        },
      };
      const attributes = feature.properties ?? {};
      const sourceMapping =
        dataset?.mapping ??
        (binding
          ? (binding.mapping ?? {})
          : projectRef.current.source_label === label &&
              !projectRef.current.source_binding
            ? ((projectRef.current.source_mapping as FieldMapping) ?? {})
            : {});
      const validMapping = sourceMapping;
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
        active_source_ref:
          dataset && featureKey
            ? {
                dataset_id: dataset.id,
                feature_key: featureKey,
                part_index: partIndex,
              }
            : undefined,
        route_points: points,
        route_source: label,
        mapped_attributes: attributes,
        source_fields: sourceFields?.length
          ? sourceFields
          : Object.keys(attributes),
        source_label: label,
        source_binding: binding ?? null,
        section:
          override?.part_sections?.[String(partIndex)] ??
          override?.section ??
          mappedSectionForFeature(
            feature,
            validMapping,
            dataset?.manual_section ?? sourceDefaults(current).manual_section,
          ),
        manual_section:
          dataset?.manual_section ??
          current.manual_section ??
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
      const mappingOkay = true;
      setRouteChoices(null);
      setToolMode("pan");
      fitBounds(
        mapRef.current,
        routeSourceCollection([
          {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
          },
        ] as RouteFeature[]).bounds,
        17,
      );
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
    if (sourceReadingRef.current) return;
    sourceReadingRef.current = true;
    setSourceReading(true);
    try {
      if (isTauri()) {
        const path = await chooseFile([
          {
            name: "矢量数据",
            extensions: [
              "geojson",
              "json",
              "gpkg",
              "shp",
              "kml",
              "sqlite",
              "sqlite3",
              "db",
            ],
          },
        ]);
        if (!path) return;
        const layerName = await chooseVectorLayer(path);
        if (layerName === null) return;
        const source: RouteDataSource = {
          type: "file",
          path,
          layer_name: layerName,
        };
        const imported = await readSourcePage(source, {
          expression: "",
          offset: 0,
          limit: 2_000,
        });
        const loadPage: RoutePageLoad = (options) =>
          readSourcePage(source, options);
        await acceptVector(imported, path, undefined, loadPage);
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
    } finally {
      sourceReadingRef.current = false;
      setSourceReading(false);
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
      setSurfaceSelection(null);
      setSurfaceDelete(null);
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

  function editSourceDataset(
    id: string,
    recipe: (dataset: SourceDataset) => SourceDataset,
    retainResults = false,
  ) {
    update((current) => {
      const next = {
        ...current,
        vector_basemaps: ((current.vector_basemaps as any[]) ?? []).map(
          (layer) => {
            if (layer.id !== id) return layer;
            const dataset = normalizeSourceDatasets(
              [layer],
              sourceDefaults(current),
            )[0];
            return dataset ? recipe(dataset) : layer;
          },
        ),
      };
      return retainResults
        ? retainUnchangedSourceResults(current, next, id)
        : next;
    });
  }
  function configureSourceMapping(id: string, mapping: FieldMapping) {
    const active = projectRef.current.active_source_ref as
      | { dataset_id: string }
      | undefined;
    if (active?.dataset_id === id) applyFieldMapping(mapping);
    else {
      editSourceDataset(id, (dataset) => ({
        ...dataset,
        mapping: { ...mapping },
        revision: (dataset.revision ?? 1) + 1,
      }));
      setStatus("来源级映射已更新；生成时逐行读取各自属性。", "ok");
    }
  }
  function locateGenerationIssue(row: GenerationIssueRow) {
    const dataset = sourceDatasets.find((item) => item.id === row.dataset_id);
    const feature =
      dataset?.collection.features[
        dataset.feature_keys.indexOf(row.feature_key ?? "")
      ];
    if (!feature) {
      setStatus("找不到问题路线，请检查来源数据。", "warn");
      return;
    }
    try {
      const geometry = feature.geometry;
      if (
        !geometry ||
        !["LineString", "MultiLineString"].includes(geometry.type)
      )
        throw new Error("该记录不是线几何，需修正原始数据后重新导入。");
      const override =
        dataset?.route_overrides?.[row.feature_key ?? ""]?.parts?.[
          String(row.part_index ?? 0)
        ];
      const coordinates =
        override ??
        (geometry?.type === "MultiLineString" && row.part_index !== undefined
          ? geometry.coordinates[row.part_index]
          : geometry?.type === "LineString"
            ? geometry.coordinates
            : undefined);
      const located = coordinates
        ? { ...feature, geometry: { type: "LineString" as const, coordinates } }
        : feature;
      // 修复报告使用源点序号；旧文本诊断按对应源段范围定位，不把估算里程当业务桩号。
      const diagnostic = row as GenerationIssueRow & {
        source_point_start?: number;
        source_point_end?: number;
      };
      const segments = row.message.match(/source segments (\d+) and (\d+)/);
      const start =
        diagnostic.source_point_start ??
        (segments ? Number(segments[1]) : undefined);
      const end =
        diagnostic.source_point_end ??
        (segments ? Number(segments[2]) + 1 : undefined);
      if (
        located.geometry?.type === "LineString" &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start! >= 0 &&
        end! >= start! &&
        end! < located.geometry.coordinates.length
      ) {
        located.geometry = {
          ...located.geometry,
          coordinates: located.geometry.coordinates.slice(start!, end! + 1),
        };
      }
      const bounds = routeSourceCollection([located as RouteFeature]).bounds;
      if (!bounds || bounds.some((value) => !Number.isFinite(value)))
        throw new Error("该路线坐标无效，无法定位；请修正原始数据后重新导入。");
      fitBounds(mapRef.current, bounds);
      setStatus(`已定位问题路线：${row.routeLabel}。`);
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }

  async function editGenerationIssue(row: GenerationIssueRow) {
    if (row.code === "mapping_error" || !row.feature_key) {
      setMappingDatasetId(row.dataset_id);
      return;
    }
    const dataset = sourceDatasets.find((item) => item.id === row.dataset_id);
    const feature =
      dataset?.collection.features[
        dataset.feature_keys.indexOf(row.feature_key)
      ];
    if (dataset && feature) {
      await selectSourceFeature(
        feature,
        dataset.source_label,
        dataset.binding ?? undefined,
        dataset.fields,
        dataset.id,
        row.part_index,
        row.feature_key,
      );
      if (
        (projectRef.current.active_source_ref as any)?.feature_key ===
        row.feature_key
      )
        setPanel("road");
    }
  }

  async function generateAllSources(
    retryTargets?: GenerationTarget[],
    preserveConfirmed = false,
  ) {
    if (!isTauri()) {
      setStatus("整体生成需要本地桌面引擎。", "warn");
      return;
    }
    if (jobRef.current) return;
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (
      isInvalid() ||
      document.querySelector('.editor-field [aria-invalid="true"]')
    ) {
      setStatus("请先修正表单错误，再生成参与路线。", "warn");
      return;
    }
    const input = projectRef.current;
    if (!preserveConfirmed && hasManualSurfaceEdits(input, true)) {
      setRegenerateRequest({ kind: "batch", retryTargets });
      return;
    }
    const datasets = normalizeSourceDatasets(
      input.vector_basemaps,
      sourceDefaults(input),
    );
    const job: {
      id: string;
      cancelled: boolean;
      cancelPreparation?: () => void;
    } = { id: makeId(), cancelled: false };
    jobRef.current = job;
    setWorking(true);
    setStatus("正在校验所有参与路线及字段映射…");
    let unlisten: (() => void) | undefined;
    try {
      const { tasks, issues } = await new Promise<{
        tasks: SourceBatchTask[];
        issues: SourceBatchIssue[];
      }>((resolve, reject) => {
        const worker = new Worker(
          new URL("./sourceBatchWorker.ts", import.meta.url),
          { type: "module" },
        );
        const finish = () => {
          worker.terminate();
          job.cancelPreparation = undefined;
        };
        job.cancelPreparation = () => {
          finish();
          reject(new Error("已取消批量校验"));
        };
        worker.onmessage = (event) => {
          finish();
          event.data.error
            ? reject(new Error(event.data.error))
            : resolve(event.data.value);
        };
        worker.onerror = (event) => {
          finish();
          reject(new Error(event.message || "批量校验工作线程失败"));
        };
        // 仅传递任务需要的项目属性，不复制既有成果、影像和设施。
        worker.postMessage({
          datasets,
          project: {
            route_id: input.route_id,
            crs: input.crs,
            section: input.section,
            manual_section: input.manual_section,
            source_mapping: input.source_mapping,
            source_binding: input.source_binding,
            source_label: input.source_label,
            scene_options: input.scene_options,
          },
        });
      });
      if (job.cancelled || jobRef.current?.id !== job.id) return;
      if (issues.length) {
        update(
          (current) => ({ ...current, source_batch_issues: issues }),
          false,
        );
        setStatus(
          `发现 ${issues.length} 个校验问题；继续处理有效路线，问题记录保留供修正。`,
          "warn",
        );
      }
      if (!tasks.length) {
        update(
          (current) => ({ ...current, source_batch_issues: issues }),
          true,
        );
        setStatus(
          issues.length
            ? `没有通过校验的路线；请查看“生成问题”中的 ${issues.length} 个原因。`
            : "没有参与生成的路线；请导入或勾选记录。",
          "warn",
        );
        return;
      }
      const reused = reusableResults(
        tasks,
        (input.source_batch_output as any)?.results ?? [],
      );
      const retryTarget = retryTargets
        ? generationTargetMatcher(retryTargets)
        : undefined;
      const pending = tasks.filter(
        (task) => !reused.has(task.key) && (!retryTarget || retryTarget(task)),
      );
      const runTotal = reused.size + pending.length;
      const chunks = generationChunks(pending);
      const startedAt = performance.now();
      let chunkBase = reused.size;
      let succeededBase = reused.size;
      let failedBase = 0;
      const signatures = new Map(
        datasets.map((dataset) => [
          dataset.id,
          sourceBatchInputSignature(dataset, input),
        ]),
      );
      setBatchProgress({
        completed: reused.size,
        total: runTotal,
        succeeded: reused.size,
        failed: 0,
      });
      unlisten = await listen<{
        job_id: string;
        total: number;
        completed: number;
        succeeded: number;
        failed: number;
      }>("road-batch-progress", (event) => {
        if (
          event.payload.job_id !== job.id ||
          job.cancelled ||
          jobRef.current?.id !== job.id
        )
          return;
        setBatchProgress({
          total: runTotal,
          completed: chunkBase + event.payload.completed,
          succeeded: succeededBase + event.payload.succeeded,
          failed: failedBase + event.payload.failed,
        });
      });
      if (job.cancelled || jobRef.current?.id !== job.id) return;
      setStatus(
        `正在整体生成 ${tasks.length} 个线部件 · 来源 ${datasets.length} 个…`,
      );
      const computed: SourceBatchResult[] = [];
      let processesStarted = 0;
      let completedChunks = 0;
      const queue = [...chunks];
      while (queue.length) {
        const chunk = queue.shift()!;
        if (job.cancelled || jobRef.current?.id !== job.id) return;
        let output: {
          results: SourceBatchResult[];
          total: number;
          engine_processes_started?: number;
        };
        try {
          output = await invokeNative<typeof output>("generate_roads_batch", {
            jobId: job.id,
            tasks: chunk.map(
              ({ key, dataset_id, feature_key, part_index, request }) => ({
                key,
                dataset_id,
                feature_key,
                part_index,
                request,
              }),
            ),
          });
        } catch (error) {
          // 输出大小取决于几何复杂度；仅资源超限时缩小批次重试，不跳过记录。
          if (
            !job.cancelled &&
            chunk.length > 1 &&
            /MiB|字节|输出.*(?:大|限)|响应.*(?:大|限)/i.test(
              errorMessage(error),
            )
          ) {
            const middle = Math.ceil(chunk.length / 2);
            queue.unshift(chunk.slice(0, middle), chunk.slice(middle));
            setBatchProgress({
              total: runTotal,
              completed: chunkBase,
              succeeded: succeededBase,
              failed: failedBase,
            });
            continue;
          }
          if (job.cancelled) return;
          // 进程或传输级故障也记录到受影响部件，避免丢掉已完成的其他批次。
          output = {
            total: chunk.length,
            results: chunk.map((task) => ({
              key: task.key,
              dataset_id: task.dataset_id,
              feature_key: task.feature_key,
              part_index: task.part_index,
              input_signature: task.input_signature,
              source_properties: task.source_properties,
              error: errorMessage(error),
            })),
          };
        }
        const received = new Map(
          output.results.map((result) => [result.key, result]),
        );
        output.results = chunk.map((task) => {
          const result = received.get(task.key);
          const { request: _request, ...identity } = task;
          return {
            ...identity,
            ...(result ?? {}),
            ...(!result || (!result.response && !result.error)
              ? { error: "引擎未返回该部件成果，请重试。" }
              : {}),
          };
        });
        completedChunks += 1;
        computed.push(...output.results);
        processesStarted += output.engine_processes_started ?? 0;
        chunkBase += output.results.length;
        succeededBase += output.results.filter(
          (result) => result.response && !result.error,
        ).length;
        failedBase += output.results.filter((result) => result.error).length;
      }
      if (job.cancelled || jobRef.current?.id !== job.id) return;
      const latest = projectRef.current;
      const latestDatasets = normalizeSourceDatasets(
        latest.vector_basemaps,
        sourceDefaults(latest),
      );
      if (
        sceneInputKey(input) !== sceneInputKey(latest) ||
        latestDatasets.length !== datasets.length ||
        latestDatasets.some(
          (dataset) =>
            signatures.get(dataset.id) !==
            sourceBatchInputSignature(dataset, latest),
        )
      ) {
        setStatus(
          "参与数据或映射在生成期间发生变更，已丢弃旧批次成果。",
          "warn",
        );
        return;
      }
      const computedByKey = new Map(
        computed.map((result) => [result.key, result]),
      );
      const previousByKey = new Map(
        (
          (input.source_batch_output as SourceBatchOutput | undefined)
            ?.results ?? []
        ).map((result) => [result.key, result]),
      );
      const results = tasks.flatMap((task) => {
        const previous = previousByKey.get(task.key);
        const result =
          reused.get(task.key) ??
          computedByKey.get(task.key) ??
          (previous?.input_signature === task.input_signature
            ? previous
            : undefined);
        if (!result) return [];
        const { points, ...request } = task.request;
        return [
          {
            ...task,
            ...result,
            request: { ...request, point_count: points.length },
          },
        ];
      });
      const failures = mergeGenerationFailures(
        (input.source_batch_failures as SourceBatchIssue[] | undefined) ??
          (
            (input.source_batch_output as SourceBatchOutput | undefined)
              ?.results ?? []
          )
            .filter((result) => result.error)
            .map((result) => ({
              ...result,
              code: "engine_error",
              message: result.error!,
            })),
        tasks.filter(
          (task) => reused.has(task.key) || !retryTarget || retryTarget(task),
        ),
        [...computed, ...reused.values()],
        datasets,
      );
      update(
        (current) => ({
          ...current,
          // 当前编辑路线若属于本批次，以完整批次成果为准，避免重复叠加。
          ...((current.active_source_ref as any)?.dataset_id &&
          results.some(
            (result) =>
              result.response &&
              result.dataset_id ===
                (current.active_source_ref as any).dataset_id &&
              result.feature_key ===
                (current.active_source_ref as any).feature_key,
          )
            ? { output: null }
            : {}),
          source_batch_output: makeSourceBatchOutput(results, tasks.length, {
            datasets,
            scene_key: sceneInputKey(input),
            issues,
          }),
          source_batch_issues: issues,
          source_batch_failures: failures,
          source_batch_job_error: undefined,
          source_batch_metrics: {
            total: tasks.length,
            computed: pending.length,
            reused: reused.size,
            native_chunks: completedChunks,
            engine_processes_started: processesStarted,
            elapsed_ms: performance.now() - startedAt,
          },
        }),
        true,
      );
      const failed = results.filter((result) => result.error).length;
      const reviewCount = generationReviewIssues(
        {
          results,
          dataset_revisions: Object.fromEntries(
            datasets.map((dataset) => [dataset.id, dataset.revision ?? 0]),
          ),
        },
        datasets,
      ).length;
      setRoadState("ready");
      setStatus(
        `${retryTargets ? "失败路线重试" : "整体生成"}完成：有效成果 ${results.length - failed} 个线部件，复用 ${reused.size} 个，本次处理 ${pending.length} 个，耗时 ${((performance.now() - startedAt) / 1000).toFixed(1)} 秒${failures.length || issues.length || reviewCount ? `；失败 ${failures.length + issues.length} 个，需复核 ${reviewCount} 个，请查看生成问题` : "；全部成果已加载地图"}。`,
        failures.length || issues.length || reviewCount ? "warn" : "ok",
      );
    } catch (error) {
      if (!job.cancelled) {
        update(
          (current) => ({
            ...current,
            source_batch_job_error: errorMessage(error),
          }),
          true,
        );
        setStatus(errorMessage(error), "error");
      }
    } finally {
      unlisten?.();
      if (jobRef.current?.id === job.id) {
        jobRef.current = null;
        setWorking(false);
        setBatchProgress(undefined);
      }
    }
  }
  function replaceSurfaceDataset(
    current: RoadProject,
    dataset: SourceDataset,
  ): RoadProject {
    const next = {
      ...current,
      vector_basemaps: ((current.vector_basemaps as any[]) ?? []).map((item) =>
        item.id === dataset.id ? dataset : item,
      ),
    };
    return retainUnchangedSourceResults(current, next, dataset.id);
  }
  function deleteSurface(kind: "component" | "part") {
    const selection = surfaceSelection;
    if (!selection || jobRef.current) return;
    textTransaction.current = null;
    update((current) => {
      if (selection.dataset_id && selection.feature_key) {
        const dataset = normalizeSourceDatasets(
          current.vector_basemaps,
          sourceDefaults(current),
        ).find((item) => item.id === selection.dataset_id);
        if (!dataset) return current;
        const changed =
          kind === "part"
            ? setPartExcluded(
                dataset,
                selection.feature_key,
                selection.part_index,
                true,
              )
            : setPartComponentExclusion(
                dataset,
                selection.feature_key,
                selection.part_index,
                selection.selector,
                true,
              );
        return replaceSurfaceDataset(current, changed);
      }
      const selector = kind === "part" ? { part_index: 0 } : selection.selector;
      return {
        ...current,
        surface_component_exclusions: [
          ...((current.surface_component_exclusions as ComponentSelector[]) ??
            []),
          selector,
        ],
      };
    });
    setSurfaceDelete(null);
    setStatus(
      kind === "part"
        ? "此路段成果已删除；参考线与属性保留，可恢复规则或撤销。"
        : "选中组成已删除；其他车道与路肩保持不变，可撤销。",
      "ok",
    );
  }
  async function applySurfaceSection(section: RouteSection, reset = false) {
    const selection = surfaceSelection;
    if (!selection || jobRef.current) return;
    if (!isTauri()) {
      setStatus("路面宽度修改需要本地桌面引擎。", "warn");
      return;
    }
    const input = projectRef.current;
    const job: {
      id: string;
      cancelled: boolean;
      cancelPreparation?: () => void;
    } = { id: makeId(), cancelled: false };
    jobRef.current = job;
    setWorking(true);
    setStatus("正在精确重生成所选路段；其他路段成果保持不变…");
    try {
      if (selection.dataset_id && selection.feature_key) {
        const dataset = normalizeSourceDatasets(
          input.vector_basemaps,
          sourceDefaults(input),
        ).find((item) => item.id === selection.dataset_id);
        if (!dataset) throw new Error("所选来源已不存在，请重新选择路面。");
        const changed = reset
          ? resetPartEdits(dataset, selection.feature_key, selection.part_index)
          : setPartSection(
              dataset,
              selection.feature_key,
              selection.part_index,
              section,
            );
        const index = changed.feature_keys.indexOf(selection.feature_key);
        if (index < 0) throw new Error("所选来源记录已不存在。");
        // 只向后台线程传递所选记录，不复制整张来源表或已有成果。
        const prepared = await new Promise<{
          tasks: SourceBatchTask[];
          issues: SourceBatchIssue[];
        }>((resolve, reject) => {
          const worker = new Worker(
            new URL("./sourceBatchWorker.ts", import.meta.url),
            { type: "module" },
          );
          const finish = () => {
            worker.terminate();
            job.cancelPreparation = undefined;
          };
          job.cancelPreparation = () => {
            finish();
            reject(new Error("已取消路面校验"));
          };
          worker.onmessage = (event) => {
            finish();
            event.data.error
              ? reject(new Error(event.data.error))
              : resolve(event.data.value);
          };
          worker.onerror = (event) => {
            finish();
            reject(new Error(event.message || "路面校验失败"));
          };
          worker.postMessage({
            datasets: [
              {
                ...changed,
                collection: {
                  ...changed.collection,
                  features: [changed.collection.features[index]],
                },
                feature_keys: [selection.feature_key],
              },
            ],
            project: {
              route_id: input.route_id,
              crs: input.crs,
              section: input.section,
              manual_section: input.manual_section,
              source_mapping: input.source_mapping,
              source_binding: input.source_binding,
              scene_options: input.scene_options,
            },
          });
        });
        const task = prepared.tasks.find(
          (item) => item.part_index === selection.part_index,
        );
        if (!task)
          throw new Error(
            prepared.issues.find(
              (item) => item.part_index === selection.part_index,
            )?.message ??
              prepared.issues[0]?.message ??
              "所选部件无法生成。",
          );
        if (job.cancelled) return;
        const response = await invokeNative<unknown>("generate_road", {
          request: task.request,
          jobId: job.id,
        });
        if (job.cancelled || jobRef.current?.id !== job.id) return;
        if (projectRef.current !== input) {
          setStatus("生成期间工程发生变化，未提交旧版编辑；请重试。", "warn");
          return;
        }
        textTransaction.current = null;
        update((current) => {
          const next = replaceSurfaceDataset(current, changed);
          const old = next.source_batch_output as SourceBatchOutput | undefined;
          const nextDatasets = normalizeSourceDatasets(
            next.vector_basemaps,
            sourceDefaults(next),
          );
          const byId = new Map(
            nextDatasets.map((item) => [
              item.id,
              {
                revision: item.revision,
                keys: new Set(item.feature_keys),
                excluded: new Set(item.excluded_keys ?? []),
              },
            ]),
          );
          const results = (
            old?.scene_key === sceneInputKey(input) ? old.results : []
          ).filter((item) => {
            const dataset = byId.get(item.dataset_id);
            return (
              item.key !== task.key &&
              dataset &&
              old?.dataset_revisions[item.dataset_id] === dataset.revision &&
              dataset.keys.has(item.feature_key) &&
              !dataset.excluded.has(item.feature_key)
            );
          });
          const result = {
            ...task,
            response,
            request: {
              ...task.request,
              points: undefined,
              point_count: task.request.points.length,
            },
          };
          const all = [...results, result];
          const active = current.active_source_ref as
            | { dataset_id: string; feature_key: string; part_index: number }
            | undefined;
          return {
            ...next,
            source_batch_output: {
              ...(old ?? {}),
              ...makeSourceBatchOutput(
                all,
                Math.max(old?.total ?? 0, all.length),
                {
                  datasets: nextDatasets,
                  scene_key: sceneInputKey(next),
                },
              ),
            },
            ...(active &&
            active.dataset_id === selection.dataset_id &&
            active.feature_key === selection.feature_key &&
            active.part_index === selection.part_index
              ? { output: null }
              : {}),
          };
        });
      } else {
        const restored = reset
          ? ((input.surface_original_section as RouteSection | undefined) ??
            input.section)
          : section;
        const response = await invokeNative<unknown>("generate_road", {
          request: {
            route_id: input.route_id,
            points: input.route_points,
            crs: input.crs,
            source: input.route_source,
            section: restored,
            scene_options: input.scene_options ?? {},
          },
          jobId: job.id,
        });
        if (job.cancelled || jobRef.current?.id !== job.id) return;
        if (projectRef.current !== input) {
          setStatus("生成期间工程发生变化，未提交旧版编辑；请重试。", "warn");
          return;
        }
        textTransaction.current = null;
        update(
          (current) => ({
            ...current,
            section: restored,
            surface_original_section:
              current.surface_original_section ??
              structuredClone(current.section),
            ...(reset ? { surface_component_exclusions: [] } : {}),
          }),
          true,
          response,
        );
      }
      setRoadState("ready");
      setStatus(
        reset
          ? "此路段原规则已恢复并重生成；其他路段不受影响。"
          : "所选路段宽度已修改并精确重生成；可撤销本次编辑。",
        "ok",
      );
    } catch (error) {
      if (!job.cancelled)
        setStatus(`路面编辑未提交：${errorMessage(error)}`, "error");
    } finally {
      if (jobRef.current?.id === job.id) {
        jobRef.current = null;
        setWorking(false);
      }
    }
  }
  async function generate(preserveConfirmed = false) {
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
    const sectionIssue = sectionFormIssue(projectRef.current.section);
    if (
      isInvalid() ||
      sectionIssue ||
      document.querySelector('.editor-field [aria-invalid="true"]')
    ) {
      setStatus(sectionIssue ?? "请先修正表单错误，再生成道路。", "warn");
      return;
    }
    if (!preserveConfirmed && hasManualSurfaceEdits(projectRef.current)) {
      setRegenerateRequest({ kind: "current" });
      return;
    }
    if (jobRef.current) return;
    const jobId = makeId();
    const job = { id: jobId, cancelled: false };
    jobRef.current = job;
    setWorking(true);
    setRoadState("changed");
    setStatus("正在生成道路成果…");
    const generationRouteLabel = projectRef.current.route_id;
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
        current_generation_error: undefined,
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
        update(
          (current) => ({
            ...current,
            current_generation_error: `路线「${generationRouteLabel}」：${errorMessage(error)}`,
          }),
          false,
        );
        touchDocument();
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
    job.cancelPreparation?.();
    jobRef.current = null;
    setWorking(false);
    setBatchProgress(undefined);
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
      if (!layers.length && !project.manual_facilities.length)
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
      const exportNames = exportLayerNames(
        collections.map((item) => item.name),
      );
      const projected = collections.map((item, index) =>
        item.crs === project.crs
          ? { ...item, name: exportNames[index] }
          : {
              ...item,
              name: exportNames[index],
              collection: transformCollection(
                item.collection,
                item.crs,
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
  function applyFieldMapping(
    mapping: Record<string, string | null | boolean>,
    syncDataset = true,
  ) {
    const active = projectRef.current.active_source_ref as
      | { dataset_id: string }
      | undefined;
    const mappedLayers = (value: RoadProject) =>
      syncDataset && active
        ? {
            vector_basemaps: ((value.vector_basemaps as any[]) ?? []).map(
              (layer) =>
                layer.id === active.dataset_id
                  ? {
                      ...layer,
                      mapping: { ...mapping },
                      revision: (layer.revision ?? 1) + 1,
                    }
                  : layer,
            ),
          }
        : {};
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
        ...mappedLayers(value),
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
        ...mappedLayers(value),
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

  qaEditSource.current = async (id, key) => {
    const dataset = sourceDatasets.find((item) => item.id === id);
    const index = dataset
      ? findSourceFeatureIndex(dataset, {} as any, key)
      : -1;
    if (!dataset || index < 0) throw new Error("找不到测试来源记录。");
    await selectSourceFeature(
      dataset.collection.features[index],
      dataset.source_label,
      dataset.binding ?? undefined,
      dataset.fields,
      id,
      0,
      key,
    );
  };
  const qa = useMemo(
    () => ({
      getProject: () => structuredClone(projectRef.current),
      loadProject: (data: unknown) => {
        setSurfaceSelection(null);
        setSurfaceDelete(null);
        const normalized = normalizeProject(data);
        setProject(normalized);
        projectRef.current = normalized;
      },
      getMap: () => mapRef.current,
      getDisplayMetrics: () => ({ ...displayMetrics.current }),
      getMemoryDiagnostics: () => ({
        history_count: historyRef.current.length,
        redo_count: redoRef.current.length,
        history_shared_source_count: historyRef.current.filter(
          (snapshot) =>
            snapshot.vector_basemaps === projectRef.current.vector_basemaps,
        ).length,
        history_shared_batch_count: historyRef.current.filter(
          (snapshot) =>
            snapshot.source_batch_output ===
            projectRef.current.source_batch_output,
        ).length,
        route_points_count: projectRef.current.route_points.length,
        active_source_ref: projectRef.current.active_source_ref,
        source_geometry: geometryDiagnostics(
          ((projectRef.current.vector_basemaps as any[]) ?? [])
            .filter(
              (layer) =>
                layer.kind === "route-source" &&
                layer.collection?.type === "FeatureCollection",
            )
            .map((layer) => layer.collection),
        ),
        batch_geometry: geometryDiagnostics(
          (
            (
              projectRef.current.source_batch_output as
                | SourceBatchOutput
                | undefined
            )?.results ?? []
          ).flatMap((result) => responseGeometryCollections(result.response)),
        ),
      }),
      editSourceFeatureByKey: (id: string, key: string) =>
        qaEditSource.current(id, key),
      undo: () => actionsRef.current.undo(),
      redo: () => actionsRef.current.redo(),
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
  const sectionIssue = sectionFormIssue(project.section);
  const generationDisabledReason = working
    ? "道路生成任务正在运行"
    : !isTauri()
      ? "请在 Tauri 桌面端运行生成"
      : !ready
        ? "至少需要两个路线点"
        : hasInvalidFields
          ? "请先修正表单中标记的无效数值"
          : sectionIssue;
  const roadLabel = working
    ? "生成中"
    : validBatchOutput?.results.some(
          (result) => result.response && !result.error,
        )
      ? "批量成果已生成"
      : !ready
        ? "待绘制"
        : roadState === "error"
          ? "生成失败"
          : stale || roadState === "changed"
            ? "成果待更新"
            : project.output
              ? "已生成"
              : "未生成";
  const toolHint =
    tool === "route"
      ? "单击添加路线点，拖动顶点调整位置；Esc 完成绘制。"
      : tool === "vertex"
        ? "编辑参考线：拖动控制点调整位置，Delete 删除；Esc 返回选择。"
        : tool === "surface"
          ? "点击已生成的路面，修改所在路段宽度或删除成果组成；Esc 返回选择。"
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
          disabled: !layers.length && !project.manual_facilities.length,
          run: () => void exportGeoPackage(),
        },
        {
          label: "导出 GeoJSON（WGS84）…",
          disabled: !layers.length && !project.manual_facilities.length,
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
          disabled: !layers.length,
          run: () => {
            update((current) => ({
              ...current,
              output: null,
              source_batch_output: null,
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
              active_source_ref: undefined,
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
            setSourceEntry("connection");
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
            if (
              !(project.source_fields as Field[] | undefined)?.length &&
              sourceDatasets.length
            )
              setMappingDatasetId(sourceDatasets[0].id);
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
          label: "编辑路面成果",
          run: () => {
            setToolMode("surface");
            setStatus("点击生成的路面，调整宽度或删除组成。");
          },
          checked: tool === "surface",
          disabled: !layers.length,
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
          disabled: Boolean(generationDisabledReason),
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
            title="打开项目（Ctrl+O）"
          >
            <FolderOpen size={16} />
            打开
          </button>
          <button
            className="button quiet"
            onClick={saveProject}
            aria-label="保存项目"
            title={
              saveState === "error"
                ? "重试保存项目（Ctrl+S）"
                : "保存项目（Ctrl+S）"
            }
            disabled={saveState === "saving"}
          >
            <Save size={16} />
            保存项目
          </button>
          <button
            className="button primary"
            aria-label="生成当前路线道路"
            title={generationDisabledReason ?? "生成当前路线道路（F5）"}
            disabled={Boolean(generationDisabledReason)}
            onClick={() => void generate()}
          >
            {working ? (
              <LoaderCircle size={18} className="is-spinning" />
            ) : (
              <Activity size={18} />
            )}
            生成道路
          </button>
          <button
            className="button outline"
            aria-label="选择成果导出格式"
            title="导出成果"
            disabled={
              working || (!layers.length && !project.manual_facilities.length)
            }
            onClick={() => setExportOpen(true)}
          >
            <Download size={18} />
            导出
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
                  <summary>路线数据</summary>
                  <div
                    className="source-entry-tabs"
                    role="group"
                    aria-label="路线数据来源"
                  >
                    <button
                      type="button"
                      className="button outline"
                      aria-pressed={sourceEntry === "file"}
                      disabled={sourceReading}
                      onClick={() => setSourceEntry("file")}
                    >
                      文件
                    </button>
                    <button
                      type="button"
                      className="button outline"
                      aria-pressed={sourceEntry === "connection"}
                      disabled={sourceReading}
                      onClick={() => setSourceEntry("connection")}
                    >
                      连接
                    </button>
                  </div>
                  {sourceEntry === "file" ? (
                    <div className="source-file-entry">
                      <p>
                        本地矢量文件、GeoPackage 可直接查询，无需数据库服务。
                      </p>
                      <button
                        className="button primary full"
                        onClick={() => void importRoute()}
                        disabled={sourceReading}
                        aria-label="导入本地路线"
                      >
                        <FolderOpen size={15} />
                        {sourceReading ? "正在读取图层…" : "打开路线文件"}
                      </button>
                    </div>
                  ) : (
                    <DataSourceTools
                      getMapBounds={() => {
                        const bounds = mapRef.current?.getBounds();
                        return bounds
                          ? [
                              bounds.getWest(),
                              bounds.getSouth(),
                              bounds.getEast(),
                              bounds.getNorth(),
                            ]
                          : null;
                      }}
                      onImport={(result, label, binding, loadPage) => {
                        void acceptVector(
                          result,
                          label,
                          binding,
                          loadPage,
                        ).catch((error) =>
                          setStatus(errorMessage(error), "error"),
                        );
                      }}
                    />
                  )}
                </details>
              }
              extras={
                <>
                  <SourceDatasetManager
                    generationDisabledReason={
                      hasInvalidFields
                        ? "请先修正表单中标记的无效数值"
                        : undefined
                    }
                    datasets={sourceDatasets}
                    working={working}
                    progress={batchProgress}
                    generatedCounts={generatedCounts}
                    onAppend={() => {
                      setSourceOpen(true);
                      setPanel("data");
                      setStatus(
                        "在上方路线数据入口继续选择记录；同一来源将自动追加并去重。",
                      );
                    }}
                    onGenerate={() => void generateAllSources()}
                    onCancel={() => void cancelGenerate()}
                    onRemoveDataset={(id) => {
                      update((current) => ({
                        ...current,
                        vector_basemaps: (
                          (current.vector_basemaps as any[]) ?? []
                        ).filter((layer) => layer.id !== id),
                        ...((current.active_source_ref as any)?.dataset_id ===
                        id
                          ? {
                              active_source_ref: undefined,
                              route_points: [],
                              output: null,
                            }
                          : {}),
                      }));
                      setStatus(
                        "已移除工程中的来源数据及其成果；未修改原文件或数据库，可撤销。",
                        "ok",
                      );
                    }}
                    onRemoveFeatures={(id, keys) => {
                      update((current) => {
                        const active = current.active_source_ref as
                          | { dataset_id: string; feature_key: string }
                          | undefined;
                        const next = {
                          ...current,
                          vector_basemaps: (
                            (current.vector_basemaps as any[]) ?? []
                          ).map((layer) =>
                            layer.id === id
                              ? removeDatasetFeatures(
                                  normalizeSourceDatasets(
                                    [layer],
                                    sourceDefaults(current),
                                  )[0],
                                  keys,
                                )
                              : layer,
                          ),
                          ...(active?.dataset_id === id &&
                          keys.includes(active.feature_key)
                            ? {
                                active_source_ref: undefined,
                                route_points: [],
                                output: null,
                              }
                            : {}),
                        };
                        return retainUnchangedSourceResults(current, next, id);
                      });
                      setStatus(
                        "已从工程移除所选记录；原始数据不受影响，可撤销。",
                        "ok",
                      );
                    }}
                    onSetIncluded={(id, keys, included) =>
                      editSourceDataset(
                        id,
                        (dataset) =>
                          setDatasetIncluded(dataset, keys, included),
                        true,
                      )
                    }
                    onEditFeature={(id, key) => {
                      const dataset = sourceDatasets.find(
                        (item) => item.id === id,
                      );
                      const index = dataset?.feature_keys.indexOf(key) ?? -1;
                      if (dataset && index >= 0)
                        void selectSourceFeature(
                          dataset.collection.features[index],
                          dataset.source_label,
                          dataset.binding ?? undefined,
                          dataset.fields,
                          id,
                          undefined,
                          key,
                        );
                    }}
                    onConfigureMapping={setMappingDatasetId}
                    onLocateDataset={(id) => {
                      const dataset = sourceDatasets.find(
                        (item) => item.id === id,
                      );
                      if (dataset)
                        try {
                          fitBounds(
                            mapRef.current,
                            routeSourceCollection(
                              dataset.collection.features as RouteFeature[],
                            ).bounds,
                          );
                        } catch (error) {
                          setStatus(errorMessage(error), "error");
                        }
                    }}
                  />
                  <GenerationIssuesPanel
                    rows={generationRows}
                    working={working}
                    onRetry={(rows) => void generateAllSources(rows)}
                    onLocate={locateGenerationIssue}
                    onEdit={(row) => void editGenerationIssue(row)}
                    onMapping={(row) => setMappingDatasetId(row.dataset_id)}
                  />
                  {typeof project.source_batch_job_error === "string" && (
                    <section
                      className="data-tool-details"
                      aria-label="批量任务错误"
                    >
                      <p>任务未完成：{project.source_batch_job_error}</p>
                      <button
                        disabled={working || hasInvalidFields}
                        onClick={() => void generateAllSources()}
                      >
                        重新校验并生成
                      </button>
                    </section>
                  )}
                  {Boolean(project.current_generation_error) && (
                    <section
                      className="data-tool-details"
                      aria-label="当前路线生成错误"
                    >
                      <p>
                        当前路线生成失败：
                        {String(project.current_generation_error)}
                      </p>
                      <p>
                        失败不会覆盖既有成果；重试使用当前编辑路线和横断面，请确认当前路线与问题路线一致。
                      </p>
                      <button
                        disabled={working}
                        onClick={() => {
                          setPanel("road");
                          fitProject(mapRef.current, projectRef.current);
                        }}
                      >
                        定位并修改当前路线
                      </button>
                      <button
                        disabled={Boolean(generationDisabledReason)}
                        onClick={() => void generate()}
                      >
                        重试当前路线
                      </button>
                    </section>
                  )}
                  {Boolean(
                    (project.source_fields as Field[] | undefined)?.length,
                  ) && (
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
                  )}
                </>
              }
            />
          )}
          {panel === "road" &&
            !surfaceSelection &&
            (savedSurfaceTargets.length > 0 ||
              project.surface_original_section ||
              (
                project.surface_component_exclusions as
                  | ComponentSelector[]
                  | undefined
              )?.length) && (
              <details className="section-block">
                <summary>已保存的路面编辑 · 可恢复被删除的成果</summary>
                <div
                  style={{
                    maxHeight: 180,
                    overflowY: "auto",
                    display: "grid",
                    gap: 6,
                    marginTop: 8,
                  }}
                >
                  {savedSurfaceTargets.map((target) => (
                    <button
                      key={`${target.dataset_id}/${target.feature_key}/${target.part_index}`}
                      className="button outline"
                      onClick={() => {
                        setSurfaceSelection(target);
                        setToolMode("surface");
                      }}
                    >
                      {target.label} · 部件 {target.part_index + 1}
                    </button>
                  ))}
                  {!project.active_source_ref &&
                    (Boolean(project.surface_original_section) ||
                      Boolean(
                        (
                          project.surface_component_exclusions as
                            | ComponentSelector[]
                            | undefined
                        )?.length,
                      )) && (
                      <button
                        className="button outline"
                        onClick={() => {
                          setSurfaceSelection({
                            part_index: 0,
                            selector: { part_index: 0 },
                            label: project.route_id,
                            componentLabel: "已保存的路段编辑",
                          });
                          setToolMode("surface");
                        }}
                      >
                        当前手动路线
                      </button>
                    )}
                </div>
              </details>
            )}
          {panel === "road" &&
            (surfaceSelection ? (
              <GeneratedSurfaceEditor
                key={`${surfaceSelection.dataset_id ?? "manual"}/${surfaceSelection.feature_key ?? ""}/${surfaceSelection.part_index}`}
                selection={{
                  label: surfaceSelection.label,
                  componentLabel: surfaceSelection.componentLabel,
                  partIndex: surfaceSelection.part_index,
                  scopeLabel: surfaceSelection.dataset_id
                    ? "所选来源记录的当前线部件"
                    : "当前手动路线",
                }}
                section={surfaceSection}
                busy={working}
                onApply={applySurfaceSection}
                onDeleteComponent={() =>
                  surfaceSelection.selector.component
                    ? setSurfaceDelete("component")
                    : setStatus(
                        "请先在地图点击具体的车道、路肩等组成；当前为路段级编辑。",
                        "warn",
                      )
                }
                onDeletePart={() => setSurfaceDelete("part")}
                onReset={() => void applySurfaceSection(surfaceSection, true)}
                onClose={() => {
                  setSurfaceSelection(null);
                  setToolMode("pan");
                }}
              />
            ) : (
              <RoadPanel
                project={project}
                update={update}
                status={status}
                roadLabel={roadLabel}
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
            ))}
          {panel === "facility" && (
            <>
              <FacilityDisplaySettings
                value={facilityDisplayScale}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    facility_display_scale: value,
                  }))
                }
              />
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
                categories={[
                  ...new Set(catalog.map((entry) => entry.category)),
                ]}
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
            </>
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
              fresh={Boolean(layers.length && !stale)}
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
                title="选择与平移（P）"
                aria-label="选择与平移"
                aria-pressed={tool === "pan"}
              >
                <MousePointer2 size={17} />
              </button>
              <button
                className={tool === "route" ? "selected" : ""}
                onClick={() => setToolMode("route")}
                title="绘制路线"
                aria-label="绘制路线"
                aria-pressed={tool === "route"}
              >
                <PenLine size={17} />
              </button>
              <button
                className={tool === "surface" ? "selected" : ""}
                onClick={() => {
                  setToolMode("surface");
                  setStatus("点击已生成的路面，进入宽度和成果删除编辑。");
                }}
                title="编辑路面成果：调整宽度、删除组成"
                aria-label="编辑路面成果"
                aria-pressed={tool === "surface"}
                disabled={
                  !layers.some((layer) =>
                    layer.collection.features.some((feature) =>
                      ["Polygon", "MultiPolygon"].includes(
                        feature.geometry?.type,
                      ),
                    ),
                  )
                }
              >
                <Pencil size={17} />
              </button>
              <button
                className={tool === "vertex" ? "selected" : ""}
                onClick={() => setToolMode("vertex")}
                title="编辑参考线顶点：单击选择，拖动调整，Delete 删除"
                aria-label="编辑路线顶点"
                aria-pressed={tool === "vertex"}
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
                      update((current) => ({
                        ...current,
                        active_source_ref: undefined,
                        route_points: [],
                      }));
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
                        <br />左 {project.section.left_lanes.length} 车道 · 右{" "}
                        {project.section.right_lanes.length} 车道（按路线正向）
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
                  {layerVisible.generated && layers.length > 0 && (
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
              <MapCoordinateReadout
                mapRef={mapRef}
                crs={project.crs}
                mode={coordinateMode}
              />
            </div>
            <div
              className="map-status"
              title={status.text}
              role="status"
              aria-live="polite"
            >
              {displayPreparing && <span>正在准备地图显示 · </span>}
              <span className={`status-dot ${status.tone ?? ""}`} />
              <span className="status-message">{status.text}</span>
              <span className="active-tool">
                {tool === "route"
                  ? "绘制路线"
                  : tool === "vertex"
                    ? "编辑参考线"
                    : tool === "surface"
                      ? "编辑路面"
                      : tool === "facility"
                        ? "布设设施"
                        : "选择 / 平移"}
              </span>
            </div>
          </div>
          <div className="generation-card">
            <div className="generation-icon">
              {working ? (
                <LoaderCircle size={18} className="is-spinning" />
              ) : roadState === "error" ? (
                <CircleAlert size={18} />
              ) : layers.length && !stale ? (
                <CircleCheck size={18} />
              ) : (
                <Activity size={18} />
              )}
            </div>
            <div className="generation-copy">
              <strong>{working ? "几何处理中" : "当前路线几何"}</strong>
              <span>
                {!isTauri()
                  ? "预览模式"
                  : ready
                    ? roadLabel
                    : "先准备参考线与横断面"}
              </span>
              {working && batchProgress && (
                <div className="generation-progress" aria-label="道路生成进度">
                  <progress
                    max={Math.max(batchProgress.total, 1)}
                    value={batchProgress.completed}
                  />
                  <span>
                    {batchProgress.completed} / {batchProgress.total} 个线部件
                  </span>
                </div>
              )}
            </div>
            {working ? (
              <button
                className="button outline"
                onClick={cancelGenerate}
                title="停止生成；迟到结果不会写入工程"
              >
                <X size={15} />
                停止
              </button>
            ) : (
              <button
                className="button outline"
                disabled={Boolean(generationDisabledReason)}
                onClick={() => void generate()}
                title={
                  generationDisabledReason ??
                  "生成当前编辑路线；整体生成请使用数据面板中的“生成全部参与路线”"
                }
              >
                <Activity size={15} />
                {roadState === "error" ? "重试生成" : "生成道路"}
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
              <h2>
                {selected ? "所选设施" : ready ? "当前路线属性" : "工程属性"}
              </h2>
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
      {regenerateRequest && (
        <Modal
          title="保留人工修改并重新生成？"
          onCancel={() => setRegenerateRequest(null)}
        >
          <p>
            影响范围：
            {regenerateRequest.kind === "current"
              ? `当前路线「${project.route_id}」`
              : "所有已加载并参与生成的路线"}
            。
          </p>
          <div className="inspector-context">
            已检测到人工断面或成果删除规则。本次生成保留这些规则；恢复原规则请在对应成果编辑器中操作。
          </div>
          <div className="dialog-actions">
            <button
              className="button outline"
              onClick={() => setRegenerateRequest(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              onClick={() => {
                const request = regenerateRequest;
                setRegenerateRequest(null);
                if (request.kind === "current") void generate(true);
                else void generateAllSources(request.retryTargets, true);
              }}
            >
              保留人工修改并生成
            </button>
          </div>
        </Modal>
      )}
      {exportOpen && (
        <Modal title="导出成果" onCancel={() => setExportOpen(false)}>
          <p>选择成果格式，确认文件位置后导出。</p>
          <div className="export-format-list">
            <button
              className="button outline full"
              onClick={() => {
                setExportOpen(false);
                void exportGeoPackage();
              }}
            >
              <Database size={20} />
              <span>
                <strong>GeoPackage</strong>
                <small>保留工程坐标系 · {project.crs}</small>
              </span>
              <Download size={18} />
            </button>
            <button
              className="button outline full"
              onClick={() => {
                setExportOpen(false);
                void exportGeoJSON();
              }}
            >
              <FileJson size={20} />
              <span>
                <strong>GeoJSON</strong>
                <small>转换为 WGS84 地理坐标</small>
              </span>
              <Download size={18} />
            </button>
          </div>
          <div className="dialog-actions">
            <button
              className="button outline"
              onClick={() => setExportOpen(false)}
            >
              取消
            </button>
          </div>
        </Modal>
      )}
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
          title={
            routeChoices.loadPage
              ? "选择路线"
              : `选择路线 · ${routeChoices.features.length} 条`
          }
          onCancel={() => setRouteChoices(null)}
        >
          <RouteFeatureSelector
            key={routeChoices.revision}
            features={routeChoices.features}
            fields={routeChoices.fields}
            capabilities={routeChoices.capabilities}
            sourceLabel={routeChoices.label}
            loadPage={routeChoices.loadPage}
            pageInfo={routeChoices.pageInfo}
            onCancel={() => setRouteChoices(null)}
            onReadBatch={async (features, final) => {
              if (bulkReadRef.current.revision !== routeChoices.revision)
                bulkReadRef.current = {
                  revision: routeChoices.revision,
                  started: false,
                };
              if (features.length) {
                if (
                  !loadSelectedRoutes(
                    features,
                    routeChoices.label,
                    routeChoices.fields,
                    routeChoices.binding,
                    {
                      streaming: true,
                      recordHistory: !bulkReadRef.current.started,
                    },
                  )
                )
                  throw new Error("追加路线失败，已停止继续加载");
                bulkReadRef.current.started = true;
              }
              if (final) {
                const dataset = (
                  (projectRef.current.vector_basemaps as any[]) ?? []
                ).find(
                  (layer) =>
                    layer.kind === "route-source" &&
                    (routeChoices.binding?.fingerprint
                      ? layer.binding?.fingerprint ===
                        routeChoices.binding.fingerprint
                      : layer.source_label === routeChoices.label),
                );
                if (dataset?.collection?.features.length) {
                  const { bounds } = routeSourceCollection(
                    dataset.collection.features,
                  );
                  fitBounds(mapRef.current, bounds);
                }
                setRouteChoices(null);
                setToolMode("pan");
                setStatus(
                  `所选路线已追加到地图，当前来源 ${dataset?.collection?.features.length ?? 0} 条记录；可整体生成。`,
                  "ok",
                );
                bulkReadRef.current.started = false;
              }
            }}
            onRead={(features) => {
              const loaded = loadSelectedRoutes(
                features,
                routeChoices.label,
                routeChoices.fields,
                routeChoices.binding,
              );
              if (loaded && features.length === 1) {
                void selectSourceFeature(
                  features[0],
                  routeChoices.label,
                  routeChoices.binding,
                  routeChoices.fields,
                );
                return;
              }
            }}
          />
        </Modal>
      )}
      {mappingDataset && (
        <Modal
          title={`来源字段映射 · ${mappingDataset.label}`}
          onCancel={() => setMappingDatasetId(null)}
        >
          <p>
            此规则适用于该来源的全部参与记录；生成时使用每条记录自身的属性。人工修改的记录优先使用其单独覆盖。
          </p>
          <FieldMappingTools
            fields={mappingDataset.fields}
            attributes={mappingDataset.collection.features[0]?.properties ?? {}}
            value={
              mappingDataset.mapping ?? mappingDataset.binding?.mapping ?? {}
            }
            context={mappingDataset.source_label}
            onChange={(mapping) =>
              configureSourceMapping(mappingDataset.id, mapping)
            }
            onSaveRule={
              mappingDataset.binding
                ? () => {
                    try {
                      saveBindingMapping(
                        mappingDataset.binding!,
                        mappingDataset.mapping ?? {},
                      );
                      setStatus("已保存整图层映射规则。", "ok");
                    } catch (error) {
                      setStatus(errorMessage(error), "error");
                    }
                  }
                : undefined
            }
          />
          <div className="dialog-actions">
            <button
              className="button primary"
              onClick={() => setMappingDatasetId(null)}
            >
              完成
            </button>
          </div>
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
      {surfaceDelete && surfaceSelection && (
        <Modal
          title={
            surfaceDelete === "part" ? "删除此路段成果？" : "删除选中组成？"
          }
          onCancel={() => setSurfaceDelete(null)}
        >
          <p>
            {surfaceSelection.label} · 部件 {surfaceSelection.part_index + 1}
            {surfaceDelete === "component"
              ? ` · ${surfaceSelection.componentLabel}`
              : " · 全部成果组成"}
          </p>
          <p>
            仅删除对应成果，不删除来源路线和属性。规则会随工程保存并作用于后续生成与导出；可撤销或在编辑面板恢复。
          </p>
          <div className="dialog-actions">
            <button
              className="button outline"
              onClick={() => setSurfaceDelete(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={working}
              onClick={() => deleteSurface(surfaceDelete)}
            >
              确认删除
            </button>
          </div>
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
  importRaster,
  onFieldMap,
  onNullFallback,
  mappingField,
  extras,
  primarySource,
}: {
  project: RoadProject;
  status: Status;
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
          <h3>影像与人工输入</h3>
          <span className="count-tag">{project.crs}</span>
        </div>

        <div className="data-secondary-actions">
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
  roadLabel,
}: {
  project: RoadProject;
  update: (fn: (current: RoadProject) => RoadProject) => void;
  busy: boolean;
  onApplyAuto: (options: Record<string, unknown>) => void;
  onClearAuto: () => void;
  roadLabel: string;
  [key: string]: unknown;
}) {
  const [roadTab, setRoadTab] = useState<"section" | "display" | "along">(
    "section",
  );
  const { hasInvalidFields } = useEditorValidation();
  const issue = sectionFormIssue(project.section);
  return (
    <div className="panel-content road-panel">
      <div className="workbench-context">
        <Baseline size={18} />
        <div>
          <strong title={project.route_id}>
            {project.route_id || "未命名路线"}
          </strong>
          <small>当前路线 · 左右按参考线正向定义</small>
        </div>
      </div>
      {(hasInvalidFields ||
        issue ||
        roadLabel === "成果待更新" ||
        roadLabel === "生成失败") && (
        <div
          className="generation-warning"
          data-tone={
            hasInvalidFields || issue || roadLabel === "生成失败"
              ? "error"
              : "warn"
          }
          role="status"
        >
          {hasInvalidFields
            ? "请修正标记的数值，再生成道路。"
            : (issue ??
              (roadLabel === "生成失败"
                ? "生成失败，可修正参数后重试；既有成果保留。"
                : "参数已修改 · 成果待更新"))}
        </div>
      )}
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
            tabIndex={roadTab === id ? 0 : -1}
            aria-controls={`road-page-${id}`}
            onClick={() => setRoadTab(id)}
            onKeyDown={(event) => {
              if (isImeComposing(event.nativeEvent)) return;
              const tabs = ["section", "display", "along"] as const;
              const index = tabs.indexOf(id);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : event.key === "ArrowRight"
                      ? (index + 1) % 3
                      : event.key === "ArrowLeft"
                        ? (index + 2) % 3
                        : null;
              if (next === null) return;
              event.preventDefault();
              setRoadTab(tabs[next]);
              (
                event.currentTarget.parentElement?.querySelectorAll("button")[
                  next
                ] as HTMLButtonElement
              )?.focus();
            }}
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
      {project.route_points.length > 1 && (
        <div className="inspector-context">
          <Baseline size={18} />
          <span>
            当前路线：{project.route_id || "未命名路线"}
            。属性修改仅作用于当前路线。
          </span>
        </div>
      )}
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
        <div className="inspector-field">
          <span>车道配置（按路线正向）</span>
          <strong>
            左 {project.section.left_lanes.length} · 右{" "}
            {project.section.right_lanes.length} · 共{" "}
            {project.section.left_lanes.length +
              project.section.right_lanes.length}{" "}
            车道
          </strong>
          <small>来自逐记录映射或人工横断面，不由总宽度推断。</small>
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
  const first = transformPosition(
    project.route_points[0],
    project.crs,
    "EPSG:4326",
  );
  if (project.route_points.length === 1) {
    map.easeTo({ center: first, zoom: Math.max(14, map.getZoom()) });
    return;
  }
  const bounds = new maplibregl.LngLatBounds(first, first);
  for (const point of project.route_points)
    bounds.extend(transformPosition(point, project.crs, "EPSG:4326"));
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
function fitBounds(
  map: MapLibreMap | null,
  bounds: number[],
  maxZoom?: number,
) {
  if (!map || bounds.length !== 4 || !bounds.every(Number.isFinite)) return;
  map.fitBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    {
      padding: 80,
      duration: 500,
      ...(maxZoom === undefined ? {} : { maxZoom }),
    },
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
  displayCrsDefinitions[crs] = definition;
}
function reprojectProject(
  project: RoadProject,
  targetCrs: string,
): RoadProject {
  if (project.crs === targetCrs) return project;
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
        if (isImeComposing(e.nativeEvent)) return;
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
        if (isImeComposing(event.nativeEvent)) return;
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
          if (isImeComposing(event.nativeEvent)) return;
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
