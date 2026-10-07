import {
  ArrowRight,
  Clock3,
  FilePlus2,
  FolderOpen,
  MapPinned,
  PencilRuler,
  Route,
} from "lucide-react";
import "./StartPage.css";

export type RecentProject = {
  path: string;
  name: string;
};

export type StartPageProps = {
  onImportRoute: () => void;
  onOpenProject: () => void;
  onDrawRoute: () => void;
  onOpenExamples: () => void;
  recentProjects?: RecentProject[];
  onOpenRecent?: (path: string) => void;
};

export function StartPage({
  onImportRoute,
  onOpenProject,
  onDrawRoute,
  onOpenExamples,
  recentProjects = [],
  onOpenRecent,
}: StartPageProps) {
  return (
    <section className="start-page" data-testid="workbench-start-page">
      <div className="start-page__content">
        <div className="start-page__eyebrow">
          <span className="start-page__mark" aria-hidden="true">
            <Route size={17} strokeWidth={2.2} />
          </span>
          <span>道路几何工作台</span>
        </div>

        <header className="start-page__intro">
          <h1>开始道路工程</h1>
          <p>
            导入路线数据，或在地图上绘制参考线，开始构建可编辑、可查询的道路几何成果。
          </p>
        </header>

        <div className="start-page__actions" aria-label="开始方式">
          <button
            className="start-page__action start-page__action--primary"
            type="button"
            onClick={onImportRoute}
            aria-label="导入路线"
          >
            <span className="start-page__action-icon">
              <FilePlus2 size={19} />
            </span>
            <span className="start-page__action-copy">
              <strong>导入路线</strong>
              <span>从本地数据创建工程</span>
            </span>
            <ArrowRight className="start-page__action-arrow" size={16} />
          </button>

          <button
            className="start-page__action"
            type="button"
            onClick={onOpenProject}
            aria-label="打开工程"
          >
            <span className="start-page__action-icon">
              <FolderOpen size={19} />
            </span>
            <span className="start-page__action-copy">
              <strong>打开工程</strong>
              <span>继续已有道路项目</span>
            </span>
            <ArrowRight className="start-page__action-arrow" size={16} />
          </button>

          <button
            className="start-page__action"
            type="button"
            onClick={onDrawRoute}
            aria-label="绘制参考线"
          >
            <span className="start-page__action-icon">
              <PencilRuler size={19} />
            </span>
            <span className="start-page__action-copy">
              <strong>绘制参考线</strong>
              <span>从地图上的路线开始</span>
            </span>
            <ArrowRight className="start-page__action-arrow" size={16} />
          </button>
        </div>

        {recentProjects.length > 0 && onOpenRecent && (
          <section className="start-page__recent" aria-label="最近工程">
            <div className="start-page__section-title">
              <Clock3 size={15} aria-hidden="true" />
              <h2>最近工程</h2>
            </div>
            <div className="start-page__recent-list">
              {recentProjects.map((project) => (
                <button
                  className="start-page__recent-item"
                  key={project.path}
                  type="button"
                  onClick={() => onOpenRecent(project.path)}
                  aria-label={`打开最近工程：${project.name}`}
                  title={project.path}
                >
                  <span className="start-page__recent-icon" aria-hidden="true">
                    <MapPinned size={16} />
                  </span>
                  <span className="start-page__recent-copy">
                    <strong>{project.name}</strong>
                    <span>{project.path}</span>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        )}

        <button
          className="start-page__examples"
          type="button"
          onClick={onOpenExamples}
          aria-label="从真实道路示例开始"
        >
          <span>从真实道路示例开始</span>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
