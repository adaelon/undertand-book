use crate::{InstructionModule, ToolSpec};
use std::collections::HashSet;

pub const BASE_INSTRUCTIONS: &str = "你是当前书籍的内置阅读 agent。只依据用户提供的正文和已验证的书内证据回答。工具选择为 auto: 用户给出的引用已经足够时可以直接回答;否则只调用能缩小当前证据缺口、完成用户明确副作用请求或发现所需能力的最少工具。";

const EVIDENCE_ROUTING: &str = "证据路由:
- 用户给出正文引用并问局部含义时,引用本身是最高优先级证据;selection_provenance.v1 的 resolved_quote 已由 Server 验证并进入本轮证据,足够时必须直接解释,不得调用工具重复验证。只有答案确实依赖引用外信息时才至多补 book.text、book.context 或 book.synthesize,不要先做开放检索。
- 用户问原话、公式、符号或精确写法的第一次/上一处/下一处/所有出现时,字面位置优先:先用 book.search_text,不得先调 book.query。所有出现要沿 next_cursor 逐页读取到为空后才能声称完整,不得重复同一 request/cursor。
- search occurrence 只证明字面出现;解释含义、原因、推导、章节作用或前后关系时必须再用 book.text 读取命中 LID,必要时才扩展 book.context。
- 显式概念或实体的定义、解释、关系、比较需要新证据时用 book.query;query 必须自含,targets 是明确 referent,obligations 是 1..3 个原子回答要求。ambiguous/unresolved 时不得把 candidate_id 当概念名循环试探。
- 当前 passage 问题优先 book.text/book.context 或已知 LID 的 book.synthesize。概念/实体展示名不确定时先用 book.concept 做候选发现,根据完整问题比较 name、match_tier、match_reasons 与 previews,选择一个或多个候选后必须用 book.text 读取所选 occurrences 的完整正文;preview 不是最终证据。已有精确原词、公式或写法且只求字面位置时优先 book.search_text。";

const SOURCE_DELIVERY: &str = "来源呈现:
- source.present 是可选的展示步骤,不是完成每个回答的强制调用。只有要向用户展示书内位置时,才对本轮已观察证据调用 source.present。
- 在相关句后使用 source.present 返回的 [[source:<source_ref_id>]];不得把原始 LID 写进普通回答,也不得编造 LID 或来源引用。";

const TOOL_DISCOVERY: &str = "能力发现:
- 当前工具列表只包含本次 sampling 可直接使用的能力。缺少完成任务所需工具时调用 tool.search。
- tool.search 只返回元数据并激活能力;新激活工具从下一次 sampling 才可见,不得在同一批 tool_calls 中立即调用。每次只发现当前任务真正需要的最少能力。";

const NAVIGATION: &str = "导航与带读:
- 章节主旨或整篇贡献先用 book.structure/book.guide_path 或 book.paper_reading_guide 选择真 LID,再用 book.synthesize;route_from/guided_route_from/route_to/unvisited_back 只用于导航、带读、前置与路径,不是普通解释工具。
- 主动带读先用 reader.state 取得当前 anchor,再看结构或路线,每回合只前进一个真实停靠点;必须用 reader.gotoLid 真正跳转后再解释。
- 对无具体指向的“没懂”,先用 book.unvisited_back 检查未读前置。为空时原地换讲法;非空时先建议回看,用户再次没懂再真正跳转。未读前置只能来自工具结果。";

const READER_EFFECTS: &str = "Reader 副作用:
- 用户要求翻页、跳转、高亮、记笔记、布局或论文工作台操作时,必须真实调用对应 reader 工具,不能只用文字声称完成。
- gotoLid 用于跳转,highlight 用于高亮,note 用于记录。reader.layout.apply 的 action 必须使用 manifest 中的 slot_id 与 snake_case kind。
- 可直接执行的 action 以工具结果为准;close_slot、reorder_slot、set_layout_preset、reset_layout 以及需要持久化或切 mode 的动作若返回 proposal,必须等待用户确认,不得绕过 reducer。
- 定位到目标后立即执行所请求的 reader 动作并简短收敛,不要为了操作任务反复读取正文。";

const PAPER_WORKBENCH: &str = "论文工作台:
- 元数据、作者年份、数据集、术语缩写、阅读路线或摘要辅助分别使用 paper metadata/lexicon/reading guide 能力,再按返回的真实 LID 读原文。
- paper minimap 只能根据本轮 paper_minimap_agent_context 行动;没有合法 region/landmark/evidence 时 noop 或澄清,不得补造节点关系。
- agent 不得自行展开地图、写 viewport/selection、直接导航正文、切 mode 或持久化。saved 和 mode 变更必须由 reducer 返回 proposal 并等待用户确认。";

const MEMORY_POLICY: &str = "记忆策略:
- 只有用户明确要求记住,或确有跨会话复用价值的读者背景、偏好、关注点、卡点时,才用 memory.save(type='context');内容必须区分事实与推断,有书内依据时引用已观察的真 LID。
- 不要把每个问题或每句话都变成模型发起的记忆写入。问题轨迹由 Runtime 观察成功的 book.query 自动记录,不要为此调用 memory.save(type='qa')。
- 需要贴合历史关注点时可按当前真 LID 用 memory.recall;记忆可见、可删除,不得把推断冒充用户事实。";

const PROFILE_POLICY: &str = "读者画像:
- 注入的 reader profile snapshot 是只读上下文。只有其事实实际影响了检索计划、解释深度、术语、例子或导航时才声明使用;不得补造未注入的 fact id。
- profile.manifest 仅在需要完整 slots、presets、projections 或 tool policy 时读取。";

const FINISH_POLICY: &str = "收敛:
- 工具结果使用 tool_result_envelope.v1。只有 model_body 是本次可用于回答的结果正文;receipt 只证明调用发生过,不能当作正文证据。truncated=true 表示结果不完整,按 continuation 继续或明确保留缺口;model_body=null 表示新鲜正文已在上一次 sampling 消费。
- 工具返回 AGENT_NO_PROGRESS 时停止重复同一调用,改用已有证据回答或诚实说明缺口。
- 证据不足时明确说明,不要编造结论、LID 或工具执行结果。准备好答案后直接用自然语言终答,不要为覆盖率追加无关工具。";

fn module(asset_id: &str, text: &str) -> InstructionModule {
    InstructionModule::new(asset_id, "v1", text)
}

fn has_any(names: &HashSet<&str>, candidates: &[&str]) -> bool {
    candidates.iter().any(|name| names.contains(name))
}

pub fn policy_modules_for_tools(tools: &[ToolSpec]) -> Vec<InstructionModule> {
    let names: HashSet<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    let mut modules = Vec::new();

    if has_any(
        &names,
        &[
            "book.query",
            "book.synthesize",
            "book.search_text",
            "book.text",
            "book.context",
            "book.concept",
        ],
    ) {
        modules.push(module(
            "resident-agent.policy.evidence-routing",
            EVIDENCE_ROUTING,
        ));
    }
    if names.contains("source.present") {
        modules.push(module(
            "resident-agent.policy.source-delivery",
            SOURCE_DELIVERY,
        ));
    }
    if names.contains("tool.search") {
        modules.push(module(
            "resident-agent.policy.tool-discovery",
            TOOL_DISCOVERY,
        ));
    }
    if has_any(
        &names,
        &[
            "book.structure",
            "book.guide_path",
            "book.paper_reading_guide",
            "book.route_from",
            "book.guided_route_from",
            "book.unvisited_back",
            "book.route_to",
            "reader.state",
        ],
    ) {
        modules.push(module("resident-agent.policy.navigation", NAVIGATION));
    }
    if has_any(
        &names,
        &[
            "reader.gotoLid",
            "reader.scroll",
            "reader.highlight",
            "reader.note",
            "reader.layout.apply",
        ],
    ) {
        modules.push(module(
            "resident-agent.policy.reader-effects",
            READER_EFFECTS,
        ));
    }
    if has_any(
        &names,
        &[
            "book.paper_reading_guide",
            "book.paper_metadata",
            "book.paper_lexicon",
            "reader.paper_minimap.apply",
        ],
    ) {
        modules.push(module(
            "resident-agent.policy.paper-workbench",
            PAPER_WORKBENCH,
        ));
    }
    if has_any(&names, &["memory.save", "memory.recall"]) {
        modules.push(module("resident-agent.policy.memory", MEMORY_POLICY));
    }
    if has_any(&names, &["profile.manifest", "profile.mark_used"]) {
        modules.push(module("resident-agent.policy.profile", PROFILE_POLICY));
    }
    modules.push(module("resident-agent.policy.finish", FINISH_POLICY));
    modules
}

#[cfg(test)]
pub(crate) fn canonical_policy_text() -> String {
    [
        EVIDENCE_ROUTING,
        SOURCE_DELIVERY,
        TOOL_DISCOVERY,
        NAVIGATION,
        READER_EFFECTS,
        PAPER_WORKBENCH,
        MEMORY_POLICY,
        PROFILE_POLICY,
        FINISH_POLICY,
    ]
    .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            description: name.into(),
            parameters: serde_json::json!({"type": "object"}),
        }
    }

    #[test]
    fn agent_tool_policy_base_allows_zero_tool_answers_and_runtime_owns_qa_bookkeeping() {
        assert!(BASE_INSTRUCTIONS.contains("引用已经足够时可以直接回答"));
        assert!(EVIDENCE_ROUTING.contains("不得调用工具重复验证"));
        assert!(EVIDENCE_ROUTING.contains("book.concept 做候选发现"));
        assert!(EVIDENCE_ROUTING.contains("必须用 book.text"));
        assert!(EVIDENCE_ROUTING.contains("preview 不是最终证据"));
        assert!(MEMORY_POLICY.contains("Runtime"));
        assert!(!MEMORY_POLICY.contains("每当"));
    }

    #[test]
    fn agent_tool_policy_modules_follow_the_current_visible_capabilities() {
        let initial = policy_modules_for_tools(&[
            spec("book.query"),
            spec("source.present"),
            spec("tool.search"),
        ]);
        let initial_ids: Vec<_> = initial
            .iter()
            .map(|module| module.asset_id.as_str())
            .collect();
        assert_eq!(
            initial_ids,
            [
                "resident-agent.policy.evidence-routing",
                "resident-agent.policy.source-delivery",
                "resident-agent.policy.tool-discovery",
                "resident-agent.policy.finish",
            ]
        );

        let activated = policy_modules_for_tools(&[
            spec("reader.state"),
            spec("reader.gotoLid"),
            spec("memory.recall"),
        ]);
        let activated_ids: Vec<_> = activated
            .iter()
            .map(|module| module.asset_id.as_str())
            .collect();
        assert!(activated_ids.contains(&"resident-agent.policy.navigation"));
        assert!(activated_ids.contains(&"resident-agent.policy.reader-effects"));
        assert!(activated_ids.contains(&"resident-agent.policy.memory"));
        assert!(!activated_ids.contains(&"resident-agent.policy.paper-workbench"));
    }
}
