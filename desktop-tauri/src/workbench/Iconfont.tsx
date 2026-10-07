import type { CSSProperties, FC, HTMLAttributes } from "react";
import "./Iconfont.css";

export type IconfontProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "color" | "title"
> & {
  size?: number | string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  color?: string;
  title?: string;
};

/** 与 lucide-react 组件签名兼容，供既有菜单配置和组件 props 使用。 */
export type LucideIcon = FC<IconfontProps>;

type IconName =
  | "activity"
  | "alert-triangle"
  | "arrow-down-to-line"
  | "arrow-right"
  | "arrow-up-from-line"
  | "baseline"
  | "box"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "circle-alert"
  | "circle-check"
  | "circle-help"
  | "clock"
  | "cloud-off"
  | "columns"
  | "copy"
  | "database"
  | "download"
  | "file-json"
  | "file-plus"
  | "file-up"
  | "folder-open"
  | "image-plus"
  | "layers"
  | "loader"
  | "locate-fixed"
  | "map"
  | "map-pinned"
  | "maximize"
  | "minimize"
  | "minus"
  | "mouse-pointer"
  | "move-3d"
  | "pen-line"
  | "pencil"
  | "pencil-ruler"
  | "play"
  | "plus"
  | "redo"
  | "refresh"
  | "rotate-ccw"
  | "route"
  | "save"
  | "search"
  | "settings"
  | "trash"
  | "undo"
  | "upload"
  | "close"
  | "crosshair"
  | "panel-left-close"
  | "panel-left-open"
  | "nav-zoom-in"
  | "nav-zoom-out"
  | "nav-compass";

const SYMBOLS: Record<IconName, string> = {
  activity: "monitoring",
  "alert-triangle": "warning",
  "arrow-down-to-line": "download",
  "arrow-right": "arrow_forward",
  "arrow-up-from-line": "upload",
  baseline: "horizontal_rule",
  box: "check_box_outline_blank",
  check: "check",
  "chevron-down": "keyboard_arrow_down",
  "chevron-left": "keyboard_arrow_left",
  "chevron-right": "keyboard_arrow_right",
  "circle-alert": "error",
  "circle-check": "check_circle",
  "circle-help": "help",
  clock: "schedule",
  "cloud-off": "cloud_off",
  columns: "view_column",
  copy: "content_copy",
  database: "database",
  download: "download",
  "file-json": "data_object",
  "file-plus": "note_add",
  "file-up": "upload_file",
  "folder-open": "folder_open",
  "image-plus": "add_photo_alternate",
  layers: "layers",
  loader: "progress_activity",
  "locate-fixed": "my_location",
  map: "map",
  "map-pinned": "pin_drop",
  maximize: "open_in_full",
  minimize: "close_fullscreen",
  minus: "remove",
  "mouse-pointer": "near_me",
  "move-3d": "open_with",
  "pen-line": "edit_note",
  pencil: "edit",
  "pencil-ruler": "design_services",
  play: "play_arrow",
  plus: "add",
  redo: "redo",
  refresh: "refresh",
  "rotate-ccw": "rotate_left",
  route: "route",
  save: "save",
  search: "search",
  settings: "settings",
  trash: "delete",
  undo: "undo",
  upload: "upload",
  close: "close",
  crosshair: "center_focus_strong",
  "panel-left-close": "left_panel_close",
  "panel-left-open": "left_panel_open",
  "nav-zoom-in": "add",
  "nav-zoom-out": "remove",
  "nav-compass": "explore",
};

function Iconfont({
  name,
  size = 24,
  strokeWidth = 2,
  absoluteStrokeWidth: _absoluteStrokeWidth,
  color,
  className,
  style,
  title,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-hidden": ariaHidden,
  role,
  ...attributes
}: IconfontProps & { name: IconName }) {
  void _absoluteStrokeWidth;
  const hasAccessibleName = Boolean(title || ariaLabel || ariaLabelledBy);
  const weight = Math.min(700, Math.max(100, 400 + (strokeWidth - 2) * 120));
  const iconStyle: CSSProperties = {
    fontSize: size,
    color,
    "--app-icon-weight": weight,
    ...style,
  } as CSSProperties;

  return (
    <span
      {...attributes}
      className={className ? `app-icon ${className}` : "app-icon"}
      style={iconStyle}
      data-icon={name}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-hidden={ariaHidden ?? (hasAccessibleName ? undefined : true)}
      role={role ?? (hasAccessibleName ? "img" : undefined)}
      title={title}
    >
      {SYMBOLS[name]}
    </span>
  );
}

function defineIcon(name: IconName, displayName: string): LucideIcon {
  const Component: LucideIcon = (props) => <Iconfont {...props} name={name} />;
  Component.displayName = displayName;
  return Component;
}

export const Activity = defineIcon("activity", "Activity");
export const AlertTriangle = defineIcon("alert-triangle", "AlertTriangle");
export const ArrowDownToLine = defineIcon(
  "arrow-down-to-line",
  "ArrowDownToLine",
);
export const ArrowRight = defineIcon("arrow-right", "ArrowRight");
export const ArrowUpFromLine = defineIcon(
  "arrow-up-from-line",
  "ArrowUpFromLine",
);
export const Baseline = defineIcon("baseline", "Baseline");
export const Box = defineIcon("box", "Box");
export const Check = defineIcon("check", "Check");
export const ChevronDown = defineIcon("chevron-down", "ChevronDown");
export const ChevronLeft = defineIcon("chevron-left", "ChevronLeft");
export const ChevronRight = defineIcon("chevron-right", "ChevronRight");
export const CircleAlert = defineIcon("circle-alert", "CircleAlert");
export const CircleCheck = defineIcon("circle-check", "CircleCheck");
export const CircleHelp = defineIcon("circle-help", "CircleHelp");
export const Clock3 = defineIcon("clock", "Clock3");
export const CloudOff = defineIcon("cloud-off", "CloudOff");
export const Columns3 = defineIcon("columns", "Columns3");
export const Copy = defineIcon("copy", "Copy");
export const Database = defineIcon("database", "Database");
export const Download = defineIcon("download", "Download");
export const FileJson = defineIcon("file-json", "FileJson");
export const FilePlus2 = defineIcon("file-plus", "FilePlus2");
export const FileUp = defineIcon("file-up", "FileUp");
export const FolderOpen = defineIcon("folder-open", "FolderOpen");
export const ImagePlus = defineIcon("image-plus", "ImagePlus");
export const Layers3 = defineIcon("layers", "Layers3");
export const LoaderCircle = defineIcon("loader", "LoaderCircle");
export const LocateFixed = defineIcon("locate-fixed", "LocateFixed");
export const Map = defineIcon("map", "Map");
export const MapIcon = Map;
export const MapPinned = defineIcon("map-pinned", "MapPinned");
export const Maximize2 = defineIcon("maximize", "Maximize2");
export const Minimize2 = defineIcon("minimize", "Minimize2");
export const Minus = defineIcon("minus", "Minus");
export const MousePointer2 = defineIcon("mouse-pointer", "MousePointer2");
export const Move3D = defineIcon("move-3d", "Move3D");
export const PenLine = defineIcon("pen-line", "PenLine");
export const Pencil = defineIcon("pencil", "Pencil");
export const PencilRuler = defineIcon("pencil-ruler", "PencilRuler");
export const Play = defineIcon("play", "Play");
export const Plus = defineIcon("plus", "Plus");
export const Redo2 = defineIcon("redo", "Redo2");
export const RefreshCw = defineIcon("refresh", "RefreshCw");
export const RotateCcw = defineIcon("rotate-ccw", "RotateCcw");
export const Route = defineIcon("route", "Route");
export const Save = defineIcon("save", "Save");
export const Search = defineIcon("search", "Search");
export const Settings2 = defineIcon("settings", "Settings2");
export const Trash2 = defineIcon("trash", "Trash2");
export const Undo2 = defineIcon("undo", "Undo2");
export const Upload = defineIcon("upload", "Upload");
export const X = defineIcon("close", "X");
export const Crosshair = defineIcon("crosshair", "Crosshair");
export const PanelLeftClose = defineIcon("panel-left-close", "PanelLeftClose");
export const PanelLeftOpen = defineIcon("panel-left-open", "PanelLeftOpen");

/** 用于 MapLibre 内置导航按钮的本地字体字形，供CSS覆盖内置 SVG 背景。 */
export const MapLibreZoomIn = defineIcon("nav-zoom-in", "MapLibreZoomIn");
export const MapLibreZoomOut = defineIcon("nav-zoom-out", "MapLibreZoomOut");
export const MapLibreCompass = defineIcon("nav-compass", "MapLibreCompass");
