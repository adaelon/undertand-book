// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { expect, it, vi } from "vitest";
import { api } from "../api";
import AgentPresentation from "./AgentPresentation.vue";

it("keeps the live frame when a parent renders the same version reference again", async () => {
  const read = vi.spyOn(api, "presentationRead").mockResolvedValue({
    reference: { presentation_id: "p", revision: 1 }, title: "Experiment", entrypoint: "index.html",
    content_files: { "index.html": "<p>Experiment</p>" }, sources: [], assumptions: [], initial_state: {},
    restored_state: null, restored_state_revision: null, readable_view: { parts: [], sources: [] },
  });
  const wrapper = mount(AgentPresentation, { props: { sessionId: "s", turnId: "t", reference: { presentation_id: "p", revision: 1 } } });
  try {
    await flushPromises();
    const original = wrapper.find("iframe").element;
    await wrapper.setProps({ busy: true, reference: { presentation_id: "p", revision: 1 } });
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(1);
    expect(wrapper.find("iframe").element).toBe(original);
    await wrapper.find("iframe").trigger("load");
    for (let index = 0; index < 10; index += 1) {
      await wrapper.get("header button").trigger("click");
    }
    expect(wrapper.find("iframe").element).toBe(original);
    expect(wrapper.find("iframe").attributes("data-load-count")).toBe("1");
    await wrapper.setProps({ reference: { presentation_id: "p", revision: 2 } });
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(2);
  } finally { wrapper.unmount(); read.mockRestore(); }
});
