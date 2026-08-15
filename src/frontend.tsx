import { createRoot } from "react-dom/client";
import { App } from "./App";
import { captureAdHocHandoffFromLocation } from "@/lib/ad-hoc-handoff";

const elem = document.getElementById("root")!;
const initialAdHocHandoff = captureAdHocHandoffFromLocation(window.location, window.history);
const app = (
  <App
    initialAdHocHandoff={initialAdHocHandoff.handoff}
    initialAdHocHandoffAttempted={initialAdHocHandoff.attempted}
  />
);

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);

  import.meta.hot.accept("./App", (nextModule) => {
    root.render(<nextModule.App />);
  });
} else {
  // The hot module reloading API is not available in production.
  createRoot(elem).render(app);
}
