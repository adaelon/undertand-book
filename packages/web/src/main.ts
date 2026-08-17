import { createApp } from "vue";
import App from "./App.vue";
import "katex/dist/katex.min.css"; // agent 答案 LaTeX 公式样式
import "./style.css";
import { installReaderPerformanceDiagnostics } from "./reader-performance";

if (import.meta.env.DEV || import.meta.env.VITE_READER_PERF === "1") {
  installReaderPerformanceDiagnostics();
}

createApp(App).mount("#app");
