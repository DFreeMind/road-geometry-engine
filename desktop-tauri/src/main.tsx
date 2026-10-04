import React from "react";
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")!);
const isGenerationIssuesWindow =
  new URLSearchParams(window.location.search).get("window") ===
  "generation-issues";

if (isGenerationIssuesWindow) {
  void import("./workbench/GenerationIssuesWindow").then(
    ({ GenerationIssuesWindow }) => {
      root.render(
        <React.StrictMode>
          <GenerationIssuesWindow />
        </React.StrictMode>,
      );
    },
  );
} else {
  void Promise.all([
    import("maplibre-gl/dist/maplibre-gl.css"),
    import("./styles.css"),
    import("./workbench/App"),
  ]).then(([, , { App }]) => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
}
