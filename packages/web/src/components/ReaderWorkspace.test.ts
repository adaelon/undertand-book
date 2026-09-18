// @vitest-environment happy-dom
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ReaderWorkspace from "./ReaderWorkspace.vue";

const logical = {
  contextKey: "book:chat",
  revision: 1n,
  activePreset: "technical_read",
  openSlots: ["technical.structure_map", "technical.agent"],
  focusedSlot: null,
};

const environment = (width: number, height: number) => ({
  containerWidth: width,
  containerHeight: height,
  visualWidth: width,
  visualHeight: height,
  offsetTop: 0,
  offsetLeft: 0,
  scale: 1,
});

describe("ReaderWorkspace", () => {
  it("switches single-region foreground without remounting core slots", async () => {
    const mounted = vi.fn();
    const Core = defineComponent({
      mounted,
      setup: () => () => h("div", { class: "core-instance" }, "core"),
    });
    const wrapper = mount(ReaderWorkspace, {
      props: { logical, environment: environment(390, 844) },
      slots: { default: () => [h(Core, { key: "reader" }), h(Core, { key: "assistant" })] },
    });
    expect(wrapper.attributes("data-mode")).toBe("single");
    expect(mounted).toHaveBeenCalledTimes(2);
    await wrapper.findAll(".workspace-mobile-nav button")[1].trigger("click");
    expect(wrapper.attributes("data-foreground")).toBe("assistant");
    expect(wrapper.emitted("tab-request")?.at(-1)).toEqual(["agent"]);
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it("opens global actions from the bottom navigation without adding a top row", async () => {
    const wrapper = mount(ReaderWorkspace, {
      props: { logical, environment: environment(390, 844), globalActionsOpen: false },
    });
    const menu = wrapper.get('.workspace-mobile-nav button[aria-haspopup="menu"]');
    expect(menu.text()).toBe("菜单");
    expect(menu.attributes("aria-expanded")).toBe("false");
    await menu.trigger("click");
    expect(wrapper.emitted("global-actions-request")).toHaveLength(1);
    await wrapper.setProps({ globalActionsOpen: true });
    expect(menu.attributes("aria-expanded")).toBe("true");
    expect(menu.classes()).toContain("active");
  });

  it("enters compare only after an explicit request at sufficient dimensions", async () => {
    const wrapper = mount(ReaderWorkspace, {
      props: { logical, environment: environment(844, 390) },
    });
    expect(wrapper.attributes("data-mode")).toBe("single");
    await wrapper.find(".workspace-mobile-top button:last-child").trigger("click");
    expect(wrapper.attributes("data-mode")).toBe("compare");
    await wrapper.setProps({ environment: environment(731, 390) });
    expect(wrapper.attributes("data-mode")).toBe("single");
  });

  it("keeps a logical focus request pending during a protected selection", async () => {
    const wrapper = mount(ReaderWorkspace, {
      props: {
        logical: { ...logical, revision: 2n, focusedSlot: "technical.agent" },
        selectionActive: true,
        environment: environment(390, 844),
      },
    });
    expect(wrapper.text()).toContain("当前编辑结束后显示请求区域");
    expect(wrapper.attributes("data-foreground")).toBe("reader");
    await wrapper.setProps({ selectionActive: false });
    expect(wrapper.attributes("data-foreground")).toBe("assistant");
  });

  it("offers the explicit answer return only while a return point exists", async () => {
    const wrapper = mount(ReaderWorkspace, {
      props: { logical, returnAvailable: true, environment: environment(390, 844) },
    });
    await wrapper.get(".workspace-return").trigger("click");
    expect(wrapper.emitted("return")).toHaveLength(1);
    await wrapper.setProps({ returnAvailable: false });
    expect(wrapper.find(".workspace-return").exists()).toBe(false);
  });

  it("supports a build-level rollback without creating a second slot tree", () => {
    const wrapper = mount(ReaderWorkspace, {
      props: { logical, enabled: false, environment: environment(390, 844) },
    });
    expect(wrapper.attributes("data-mode")).toBe("wide");
    expect(wrapper.attributes("data-mobile-workspace")).toBe("false");
    expect(wrapper.find(".workspace-mobile-nav").exists()).toBe(false);
  });

  it("offers an explicit Markdown/PDF choice without changing capability state", async () => {
    const wrapper = mount(ReaderWorkspace, {
      props: {
        logical,
        environment: environment(390, 844),
        readerSurface: "pdf",
        pdfSurfaceAvailable: true,
      },
    });
    const choices = wrapper.findAll(".workspace-reader-surface-switch button");
    expect(choices.map((choice) => choice.text())).toEqual(["Markdown", "PDF"]);
    expect(choices[1].attributes("aria-pressed")).toBe("true");
    await choices[0].trigger("click");
    expect(wrapper.emitted("reader-surface-request")?.at(-1)).toEqual(["markdown"]);
    await wrapper.setProps({ pdfSurfaceAvailable: false });
    expect(wrapper.find(".workspace-reader-surface-switch").exists()).toBe(false);
  });
});
