// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import FileDropField from "./FileDropField.vue";

const baseProps = {
  modelValue: null,
  label: "Markdown",
  accept: ".md,text/markdown,text/plain",
  acceptLabel: ".md",
  kind: "markdown" as const,
};

describe("FileDropField", () => {
  it("emits a selected file and renders Lucide upload affordance", async () => {
    const wrapper = mount(FileDropField, { props: baseProps });
    const file = new File(["# Paper"], "paper.md", { type: "text/markdown" });
    const input = wrapper.get("input[type=file]");
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });

    await input.trigger("change");

    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([file]);
    expect(wrapper.find("svg").exists()).toBe(true);
  });

  it("rejects a dropped file outside the accepted format", async () => {
    const wrapper = mount(FileDropField, { props: baseProps });
    const file = new File(["bad"], "paper.exe", { type: "application/octet-stream" });

    await wrapper.trigger("drop", { dataTransfer: { files: [file] } });

    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.get("[role=alert]").text()).toContain("不是支持的 .md 文件");
  });

  it("clears a selected file from the icon action", async () => {
    const file = new File(["# Paper"], "paper.md", { type: "text/markdown" });
    const wrapper = mount(FileDropField, { props: { ...baseProps, modelValue: file } });

    await wrapper.get('button[aria-label="移除Markdown"]').trigger("click");

    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([null]);
  });
});
