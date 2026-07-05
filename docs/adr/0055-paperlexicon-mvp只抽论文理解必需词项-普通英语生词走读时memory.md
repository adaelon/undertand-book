# ADR-0055 paper_lexicon MVP 只抽论文理解必需词项 / 普通英语生词走读时 memory

状态:已接受(2026-07-05,PDF/paper §0.5 lexicon 范围)

## 背景
ADR-0054 定义 BilingualAidLayer:英文原文仍是唯一正文真相,预构建只抽 `paper_lexicon.json`,普通词句走读时按需解释 + 用户 memory。需要进一步收窄 lexicon 的 MVP 范围,避免把它做成全书英语词典或全文翻译缓存。用户确认 lexicon 应只抽“论文理解必需词项”,普通英语生词不进入公共基座。

## 决策
1. **paper_lexicon MVP 只抽理解本论文必需的公共词项**。
2. **MVP 收录范围**:
```text
paper-defined terms
method names
acronyms
domain terms
dataset / metric / model names
recurring academic phrases that affect argument understanding
```
3. **普通英语生词不进公共 lexicon**:如 `substantial`、`alleviate`、`demonstrate` 这类普通词,默认由读时按需解释处理。
4. **例外条件**:普通词只有在本论文中被定义为术语、被反复作为论证关键词、或其固定搭配影响论证理解时,才可进入 paper_lexicon。
5. **读者个人词汇难点进 memory**:某个用户不会的普通词属于 reader memory / vocabulary,不写入只读基座。

## 命门
- **公共 lexicon 记录论文状态,不是读者英语水平**。
- **高价值短语按论证作用收录**:不是因为“难”,而是因为不懂会误解论文主张、方法或证据。
- **宁少勿滥**:噪声词越多,读时辅助越像普通词典,反而稀释论文关键术语。

## 否决
- 预构建全词典:成本高、噪声大、与读者差异强相关。
- 把普通生词写进 paper_lexicon:污染公共基座。
- 把 paper_lexicon 当全文翻译缓存:违 ADR-0054。
- 仅按词频收录:高频功能词/普通动词不等于论文关键术语。

## 何时回头
- 用户反复在同一类学术短语上卡住时,扩展高价值短语规则。
- reader memory 中大量用户都保存同一普通词时,可考虑 profile 级推荐,但仍需人工/规则确认其论文作用。
- 需要系统化英语学习模式时,另立 reader_profile / vocabulary training ADR。

## 影响
- `CONTEXT.md` 修正 `paper_lexicon.json` 范围。
- `skills/build/SKILL.md` 同步 lexicon MVP 收录和排除规则。
- 后续 paper lexicon extractor 必须按“论文理解必需”筛选,不得按普通词汇难度铺满。
