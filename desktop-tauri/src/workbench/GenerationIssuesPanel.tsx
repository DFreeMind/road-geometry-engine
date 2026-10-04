import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  LocateFixed,
  Maximize2,
  Minus,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { createIssueSnapshot } from "./GenerationIssuesBridge";
import "./GenerationIssuesPanel.css";

export type GenerationIssueRow = {
  id: string;
  dataset_id: string;
  feature_key?: string;
  part_index?: number;
  stage: "validation" | "generation" | "review";
  message: string;
  code: string;
  sourceLabel: string;
  routeLabel: string;
};

type GenerationIssuesPanelProps = {
  rows: GenerationIssueRow[];
  working: boolean;
  onRetry: (rows: GenerationIssueRow[]) => void;
  onLocate: (row: GenerationIssueRow) => void;
  onEdit: (row: GenerationIssueRow) => void;
  onMapping: (row: GenerationIssueRow) => void;
  detached?: boolean;
};

type Point = { left: number; top: number };
type Size = { width: number; height: number };
type DragState = {
  pointerX: number;
  pointerY: number;
  left: number;
  top: number;
};
type ResizeState = {
  pointerX: number;
  pointerY: number;
  width: number;
  height: number;
};

const PAGE_SIZE = 20;
const VIEWPORT_GUTTER = 8;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 280;

function boundedPoint(point: Point, size: Size): Point {
  return {
    left: Math.max(
      VIEWPORT_GUTTER,
      Math.min(point.left, window.innerWidth - size.width - VIEWPORT_GUTTER),
    ),
    top: Math.max(
      VIEWPORT_GUTTER,
      Math.min(point.top, window.innerHeight - size.height - VIEWPORT_GUTTER),
    ),
  };
}

function issueHint(row: GenerationIssueRow): string | undefined {
  const message = row.message.toLocaleLowerCase();
  const code = row.code.toLocaleLowerCase();
  if (
    /duplicate|repeated|重复/.test(`${code} ${message}`) &&
    /point|vertex|节点|控制点|坐标/.test(`${code} ${message}`)
  ) {
    return "路线中可能存在重复控制点或零长度线段。检查并合并重复点后重新生成。";
  }
  if (
    /self.?intersect|self.?intersection|自相交|自交/.test(
      `${code} ${message}`,
    ) ||
    /offset/.test(code)
  ) {
    return "偏移线在急弯处可能发生自相交。检查路线转角、局部曲率与道路宽度，必要时拆分区间或修正路线。";
  }
  if (/width|宽度/.test(`${code} ${message}`)) {
    return "检查左右侧宽度、单位、字段映射及变宽区间；宽度需为有效的米制数值。";
  }
  if (code === "mapping_error") {
    return "检查来源字段映射、空值回退及横断面宽度。";
  }
  if (
    code === "invalid_coordinate" ||
    code === "unsupported_geometry" ||
    code === "invalid_part"
  ) {
    return "检查原始线几何与坐标系；无法编辑的几何需修正原始数据后重新导入。";
  }
  return "定位路线并检查控制点、横断面属性及几何有效性，修正后重新生成。";
}

export function GenerationIssuesPanel({
  rows,
  working,
  onRetry,
  onLocate,
  onEdit,
  onMapping,
  detached = false,
}: GenerationIssuesPanelProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(detached);
  const [minimized, setMinimized] = useState(false);
  const [point, setPoint] = useState<Point | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const filteredRows = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) =>
      [
        row.message,
        row.code,
        row.sourceLabel,
        row.routeLabel,
        row.feature_key ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(keyword)),
    );
  }, [query, rows]);
  const retryableRows = useMemo(
    () => rows.filter((row) => row.stage !== "review"),
    [rows],
  );
  const reviewCount = rows.length - retryableRows.length;
  const pageCount = Math.ceil(filteredRows.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const visibleRows = filteredRows.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  function openIssues() {
    if (!detached && isTauri()) {
      void invoke("open_generation_issues_window", {
        snapshot: createIssueSnapshot(rows, working),
      }).catch((error) => {
        console.error("打开生成问题窗口失败", error);
      });
      return;
    }
    if (open && minimized) {
      setMinimized(false);
      requestAnimationFrame(() => searchRef.current?.focus());
      return;
    }
    if (open) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const nextSize = {
      width: Math.min(
        960,
        Math.max(
          Math.min(MIN_WIDTH, viewportWidth - 16),
          viewportWidth - 32 < 720 ? viewportWidth - 16 : 780,
        ),
      ),
      height: Math.min(
        760,
        Math.max(
          Math.min(MIN_HEIGHT, viewportHeight - 16),
          viewportHeight - 32 < 520 ? viewportHeight - 16 : 620,
        ),
      ),
    };
    setSize(nextSize);
    setPoint(
      boundedPoint(
        {
          left: Math.max(VIEWPORT_GUTTER, (viewportWidth - nextSize.width) / 2),
          top: Math.max(
            VIEWPORT_GUTTER,
            (viewportHeight - nextSize.height) / 2,
          ),
        },
        nextSize,
      ),
    );
    setMinimized(false);
    setOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  function closeWindow() {
    if (detached && isTauri()) {
      void invoke("close_generation_issues_window");
      return;
    }
    setOpen(false);
    setMinimized(false);
    requestAnimationFrame(() => summaryRef.current?.focus());
  }

  function startDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (detached && isTauri()) {
      event.preventDefault();
      void invoke("start_dragging_generation_issues_window");
      return;
    }
    if (!point || !size) return;
    event.preventDefault();
    setDrag({ pointerX: event.clientX, pointerY: event.clientY, ...point });
  }

  function startResizing(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !point || !size) return;
    event.preventDefault();
    event.stopPropagation();
    setResize({
      pointerX: event.clientX,
      pointerY: event.clientY,
      ...size,
    });
  }

  function handleWindowKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeWindow();
    }
  }

  function handleDragKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!event.altKey || !point || !size) return;
    const step = event.shiftKey ? 40 : 12;
    const delta = {
      ArrowLeft: { left: -step, top: 0 },
      ArrowRight: { left: step, top: 0 },
      ArrowUp: { left: 0, top: -step },
      ArrowDown: { left: 0, top: step },
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    setPoint(
      boundedPoint(
        { left: point.left + delta.left, top: point.top + delta.top },
        size,
      ),
    );
  }

  useEffect(() => {
    if (!detached) return;
    setPoint({ left: 0, top: 0 });
    setSize({ width: window.innerWidth, height: window.innerHeight });
    setOpen(true);
  }, [detached]);

  useEffect(() => {
    if (!drag) return;
    const activeDrag = drag;
    function move(event: PointerEvent) {
      setPoint(
        boundedPoint(
          {
            left: activeDrag.left + event.clientX - activeDrag.pointerX,
            top: activeDrag.top + event.clientY - activeDrag.pointerY,
          },
          size ?? { width: 0, height: 0 },
        ),
      );
    }
    function finish() {
      setDrag(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
  }, [drag, size]);

  useEffect(() => {
    if (!resize) return;
    const activeResize = resize;
    function move(event: PointerEvent) {
      const maxWidth = window.innerWidth - point!.left - VIEWPORT_GUTTER;
      const maxHeight = window.innerHeight - point!.top - VIEWPORT_GUTTER;
      setSize({
        width: Math.max(
          Math.min(MIN_WIDTH, maxWidth),
          Math.min(
            maxWidth,
            activeResize.width + event.clientX - activeResize.pointerX,
          ),
        ),
        height: Math.max(
          Math.min(MIN_HEIGHT, maxHeight),
          Math.min(
            maxHeight,
            activeResize.height + event.clientY - activeResize.pointerY,
          ),
        ),
      });
    }
    function finish() {
      setResize(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
  }, [point, resize]);

  useEffect(() => {
    function constrainToViewport() {
      if (!point || !size) return;
      const nextSize = {
        width: Math.max(
          Math.min(MIN_WIDTH, window.innerWidth - 16),
          Math.min(size.width, window.innerWidth - 16),
        ),
        height: Math.max(
          Math.min(MIN_HEIGHT, window.innerHeight - 16),
          Math.min(size.height, window.innerHeight - 16),
        ),
      };
      setSize(nextSize);
      setPoint(boundedPoint(point, nextSize));
    }
    window.addEventListener("resize", constrainToViewport);
    return () => window.removeEventListener("resize", constrainToViewport);
  }, [point, size]);

  useEffect(() => {
    if (!open || minimized) return;
    dragHandleRef.current?.focus();
  }, [open, minimized]);

  function locateIssue(row: GenerationIssueRow) {
    onLocate(row);
  }

  const windowContent = open && point && size && (
    <div
      className={`generation-issues-window${minimized ? " is-minimized" : ""}${detached ? " is-detached" : ""}`}
      style={
        detached
          ? undefined
          : minimized
            ? { left: point.left, top: point.top, width: 300 }
            : {
                left: point.left,
                top: point.top,
                width: size.width,
                height: size.height,
              }
      }
      role="dialog"
      aria-labelledby="generation-issues-window-title"
      onKeyDown={handleWindowKeyDown}
    >
      <header className="generation-issues-window__titlebar">
        <div
          ref={dragHandleRef}
          className="generation-issues-window__drag-handle"
          role="group"
          tabIndex={0}
          aria-label="生成问题窗口标题栏。按住拖动，或按 Alt 加方向键移动；Shift 加方向键可快速移动。"
          onPointerDown={startDragging}
          onKeyDown={handleDragKeyDown}
        >
          <span className="generation-issues-window__mark" aria-hidden="true">
            <AlertTriangle size={15} />
          </span>
          <span id="generation-issues-window-title">生成问题</span>
          <span className="generation-issues-window__count">{rows.length}</span>
        </div>
        <div className="generation-issues-window__window-actions">
          {minimized ? (
            <button
              ref={restoreRef}
              type="button"
              aria-label="还原生成问题窗口"
              title="还原窗口"
              onClick={() => setMinimized(false)}
            >
              <Maximize2 size={14} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="最小化生成问题窗口"
              title="最小化"
              onClick={() => {
                if (detached && isTauri()) {
                  void invoke("minimize_generation_issues_window");
                } else {
                  setMinimized(true);
                }
              }}
            >
              <Minus size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            aria-label="关闭生成问题窗口"
            title="关闭"
            onClick={closeWindow}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {!minimized && (
        <div className="generation-issues-window__body">
          <div className="generation-issues-window__toolbar">
            <label className="generation-issues-window__search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder="搜索原因、来源或路线"
                aria-label="搜索完整原因、来源或路线"
              />
              <span>{filteredRows.length} 条</span>
            </label>
            <button
              type="button"
              className="generation-issues-window__retry-all"
              disabled={working || retryableRows.length === 0}
              onClick={() => onRetry(retryableRows)}
              aria-label={`重试全部失败项，共 ${retryableRows.length} 条`}
            >
              <RefreshCw size={14} aria-hidden="true" />
              重试全部
            </button>
          </div>
          {rows.length > 0 && (
            <p className="generation-issues-window__workflow">
              成功成果会保留；修正后重试会重新校验，未处理的问题不会自动删除。
            </p>
          )}

          <div className="generation-issues-window__results">
            {rows.length === 0 ? (
              <div className="generation-issues__empty" role="status">
                <strong>暂无生成问题</strong>
                <span>校验或生成失败的路线会显示在这里。</span>
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="generation-issues__empty" role="status">
                <strong>没有匹配的问题</strong>
                <span>试试其他原因、来源名称或路线名称。</span>
              </div>
            ) : (
              <ol className="generation-issues__list" aria-label="问题记录">
                {visibleRows.map((row) => {
                  const expanded = expandedId === row.id;
                  return (
                    <li className="generation-issue" key={row.id}>
                      <div className="generation-issue__main">
                        <div className="generation-issue__identity">
                          <strong title={row.sourceLabel}>
                            {row.sourceLabel}
                          </strong>
                          <span
                            className="generation-issue__route"
                            title={row.routeLabel}
                          >
                            {row.routeLabel}
                          </span>
                          <span className="generation-issue__part">
                            {row.part_index === undefined
                              ? "整体"
                              : `部件 ${row.part_index + 1}`}
                          </span>
                        </div>
                        <span
                          className={`generation-issue__stage is-${row.stage}`}
                        >
                          {row.stage === "review"
                            ? "需复核"
                            : row.stage === "validation"
                              ? "校验失败"
                              : "生成失败"}
                        </span>
                        <code
                          className="generation-issue__code"
                          title={row.code}
                        >
                          {row.code}
                        </code>
                        <span
                          className="generation-issue__preview"
                          title={row.message}
                        >
                          {row.message}
                        </span>
                        <div
                          className="generation-issue__actions"
                          aria-label="问题操作"
                        >
                          <button
                            type="button"
                            onClick={() => locateIssue(row)}
                            aria-label={`定位：${row.sourceLabel}，${row.routeLabel}`}
                          >
                            <LocateFixed size={14} aria-hidden="true" />
                            定位
                          </button>
                          <button
                            type="button"
                            disabled={working}
                            onClick={() => onEdit(row)}
                            aria-label={`修改：${row.sourceLabel}，${row.routeLabel}`}
                          >
                            <Pencil size={14} aria-hidden="true" />
                            修改
                          </button>
                          <button
                            type="button"
                            disabled={working}
                            onClick={() => onMapping(row)}
                            aria-label={`字段映射：${row.sourceLabel}，${row.routeLabel}`}
                          >
                            <Settings2 size={14} aria-hidden="true" />
                            映射
                          </button>
                          <button
                            type="button"
                            className="is-retry"
                            disabled={working || row.stage === "review"}
                            onClick={() => onRetry([row])}
                            aria-label={`重试：${row.sourceLabel}，${row.routeLabel}`}
                          >
                            <RefreshCw size={14} aria-hidden="true" />
                            重试
                          </button>
                        </div>
                        <button
                          type="button"
                          className="generation-issue__detail-toggle"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedId(expanded ? null : row.id)
                          }
                        >
                          {expanded ? "收起详情" : "详情"}
                        </button>
                      </div>
                      {expanded && (
                        <div className="generation-issue__details">
                          {row.feature_key && (
                            <p>
                              <strong>来源记录标识：</strong>
                              {row.feature_key}
                            </p>
                          )}
                          <p>
                            <strong>完整原因：</strong>
                          </p>
                          <pre>{row.message}</pre>
                          <p>
                            <strong>常见处理建议：</strong>
                            {issueHint(row)}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {filteredRows.length > 0 && (
            <nav
              className="generation-issues-window__pagination"
              aria-label="问题列表分页"
            >
              <span aria-live="polite">
                显示 {currentPage * PAGE_SIZE + 1}–
                {Math.min((currentPage + 1) * PAGE_SIZE, filteredRows.length)}{" "}
                条，共 {filteredRows.length} 条匹配
              </span>
              <div>
                <button
                  type="button"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                  aria-label="上一页"
                >
                  <ChevronLeft size={15} aria-hidden="true" />
                </button>
                <span aria-current="page">
                  {currentPage + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage(currentPage + 1)}
                  aria-label="下一页"
                >
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            </nav>
          )}
        </div>
      )}
      {!minimized && !detached && (
        <button
          type="button"
          className="generation-issues-window__resize-handle"
          aria-label="调整生成问题窗口大小；使用方向键调整"
          title="拖动调整窗口大小；使用方向键微调，Shift 加速"
          onPointerDown={startResizing}
          onKeyDown={(event) => {
            if (
              !size ||
              !point ||
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            const delta = event.shiftKey ? 40 : 12;
            const widthDelta =
              event.key === "ArrowRight"
                ? delta
                : event.key === "ArrowLeft"
                  ? -delta
                  : 0;
            const heightDelta =
              event.key === "ArrowDown"
                ? delta
                : event.key === "ArrowUp"
                  ? -delta
                  : 0;
            setSize({
              width: Math.max(
                Math.min(MIN_WIDTH, window.innerWidth - point.left - 8),
                Math.min(
                  window.innerWidth - point.left - 8,
                  size.width + widthDelta,
                ),
              ),
              height: Math.max(
                Math.min(MIN_HEIGHT, window.innerHeight - point.top - 8),
                Math.min(
                  window.innerHeight - point.top - 8,
                  size.height + heightDelta,
                ),
              ),
            });
          }}
        />
      )}
    </div>
  );

  return (
    <>
      {!detached && (
        <section className="generation-issues" aria-label="生成问题摘要">
          <button
            ref={summaryRef}
            type="button"
            className="generation-issues__summary"
            onClick={openIssues}
            aria-haspopup="dialog"
            aria-expanded={open && !minimized}
            aria-label={`查看生成问题，共 ${rows.length} 条`}
            aria-live="polite"
          >
            <span className="generation-issues__summary-label">
              <AlertTriangle size={14} aria-hidden="true" />
              {`查看生成问题（${rows.length}）`}
            </span>
            <span
              className={`generation-issues__summary-count${retryableRows.length ? " has-issues" : ""}`}
            >
              {retryableRows.length}
            </span>
            <span className="generation-issues__summary-breakdown">
              失败 {retryableRows.length} · 需复核 {reviewCount}
            </span>
          </button>
          <button
            type="button"
            className="generation-issues__retry-summary"
            disabled={working || retryableRows.length === 0}
            onClick={() => onRetry(retryableRows)}
            aria-label={`重试全部失败项，共 ${retryableRows.length} 条`}
          >
            <RefreshCw size={13} aria-hidden="true" />
            重试全部
          </button>
        </section>
      )}
      {detached ? windowContent : createPortal(windowContent, document.body)}
    </>
  );
}
