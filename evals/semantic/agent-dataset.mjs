import { tasks, memoryTasks } from './dataset.mjs';

// Natural-answer protocol: gold fields are supplied only to the independent grader.
// Freeze before the main run. Original retrieval-ablation results remain unchanged.
export const version = 'quantification-essence-agent-v1';
export const answerInstruction = '请仅依据本书回答，并给出支持结论的原文来源。证据不足时明确说明，不要猜测。';
export const qaTasks = tasks.filter(t => t.category !== 'source').map(t => {
  if (t.id === 'refusal-01') return { ...t, question: '本文 AlphaGPT 训练实验使用的随机种子整数是多少？只能根据本书原文回答。' };
  if (t.id === 'refusal-03') return { ...t, question: '本文作者实际部署的金融时序数据库服务器 IP 地址是什么？只能根据本书原文回答。' };
  return t;
});
export const sourceTasks = tasks.filter(t => t.category === 'source');
export const restartTasks = memoryTasks.map(t => ({ ...t,
  setup: t.kind === 'note'
    ? `找到原文“${t.anchor}”，在对应位置保存一条阅读笔记，内容必须完整保留为“${t.content}”。`
    : t.kind === 'highlight'
      ? `找到并高亮原文中的这句话：“${t.anchor}”。`
      : `请把阅读器跳转到原文“${t.anchor}”所在的位置，我要从这里接着读。`,
  resume: t.id === 'restart-01' ? '我重启了阅读服务。请找回我保存的、关于下次比较两类策略的阅读笔记，逐字告诉我笔记内容。'
    : t.id === 'restart-02' ? '我重启了阅读服务。请找回我上次保存的防过拟合高亮，逐字告诉我高亮了什么。'
      : t.id === 'restart-03' ? '我重启了阅读服务。现在恢复到我上次阅读的位置了吗？请读取当前阅读位置，并告诉我那里关于领先和落后因子权重的原话。'
        : '我重启了阅读服务。请找回我保存的、关于数据库审阅的阅读笔记，逐字告诉我笔记内容。',
}));
