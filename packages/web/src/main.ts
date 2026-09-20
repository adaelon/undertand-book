import { createApp } from "vue";
import App from "./App.vue";
import { installAppViewportHeightFallback } from "./app-viewport-height";
import "katex/dist/katex.min.css"; // agent 答案 LaTeX 公式样式
import "./style.css";

const stopViewportHeightFallback = installAppViewportHeightFallback();
createApp(App).mount("#app");

if (import.meta.hot) import.meta.hot.dispose(stopViewportHeightFallback);
