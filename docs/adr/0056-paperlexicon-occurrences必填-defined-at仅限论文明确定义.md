# ADR-0056 paper_lexicon occurrences 必填 / defined_at 仅限论文明确定义

状态:已接受(2026-07-05,PDF/paper §0.5 lexicon 证据粒度)

## 背景
ADR-0055 已将 `paper_lexicon.json` 收敛为论文理解必需的公共词项。下一步需要区分“这个词在哪里出现过”和“论文在哪里定义了这个词”。许多领域术语、方法名、数据集名会在论文中使用但不定义;如果 LLM 把自己的解释或普通出现位置写成定义位置,会污染证据链。

## 决策
1. **每个 lexicon 条目必须有 `occurrences_lids`**:表示该词项在论文中真实出现的位置集合。
2. **`defined_at_lid` 只在论文明确给出定义时填写**:例如 “we define X as...”, “X refers to...”, “denoted by...” 等明确文本信号。
3. **没有明确定义就不填 `defined_at_lid`**:可以有中文 gloss/explanation,但必须承认这是辅助解释或上下文释义。
4. **模型解释不得伪装为论文定义**:LLM 可以生成 `explanation_zh`,但不能因此制造 `defined_at_lid`。
5. **acronym expansion 可有独立证据**:若论文给出缩写展开,可用该 LID 作为 `defined_at_lid` 或后续细化字段的 evidence;若只是常识展开,不得伪装成论文定义。

## 命门
- **occurrence 是出现,definition 是定义**:二者不能混用。
- **中文解释不是定义证据**:证据仍来自英文原文 LID。
- **宁缺定义,不造定义**:没有 explicit definition 时,读时可解释但不能标定义位置。

## 否决
- 用第一次出现位置当默认 `defined_at_lid`:首次出现不等于定义。
- 用模型常识补 `defined_at_lid`:破坏 LID 证据红线。
- 没有 occurrences 的词条:无法回到论文原文。

## 何时回头
- 如果需要表达“隐含定义/上下文定义”,另加字段如 `inferred_from_lids`,不得复用 `defined_at_lid`。
- 如果缩写展开和正式定义需要分离,另细化 `acronym_expansion_evidence_lids`。

## 影响
- `CONTEXT.md` 修正 `paper_lexicon.json` 证据规则。
- `skills/build/SKILL.md` 同步 occurrences/defined_at 红线。
- 后续 paper lexicon extractor 必须强制输出 occurrences_lids,并仅在 explicit definition 时输出 defined_at_lid。
