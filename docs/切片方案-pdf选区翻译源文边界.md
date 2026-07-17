# 切片方案 - PDF 选区翻译源文边界

> 状态:2026-07-17 TS0-TS4 已完成。
> 根因:Provider 偶发把完整 LID `context_blocks[0]` 当成待翻译正文。
> 既有边界:[ADR-0078](adr/0078-pdf-selection-translation-ephemeral-lock-free-bilingual-projection.md) 与 [PDF 选区翻译方案](切片方案-pdf选区翻译.md)。

## 0. 冻结边界

1. 保留 `context_blocks`,先验证 prompt 单一源文契约能否稳定消除扩译。
2. `source_markdown` 是唯一允许进入 `translation_markdown` 的源文;context 只允许消歧。
3. 不改 PDF 原生 Selection、rect capture、selection map、`resolved/partial` 分流或前端状态机。
4. 不改 endpoint、Provider timeout、Markdown/KaTeX、lexicon、缓存、chat、memory 或 citation 边界。
5. 不增加译后字符串启发式拦截;确定性验证锁定 prompt 契约,真实 Provider 验收观察语义效果。
6. 若强化 prompt 后仍复现 context 扩译,回到输入层方案:停止向 Provider 发送整 LID context。

## 1. 根因证据

- 真书选区从 `The heart was transected...` 开始,resolver 返回 `partial`,首个映射从 `2.43.2[746]` 开始。
- `partial` 的 `source_markdown` 是正确 `raw_quote`,没有包含段首。
- `context_blocks[0]` 是完整 `2.43.2`:从 `All frozen cardiac tissues...` 到公式前的 `...freezing in a  `。
- 错误译文恰好从该 context 段首开始并在其末尾停止;PDF range、前端 draft 与翻译 source 均不是首个偏差点。
- 当前测试只断言 JSON 序列化和响应形状,没有约束模型只能翻译 `source_markdown`。

## 2. §1 Prompt 单一源文契约

**决策**:明确限定模型只翻译 `source_markdown`。

**否决**:
- 立即删除 context:先按用户选择验证 prompt-first 路线。
- 仅追加一句泛化提醒:字段角色仍不够可判定。
- 译后关键词拦截:无法覆盖无专名的扩译。

**命门**:context 可影响措辞,不得贡献任何未出现在 source 中的内容。
**何时回头**:同一真书选区仍出现段首、审批号或其他 context-only 内容时。

## 3. Prompt 契约

```text
translation_markdown = translate_exactly(source_markdown)
context_blocks = reference_only

rules:
  translate every part of source_markdown
  do not translate, quote, summarize, prepend, or append context_blocks
  when source and context differ, source_markdown defines output scope
  terminology constrains wording but does not add content
```

建议 user JSON 形状:

```json
{
  "task": {
    "operation": "translate_exactly",
    "source_field": "source_markdown",
    "reference_only_fields": ["reference_only.context_blocks"],
    "target_locale": "zh-CN"
  },
  "source_markdown": "...",
  "selection_status": "partial",
  "reference_only": {
    "context_blocks": []
  },
  "terminology": [],
  "target_locale": "zh-CN"
}
```

## 4. 实现切片

**TS0 方案落档**

- **Do**:冻结根因、边界、prompt 契约、切片与验收矩阵。
- **Do not**:不改代码或既有文档。
- **Done**:本文件可独立指导 TS1-TS4。

**TS1 Prompt 边界红测**

- **Do**:新增 `selection_translation_prompt_limits_output_to_source_markdown`,断言 system 的唯一源文规则与 user JSON 的 `task/reference_only` 角色。
- **Do not**:不修改 `selection_translation_prompt` 实现。
- **Done**:`cargo test -p server selection_translation_prompt_limits_output_to_source_markdown` 已在唯一源文 system 断言处按预期失败。

**TS2 Prompt 强化**

- **Do**:只修改 `selection_translation_prompt`,落实第 3 节 system 规则和 JSON 形状。
- **Do not**:不删除 context,不改 `SelectionTranslationWork`、Provider adapter 或 endpoint。
- **Done**:TS1 转绿;translation 9/9、server 154/154 全绿;本切片 diff 通过 `git diff --check`。

**TS3 真书重复验收**

- **Do**:用 `.understand-book/1` 同一 13 行选区连续请求 5 次,记录 resolver 与翻译响应。
- **Do not**:不把单次正确响应当稳定结论,不使用 LLM 自评。
- **Done**:隔离新二进制上的 5 次请求均 HTTP 200;译文包含所选 `15`/`80` 信息,且均不含 context-only `PRO00006097`、`STU00216333` 或选区前四句内容。

**TS4 文档与热启动收口**

- **Do**:更新既有翻译方案的 prompt 规则,追加 code trail,覆写 `SESSION_CHECKPOINT.md`。
- **Do not**:不改 ADR-0078 或 architecture;本修复不改变模块、锁或数据流边界。
- **Done**:既有方案与代码一致,code trail 已追加,checkpoint 明确所有未提交组、验证证据和运行服务。

## 5. 确定性验收矩阵

| 层 | 判据 |
|---|---|
| Prompt unit | system 明示唯一源文;user JSON 将 context 放入 `reference_only` |
| Preparation | resolved/partial、4k/12k/32 预算与 context 内容保持不变 |
| Provider contract | 仍只接受单字段非空 `translation_markdown` JSON |
| Server regression | translation 相关测试与 server 全量测试全绿 |
| Real endpoint | 同一真实选区 5 次无 context-only 审批号或前缀句 |
