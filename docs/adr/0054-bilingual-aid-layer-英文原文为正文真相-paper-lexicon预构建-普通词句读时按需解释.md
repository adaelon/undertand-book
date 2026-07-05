# ADR-0054 BilingualAidLayer / 英文原文为正文真相 / paper_lexicon 预构建 / 普通词句读时按需解释

状态:已接受(2026-07-05,PDF/paper §0.5 英文论文中文辅助)

## 背景
paper profile 的目标用户包括“看英语论文的中国人”:主要希望理解英文原文,但需要中文辅助解释。英语不是母语时,单词、短语、缩写、学术表达和长句本身也会成为理解对象。若把全文预翻译成中文,会产生第二正文,破坏 `source/book.text` 的证据红线;若完全不做词汇/术语支持,又会削弱产品对该用户群的价值。

## 决策
1. **英文原文仍是唯一正文真相**:`source/book.text` 保存英文 cleaned Markdown;citation anchor 仍是 LID。
2. **中文只做辅助解释**:中文 gloss、解释、句法拆解、术语说明和学习提示不得替代英文原文,也不得作为 citation source。
3. **新增 BilingualAidLayer**:面向中文母语用户读英文论文的辅助层,属于 profile/读时投影能力,不改变 Core。
4. **预构建只抽公共高价值术语表**:`paper_lexicon.json` 只包含论文关键术语、缩写、方法名、领域术语、数据集/指标/模型名、高价值学术短语等。
5. **普通词句走读时按需解释**:用户点词/短语/句子时,读时用当前 LID 原文 + 上下文生成中文解释、释义或句法拆解。
6. **用户不会的词进私人 memory**:读者个人词汇难点、已学/未懂状态属于 reader memory,不写入公共 paper_lexicon。

## paper_lexicon 条目草形
```ts
type PaperLexiconEntry = {
  term: string;
  normalized_term?: string;
  chinese_gloss?: string;
  explanation_zh?: string;
  occurrences_lids: string[];
  defined_at_lid?: string;
  aliases?: string[];
  acronym_expansion?: string;
};
```

## 命门
- **英文原文不可被中文替代**:所有可验证回答仍应能回到英文 LID。
- **公共术语表与私人词汇记忆分离**:paper_lexicon 记录“这篇论文的重要词”,memory 记录“这个读者需要帮助的词”。
- **按需解释优先于预生成海量词典**:普通单词和句子不在预构建期铺满。

## 否决
- 全文预翻译成中文作为第二正文:破坏 source truth,并引入双正文一致性风险。
- 中文解释作为 citation evidence:中文是辅助,证据仍是英文 LID 原文。
- 预构建全词典:成本高、噪声大,且普通词汇需求因读者而异。
- 把用户个人不懂的词写进只读基座:污染公共书基座。

## 何时回头
- 用户大量请求固定短语解释时,扩展 paper_lexicon 的高价值短语抽取规则。
- 读时按需解释频繁重复时,用 memory 缓存读者私人词汇卡片。
- 若需要教学型英语训练模式,另立 reader_profile / exercise policy ADR。

## 影响
- `CONTEXT.md` 新增 `BilingualAidLayer`、`paper_lexicon.json`。
- `skills/build/SKILL.md` 后续应把 paper_lexicon 作为 paper 规则包的可物化 profile artifact。
- 本 ADR 不新增 Core 命令面;读时/MCP 可从 paper_lexicon + book.text + memory 投影双语辅助视图。
