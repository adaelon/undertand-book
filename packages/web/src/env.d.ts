/// <reference types="vite/client" />

// .vue 单文件组件的 TS shim(vue-tsc 解析,tsc 兜底类型)。
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
