//! 外层 E 编排 loop `[ADR-0026/0016/0005]`:messages 会话态、LLM 自主多轮 tool-calling、
//! 双重停机(max_turns ∨ usage token 触顶 → 诚实标 incomplete)、工具错误回喂不降级。
//! 外层工具集 = book.query/text/context/concept + memory.save/recall + reader.gotoLid/scroll/highlight/note/state。
//! book.manifest **不在外层暴露**(返回全树 token 炸弹,S7 真跑实测一次撑爆 budget;外层导航靠 concept/context 足够);
//! dispatch 仍保留 manifest 防御分支。reader.* 是会话态阅读器(S7 接入):agent 经命令面驱动
//! 「问→跳转→高亮→记笔记」闭环 `[ADR-0007/0015]`。
//! 内层 book.query 复用 `crate::query`(同一 adapter 触 `complete`)`[ADR-0025]`。
use crate::{query, synthesize, AssistantTurn, Message, ModelAdapter, Role, ToolSpec};
use memory::{Anchor, MemCitation, MemoryStore, ReaderProfileSnapshot, RecallQuery, SaveInput};
use read_tools::{
    Book, PaperLandmarkKind, PaperMinimapAvailabilityStatus, PaperRegion, ReaderLayoutAction,
    ReaderLayoutApplyOutcome, ReaderLayoutEffect, ReaderLayoutProposal, ToolError,
};
use reader::{
    project_paper_minimap_lens, PaperMinimapActor, PaperMinimapApplyOutcome, PaperMinimapCommand,
    PaperMinimapEffect, PaperMinimapMode, PaperMinimapProposal, PaperViewportPosition, Reader,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use ts_rs::TS;

/// 外层停机预算(切片0 占位,实测回填 `[ADR-0016]`)。
#[derive(Debug, Clone, Copy)]
pub struct OuterConfig {
    pub max_turns: usize,
    pub token_budget: u32,
}

impl Default for OuterConfig {
    fn default() -> OuterConfig {
        OuterConfig {
            max_turns: 12,
            token_budget: 120_000,
        }
    }
}

/// 外层 loop 终局 `[ADR-0026]`。incomplete=true ⇒ 触顶诚实标,answer 可能是部分答/缺。
/// `effects`/`trace`:本回合(一次 `/agent/chat`)的可撤销副作用清单 + 查询踪迹 `[ADR-0030]`,
/// runtime 内部结构(非冻结命令面),前端据此渲提议卡 / 折叠踪迹。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct OuterOutcome {
    pub answer: Option<String>,
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub turns: usize,
    pub tokens_spent: u32,
    pub effects: Vec<AgentEffect>,
    pub trace: Vec<TraceStep>,
}

/// 一次对话回合的**可撤销副作用** `[ADR-0030 决策3]`:前端据此做反向命令 undo。
/// 提议单元 = 一次对话回合(事务性):视口变更跨回合合并成单条 `Goto`(undo=goto(before));
/// highlight/note 每次一条(undo=memory.delete(mem_id))。agent 标注落 session 层,用户「保留」才升 long_term。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
#[serde(tag = "kind")]
pub enum AgentEffect {
    /// 视口跳转(goto/scroll 合并);undo = `reader.goto(before_anchor)`。
    Goto {
        before_anchor: String,
        after_anchor: String,
    },
    /// 高亮提议(session 层);undo = `memory.delete(mem_id)`。
    Highlight { mem_id: String, lid: String },
    /// 笔记提议(session 层);undo = `memory.delete(mem_id)`。
    Note {
        mem_id: String,
        lid: String,
        text: String,
    },
    /// 布局直执变更;undo = restore `effect.before` when current rev still matches `effect.after.rev`.
    Layout { effect: ReaderLayoutEffect },
    /// 高风险布局变更提议;Apply 时以后端 `proposal_id` + `base_layout_rev` 复验。
    LayoutProposal { proposal: ReaderLayoutProposal },
    /// Agent-applied reversible paper minimap session effect.
    PaperMinimap { effect: PaperMinimapEffect },
    /// Paper minimap mode/saved change awaiting explicit user confirmation.
    PaperMinimapProposal { proposal: PaperMinimapProposal },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaperMinimapAgentLandmarkState {
    Normal,
    Emphasized,
    Hidden,
    Pinned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaperMinimapAgentLandmark {
    pub landmark_id: String,
    pub kind: PaperLandmarkKind,
    pub anchor_lid: String,
    pub page_index: u32,
    pub label: String,
    pub state: PaperMinimapAgentLandmarkState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaperMinimapAgentUserSignal {
    pub current_goal: Option<String>,
    pub latest_feedback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PaperMinimapAgentContext {
    pub map_rev: String,
    pub state_rev: u64,
    pub topology: Vec<PaperRegion>,
    pub position: PaperViewportPosition,
    pub mode: PaperMinimapMode,
    pub landmarks: Vec<PaperMinimapAgentLandmark>,
    pub user_signal: PaperMinimapAgentUserSignal,
    pub allowed_actions: Vec<String>,
}

/// 查询踪迹一步 `[ADR-0030 决策5]`:tool_calls 序列摘要,对用户可见(book.query 的检索范围 + citations 链在 `result_digest` 里)。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/web/src/generated/")]
pub struct TraceStep {
    pub tool: String,
    pub args: String,
    pub result_digest: String,
}

/// 确定性近似 token(CJK=1,其余=0.25,ceil);仅在后端不返 usage 时兜底 `[ADR-0026]`。
fn estimate_tokens(s: &str) -> u32 {
    let mut t = 0f32;
    for c in s.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&c) {
            t += 1.0;
        } else {
            t += 0.25;
        }
    }
    t.ceil() as u32
}

fn messages_estimate(messages: &[Message]) -> u32 {
    messages
        .iter()
        .map(|m| m.content.as_deref().map(estimate_tokens).unwrap_or(0))
        .sum()
}

/// 外层 loop 暴露给模型的工具集(7 个;reader.* 留 S7)`[ADR-0026]`。
pub fn tool_specs() -> Vec<ToolSpec> {
    use serde_json::json;
    let s = |name: &str, description: &str, parameters: serde_json::Value| ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters,
    };
    vec![
        s(
            "book.query",
            "对本书做锚定问答:给定问题与一个锚点 LID,内部确定性检索+合一轮作答,返回带真 LID citation 的答案。",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "自然语言问题"},
                    "anchor_lid": {"type": "string", "description": "锚点 LID(从 manifest/context 获得)"}
                },
                "required": ["query", "anchor_lid"]
            }),
        ),
        s(
            "book.synthesize",
            "对调用方给定的离散 LID 集做综合;不外扩检索,返回 citations ⊆ 输入 lids 的综合回答。",
            json!({
                "type": "object",
                "properties": {
                    "lids": {"type": "array", "items": {"type": "string"}, "description": "要综合的 LID 列表"},
                    "task": {"type": "string", "description": "可选综合任务"}
                },
                "required": ["lids"]
            }),
        ),
        s(
            "book.text",
            "按 LID 或 LID 区间取真原文。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "end_lid": {"type": "string", "description": "可选,取 [lid, end_lid] 区间"}
                },
                "required": ["lid"]
            }),
        ),
        s(
            "book.context",
            "取某 LID 的上下文指针:near=树邻接+local 边,mid=near+概念/实体其他 occurrences,far=mid+long_range 边;不带原文,用 book.text 取内容。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "granularity": {"type": "string", "enum": ["near", "mid", "far"], "description": "默认 near"},
                    "k": {"type": "integer", "description": "可选 top-K"}
                },
                "required": ["lid"]
            }),
        ),
        s(
            "book.concept",
            "按名查概念/实体,返回全量出现 LID + 关联实体。",
            json!({
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }),
        ),
        s(
            "book.structure",
            "BookStructure 结构投影:说明某 LID 在全书 spine/throughline/key_stop 中的结构意义。缺 at 时返回全书结构概览;缺 sidecar 时显式 unavailable。",
            json!({
                "type": "object",
                "properties": {
                    "at": {"type": "string", "description": "可选,当前位置或候选 LID"}
                }
            }),
        ),
        s(
            "book.guide_path",
            "BookStructure 宏观带读路线:按 spine 分段展开 key_stops,不理解自然语言、不读取 reader/memory。缺 sidecar 时显式 unavailable。",
            json!({
                "type": "object",
                "properties": {
                    "at": {"type": "string", "description": "可选,用于标记当前所在 spine 段"}
                }
            }),
        ),
        s(
            "book.paper_reading_guide",
            "PaperReadingGuide 只读投影:组合 paper metadata/lexicon、BookStructure、graph、discourse 与原文,返回论文十问、Codebook、摘要阅读辅助。不会新增或修改持久 truth。",
            json!({
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["skim", "close", "deep"], "description": "默认 skim"},
                    "stage": {"type": "string", "enum": ["passive", "active", "critical", "creative"], "description": "默认 passive"}
                }
            }),
        ),
        s(
            "book.paper_metadata",
            "返回当前单篇 paper 的 metadata projection,保留 value/source/evidence_lids/confidence;缺 sidecar 时 explicit unavailable,不生成跨论文关系。",
            json!({
                "type": "object",
                "properties": {}
            }),
        ),
        s(
            "book.paper_lexicon",
            "返回当前单篇 paper 的 lexicon projection,用于术语/缩写/数据集候选对齐;缺 sidecar 时 explicit unavailable。",
            json!({
                "type": "object",
                "properties": {}
            }),
        ),
        s(
            "profile.manifest",
            "返回当前 book 的 ProfileManifest;可选 profile_id=technical_learning|paper 读取 registry 中的显式 manifest。",
            json!({
                "type": "object",
                "properties": {
                    "profile_id": {"type": "string", "enum": ["technical_learning", "paper"], "description": "可选;缺省为当前 book profile"}
                }
            }),
        ),
        s(
            "book.route_from",
            "从某 LID 出发的确定性导航前沿:按导航语义返回 5 类分组(back 前置/forward 深入/concretize 例证/cross 关联/continue 顺读),每步是真 LID+真边。零 LLM,用于决定『下一步去哪』。",
            json!({
                "type": "object",
                "properties": {
                    "at": {"type": "string", "description": "出发 LID"},
                    "k": {"type": "integer", "description": "可选,每类前沿 top-K"}
                },
                "required": ["at"]
            }),
        ),
        s(
            "book.guided_route_from",
            "从某 LID 出发的【教学整形】导航前沿:= route_from + technical_learning 教学排序(按教学优先序重排 5 类分组、剔空组),返回有序分组 [{category, steps}]。带读/引导优先用本工具(裸 route_from 给底层/访客)。零 LLM,全真 LID+真边。",
            json!({
                "type": "object",
                "properties": {
                    "at": {"type": "string", "description": "出发 LID"},
                    "k": {"type": "integer", "description": "可选,每类前沿 top-K"}
                },
                "required": ["at"]
            }),
        ),
        s(
            "book.unvisited_back",
            "裸『没懂』结构兜底:返回当前 LID 的【未读前置】= route_from(at).back 里读者还没读过的(确定性 back ∩ 未读)。当用户只说『没懂/看不明白』且无具体指向(没说要例子/关联/回看哪)时调它——返回非空则首项是建议回看的未读前置,空则该回看的前置都读过了(改走原地重讲)。零 LLM,全真 LID。",
            json!({
                "type": "object",
                "properties": {"at": {"type": "string", "description": "当前 LID"}},
                "required": ["at"]
            }),
        ),
        s(
            "book.route_to",
            "在导航图上求 from→target 的确定性路径(BFS,返回导航步序列,全真 LID+真边)。target 须为已解析 LID(先用 book.concept/context 定位)。",
            json!({
                "type": "object",
                "properties": {
                    "from": {"type": "string", "description": "出发 LID"},
                    "target": {"type": "string", "description": "目标 LID(已解析)"},
                    "k": {"type": "integer", "description": "可选,跳数预算"}
                },
                "required": ["from", "target"]
            }),
        ),
        s(
            "memory.save",
            "保存一条记忆:note/highlight/position(用户逐字便签 / 位置),\
qa(用户对书内容的提问:你用 book.query 答完后存,anchor_lid=问题所在 LID、content=用户原问题),\
或 context(主动构建的用户上下文:对该读者背景/偏好/关注/卡点的理解,用认知诚实措辞)。\
note/highlight 自动锚回 anchor 的 LID;context 可经 citations 锚回支撑该理解的真 LID。",
            json!({
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["note", "highlight", "position", "qa", "context"]},
                    "anchor_lid": {"type": "string"},
                    "content": {"type": "string"},
                    "citations": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选,支撑该记忆的真 LID 列表(主要供 context 用);无效 LID 自动丢弃,可为空"
                    }
                },
                "required": ["type", "anchor_lid", "content"]
            }),
        ),
        s(
            "memory.recall",
            "召回本书相关记忆(可按 lid/type/层/文本子串过滤),每条带可验证 LID citation。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "type": {"type": "string"},
                    "layer": {"type": "string"},
                    "text": {"type": "string"}
                }
            }),
        ),
        s(
            "reader.gotoLid",
            "翻到某 LID(叶→锚到该叶,容器→锚到子树首叶),返回变更后视口 {anchor_lid, visible_lids}。",
            json!({
                "type": "object",
                "properties": {"lid": {"type": "string", "description": "目标 LID"}},
                "required": ["lid"]
            }),
        ),
        s(
            "reader.scroll",
            "沿叶序滚动锚点(delta 正向后/负向前,越界 clamp),返回变更后视口。",
            json!({
                "type": "object",
                "properties": {"delta": {"type": "integer", "description": "沿叶序移动的叶数(可负)"}},
                "required": ["delta"]
            }),
        ),
        s(
            "reader.highlight",
            "高亮某 LID(薄入口,持久化委托记忆层),返回 highlight_id(=记忆层 id)。",
            json!({
                "type": "object",
                "properties": {"lid": {"type": "string"}},
                "required": ["lid"]
            }),
        ),
        s(
            "reader.note",
            "对某 LID 记笔记(薄入口,持久化委托记忆层),返回 note_id(=记忆层 id)。",
            json!({
                "type": "object",
                "properties": {
                    "lid": {"type": "string"},
                    "text": {"type": "string", "description": "笔记内容"}
                },
                "required": ["lid", "text"]
            }),
        ),
        s(
            "reader.layout.apply",
            "通过后端 reducer 应用 typed ReaderLayoutAction[]。低风险 action 直执并返回 layout effect;close/reorder/preset/reset 等高风险 action 返回 proposal,等待用户确认。",
            json!({
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "items": {"type": "object"}
                    }
                },
                "required": ["actions"]
            }),
        ),
        s(
            "reader.paper_minimap.apply",
            "按 paper_minimap_agent_context policy 经 reducer 应用 typed commands。orientation/interest/confusion/density 可直执 session focus/emphasis/local projection/layer;mode/correction/persistence 必须返回 proposal。不得展开、导航或写 viewport/selection。",
            json!({
                "type": "object",
                "properties": {
                    "base_state_rev": {"type": "integer", "minimum": 0},
                    "commands": {"type": "array", "items": {"type": "object"}},
                    "reason": {"type": "string"},
                    "evidence_lids": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["base_state_rev", "commands", "reason"]
            }),
        ),
        s(
            "reader.state",
            "取阅读器当前会话态 {viewport, open_panels, selection, layout, profile, paper_minimap, paper_minimap_agent_context},供中途接入/手动操作后 re-sync。",
            json!({"type": "object", "properties": {}}),
        ),
    ]
}

const SYSTEM_PROMPT: &str = "你是这本书的阅读 agent。事实性回答经 book.query 取得带真 LID citation 的证据;\
用 book.concept/context/text 定位与读原文。\
工具价值判断——先判断任务类型和证据缺口,只调用能减少当前不确定性的最小工具。\
当用户给出『引用原文 [LID: ...]』并问『这段怎么理解/什么意思』时,引用文本本身是最高优先级证据:先直接解释引用;\
必要时最多用 book.text(lid) 补完整原文、book.context(lid,near) 补近邻上下文、book.synthesize([lid]) 做受控综合。\
不要把引用拆成一串关键词去批量调用 book.concept,也不要先用 book.query 做开放检索。\
当问题指向当前阅读位置但没有引用时,先 reader.state() 取 anchor,再按缺口用 book.text(anchor)、book.context(anchor,near) 或 book.synthesize([anchor])。\
当用户问明确概念『在哪里讲/有哪些出现』时,book.concept(name) 最高价值;概念不存在时不要换同义词连续试探超过两次,改为说明没在图谱中命中。\
当用户问开放解释/综合问题且没有给引用或已知 LID 时,用 book.query(query,anchor_lid) 做锚定问答;答完书内实质问题再记录 qa。\
当用户问『这和前后文/别处什么关系』且已有 LID 时,先 book.context(lid,near/mid/far) 取指针,再对少量相关 LID 调 book.text 或 book.synthesize。\
book.route_from/guided_route_from/route_to/unvisited_back 只用于导航、带读、找前置和找路径,不是普通解释工具。\
reader.state 会返回当前 layout 与 profile summary;若需要完整 slots/presets/projections/tool policy,调 profile.manifest。\
读论文时若用户要『元数据/作者/年份/数据集/术语/缩写/怎么读这篇/十问/Codebook/摘要辅助』,先调 book.paper_metadata、book.paper_lexicon 或 book.paper_reading_guide(mode,stage),再按其中 LID 证据读取原文。\
论文地图反馈 policy——仅在本自然语言回合注入的 paper_minimap_agent_context 内行动:\
orientation(我在哪/结构位置)→focus 当前 region;interest(关注/重点)→必要时读 evidence LID 后 emphasize 最多5个地标;confusion(困惑/没懂)→当前 region 的合法 local projection 最多4槽;density(太密/太多)→只改 session layer visibility;correction(更正/不对)→带理由的 saved override proposal;persistence(记住/保存偏好)→saved proposal。\
没有合法 region/landmark/evidence 时 noop 或简短澄清,不得补造节点/关系。Agent 不得展开地图、写 viewport/selection、直接导航正文、直接切 mode 或直接持久化;saved 和 mode 必须让 reducer 返回 proposal 等用户确认。\
特别注意——当用户要求操作阅读器时,必须真的调用对应 reader 工具来执行,不能只靠读原文代替:\
要求『翻到/跳转』调 reader.gotoLid(lid);要求『高亮』调 reader.highlight(lid);要求『记笔记/记录』调 reader.note(lid,text)。\
要求『打开/聚焦/固定证据/调整布局/切换论文工作台』调 reader.layout.apply({actions:[...]})。layout action 必须使用 manifest 里的 slot_id 和 snake_case kind;open_slot/focus_slot/pin_evidence/set_panel_size 可直执,close_slot/reorder_slot/set_layout_preset/reset_layout 会返回 proposal,等待用户确认,不要绕过 reducer。\
流程:先用 book.concept/context 定位到目标 LID,一旦定位到就立即调用 reader 工具完成操作,然后给简短终答,不要反复读原文。\
主动带读——当用户请求『带我读/一步步讲/引导我看这章/接着讲』时,先结构地图、再逐停靠点:\
①先 reader.state() 拿当前 anchor(用户可能自己翻动过);\
②book.structure(anchor) 看当前位置在全书 spine/throughline/key_stop 中的意义;book.guide_path(anchor) 看全书级宏观路线(若 unavailable,诚实降级到局部前沿);\
③book.guided_route_from(anchor) 看【教学整形】后的 5 类导航前沿(有序分组 [{category, steps}],按教学优先序排好、已剔空组;category∈back 前置/forward 深入/concretize 例证/cross 关联/continue 顺读);\
④按用户意图从 guide_path/key_stops 或前沿挑一个下一停靠点(无特别意图就先顺 guide_path 当前段 key_stop,否则顺教学序取靠前的;想回看前置挑 back、想深入挑 forward、要例子挑 concretize、问关联挑 cross),局部前沿停靠点只能取自 guided_route_from 返回,不可编造;\
⑤reader.gotoLid(停靠点) 真翻过去;\
⑥book.synthesize([上一停靠点, 新停靠点]) 取带 citation 的解释;\
⑦讲完就停:终答=结构位置一句 + 简短讲解 + 一句『继续顺读,还是想回看/深入/要例子?』,然后等用户下一句。\
一个回合只前进一个停靠点,不要一次连读整章。\
裸『没懂』兜底——当用户只说『没懂/看不明白』这类无具体指向的反馈(没说要例子/要关联/要回看哪),不要凭两字猜方向:\
①调 book.unvisited_back(当前 anchor) 拿确定性的未读前置;\
②返回空 → 该回看的前置都读过了,歧义落在讲法:调 book.synthesize([当前停靠点]) 换个讲法原地重讲一遍(不跳走),不要反问;\
③返回非空 → 可能缺前置:先重讲一遍 + 提议一句『要不要先回看 {首项 LID}(前置)再继续?』,然后等用户定(可撤销——用户说不用就留在原地);\
④若重讲后用户再次『没懂』 → 升级:reader.gotoLid({unvisited_back 首项}) 真带去回看前置。\
未读前置只能取自 book.unvisited_back 返回,不可自己判断哪个读过没读过。\
主动构建用户上下文——当用户显式说『记住/记下 X』,或你在交互中判断某点值得构建进对这个读者的长期理解\
(其背景/偏好/关注/卡点,例如反复追问某主题、明确表达学习目标或卡点)时,\
调 memory.save(type='context', anchor_lid, content, citations?) 把它记下来,免去用户日后重复交代。守三条:\
①认知诚实——content 写成带证据的理解(如『在 §3.2 反复追问所有权,像是卡在这』),不伪装成铁事实、不凭空臆断;\
②citations 锚到支撑该理解的真 LID(取自你读过的 book 工具返回;无具体证据的纯偏好可不带 citations);\
③只记真正值得跨会话复用的,别把每句话都记成 context。记错无妨——记忆透明可见、用户随时可删。\
记录提问点(qa)——每当你用 book.query 回答了用户关于书内容的提问,紧接着调 \
memory.save(type='qa', anchor_lid=<你刚才传给 book.query 的那个 anchor>, content=<用户的原问题>) \
把这个提问点记下来,锚到问题所在的真 LID。这是事实记录(用户在此问过什么),不判断对错、不判断是否卡住。\
只记针对书内容的实质提问;翻页/高亮/记笔记等操作指令、闲聊、对你的元提问都不记。\
带读到某 LID、或要回答关于某 LID 的问题时,可先 memory.recall(lid=<该 LID>, type='qa') \
看读者之前在这里问过什么,据此把解释贴合他关心的点(卡过的地方多讲一点)。\
证据不足时诚实说明,不要编造 LID。准备好最终答案时直接用自然语言回复(不再调用工具)。";

fn classify_paper_minimap_feedback(input: &str) -> Option<&'static str> {
    let text = input.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if has(&[
        "不对",
        "错了",
        "更正",
        "纠正",
        "应该是",
        "incorrect",
        "correct this",
    ]) {
        Some("correction")
    } else if has(&[
        "记住",
        "保存",
        "以后",
        "偏好",
        "remember",
        "persist",
        "save this",
    ]) {
        Some("persistence")
    } else if has(&[
        "太密",
        "太多",
        "简化",
        "少一点",
        "隐藏",
        "dense",
        "clutter",
        "simplify",
    ]) {
        Some("density")
    } else if has(&[
        "没懂",
        "不明白",
        "困惑",
        "看不懂",
        "confused",
        "don't understand",
    ]) {
        Some("confusion")
    } else if has(&[
        "感兴趣",
        "关注",
        "重点",
        "重要",
        "interest",
        "focus on",
        "important",
    ]) {
        Some("interest")
    } else if has(&[
        "我在哪",
        "到哪",
        "位置",
        "结构",
        "全局",
        "where am i",
        "orientation",
    ]) {
        Some("orientation")
    } else {
        None
    }
}

pub fn paper_minimap_agent_context(
    book: &Book,
    reader: &Reader,
    current_goal: Option<&str>,
) -> Option<PaperMinimapAgentContext> {
    let base = book.paper_minimap();
    if base.status == PaperMinimapAvailabilityStatus::Unavailable {
        return None;
    }
    let state = reader.paper_minimap_state();
    let mut landmark_ids = project_paper_minimap_lens(&base, PaperMinimapMode::Skim, None)
        .ok()
        .map(|lens| lens.global_landmark_ids)
        .unwrap_or_default();
    landmark_ids.extend(
        state
            .session_overlay
            .emphasized_landmark_ids
            .iter()
            .cloned(),
    );
    landmark_ids.extend(state.session_overlay.pinned_landmark_ids.iter().cloned());
    landmark_ids.extend(state.saved_user_overlay.pinned_landmark_ids.iter().cloned());
    landmark_ids.extend(state.session_overlay.hidden_landmark_ids.iter().cloned());
    landmark_ids.extend(state.saved_user_overlay.hidden_landmark_ids.iter().cloned());
    if let Some(landmark_id) = state
        .map_focus
        .as_ref()
        .and_then(|focus| focus.landmark_id.clone())
    {
        landmark_ids.push(landmark_id);
    }
    let mut seen = HashSet::new();
    landmark_ids.retain(|landmark_id| seen.insert(landmark_id.clone()));
    landmark_ids.truncate(12);

    let session_pins: HashSet<&str> = state
        .session_overlay
        .pinned_landmark_ids
        .iter()
        .map(String::as_str)
        .collect();
    let saved_pins: HashSet<&str> = state
        .saved_user_overlay
        .pinned_landmark_ids
        .iter()
        .map(String::as_str)
        .collect();
    let hidden: HashSet<&str> = state
        .session_overlay
        .hidden_landmark_ids
        .iter()
        .chain(state.saved_user_overlay.hidden_landmark_ids.iter())
        .map(String::as_str)
        .collect();
    let emphasized: HashSet<&str> = state
        .session_overlay
        .emphasized_landmark_ids
        .iter()
        .map(String::as_str)
        .collect();
    let selected: HashSet<&str> = landmark_ids.iter().map(String::as_str).collect();
    let landmarks = base
        .landmarks
        .iter()
        .filter(|landmark| selected.contains(landmark.landmark_id.as_str()))
        .map(|landmark| {
            let landmark_id = landmark.landmark_id.as_str();
            let landmark_state =
                if session_pins.contains(landmark_id) || saved_pins.contains(landmark_id) {
                    PaperMinimapAgentLandmarkState::Pinned
                } else if hidden.contains(landmark_id) {
                    PaperMinimapAgentLandmarkState::Hidden
                } else if emphasized.contains(landmark_id)
                    || state
                        .saved_user_overlay
                        .emphasized_kinds
                        .contains(&landmark.kind)
                {
                    PaperMinimapAgentLandmarkState::Emphasized
                } else {
                    PaperMinimapAgentLandmarkState::Normal
                };
            PaperMinimapAgentLandmark {
                landmark_id: landmark.landmark_id.clone(),
                kind: landmark.kind.clone(),
                anchor_lid: landmark.anchor_lid.clone(),
                page_index: landmark.page_index,
                label: landmark.label.clone(),
                state: landmark_state,
            }
        })
        .collect();
    let current_goal = current_goal
        .map(str::trim)
        .filter(|goal| !goal.is_empty())
        .map(String::from);
    let latest_feedback = current_goal
        .as_deref()
        .and_then(classify_paper_minimap_feedback)
        .map(String::from);
    Some(PaperMinimapAgentContext {
        map_rev: base.fingerprint,
        state_rev: state.rev,
        topology: base.regions,
        position: state.viewport_position,
        mode: state.mode,
        landmarks,
        user_signal: PaperMinimapAgentUserSignal {
            current_goal,
            latest_feedback,
        },
        allowed_actions: vec![
            "focus_region".into(),
            "focus_landmark".into(),
            "emphasize_landmarks".into(),
            "select_local_projection".into(),
            "set_layer_visibility".into(),
            "pin_landmark".into(),
            "unpin_landmark".into(),
            "set_mode_lens_proposal".into(),
            "saved_overlay_proposal".into(),
        ],
    })
}

fn paper_minimap_contextual_question(book: &Book, reader: &Reader, question: &str) -> String {
    let Some(context) = paper_minimap_agent_context(book, reader, Some(question)) else {
        return question.to_string();
    };
    let context_json = serde_json::to_string(&context).unwrap_or_else(|_| "{}".into());
    format!(
        "{question}\n\n<paper_minimap_agent_context>{context_json}</paper_minimap_agent_context>"
    )
}

fn reader_state_value(book: &Book, reader: &Reader) -> serde_json::Value {
    let state = reader.state();
    serde_json::json!({
        "viewport": state.viewport,
        "open_panels": state.open_panels,
        "selection": state.selection,
        "layout": state.layout,
        "profile": book.profile_summary(),
        "paper_minimap": reader.paper_minimap_state(),
        "paper_minimap_agent_context": paper_minimap_agent_context(book, reader, None),
    })
}

/// 执行一次工具调用,返回 `(喂回模型的结果 JSON, 可选可撤销 effect)` `[ADR-0015/0026/0030]`。
/// 错误**不降级**:把 ToolError 信封原样回喂,模型据 recovery 自纠。
/// agent 的 highlight/note 落 `session` 层(提议态,用户「保留」才升 long_term `[ADR-0030]`)。
/// 视口变更(goto/scroll)不在此产 effect:由 `run` 按回合首尾 anchor 合并成单条 `Goto`(事务性 undo)。
#[allow(clippy::too_many_arguments)]
fn dispatch(
    name: &str,
    arguments: &str,
    book: &Book,
    store: &mut MemoryStore,
    reader: &mut Reader,
    adapter: &dyn ModelAdapter,
    now: &str,
) -> (String, Option<AgentEffect>) {
    let args: serde_json::Value = match serde_json::from_str(arguments) {
        Ok(v) => v,
        Err(e) => {
            return (
                err_json(
                    "INVALID_RANGE",
                    "validation",
                    &format!("工具参数非合法 JSON: {e}"),
                ),
                None,
            )
        }
    };
    let sget = |k: &str| args.get(k).and_then(|v| v.as_str());

    match name {
        "book.query" => {
            let (Some(q), Some(anchor)) = (sget("query"), sget("anchor_lid")) else {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "book.query 需 query + anchor_lid",
                    ),
                    None,
                );
            };
            let body = match query(book, q, anchor, adapter) {
                Ok(resp) => to_json(&resp),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.synthesize" => {
            let Some(arr) = args.get("lids").and_then(|v| v.as_array()) else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.synthesize 需 lids"),
                    None,
                );
            };
            let lids: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            if lids.len() != arr.len() {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "book.synthesize lids 必须全是字符串",
                    ),
                    None,
                );
            }
            let task = args.get("task").and_then(|v| v.as_str());
            let body = match synthesize(book, &lids, task, adapter) {
                Ok(resp) => to_json(&resp),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.text" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.text 需 lid"),
                    None,
                );
            };
            let body = match book.text(lid, sget("end_lid")) {
                Ok(t) => to_json(&serde_json::json!({ "lid": lid, "text": t })),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.context" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.context 需 lid"),
                    None,
                );
            };
            let k = args.get("k").and_then(|v| v.as_u64()).map(|u| u as usize);
            let granularity = args.get("granularity").and_then(|v| v.as_str());
            let body = match book.context(lid, granularity, k) {
                Ok(c) => to_json(&c),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.concept" => {
            let Some(n) = sget("name") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.concept 需 name"),
                    None,
                );
            };
            let body = match book.concept(n) {
                Ok(c) => to_json(&c),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.structure" => {
            let body = match book.structure(sget("at")) {
                Ok(p) => to_json(&p),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.guide_path" => {
            let body = match book.guide_path(sget("at")) {
                Ok(p) => to_json(&p),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.paper_reading_guide" => {
            let body = match book.paper_reading_guide(sget("mode"), sget("stage")) {
                Ok(p) => to_json(&p),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.paper_metadata" => (to_json(&book.paper_metadata_projection()), None),
        "book.paper_lexicon" => (to_json(&book.paper_lexicon_projection()), None),
        "profile.manifest" => {
            let body = match book.profile_manifest_by_id(sget("profile_id")) {
                Ok(manifest) => to_json(&manifest),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.route_from" => {
            let Some(at) = sget("at") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.route_from 需 at"),
                    None,
                );
            };
            let k = args.get("k").and_then(|v| v.as_u64()).map(|u| u as usize);
            let body = match book.route_from(at, k) {
                Ok(f) => to_json(&f),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.guided_route_from" => {
            let Some(at) = sget("at") else {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "book.guided_route_from 需 at",
                    ),
                    None,
                );
            };
            let k = args.get("k").and_then(|v| v.as_u64()).map(|u| u as usize);
            // 单本阅读状态 `[ADR-0075]`:从持久账本派生 read + engagement 原始信号传入整形。
            let reading_state = store.derive_book_reading_state(&book.base.book_id);
            let body = match crate::guided_route_from(book, at, k, &reading_state) {
                Ok(g) => to_json(&serde_json::json!({ "at": at, "groups": g })),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.unvisited_back" => {
            let Some(at) = sget("at") else {
                return (
                    err_json("INVALID_RANGE", "validation", "book.unvisited_back 需 at"),
                    None,
                );
            };
            // 裸「没懂」兜底 `[ADR-0036 决策3]`:确定性 back ∩ 未读前置,消费单本阅读状态。
            let reading_state = store.derive_book_reading_state(&book.base.book_id);
            let body = match crate::unvisited_back(book, at, &reading_state) {
                Ok(steps) => to_json(&serde_json::json!({ "at": at, "unvisited_back": steps })),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.route_to" => {
            let (Some(from), Some(target)) = (sget("from"), sget("target")) else {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "book.route_to 需 from + target",
                    ),
                    None,
                );
            };
            let k = args.get("k").and_then(|v| v.as_u64()).map(|u| u as usize);
            let body = match book.route_to(from, target, k) {
                Ok(p) => to_json(&serde_json::json!({ "from": from, "target": target, "path": p })),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "book.manifest" => (to_json(&book.manifest()), None),
        "memory.save" => {
            let (Some(ty), Some(anchor), Some(content)) =
                (sget("type"), sget("anchor_lid"), sget("content"))
            else {
                return (
                    err_json(
                        "INVALID_MEMORY_TYPE",
                        "validation",
                        "memory.save 需 type + anchor_lid + content",
                    ),
                    None,
                );
            };
            let layer = if ty == "position" {
                "session"
            } else {
                "long_term"
            };
            // citation 确定性闸 `[ADR-0039]`(承 reader.gotoLid 同款 LID 校验):
            // 每个 cite_lid 校验 ∈ 真 LID 全集,无效**确定性丢弃、不阻断整条**,
            // 零有效 citation 仍可存(content 是用户上下文,非 book 答案,不强制有证据)。
            // 仅当 LLM 显式传 citations 时进闸:不传 → None(承 memory crate note/highlight 自动派生)。
            let citations = args.get("citations").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|lid| book.base.lid_nodes.iter().any(|n| n.lid == *lid))
                    .map(|lid| MemCitation {
                        lid: lid.to_string(),
                        book_id: book.base.book_id.clone(),
                        note: None,
                    })
                    .collect::<Vec<_>>()
            });
            let input = SaveInput {
                mem_id: None,
                mem_type: ty.into(),
                layer: layer.into(),
                book_id: book.base.book_id.clone(),
                anchor: Anchor {
                    lid: Some(anchor.into()),
                    concept: None,
                },
                content: content.into(),
                range: None,
                selection_context: None,
                citations,
                source_session_id: None,
            };
            let body = match store.save(input, now) {
                Ok(r) => to_json(&r),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "memory.recall" => {
            let q = RecallQuery {
                book_id: Some(book.base.book_id.clone()),
                lid: sget("lid").map(String::from),
                mem_type: sget("type").map(String::from),
                layer: sget("layer").map(String::from),
                text: sget("text").map(String::from),
            };
            (to_json(&store.recall(&q)), None)
        }
        "reader.gotoLid" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "reader.gotoLid 需 lid"),
                    None,
                );
            };
            let body = match reader.goto_lid(book, store, lid, now) {
                Ok(e) => to_json(&e),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "reader.scroll" => {
            let Some(delta) = args.get("delta").and_then(|v| v.as_i64()) else {
                return (
                    err_json(
                        "INVALID_RANGE",
                        "validation",
                        "reader.scroll 需 delta(整数)",
                    ),
                    None,
                );
            };
            let body = match reader.scroll(book, store, delta, now) {
                Ok(e) => to_json(&e),
                Err(e) => to_json(&e),
            };
            (body, None)
        }
        "reader.highlight" => {
            let Some(lid) = sget("lid") else {
                return (
                    err_json("INVALID_RANGE", "validation", "reader.highlight 需 lid"),
                    None,
                );
            };
            // agent 标注 = 提议态,落 session 层 `[ADR-0030 决策4]`;agent 高亮整段(range=None `[ADR-0031]`)。
            match reader.highlight(book, store, lid, None, None, "session", now) {
                Ok(e) => {
                    let eff = AgentEffect::Highlight {
                        mem_id: e.highlight_id.clone(),
                        lid: lid.to_string(),
                    };
                    (to_json(&e), Some(eff))
                }
                Err(e) => (to_json(&e), None),
            }
        }
        "reader.note" => {
            let (Some(lid), Some(text)) = (sget("lid"), sget("text")) else {
                return (
                    err_json("INVALID_RANGE", "validation", "reader.note 需 lid + text"),
                    None,
                );
            };
            match reader.note(book, store, lid, text, "session", now) {
                Ok(e) => {
                    let eff = AgentEffect::Note {
                        mem_id: e.note_id.clone(),
                        lid: lid.to_string(),
                        text: text.to_string(),
                    };
                    (to_json(&e), Some(eff))
                }
                Err(e) => (to_json(&e), None),
            }
        }
        "reader.layout.apply" => {
            let Some(actions_value) = args.get("actions") else {
                return (
                    err_json(
                        "INVALID_LAYOUT_ACTION",
                        "validation",
                        "reader.layout.apply 需 actions",
                    ),
                    None,
                );
            };
            let actions =
                match serde_json::from_value::<Vec<ReaderLayoutAction>>(actions_value.clone()) {
                    Ok(actions) => actions,
                    Err(e) => {
                        return (
                            err_json(
                                "INVALID_LAYOUT_ACTION",
                                "validation",
                                &format!("reader.layout.apply actions 非法: {e}"),
                            ),
                            None,
                        )
                    }
                };
            match reader.apply_layout_actions(book, actions) {
                Ok(ReaderLayoutApplyOutcome::Effect { effect }) => {
                    let body = to_json(&ReaderLayoutApplyOutcome::Effect {
                        effect: effect.clone(),
                    });
                    (body, Some(AgentEffect::Layout { effect }))
                }
                Ok(ReaderLayoutApplyOutcome::Proposal { proposal }) => {
                    let body = to_json(&ReaderLayoutApplyOutcome::Proposal {
                        proposal: proposal.clone(),
                    });
                    (body, Some(AgentEffect::LayoutProposal { proposal }))
                }
                Err(e) => (to_json(&e), None),
            }
        }
        "reader.paper_minimap.apply" => {
            let Some(base_state_rev) = args.get("base_state_rev").and_then(|value| value.as_u64())
            else {
                return (
                    err_json(
                        "INVALID_PAPER_MINIMAP_ACTION",
                        "validation",
                        "reader.paper_minimap.apply requires base_state_rev",
                    ),
                    None,
                );
            };
            let Some(commands_value) = args.get("commands") else {
                return (
                    err_json(
                        "INVALID_PAPER_MINIMAP_ACTION",
                        "validation",
                        "reader.paper_minimap.apply requires commands",
                    ),
                    None,
                );
            };
            let commands =
                match serde_json::from_value::<Vec<PaperMinimapCommand>>(commands_value.clone()) {
                    Ok(commands) => commands,
                    Err(error) => {
                        return (
                            err_json(
                                "INVALID_PAPER_MINIMAP_ACTION",
                                "validation",
                                &format!("invalid paper minimap commands: {error}"),
                            ),
                            None,
                        )
                    }
                };
            let evidence_lids = match args.get("evidence_lids") {
                Some(value) => match serde_json::from_value::<Vec<String>>(value.clone()) {
                    Ok(lids) => lids,
                    Err(error) => {
                        return (
                            err_json(
                                "INVALID_PAPER_MINIMAP_ACTION",
                                "validation",
                                &format!("invalid minimap evidence_lids: {error}"),
                            ),
                            None,
                        )
                    }
                },
                None => Vec::new(),
            };
            match reader.apply_paper_minimap_commands(
                book,
                base_state_rev,
                PaperMinimapActor::Agent,
                commands,
                sget("reason").unwrap_or("agent paper minimap action"),
                evidence_lids,
                None,
                now,
            ) {
                Ok(PaperMinimapApplyOutcome::Effect { effect }) => {
                    let body = to_json(&PaperMinimapApplyOutcome::Effect {
                        effect: effect.clone(),
                    });
                    (body, Some(AgentEffect::PaperMinimap { effect }))
                }
                Ok(PaperMinimapApplyOutcome::Proposal { proposal }) => {
                    let body = to_json(&PaperMinimapApplyOutcome::Proposal {
                        proposal: proposal.clone(),
                    });
                    (body, Some(AgentEffect::PaperMinimapProposal { proposal }))
                }
                Ok(PaperMinimapApplyOutcome::Noop { state }) => {
                    (to_json(&PaperMinimapApplyOutcome::Noop { state }), None)
                }
                Err(error) => (to_json(&error), None),
            }
        }
        "reader.state" => (to_json(&reader_state_value(book, reader)), None),
        other => (
            err_json("INVALID_RANGE", "validation", &format!("未知工具: {other}")),
            None,
        ),
    }
}

/// 踪迹结果摘要:截断到 200 字(book.query 的 citations 链落在此,对用户可见 `[ADR-0030]`)。
fn digest(s: &str) -> String {
    s.chars().take(200).collect()
}

/// 回合收尾:视口若较回合前 anchor 变了,合并成单条 `Goto` effect(事务性 undo `[ADR-0030]`)。
fn with_goto(reader: &Reader, before: &str, mut effects: Vec<AgentEffect>) -> Vec<AgentEffect> {
    let after = reader.state().viewport.anchor_lid;
    if after != before {
        effects.push(AgentEffect::Goto {
            before_anchor: before.to_string(),
            after_anchor: after,
        });
    }
    effects
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| {
        err_json(
            "INTERNAL_ERROR",
            "internal",
            &format!("结果序列化失败: {e}"),
        )
    })
}

fn err_json(error_code: &str, category: &str, message: &str) -> String {
    to_json(&ToolError {
        error_code: error_code.into(),
        category: category.into(),
        message: message.into(),
    })
}

/// 新建一个对话会话的初始 `messages`(仅 system)`[ADR-0030]`:供 server `/agent/new` 重置、
/// CLI/测试起会话。messages 由调用方(server `AppState`)跨回合持有,run 不再自建。
pub fn new_session() -> Vec<Message> {
    vec![Message::system(SYSTEM_PROMPT)]
}

fn messages_with_profile_snapshot(
    messages: &[Message],
    profile_snapshot: &ReaderProfileSnapshot,
) -> Vec<Message> {
    let insert_at = messages
        .iter()
        .position(|message| message.role != Role::System)
        .unwrap_or(messages.len());
    let mut request = Vec::with_capacity(messages.len() + 1);
    request.extend_from_slice(&messages[..insert_at]);
    request.push(Message::system(profile_snapshot.to_prompt_data()));
    request.extend_from_slice(&messages[insert_at..]);
    request
}

/// 外层 E 编排 loop `[ADR-0026/0016/0030]`:LLM 自主多轮调工具,双重停机诚实标 incomplete。
/// `reader`/`messages` 由调用方注入(与前端共享同一会话态视口 + 跨回合 messages `[ADR-0030 决策2]`);
/// 本回合(一次调用)的可撤销 `effects` + 查询 `trace` 随 `OuterOutcome` 返回。
#[allow(clippy::too_many_arguments)]
pub fn run(
    book: &Book,
    store: &mut MemoryStore,
    reader: &mut Reader,
    adapter: &dyn ModelAdapter,
    messages: &mut Vec<Message>,
    profile_snapshot: &ReaderProfileSnapshot,
    question: &str,
    now: &str,
    cfg: OuterConfig,
) -> Result<OuterOutcome, ToolError> {
    let tools = tool_specs();
    messages.push(Message::user(paper_minimap_contextual_question(
        book, reader, question,
    ))); // system 由 new_session 注入;messages 跨回合保留
    let before_anchor = reader.state().viewport.anchor_lid; // 回合前视口锚(viewport undo 基准)
    let mut effects: Vec<AgentEffect> = Vec::new();
    let mut trace: Vec<TraceStep> = Vec::new();
    let trace_dbg = std::env::var("UB_TRACE").is_ok(); // 诊断:打印每轮 tool_calls + 结果(env-gated)
    let mut spent: u32 = 0;
    let mut turns: usize = 0;

    loop {
        turns += 1;
        let request_messages = messages_with_profile_snapshot(messages, profile_snapshot);
        let turn: AssistantTurn =
            adapter
                .chat(&request_messages, &tools)
                .map_err(|e| ToolError {
                    error_code: "PROVIDER_ERROR".into(),
                    category: "provider".into(),
                    message: e.message,
                })?;
        spent += turn
            .usage_total_tokens
            .unwrap_or_else(|| messages_estimate(&request_messages));

        if trace_dbg {
            eprintln!(
                "── turn {turns}: text={:?} tool_calls={:?}",
                turn.text
                    .as_deref()
                    .map(|t| t.chars().take(60).collect::<String>()),
                turn.tool_calls
                    .iter()
                    .map(|t| format!("{}({})", t.name, t.arguments))
                    .collect::<Vec<_>>()
            );
        }

        // 正常停:无工具请求 = LLM 给最终答。终答入 messages(跨回合保留,下一回合可见上轮回答)。
        if turn.tool_calls.is_empty() {
            messages.push(Message {
                role: Role::Assistant,
                content: turn.text.clone(),
                tool_calls: vec![],
                tool_call_id: None,
            });
            return Ok(OuterOutcome {
                answer: turn.text,
                incomplete: false,
                warning: None,
                turns,
                tokens_spent: spent,
                effects: with_goto(reader, &before_anchor, effects),
                trace,
            });
        }

        // 追加 assistant 回合(含 tool_calls),再逐个执行工具、回填 tool 结果 + 攒 effects/trace。
        messages.push(Message {
            role: Role::Assistant,
            content: turn.text.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_call_id: None,
        });
        for tc in &turn.tool_calls {
            let (result, effect) =
                dispatch(&tc.name, &tc.arguments, book, store, reader, adapter, now);
            if trace_dbg {
                eprintln!(
                    "   ↳ {} => {}",
                    tc.name,
                    result.chars().take(180).collect::<String>()
                );
            }
            trace.push(TraceStep {
                tool: tc.name.clone(),
                args: tc.arguments.clone(),
                result_digest: digest(&result),
            });
            if let Some(e) = effect {
                effects.push(e);
            }
            messages.push(Message {
                role: Role::Tool,
                content: Some(result),
                tool_calls: vec![],
                tool_call_id: Some(tc.id.clone()),
            });
        }

        // 硬闸双重停机:max_turns ∨ token 触顶 → 诚实标 incomplete,不假装完整。
        if turns >= cfg.max_turns || spent > cfg.token_budget {
            return Ok(OuterOutcome {
                answer: turn.text,
                incomplete: true,
                warning: Some("CONTEXT_BUDGET_EXCEEDED".into()),
                turns,
                tokens_spent: spent,
                effects: with_goto(reader, &before_anchor, effects),
                trace,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        parse_react_assistant_turn, AdapterError, CompletionRequest, ParsedResponse, RawCitation,
        ToolCall,
    };
    use base_schema::{sample_base, GraphEdge, GraphNode, LidNode, NodeKind, ReadOnlyBase, Span};
    use memory::{
        Applicability, CreateProfileFact, EvidenceRef, FactSource, PreferenceClaim, ProfilePayload,
        ProfileScope, Sensitivity, SnapshotContext, SnapshotRequest,
    };
    use read_tools::{
        ContentProfileId, LayoutRegion, LayoutSize, LayoutSizeKind, ReaderLayoutAction,
        ReaderLayoutEffect, ReaderLayoutState,
    };
    use reader::DEFAULT_RADIUS;
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};
    use std::path::PathBuf;

    /// 双队列脚本替身:chat 回合 + (内层 book.query 触发的)complete 回合各一队,按序吐。
    struct FakeAdapter {
        chats: RefCell<VecDeque<AssistantTurn>>,
        completes: RefCell<VecDeque<ParsedResponse>>,
    }
    struct ScriptedReActAdapter {
        chats: RefCell<VecDeque<String>>,
        completes: RefCell<VecDeque<ParsedResponse>>,
    }
    struct RecordingAdapter {
        chats: RefCell<VecDeque<AssistantTurn>>,
        seen_messages: RefCell<Vec<Vec<Message>>>,
    }
    impl FakeAdapter {
        fn new(chats: Vec<AssistantTurn>, completes: Vec<ParsedResponse>) -> Self {
            FakeAdapter {
                chats: RefCell::new(chats.into()),
                completes: RefCell::new(completes.into()),
            }
        }
    }
    impl ModelAdapter for FakeAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.completes
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "fake complete 脚本耗尽".into(),
                })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            self.chats
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "fake chat 脚本耗尽".into(),
                })
        }
    }
    impl ScriptedReActAdapter {
        fn new(chats: Vec<&str>, completes: Vec<ParsedResponse>) -> Self {
            ScriptedReActAdapter {
                chats: RefCell::new(chats.into_iter().map(String::from).collect()),
                completes: RefCell::new(completes.into()),
            }
        }
    }
    impl ModelAdapter for ScriptedReActAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.completes
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "react fake complete 脚本耗尽".into(),
                })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            let raw = self
                .chats
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "react fake chat 脚本耗尽".into(),
                })?;
            parse_react_assistant_turn(&raw)
        }
    }

    impl ModelAdapter for RecordingAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            Err(AdapterError {
                message: "recording adapter complete is not scripted".into(),
            })
        }

        fn chat(
            &self,
            messages: &[Message],
            _tools: &[ToolSpec],
        ) -> Result<AssistantTurn, AdapterError> {
            self.seen_messages.borrow_mut().push(messages.to_vec());
            self.chats
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| AdapterError {
                    message: "recording chat script exhausted".into(),
                })
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        book: &Book,
        store: &mut MemoryStore,
        reader: &mut Reader,
        adapter: &dyn ModelAdapter,
        messages: &mut Vec<Message>,
        question: &str,
        now: &str,
        cfg: OuterConfig,
    ) -> Result<OuterOutcome, ToolError> {
        let content_profile = match book.content_profile_id() {
            ContentProfileId::TechnicalLearning => "technical_learning",
            ContentProfileId::Paper => "paper",
        };
        let request = SnapshotRequest::current(SnapshotContext {
            book_id: Some(book.base.book_id.clone()),
            content_profile: Some(content_profile.into()),
            now: Some(now.into()),
            ..Default::default()
        });
        let snapshot = store.project_reader_profile_snapshot(&request);
        super::run(
            book, store, reader, adapter, messages, &snapshot, question, now, cfg,
        )
    }

    fn book() -> Book {
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }

    fn paper_book(name: &str) -> (Book, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ub-orch-paper-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = "# Introduction\nWhich method works?\n";
        let heading_end = "# Introduction\n".encode_utf16().count();
        let source_end = source.encode_utf16().count();
        let base = ReadOnlyBase {
            book_id: "runtime-paper".into(),
            lid_nodes: vec![
                LidNode {
                    lid: "1".into(),
                    path: vec![1],
                    kind: NodeKind::Chapter,
                    span: Span {
                        start: 0,
                        end: source_end,
                    },
                    children: vec!["1.1".into()],
                },
                LidNode {
                    lid: "1.1".into(),
                    path: vec![1, 1],
                    kind: NodeKind::Section,
                    span: Span {
                        start: 0,
                        end: source_end,
                    },
                    children: vec!["1.1.1".into()],
                },
                LidNode {
                    lid: "1.1.1".into(),
                    path: vec![1, 1, 1],
                    kind: NodeKind::Paragraph,
                    span: Span {
                        start: heading_end,
                        end: source_end,
                    },
                    children: Vec::new(),
                },
            ],
            graph_nodes: Vec::new(),
            graph_edges: Vec::new(),
        };
        std::fs::write(dir.join("base.json"), serde_json::to_string(&base).unwrap()).unwrap();
        std::fs::write(dir.join("source.txt"), source).unwrap();
        std::fs::write(
            dir.join("book_structure.json"),
            serde_json::json!({
                "header": {
                    "book_id": "runtime-paper", "book_version": "v1",
                    "profile_id": "paper", "profile_version": "paper_v0",
                    "core_schema_version": "core_v0", "generated_at": "t0"
                },
                "spine": [], "throughlines": [], "key_stops": []
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("source_manifest.json"),
            serde_json::json!({
                "version": "source_manifest.v2", "book_id": "runtime-paper",
                "canonical_source": {"path": "source.txt", "sha256": "sha-a"},
                "capabilities": {
                    "view_pdf": {"status": "available"},
                    "project_lid_to_pdf": {"status": "available", "config_hash": "cfg-a"}
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("pdf_source_map.json"),
            serde_json::json!({
                "version": "pdf_source_map.v1", "book_id": "runtime-paper",
                "pages": [{"pageIndex": 0}],
                "entries": [{
                    "lid": "1.1.1",
                    "source_span": {"start": heading_end, "end": source_end},
                    "regions": [{"pageIndex": 0}]
                }],
                "config_hash": "cfg-a"
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("discourse_index.json"),
            serde_json::json!({
                "items": [{
                    "lid": "1.1.1", "mode": "argumentative",
                    "local_function": "research_question",
                    "local_summary": "Which method works?", "relations": []
                }]
            })
            .to_string(),
        )
        .unwrap();
        (Book::load(dir.to_str().unwrap()).unwrap(), dir)
    }
    /// 容器 "1" 下挂 n 个叶 "1.1".."1.n"(各 10 字符),供视口跳转/合并测试(首叶 "1.1")。
    fn book_leaves(n: usize) -> Book {
        let mut lid_nodes = vec![LidNode {
            lid: "1".into(),
            path: vec![1],
            kind: NodeKind::Chapter,
            span: Span {
                start: 0,
                end: n * 10,
            },
            children: (1..=n).map(|i| format!("1.{i}")).collect(),
        }];
        for i in 1..=n {
            lid_nodes.push(LidNode {
                lid: format!("1.{i}"),
                path: vec![1, i as u32],
                kind: NodeKind::Paragraph,
                span: Span {
                    start: (i - 1) * 10,
                    end: i * 10,
                },
                children: vec![],
            });
        }
        Book::new(
            ReadOnlyBase {
                book_id: "bookL".into(),
                lid_nodes,
                graph_nodes: Vec::<GraphNode>::new(),
                graph_edges: Vec::<GraphEdge>::new(),
            },
            &"X".repeat(n * 10),
        )
    }
    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-orch-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }
    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args.into(),
        }
    }
    fn turn_calls(calls: Vec<ToolCall>) -> AssistantTurn {
        AssistantTurn {
            text: None,
            tool_calls: calls,
            usage_total_tokens: Some(10),
        }
    }
    fn turn_final(text: &str) -> AssistantTurn {
        AssistantTurn {
            text: Some(text.into()),
            tool_calls: vec![],
            usage_total_tokens: Some(10),
        }
    }

    #[test]
    fn profile_snapshot_is_ephemeral_and_frozen_across_the_tool_loop() {
        let b = book();
        let mut store = MemoryStore::open(tmp("profile-snapshot-loop")).unwrap();
        store
            .create_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Global,
                    applicability: Applicability::Any,
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: "depth".into(),
                        value: "detailed".into(),
                    }),
                    source: FactSource::UserStated,
                    evidence: vec![EvidenceRef::Turn {
                        session_id: "seed".into(),
                        turn_id: "turn".into(),
                    }],
                    confidence: None,
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        let request = SnapshotRequest::current(SnapshotContext {
            book_id: Some(b.base.book_id.clone()),
            content_profile: Some("technical_learning".into()),
            now: Some("2026-01-02T00:00:00Z".into()),
            ..Default::default()
        });
        let snapshot = store.project_reader_profile_snapshot(&request);
        assert_eq!(snapshot.source_revision, 1);

        let adapter = RecordingAdapter {
            chats: RefCell::new(
                vec![
                    turn_calls(vec![call(
                        "save",
                        "memory.save",
                        r#"{"type":"context","anchor_lid":"1.1","content":"loop mutation"}"#,
                    )]),
                    turn_final("done"),
                ]
                .into(),
            ),
            seen_messages: RefCell::new(Vec::new()),
        };
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = super::run(
            &b,
            &mut store,
            &mut reader,
            &adapter,
            &mut messages,
            &snapshot,
            "remember the current request first",
            "2026-01-02T00:00:00Z",
            OuterConfig::default(),
        )
        .unwrap();
        assert_eq!(out.answer.as_deref(), Some("done"));
        assert_eq!(store.projection_revision(), 2);

        let seen = adapter.seen_messages.borrow();
        assert_eq!(seen.len(), 2);
        for request_messages in seen.iter() {
            let snapshots: Vec<&str> = request_messages
                .iter()
                .filter_map(|message| message.content.as_deref())
                .filter(|content| content.starts_with("reader_profile_snapshot.v1"))
                .collect();
            assert_eq!(snapshots.len(), 1);
            assert!(snapshots[0].contains("source_revision=1"));
            assert!(snapshots[0].contains("detailed"));
            let snapshot_index = request_messages
                .iter()
                .position(|message| {
                    message
                        .content
                        .as_deref()
                        .is_some_and(|content| content.starts_with("reader_profile_snapshot.v1"))
                })
                .unwrap();
            let user_index = request_messages
                .iter()
                .position(|message| message.role == Role::User)
                .unwrap();
            assert!(snapshot_index < user_index);
        }
        let persisted = serde_json::to_string(&messages).unwrap();
        assert!(!persisted.contains("reader_profile_snapshot.v1"));
        assert!(!persisted.contains("detailed"));
    }

    // 多跳收敛:chat 调 book.query(触发内层 complete)→ chat 调 memory.save → chat 终答。
    #[test]
    fn multihop_query_then_save_then_finish() {
        let b = book();
        let mut store = MemoryStore::open(tmp("multihop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call(
                    "c1",
                    "book.query",
                    r#"{"query":"命令模式?","anchor_lid":"1.1"}"#,
                )]),
                turn_calls(vec![call(
                    "c2",
                    "memory.save",
                    r#"{"type":"note","anchor_lid":"1.1","content":"命令=对象化的调用"}"#,
                )]),
                turn_final("命令模式把请求封装成对象。"),
            ],
            // 内层 book.query 的合一轮:充分 + 真 LID citation
            vec![ParsedResponse {
                sufficient: true,
                answer: Some("命令模式".into()),
                citations: vec![RawCitation {
                    lid: "1.1".into(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            }],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "命令模式是什么",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.answer.as_deref(), Some("命令模式把请求封装成对象。"));
        assert_eq!(out.turns, 3);
        // memory.save 真落库 + citation 自动锚回 1.1
        let recalled = store.recall(&RecallQuery::default());
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].citations[0].lid, "1.1");
    }

    #[test]
    fn native_and_react_adapters_converge_on_runtime_tool_results() {
        let b = book();
        let run_once = |adapter: &dyn ModelAdapter, suffix: &str| {
            let mut store = MemoryStore::open(tmp(&format!("provider-converge-{suffix}"))).unwrap();
            let mut reader = Reader::new(&b, DEFAULT_RADIUS);
            let mut messages = new_session();
            run(
                &b,
                &mut store,
                &mut reader,
                adapter,
                &mut messages,
                "读 1.1",
                "t0",
                OuterConfig::default(),
            )
            .unwrap()
        };

        let native = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "book.text", r#"{"lid":"1.1"}"#)]),
                turn_final("已读取 1.1"),
            ],
            vec![],
        );
        let react = ScriptedReActAdapter::new(
            vec![
                r#"{"tool_calls":[{"name":"book.text","arguments":{"lid":"1.1"}}]}"#,
                r#"{"final":"已读取 1.1"}"#,
            ],
            vec![],
        );

        let native_out = run_once(&native, "native");
        let react_out = run_once(&react, "react");
        assert_eq!(native_out.answer, react_out.answer);
        assert_eq!(native_out.trace.len(), 1);
        assert_eq!(react_out.trace.len(), 1);
        assert_eq!(native_out.trace[0].tool, "book.text");
        assert_eq!(react_out.trace[0].tool, "book.text");
        assert!(native_out.trace[0].result_digest.contains(r#""lid":"1.1""#));
        assert!(react_out.trace[0].result_digest.contains(r#""lid":"1.1""#));
    }

    #[test]
    fn react_protocol_error_maps_to_provider_error() {
        let b = book();
        let mut store = MemoryStore::open(tmp("react-provider-error")).unwrap();
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let react = ScriptedReActAdapter::new(vec!["我要调用 book.text"], vec![]);
        let err = run(
            &b,
            &mut store,
            &mut reader,
            &react,
            &mut messages,
            "读 1.1",
            "t0",
            OuterConfig::default(),
        )
        .unwrap_err();
        assert_eq!(err.category, "provider");
        assert_eq!(err.error_code, "PROVIDER_ERROR");
        assert!(err.message.contains("ReAct 输出抽不到合法 JSON 对象"));
    }

    // P3-1 带读骨架:一个停靠点回合走通 reader.state → book.route_from → reader.gotoLid → book.synthesize → 终答。
    // 测的是带读管道串得通(确定性、回归保护),非 prompt 智能(后者靠真 LLM 手动验)。
    #[test]
    fn guided_read_one_stop_pipeline() {
        let b = book_leaves(3);
        let mut store = MemoryStore::open(tmp("guided")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "reader.state", "{}")]),
                turn_calls(vec![call("c2", "book.route_from", r#"{"at":"1.1"}"#)]),
                turn_calls(vec![call("c3", "reader.gotoLid", r#"{"lid":"1.2"}"#)]),
                turn_calls(vec![call(
                    "c4",
                    "book.synthesize",
                    r#"{"lids":["1.1","1.2"]}"#,
                )]),
                turn_final("这一段承接上一段。继续顺读,还是想回看/深入/要例子?"),
            ],
            // synthesize 单批一次 complete:citations 全在输入 lids 内
            vec![ParsedResponse {
                sufficient: true,
                answer: Some("两段的综合".into()),
                citations: vec![
                    RawCitation {
                        lid: "1.1".into(),
                        text: "片段a".into(),
                        role: "support".into(),
                    },
                    RawCitation {
                        lid: "1.2".into(),
                        text: "片段b".into(),
                        role: "support".into(),
                    },
                ],
                model_supplement: vec![],
            }],
        );
        let mut reader = Reader::new(&b, 1);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "带我读这一章",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 5);
        assert_eq!(
            out.answer.as_deref(),
            Some("这一段承接上一段。继续顺读,还是想回看/深入/要例子?")
        );
        // 视口跳转按回合首尾合并成单条 Goto(1.1 → 1.2),可撤销
        assert_eq!(out.effects.len(), 1);
        match &out.effects[0] {
            AgentEffect::Goto {
                before_anchor,
                after_anchor,
            } => {
                assert_eq!(before_anchor, "1.1");
                assert_eq!(after_anchor, "1.2");
            }
            other => panic!("期望 Goto,得到 {other:?}"),
        }
        // 带读管道工具序列:state → route_from → gotoLid → synthesize
        let tools: Vec<&str> = out.trace.iter().map(|t| t.tool.as_str()).collect();
        assert_eq!(
            tools,
            vec![
                "reader.state",
                "book.route_from",
                "reader.gotoLid",
                "book.synthesize"
            ]
        );
    }

    // 双重停机:max_turns 触顶,每轮都请求工具 → 诚实标 incomplete + CONTEXT_BUDGET_EXCEEDED。
    #[test]
    fn halts_at_max_turns_marks_incomplete() {
        let b = book();
        let mut store = MemoryStore::open(tmp("halt")).unwrap();
        // 每轮都调 manifest(确定性、不触 complete),永不终答
        let chats = vec![
            turn_calls(vec![call("a", "book.manifest", "{}")]),
            turn_calls(vec![call("b", "book.manifest", "{}")]),
            turn_calls(vec![call("c", "book.manifest", "{}")]),
        ];
        let fake = FakeAdapter::new(chats, vec![]);
        let cfg = OuterConfig {
            max_turns: 2,
            token_budget: 1_000_000,
        };
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "绕圈",
            "t0",
            cfg,
        )
        .unwrap();
        assert!(out.incomplete);
        assert_eq!(out.warning.as_deref(), Some("CONTEXT_BUDGET_EXCEEDED"));
        assert_eq!(out.turns, 2);
    }

    // 工具错误回喂不降级:book.text 取不存在 LID → 直接验 dispatch 回喂 LID_NOT_FOUND 信封(非静默)。
    #[test]
    fn tool_error_fed_back_not_silent() {
        let b = book();
        let mut store = MemoryStore::open(tmp("err")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let (out, eff) = dispatch(
            "book.text",
            r#"{"lid":"9.9"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(out.contains("LID_NOT_FOUND"));
        assert!(out.contains("not_found"));
        assert!(eff.is_none()); // 报错不产 effect
    }

    // ---- P8-3 route 命令面暴露 ----
    #[test]
    fn tool_specs_exposes_route_commands() {
        let names: Vec<String> = tool_specs().into_iter().map(|s| s.name).collect();
        assert!(names.iter().any(|n| n == "book.structure"));
        assert!(names.iter().any(|n| n == "book.guide_path"));
        assert!(names.iter().any(|n| n == "book.paper_reading_guide"));
        assert!(names.iter().any(|n| n == "book.paper_metadata"));
        assert!(names.iter().any(|n| n == "book.paper_lexicon"));
        assert!(names.iter().any(|n| n == "profile.manifest"));
        assert!(names.iter().any(|n| n == "reader.layout.apply"));
        assert!(names.iter().any(|n| n == "book.route_from"));
        assert!(names.iter().any(|n| n == "book.route_to"));
        assert!(names.iter().any(|n| n == "book.guided_route_from"));
    }

    #[test]
    fn dispatch_structure_and_guide_path_return_projection_or_tool_error() {
        let b = book();
        let mut store = MemoryStore::open(tmp("structure-tools")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);

        let (structure, eff) = dispatch(
            "book.structure",
            r#"{"at":"1.1"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(structure.contains("\"available\":false"));
        assert!(structure.contains("book_structure.json not attached"));
        assert!(eff.is_none());

        let (guide, eff) = dispatch(
            "book.guide_path",
            r#"{"at":"1.1"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(guide.contains("\"segments\":[]"));
        assert!(guide.contains("\"available\":false"));
        assert!(eff.is_none());

        let (paper, eff) = dispatch(
            "book.paper_reading_guide",
            r#"{"mode":"close","stage":"active"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(paper.contains("\"available\":false"));
        assert!(paper.contains("paper artifacts not attached"));
        assert!(eff.is_none());

        let (metadata, eff) = dispatch(
            "book.paper_metadata",
            r#"{}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(metadata.contains("\"available\":false"));
        assert!(metadata.contains("paper_metadata.json not attached"));
        assert!(eff.is_none());

        let (lexicon, eff) = dispatch(
            "book.paper_lexicon",
            r#"{}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(lexicon.contains("\"entries\":[]"));
        assert!(lexicon.contains("paper_lexicon.json not attached"));
        assert!(eff.is_none());

        let (manifest, eff) = dispatch(
            "profile.manifest",
            r#"{"profile_id":"paper"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(manifest.contains("\"profile_id\":\"paper\""));
        assert!(manifest.contains("paper.structure_map"));
        assert!(eff.is_none());

        let (state, eff) = dispatch(
            "reader.state",
            r#"{}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(state.contains("\"profile_id\":\"technical_learning\""));
        assert!(state.contains("\"allowed_layout_actions\""));
        assert!(state.contains("\"layout\""));
        assert!(state.contains("\"active_preset\":\"technical_read\""));
        assert!(eff.is_none());

        let (bad, _) = dispatch(
            "book.structure",
            r#"{"at":"9.9"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(bad.contains("LID_NOT_FOUND") && bad.contains("not_found"));
    }

    #[test]
    fn dispatch_reader_layout_apply_returns_effect_or_proposal() {
        let b = book();
        let mut store = MemoryStore::open(tmp("layout-dispatch")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);

        let (direct, eff) = dispatch(
            "reader.layout.apply",
            r#"{"actions":[
                {"kind":"open_slot","slot_id":"technical.evidence","region":"right"},
                {"kind":"focus_slot","slot_id":"technical.evidence"},
                {"kind":"pin_evidence","slot_id":"technical.evidence","lid":"1.1","reason":"cite"}
            ]}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(direct.contains("\"kind\":\"effect\""));
        match eff {
            Some(AgentEffect::Layout { effect }) => {
                assert_eq!(effect.before.rev, 0);
                assert_eq!(effect.after.rev, 1);
                assert!(effect
                    .after
                    .open_slots
                    .iter()
                    .any(|slot| slot == "technical.evidence"));
                assert_eq!(effect.after.pinned_evidence[0].lid, "1.1");
            }
            other => panic!("expected layout effect, got {other:?}"),
        }

        let (proposal, eff) = dispatch(
            "reader.layout.apply",
            r#"{"actions":[{"kind":"close_slot","slot_id":"technical.agent"}]}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(proposal.contains("\"kind\":\"proposal\""));
        match eff {
            Some(AgentEffect::LayoutProposal { proposal }) => {
                assert_eq!(proposal.base_layout_rev, 1);
                assert!(matches!(
                    proposal.actions[0],
                    ReaderLayoutAction::CloseSlot { .. }
                ));
            }
            other => panic!("expected layout proposal, got {other:?}"),
        }
        assert!(reader
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "technical.agent"));
    }

    #[test]
    fn agent_effect_layout_contract_serializes() {
        let before = ReaderLayoutState {
            rev: 1,
            active_preset: Some("paper_skim".into()),
            open_slots: vec!["paper.structure_map".into()],
            focused_slot: Some("paper.structure_map".into()),
            pinned_evidence: vec![],
            panel_sizes: HashMap::from([(
                "paper.structure_map".into(),
                LayoutSize {
                    kind: LayoutSizeKind::Percent,
                    value: 30.0,
                },
            )]),
            slot_order: HashMap::new(),
        };
        let effect = AgentEffect::Layout {
            effect: ReaderLayoutEffect {
                before: before.clone(),
                after: ReaderLayoutState { rev: 2, ..before },
                actions: vec![ReaderLayoutAction::OpenSlot {
                    slot_id: "paper.evidence".into(),
                    region: Some(LayoutRegion::Right),
                }],
            },
        };
        let value = serde_json::to_value(effect).unwrap();
        assert_eq!(value["kind"], "Layout");
        assert_eq!(value["effect"]["actions"][0]["kind"], "open_slot");
        assert_eq!(value["effect"]["after"]["rev"], 2);
    }

    #[test]
    fn dispatch_route_from_returns_frontier_and_invalid_at_not_found() {
        let b = book();
        let mut store = MemoryStore::open(tmp("route-from")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let (ok, eff) = dispatch(
            "book.route_from",
            r#"{"at":"1.1"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        // Frontier 总序列化全 5 类键;纯只读不产 effect。
        assert!(ok.contains("\"forward\"") && ok.contains("\"continue\""));
        assert!(eff.is_none());
        let (nf, _) = dispatch(
            "book.route_from",
            r#"{"at":"9.9"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(nf.contains("LID_NOT_FOUND") && nf.contains("not_found"));
    }

    #[test]
    fn dispatch_route_to_wraps_path_and_validates_args() {
        let b = book();
        let mut store = MemoryStore::open(tmp("route-to")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let (ok, eff) = dispatch(
            "book.route_to",
            r#"{"from":"1.1","target":"1.1"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        // 同端点 → 空路径,但 {from,target,path} 信封仍在;只读不产 effect。
        assert!(ok.contains("\"path\"") && ok.contains("\"from\""));
        assert!(eff.is_none());
        // 缺 target → validation 信封。
        let (bad, _) = dispatch(
            "book.route_to",
            r#"{"from":"1.1"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(bad.contains("INVALID_RANGE") && bad.contains("validation"));
    }

    // P3-3 教学整形命令面:guided_route_from 返 {at, groups}(有序分组+剔空),缺 at→validation,只读不产 effect。
    #[test]
    fn dispatch_guided_route_from_returns_ordered_groups_and_validates() {
        let b = book_leaves(3);
        let mut store = MemoryStore::open(tmp("guided-route")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let (ok, eff) = dispatch(
            "book.guided_route_from",
            r#"{"at":"1.1"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        // 1.1 仅 continue(next_sibling 1.2)非空 → 剔空后仅 continue 组;{at, groups} 信封。
        assert!(ok.contains("\"groups\"") && ok.contains("\"at\""));
        assert!(ok.contains("\"category\":\"continue\"") && ok.contains("1.2"));
        assert!(!ok.contains("\"category\":\"forward\"")); // 空组已剔
        assert!(eff.is_none());
        // 缺 at → validation 信封。
        let (bad, _) = dispatch(
            "book.guided_route_from",
            "{}",
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(bad.contains("INVALID_RANGE") && bad.contains("validation"));
    }

    // P3-2 裸「没懂」兜底命令面 `[ADR-0036]`:unvisited_back 返 {at, unvisited_back};缺 at→validation;
    // invalid at→not_found(承 route_from);只读不产 effect。(过滤语义的确定性由 lib.rs 单测覆盖)
    #[test]
    fn dispatch_unvisited_back_returns_envelope_and_validates() {
        let b = book_leaves(3); // 无图边 ⇒ back 空 ⇒ unvisited_back=[](信封仍在)
        let mut store = MemoryStore::open(tmp("unvisited")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let (ok, eff) = dispatch(
            "book.unvisited_back",
            r#"{"at":"1.1"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(ok.contains("\"unvisited_back\"") && ok.contains("\"at\":\"1.1\""));
        assert!(eff.is_none());
        // 缺 at → validation。
        let (bad, _) = dispatch(
            "book.unvisited_back",
            "{}",
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(bad.contains("INVALID_RANGE") && bad.contains("validation"));
        // invalid at → not_found(不静默)。
        let (nf, _) = dispatch(
            "book.unvisited_back",
            r#"{"at":"9.9"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(nf.contains("LID_NOT_FOUND") && nf.contains("not_found"));
    }

    // P4-3 citation 确定性闸 `[ADR-0039]`:context 记忆带 citations,有效 LID 保留、无效丢弃、
    // 零有效仍可存;context 直接落 long_term。承 reader.gotoLid 同款 LID 校验。judgment 智能靠真 LLM 手动验(B2)。
    #[test]
    fn dispatch_memory_save_context_gates_citations() {
        let b = book_leaves(3); // 真 LID: 1, 1.1, 1.2, 1.3
        let mut store = MemoryStore::open(tmp("ctx-cite")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);

        // 混入有效 1.1 + 无效 9.9:无效确定性丢弃、有效保留;context 落 long_term;不产可撤销 effect。
        let (ok, eff) = dispatch(
            "memory.save",
            r#"{"type":"context","anchor_lid":"1.1","content":"读者反复追问所有权,像卡在这","citations":["1.1","9.9"]}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(ok.contains("\"type\":\"context\""));
        assert!(ok.contains("\"layer\":\"long_term\"")); // context 直接 long_term
        assert!(ok.contains("\"lid\":\"1.1\"")); // 有效 citation 保留
        assert!(!ok.contains("9.9")); // 无效 citation 确定性丢弃、不阻断整条
        assert!(eff.is_none()); // memory.save 不产可撤销 effect(撤销走 memory.delete)

        // 零有效 citation(全无效):仍可存(不阻断),citations 为空数组。
        let (ok2, _) = dispatch(
            "memory.save",
            r#"{"type":"context","anchor_lid":"1.2","content":"用户是 Rust 背景(纯偏好,无具体 LID 证据)","citations":["9.9","8.8"]}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t1",
        );
        assert!(ok2.contains("\"type\":\"context\""));
        assert!(ok2.contains("\"citations\":[]")); // 零有效 → 空,仍存
        assert!(!ok2.contains("error_code")); // 不报错

        // 不传 citations 的 context:None → 不自动派生(context 非 note/highlight),空 citations 仍存。
        let (ok3, _) = dispatch(
            "memory.save",
            r#"{"type":"context","anchor_lid":"1.3","content":"读者偏好先看例子再看定义"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t2",
        );
        assert!(ok3.contains("\"citations\":[]"));

        // 落盘可见:recall 取回三条 context(透明账本,用户可见可删)。
        let got = store.recall(&RecallQuery {
            book_id: Some("bookL".into()),
            mem_type: Some("context".into()),
            ..Default::default()
        });
        assert_eq!(got.len(), 3);
    }

    // P4-5 qa-1 生产 `[ADR-0041]`:dispatch memory.save type=qa → 落 long_term + anchor 设 +
    // 不产可撤销 effect;recall(type=qa) 取回;BookReadingState 按 lid 保留 qa_count 原始活动。
    // judgment「是不是实质问题」靠真 LLM 手动验(B2);本测只钉确定性存储 + 派生。
    #[test]
    fn dispatch_memory_save_qa_lands_longterm_and_feeds_engagement() {
        let b = book_leaves(3); // 真 LID: 1, 1.1, 1.2, 1.3
        let mut store = MemoryStore::open(tmp("qa-save")).unwrap();
        let fake = FakeAdapter::new(vec![], vec![]);
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);

        let (ok, eff) = dispatch(
            "memory.save",
            r#"{"type":"qa","anchor_lid":"1.2","content":"这段在讲什么"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t0",
        );
        assert!(ok.contains("\"type\":\"qa\""));
        assert!(ok.contains("\"layer\":\"long_term\"")); // qa 直接 long_term(非 position)
        assert!(ok.contains("\"lid\":\"1.2\"")); // anchor 设
        assert!(eff.is_none()); // qa 不产可撤销 effect

        // 同 lid 再问不同问题 → qa_count=2(内容寻址,两条独立 record)。
        let _ = dispatch(
            "memory.save",
            r#"{"type":"qa","anchor_lid":"1.2","content":"和上一段啥关系"}"#,
            &b,
            &mut store,
            &mut reader,
            &fake,
            "t1",
        );
        let got = store.recall(&RecallQuery {
            book_id: Some("bookL".into()),
            mem_type: Some("qa".into()),
            ..Default::default()
        });
        assert_eq!(got.len(), 2);
        let state = store.derive_book_reading_state("bookL");
        assert_eq!(state.engagement_by_lid["1.2"].qa_count, 2);
    }

    // 闭环验收:agent 经外层 loop 命令面跑通「问→跳转→高亮→记笔记」一次闭环 `[ADR-0007/0015]`。
    // 标注真落记忆层(单一真相源)、citation 锚回真 LID,兑现切片0 总判据第 3 条。
    #[test]
    fn closed_loop_query_goto_highlight_note() {
        let b = book();
        let mut store = MemoryStore::open(tmp("closeloop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call(
                    "c1",
                    "book.query",
                    r#"{"query":"命令模式?","anchor_lid":"1.1"}"#,
                )]),
                turn_calls(vec![call("c2", "reader.gotoLid", r#"{"lid":"1.1"}"#)]),
                turn_calls(vec![call("c3", "reader.highlight", r#"{"lid":"1.1"}"#)]),
                turn_calls(vec![call(
                    "c4",
                    "reader.note",
                    r#"{"lid":"1.1","text":"命令=对象化调用"}"#,
                )]),
                turn_final("命令模式把请求封装成对象,已跳转、高亮并记笔记。"),
            ],
            vec![ParsedResponse {
                sufficient: true,
                answer: Some("命令模式".into()),
                citations: vec![RawCitation {
                    lid: "1.1".into(),
                    text: "片段".into(),
                    role: "support".into(),
                }],
                model_supplement: vec![],
            }],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "讲讲命令模式并高亮记笔记",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 5); // 问→跳转→高亮→记笔记→终答
                                  // S10f effects:agent 标注产 Highlight + Note(undo 材料);首叶=1.1 视口未变,无 Goto。
        assert_eq!(out.effects.len(), 2);
        assert!(matches!(&out.effects[0], AgentEffect::Highlight { lid, .. } if lid == "1.1"));
        assert!(
            matches!(&out.effects[1], AgentEffect::Note { lid, text, .. } if lid == "1.1" && text == "命令=对象化调用")
        );
        // trace 记录每个 tool call(问→跳转→高亮→记笔记 = 4 步),book.query 居首。
        assert_eq!(out.trace.len(), 4);
        assert_eq!(out.trace[0].tool, "book.query");
        // agent 标注落 session 层(提议态,用户「保留」才升 long_term):highlight + note 两条都在 session。
        let sess = store.recall(&RecallQuery {
            layer: Some("session".into()),
            ..Default::default()
        });
        assert_eq!(sess.len(), 2);
        // 跳转→高亮→记笔记 的标注真落记忆层(单源),anchor/citation 锚回真 LID 1.1
        let hl = store.recall(&RecallQuery {
            mem_type: Some("highlight".into()),
            ..Default::default()
        });
        assert_eq!(hl.len(), 1);
        assert_eq!(hl[0].anchor.lid.as_deref(), Some("1.1"));
        let note = store.recall(&RecallQuery {
            mem_type: Some("note".into()),
            ..Default::default()
        });
        assert_eq!(note.len(), 1);
        assert_eq!(note[0].content, "命令=对象化调用");
        assert_eq!(note[0].citations[0].lid, "1.1");
    }

    #[test]
    fn agent_loop_layout_apply_emits_direct_and_proposal_effects() {
        let b = book();
        let mut store = MemoryStore::open(tmp("layout-loop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call(
                    "l1",
                    "reader.layout.apply",
                    r#"{"actions":[
                        {"kind":"open_slot","slot_id":"technical.evidence","region":"right"},
                        {"kind":"focus_slot","slot_id":"technical.evidence"},
                        {"kind":"pin_evidence","slot_id":"technical.evidence","lid":"1.1","reason":"explain this"}
                    ]}"#,
                )]),
                turn_calls(vec![call(
                    "l2",
                    "reader.layout.apply",
                    r#"{"actions":[{"kind":"close_slot","slot_id":"technical.agent"}]}"#,
                )]),
                turn_final("已打开证据面板并提交关闭 agent 面板的确认提议。"),
            ],
            vec![],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "打开证据面板,再关闭 agent 面板",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 3);
        assert_eq!(out.effects.len(), 2);
        assert!(matches!(out.effects[0], AgentEffect::Layout { .. }));
        assert!(matches!(out.effects[1], AgentEffect::LayoutProposal { .. }));
        assert_eq!(out.trace[0].tool, "reader.layout.apply");
        assert_eq!(out.trace[1].tool, "reader.layout.apply");
        assert_eq!(
            reader.layout_state().focused_slot.as_deref(),
            Some("technical.evidence")
        );
        assert!(reader
            .layout_state()
            .open_slots
            .iter()
            .any(|slot| slot == "technical.agent"));
    }

    // loop 在工具报错后仍继续、并能收敛(错误回喂 → 模型读到后终答)。
    #[test]
    fn agent_loop_paper_minimap_tool_emits_effect_and_mode_proposal() {
        let b = book();
        let mut store = MemoryStore::open(tmp("paper-minimap-loop")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call(
                    "m1",
                    "reader.paper_minimap.apply",
                    r#"{"base_state_rev":0,"reason":"reduce density","commands":[{"scope":"session","action":{"kind":"set_layer_visibility","layer":"arguments","visible":false}}]}"#,
                )]),
                turn_calls(vec![call(
                    "m2",
                    "reader.paper_minimap.apply",
                    r#"{"base_state_rev":1,"reason":"deep reading may help","commands":[{"scope":"session","action":{"kind":"set_mode_lens","mode":"deep"}}]}"#,
                )]),
                turn_final("Adjusted density and proposed deep mode."),
            ],
            vec![],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "Make the paper minimap less dense and switch to deep mode",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert_eq!(out.effects.len(), 2);
        assert!(matches!(out.effects[0], AgentEffect::PaperMinimap { .. }));
        assert!(matches!(
            out.effects[1],
            AgentEffect::PaperMinimapProposal { .. }
        ));
        assert!(!reader
            .paper_minimap_state()
            .session_overlay
            .visible_layers
            .iter()
            .any(|layer| layer == "arguments"));
        assert_eq!(
            reader.paper_minimap_state().mode,
            reader::PaperMinimapMode::Skim
        );
    }

    #[test]
    fn paper_minimap_feedback_classifier_covers_the_frozen_policy() {
        for (input, expected) in [
            ("我现在在论文的哪个结构位置?", "orientation"),
            ("我对这个结果很感兴趣", "interest"),
            ("这里我还是没懂", "confusion"),
            ("地图太密了,少一点", "density"),
            ("这个重点不对,请更正", "correction"),
            ("记住我以后都想看证据层", "persistence"),
        ] {
            assert_eq!(classify_paper_minimap_feedback(input), Some(expected));
        }
        assert_eq!(classify_paper_minimap_feedback("继续读"), None);
    }

    #[test]
    fn agent_loop_paper_minimap_policy_emits_effect_proposal_noop_and_clarify() {
        let (b, dir) = paper_book("feedback-policy");
        let base = b.paper_minimap();
        let region = &base.regions[0];
        let landmark = &base.landmarks[0];
        let calls = vec![
            call(
                "p1",
                "reader.paper_minimap.apply",
                &serde_json::json!({
                    "base_state_rev": 0, "reason": "定位当前区域",
                    "commands": [{"scope": "session", "action": {
                        "kind": "focus_region", "region_id": region.region_id
                    }}]
                })
                .to_string(),
            ),
            call(
                "p2",
                "reader.paper_minimap.apply",
                &serde_json::json!({
                    "base_state_rev": 1, "reason": "强调用户关注点",
                    "evidence_lids": [landmark.anchor_lid],
                    "commands": [{"scope": "session", "action": {
                        "kind": "emphasize_landmarks",
                        "landmark_ids": [landmark.landmark_id],
                        "reason": "用户明确表示关注"
                    }}]
                })
                .to_string(),
            ),
            call(
                "p3",
                "reader.paper_minimap.apply",
                &serde_json::json!({
                    "base_state_rev": 2, "reason": "展开当前区域论证槽",
                    "commands": [{"scope": "session", "action": {
                        "kind": "select_local_projection",
                        "region_id": region.region_id,
                        "grammar": "introduction",
                        "focus_slots": ["research_question"]
                    }}]
                })
                .to_string(),
            ),
            call(
                "p4",
                "reader.paper_minimap.apply",
                r#"{"base_state_rev":3,"reason":"降低密度","commands":[{"scope":"session","action":{"kind":"set_layer_visibility","layer":"arguments","visible":false}}]}"#,
            ),
            call(
                "p5",
                "reader.paper_minimap.apply",
                &serde_json::json!({
                    "base_state_rev": 4, "reason": "用户更正地标权重",
                    "commands": [{"scope": "saved", "action": {
                        "kind": "set_landmark_override",
                        "target_landmark_id": landmark.landmark_id,
                        "operation": "deemphasize", "label": null,
                        "user_reason": "用户指出它不是重点"
                    }}]
                })
                .to_string(),
            ),
            call(
                "p6",
                "reader.paper_minimap.apply",
                r#"{"base_state_rev":4,"reason":"保存阅读偏好","commands":[{"scope":"saved","action":{"kind":"save_mode_preference","mode":"skim","visible_layers":["regions","landmarks"]}}]}"#,
            ),
            call(
                "p7",
                "reader.paper_minimap.apply",
                r#"{"base_state_rev":4,"reason":"保持低密度","commands":[{"scope":"session","action":{"kind":"set_layer_visibility","layer":"arguments","visible":false}}]}"#,
            ),
        ];
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![calls[0].clone()]),
                turn_calls(vec![calls[1].clone()]),
                turn_calls(vec![calls[2].clone()]),
                turn_calls(vec![calls[3].clone()]),
                turn_calls(vec![calls[4].clone()]),
                turn_calls(vec![calls[5].clone()]),
                turn_calls(vec![calls[6].clone()]),
                turn_final("请说明你要更正的是地标标签、重要性,还是证据范围。"),
            ],
            vec![],
        );
        let mut store = MemoryStore::open(tmp("paper-minimap-feedback-policy")).unwrap();
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let context = paper_minimap_agent_context(&b, &reader, Some("地图太密了")).unwrap();
        assert_eq!(
            context.user_signal.latest_feedback.as_deref(),
            Some("density")
        );
        assert!(!context
            .allowed_actions
            .iter()
            .any(|action| action == "set_presentation" || action == "update_viewport"));
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "地图太密了,也请关注研究问题;不确定我的更正目标时先问我。",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert_eq!(out.effects.len(), 6);
        assert_eq!(
            out.effects
                .iter()
                .filter(|effect| matches!(effect, AgentEffect::PaperMinimap { .. }))
                .count(),
            4
        );
        assert_eq!(
            out.effects
                .iter()
                .filter(|effect| matches!(effect, AgentEffect::PaperMinimapProposal { .. }))
                .count(),
            2
        );
        assert!(out.answer.unwrap().contains("请说明"));
        assert!(messages[1]
            .content
            .as_deref()
            .unwrap()
            .contains("paper_minimap_agent_context"));
        assert_eq!(reader.paper_minimap_state().rev, 4);
        assert_eq!(
            reader.paper_minimap_state().saved_user_overlay.overlay_rev,
            0
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn loop_continues_after_tool_error_and_converges() {
        let b = book();
        let mut store = MemoryStore::open(tmp("recover")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "book.text", r#"{"lid":"9.9"}"#)]), // 报错回喂
                turn_final("抱歉,该 LID 不存在,据现有信息无法定位。"),
            ],
            vec![],
        );
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "取 9.9",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        assert_eq!(out.turns, 2);
        assert!(out.answer.unwrap().contains("不存在"));
    }

    // S10f:agent 视口跳转(scroll/goto)按回合合并成**单条 Goto** effect(事务性 undo),trace 记录踪迹。
    #[test]
    fn agent_viewport_change_merges_into_single_goto_effect() {
        let b = book_leaves(10); // 首叶 1.1
        let mut store = MemoryStore::open(tmp("goto-merge")).unwrap();
        let fake = FakeAdapter::new(
            vec![
                turn_calls(vec![call("c1", "reader.scroll", r#"{"delta":5}"#)]), // 1.1 → 1.6
                turn_calls(vec![call("c2", "reader.gotoLid", r#"{"lid":"1.8"}"#)]), // 1.6 → 1.8
                turn_final("已翻到目标位置。"),
            ],
            vec![],
        );
        let mut reader = Reader::new(&b, 1);
        let mut messages = new_session();
        let out = run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "翻到 1.8",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(!out.incomplete);
        // 两次视口变更(scroll + goto)合并成一条 Goto:before=回合前首叶 1.1,after=最终 1.8。
        assert_eq!(out.effects.len(), 1);
        assert!(
            matches!(&out.effects[0], AgentEffect::Goto { before_anchor, after_anchor }
            if before_anchor == "1.1" && after_anchor == "1.8")
        );
        // 共享 reader 的视口真被 agent 改到 1.8(双向共享 `[ADR-0030 决策2]`)。
        assert_eq!(reader.state().viewport.anchor_lid, "1.8");
        // trace 记录两步视口工具调用。
        assert_eq!(out.trace.len(), 2);
        assert_eq!(out.trace[0].tool, "reader.scroll");
        assert_eq!(out.trace[1].tool, "reader.gotoLid");
    }

    // S10f:messages 跨回合保留 + new_session 重置(承载会话边界 = 用户「新对话」`[ADR-0030 决策6]`)。
    #[test]
    fn messages_persist_across_turns_and_reset() {
        let b = book();
        let mut store = MemoryStore::open(tmp("messages")).unwrap();
        let mut reader = Reader::new(&b, DEFAULT_RADIUS);
        let mut messages = new_session();
        assert_eq!(messages.len(), 1); // 仅 system
                                       // 第一回合:终答即停 → messages 累积 system + user + assistant。
        let fake = FakeAdapter::new(vec![turn_final("答1")], vec![]);
        run(
            &b,
            &mut store,
            &mut reader,
            &fake,
            &mut messages,
            "问1",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        let after_first = messages.len();
        assert!(after_first > 1);
        // 第二回合:复用同一 messages → 继续累积(跨回合保留)。
        let fake2 = FakeAdapter::new(vec![turn_final("答2")], vec![]);
        run(
            &b,
            &mut store,
            &mut reader,
            &fake2,
            &mut messages,
            "问2",
            "t0",
            OuterConfig::default(),
        )
        .unwrap();
        assert!(messages.len() > after_first);
        // 「新对话」:重置回仅 system。
        messages = new_session();
        assert_eq!(messages.len(), 1);
    }
}
