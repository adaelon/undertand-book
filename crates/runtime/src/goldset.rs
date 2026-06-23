//! S8 金标准集 + 验收闸 `[ADR-0004]` + 体检 §11。
//! 金标准条目 = `{q, anchor_lid, expect_cite[]}`(从真基座确定性推导,**非 LLM 自评**,守 B2)。
//! 逐条调内层 `book.query` → 两类度量:
//!   ① **结构红线**(确定性、系统强制):返回的每条 citation 都是真 LID、无悬空 → 判据 100%。
//!   ② **语义命中信号**(recall/precision):返回 citation ∩ 期望,作**人工评的客观锚**,非自动判定。
//! 自动验收只到结构红线;语义质量达阈 + 人工试读认可由人裁(守 B2:AI 出输入,确定性工具出判定)。
use crate::{query, ModelAdapter, QueryResponse};
use read_tools::{Book, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 金标准条目(人工/确定性推导,固化为 JSON;期望 citation LID 来自基座已锚定的 claim/entity)。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GoldItem {
    pub id: String,
    pub q: String,
    pub anchor_lid: String,
    pub expect_cite: Vec<String>,
}

/// 单条评测结果。
#[derive(Debug, Clone, Serialize)]
pub struct ItemResult {
    pub id: String,
    pub anchor_lid: String,
    pub scope_used: String,
    pub incomplete: bool,
    pub expect_cite: Vec<String>,
    pub returned_cite: Vec<String>,
    /// 结构红线:返回 citation 全是真 LID(无悬空)`[ADR-0004]`。
    pub structural_ok: bool,
    /// 悬空 LID(不在基座);结构红线下应恒空。
    pub dangling: Vec<String>,
    /// 语义召回 = |返回∩期望| / |期望|(人工评客观信号)。
    pub recall: f32,
    /// 语义精确 = |返回∩期望| / |返回|。
    pub precision: f32,
    pub answer: Option<String>,
    /// 该条 query 自身失败(如 provider 偶发空响应,重试后仍失败)的信封消息;成功则 None。
    /// 记录而非静默——errored ≠ 结构红线违例(无 citation 即无悬空),单列统计 `[ADR-0015]`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 全集报告。
#[derive(Debug, Clone, Serialize)]
pub struct GoldReport {
    pub total: usize,
    pub structural_pass: usize,
    /// 结构红线通过率;**切片0 判据 = 100.0**。
    pub structural_redline_pct: f32,
    /// 该条 query 自身失败(provider 偶发等)的条数;结构红线率分母 = total - errored。
    pub errored: usize,
    pub mean_recall: f32,
    pub mean_precision: f32,
    pub incomplete_count: usize,
    pub items: Vec<ItemResult>,
}

/// LID 真实性:在基座 lid_nodes 中存在(结构红线的确定性判据)。
fn is_real_lid(book: &Book, lid: &str) -> bool {
    book.base.lid_nodes.iter().any(|n| n.lid == lid)
}

/// 结构红线校验:返回的去重 LID 中,哪些是悬空(不在基座)。全空 = 通过。
pub fn structural_check(book: &Book, returned: &[String]) -> (bool, Vec<String>) {
    let dangling: Vec<String> = returned
        .iter()
        .filter(|l| !is_real_lid(book, l))
        .cloned()
        .collect();
    (dangling.is_empty(), dangling)
}

/// 语义命中:recall = |返回∩期望|/|期望|,precision = |返回∩期望|/|返回|。
/// 期望空 → recall=1.0(无可召回);返回空 → precision=0.0(无正确返回)。
pub fn semantic_metrics(returned: &[String], expect: &[String]) -> (f32, f32) {
    let eset: HashSet<&String> = expect.iter().collect();
    let inter = returned.iter().filter(|l| eset.contains(l)).count();
    let recall = if expect.is_empty() {
        1.0
    } else {
        inter as f32 / expect.len() as f32
    };
    let precision = if returned.is_empty() {
        0.0
    } else {
        inter as f32 / returned.len() as f32
    };
    (recall, precision)
}

/// 返回 citation 的去重 LID(保序;语义/结构度量都基于去重集)。
fn returned_lids(resp: &QueryResponse) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for c in &resp.citations {
        if seen.insert(c.lid.clone()) {
            out.push(c.lid.clone());
        }
    }
    out
}

/// 聚合报告(纯函数,确定性可测)。结构红线率与语义均值都只在**成功应答**的条目上算
/// (errored = 后端失败,无 citation 即无悬空,既不算红线通过也不算违例,单列)。
pub fn build_report(results: Vec<ItemResult>) -> GoldReport {
    let total = results.len();
    let errored = results.iter().filter(|r| r.error.is_some()).count();
    let evaluated = total - errored;
    let structural_pass = results
        .iter()
        .filter(|r| r.error.is_none() && r.structural_ok)
        .count();
    let incomplete_count = results.iter().filter(|r| r.incomplete).count();
    let structural_redline_pct = if evaluated == 0 {
        100.0
    } else {
        structural_pass as f32 / evaluated as f32 * 100.0
    };
    let mean = |f: &dyn Fn(&ItemResult) -> f32| -> f32 {
        if evaluated == 0 {
            0.0
        } else {
            results.iter().filter(|r| r.error.is_none()).map(f).sum::<f32>() / evaluated as f32
        }
    };
    let mean_recall = mean(&|r| r.recall);
    let mean_precision = mean(&|r| r.precision);
    GoldReport {
        total,
        structural_pass,
        structural_redline_pct,
        errored,
        mean_recall,
        mean_precision,
        incomplete_count,
        items: results,
    }
}

/// 单条评测:调内层 query → 结构红线 + 语义命中。
pub fn evaluate_item(
    book: &Book,
    adapter: &dyn ModelAdapter,
    item: &GoldItem,
) -> Result<ItemResult, ToolError> {
    let resp = query(book, &item.q, &item.anchor_lid, adapter)?;
    let returned = returned_lids(&resp);
    let (structural_ok, dangling) = structural_check(book, &returned);
    let (recall, precision) = semantic_metrics(&returned, &item.expect_cite);
    Ok(ItemResult {
        id: item.id.clone(),
        anchor_lid: item.anchor_lid.clone(),
        scope_used: resp.scope_used,
        incomplete: resp.incomplete,
        expect_cite: item.expect_cite.clone(),
        returned_cite: returned,
        structural_ok,
        dangling,
        recall,
        precision,
        answer: resp.answer,
        error: None,
    })
}

/// 该条 query 失败时的占位结果(记录信封消息,不算结构红线通过/违例)。
fn errored_item(item: &GoldItem, msg: String) -> ItemResult {
    ItemResult {
        id: item.id.clone(),
        anchor_lid: item.anchor_lid.clone(),
        scope_used: String::new(),
        incomplete: false,
        expect_cite: item.expect_cite.clone(),
        returned_cite: Vec::new(),
        structural_ok: false,
        dangling: Vec::new(),
        recall: 0.0,
        precision: 0.0,
        answer: None,
        error: Some(msg),
    }
}

/// 跑整个金标准集 → 报告。**逐条容错**:provider 偶发错(如空响应)重试一次,
/// 仍失败则记 errored 行并继续(显式记录,非静默降级 `[ADR-0015]`),不让一条抽风毁整批。
pub fn run_goldset(
    book: &Book,
    adapter: &dyn ModelAdapter,
    items: &[GoldItem],
) -> Result<GoldReport, ToolError> {
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let r = match evaluate_item(book, adapter, item) {
            Ok(r) => r,
            // provider 错(瞬时,可重试 `[ADR-0015]`)重试一次;仍失败或非 provider 错则记 errored。
            Err(_) => match evaluate_item(book, adapter, item) {
                Ok(r) => r,
                Err(e) => errored_item(item, format!("[{}/{}] {}", e.category, e.error_code, e.message)),
            },
        };
        results.push(r);
    }
    Ok(build_report(results))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdapterError, AssistantTurn, CompletionRequest, Message, ParsedResponse, RawCitation, ToolSpec};
    use base_schema::sample_base;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn book() -> Book {
        // sample_base:"1"(容器)+ "1.1"(叶);"9.9" 不存在。
        let src = "X".repeat(100) + "尾巴";
        Book::new(sample_base(), &src)
    }

    // 结构红线:真 LID 全过 → ok、悬空空;掺一个不存在的 LID → 不过 + 列出悬空。
    #[test]
    fn structural_check_flags_dangling() {
        let b = book();
        let (ok, dangling) = structural_check(&b, &["1.1".into()]);
        assert!(ok);
        assert!(dangling.is_empty());
        let (ok2, dangling2) = structural_check(&b, &["1.1".into(), "9.9".into()]);
        assert!(!ok2);
        assert_eq!(dangling2, vec!["9.9"]);
    }

    // 语义命中:全中 / 部分中 / 零中 的 recall·precision。
    #[test]
    fn semantic_metrics_recall_precision() {
        // 期望 [a,b],返回 [a,b] → recall 1 precision 1
        let (r, p) = semantic_metrics(&["a".into(), "b".into()], &["a".into(), "b".into()]);
        assert_eq!((r, p), (1.0, 1.0));
        // 期望 [a,b],返回 [a,c] → recall .5 precision .5
        let (r, p) = semantic_metrics(&["a".into(), "c".into()], &["a".into(), "b".into()]);
        assert_eq!((r, p), (0.5, 0.5));
        // 期望 [a],返回 [] → recall 0 precision 0
        let (r, p) = semantic_metrics(&[], &["a".into()]);
        assert_eq!((r, p), (0.0, 0.0));
    }

    // 聚合:结构红线率 + 均值。
    #[test]
    fn build_report_aggregates() {
        let mk = |ok: bool, recall: f32| ItemResult {
            id: "x".into(),
            anchor_lid: "1.1".into(),
            scope_used: "local".into(),
            incomplete: false,
            expect_cite: vec![],
            returned_cite: vec![],
            structural_ok: ok,
            dangling: vec![],
            recall,
            precision: recall,
            answer: None,
            error: None,
        };
        let rep = build_report(vec![mk(true, 1.0), mk(true, 0.0)]);
        assert_eq!(rep.total, 2);
        assert_eq!(rep.structural_pass, 2);
        assert_eq!(rep.structural_redline_pct, 100.0);
        assert_eq!(rep.mean_recall, 0.5);
        assert_eq!(rep.errored, 0);
    }

    // errored 条目单列:不计入结构红线分母,不污染语义均值。
    #[test]
    fn build_report_excludes_errored() {
        let ok = ItemResult {
            id: "ok".into(), anchor_lid: "1.1".into(), scope_used: "local".into(),
            incomplete: false, expect_cite: vec!["1.1".into()], returned_cite: vec!["1.1".into()],
            structural_ok: true, dangling: vec![], recall: 1.0, precision: 1.0,
            answer: Some("a".into()), error: None,
        };
        let bad = errored_item(
            &GoldItem { id: "bad".into(), q: "q".into(), anchor_lid: "1.1".into(), expect_cite: vec!["1.1".into()] },
            "[provider/PROVIDER_ERROR] 空响应".into(),
        );
        let rep = build_report(vec![ok, bad]);
        assert_eq!(rep.total, 2);
        assert_eq!(rep.errored, 1);
        assert_eq!(rep.structural_pass, 1);
        assert_eq!(rep.structural_redline_pct, 100.0); // 分母=成功应答的 1 条
        assert_eq!(rep.mean_recall, 1.0); // errored 不拉低均值
    }

    /// 确定性替身:内层 query 每轮调一次 complete。
    struct FakeAdapter {
        completes: RefCell<VecDeque<ParsedResponse>>,
    }
    impl ModelAdapter for FakeAdapter {
        fn complete(&self, _req: CompletionRequest) -> Result<ParsedResponse, AdapterError> {
            self.completes.borrow_mut().pop_front().ok_or_else(|| AdapterError {
                message: "fake 脚本耗尽".into(),
            })
        }
        fn chat(&self, _: &[Message], _: &[ToolSpec]) -> Result<AssistantTurn, AdapterError> {
            unimplemented!("goldset 走内层 query,不涉外层 chat")
        }
    }

    // run_goldset 端到端(FakeAdapter 确定性):有效 citation → 结构红线过、recall 命中。
    #[test]
    fn run_goldset_with_fake_adapter() {
        let b = book();
        let fake = FakeAdapter {
            completes: RefCell::new(
                vec![ParsedResponse {
                    sufficient: true,
                    answer: Some("答案".into()),
                    citations: vec![RawCitation { lid: "1.1".into(), text: "片段".into(), role: "support".into() }],
                    model_supplement: vec![],
                }]
                .into(),
            ),
        };
        let items = vec![GoldItem {
            id: "g1".into(),
            q: "问".into(),
            anchor_lid: "1.1".into(),
            expect_cite: vec!["1.1".into()],
        }];
        let rep = run_goldset(&b, &fake, &items).unwrap();
        assert_eq!(rep.structural_redline_pct, 100.0);
        assert_eq!(rep.mean_recall, 1.0);
        assert_eq!(rep.items[0].returned_cite, vec!["1.1"]);
        assert!(rep.items[0].dangling.is_empty());
    }
}
