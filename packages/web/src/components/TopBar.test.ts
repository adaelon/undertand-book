// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TopBar from "./TopBar.vue";

const props = {
  chapterTitle: "第一章",
  progressPct: 42,
  anchorLid: null,
  debugOpen: false,
  leftRailOpen: false,
  buildIntentOpen: false,
  buildIntentAvailable: false,
  workbenchAvailable: false,
  desktopHost: false,
  mobileCollapsible: true,
  mobileOpen: false,
};

describe("TopBar", () => {
  it("keeps mobile actions closed until requested and closes after an action", async () => {
    const wrapper = mount(TopBar, { props });
    expect(wrapper.get(".topbar").classes()).toContain("mobile-collapsible");
    expect(wrapper.get(".topbar").classes()).not.toContain("mobile-open");
    expect(wrapper.find(".topbar-mobile-backdrop").exists()).toBe(false);

    await wrapper.setProps({ mobileOpen: true });
    expect(wrapper.get(".topbar").classes()).toContain("mobile-open");
    expect(wrapper.find(".topbar-mobile-backdrop").exists()).toBe(true);
    await wrapper.get(".topbar-actions button:nth-of-type(2)").trigger("click");
    expect(wrapper.emitted("new-chat")).toHaveLength(1);
    expect(wrapper.emitted("close-mobile")).toHaveLength(1);
  });

  it("closes the mobile overlay from its backdrop", async () => {
    const wrapper = mount(TopBar, { props: { ...props, mobileOpen: true } });
    await wrapper.get(".topbar-mobile-backdrop").trigger("click");
    expect(wrapper.emitted("close-mobile")).toHaveLength(1);
  });
});
