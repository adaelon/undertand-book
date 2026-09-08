// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import TopBar from './TopBar.vue';

it('keeps desktop settings separate from browser build capabilities', async () => {
  for (const [desktopHost, readerOnly] of [[true, false], [false, false], [false, true]]) {
    const wrapper = mount(TopBar, { props: {
      chapterTitle: 'Book', progressPct: 10, anchorLid: null, debugOpen: false,
      leftRailOpen: true, buildIntentOpen: false, desktopHost,
      buildIntentAvailable: !readerOnly, workbenchAvailable: !readerOnly,
    } });
    expect(wrapper.find('[aria-label="打开桌面设置"]').exists()).toBe(desktopHost);
    expect(wrapper.find('[aria-label="打开构建方案"]').exists()).toBe(!readerOnly);
    expect(wrapper.text().includes('高级构建')).toBe(!readerOnly);
    const openBook = wrapper.findAll('button').find(button => button.text() === '打开书')!;
    await openBook.trigger('click');
    expect(wrapper.emitted('open-book')).toHaveLength(1);
    wrapper.unmount();
  }
});
