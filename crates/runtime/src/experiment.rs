//! LA8 evaluation-only access projection; the production registry is unchanged.
use crate::{InstructionModule, ToolSpec, tool_registry::ToolRegistry};
use read_tools::{Book, ExperimentalReadAccess};
use serde_json::json;

pub fn registry(book: &Book, registry: ToolRegistry) -> ToolRegistry {
    let Some(access) = book.experimental_read_access() else { return registry };
    registry.experimental_subset(|s| match s.name.as_str() {
        "book.text" | "book.search_text" | "tool.search" | "source.present" => true,
        "book.structure" | "book.context" => access != ExperimentalReadAccess::Text,
        "book.concept" => access == ExperimentalReadAccess::Graph,
        _ => false,
    })
}

pub fn policy_modules(tools: &[ToolSpec]) -> Vec<InstructionModule> {
    let mut modules = crate::agent_prompt::policy_modules_for_tools(tools);
    modules.retain(|m| !matches!(m.asset_id.as_str(), "resident-agent.policy.evidence-routing" | "resident-agent.policy.navigation"));
    modules.push(InstructionModule::new("resident-agent.policy.experimental-evidence", "v1",
        "Use only the tools exposed for this experiment. Locate literal wording with book.search_text. If available, book.structure returns canonical chapter topology, book.context expands adjacency/relationships, and book.concept locates semantic candidates. These results are locators, not evidence. Copy returned LIDs exactly; never guess positions. Read supporting original text using book.text before making factual claims or source.present. Discover a missing available capability with tool.search. Use the minimum calls needed, then deliver the answer with its selected sources. All groups share a 12,000 UTF-16 unique original-text budget and a 120,000 actual Provider token limit; stop when evidence is sufficient."));
    modules
}

/// Canonical global offsets make overlapping parent/child reads and repeated
/// ranges count once. A rejected read contributes neither body nor evidence.
#[derive(Default)]
pub struct BodyBudget { ranges: Vec<(usize, usize)> }
impl BodyBudget {
    pub fn admit(&mut self, tool: &str, args: &str, result: String, book: &Book) -> String {
        // Locator tools expose coordinates/semantic metadata only in every arm;
        // all original prose enters through the shared, budgeted book.text path.
        if tool == "book.search_text" || tool == "book.concept" {
            if let Ok(mut body) = serde_json::from_str::<serde_json::Value>(&result) {
                if let Some(rows) = body.get_mut("occurrences").and_then(|v| v.as_array_mut()) {
                    for row in rows { if let Some(o) = row.as_object_mut() { o.insert("excerpt".into(), json!("")); o.insert("heading_path".into(), json!([])); } }
                }
                if let Some(rows) = body.get_mut("section_counts").and_then(|v| v.as_array_mut()) {
                    for row in rows { if let Some(o) = row.as_object_mut() { o.insert("label".into(), json!("")); } }
                }
                if let Some(rows) = body.get_mut("candidates").and_then(|v| v.as_array_mut()) {
                    for row in rows { if let Some(o) = row.as_object_mut() { o.insert("previews".into(), json!([])); } }
                }
                return body.to_string();
            }
        }
        if tool != "book.text" { return result; }
        let Ok(body) = serde_json::from_str::<serde_json::Value>(&result) else { return result };
        if body.get("text").and_then(|v| v.as_str()).is_none() { return result; }
        let Ok(args) = serde_json::from_str::<serde_json::Value>(args) else { return result };
        let node = |key: &str| args.get(key).and_then(|v| v.as_str()).and_then(|lid| book.base.lid_nodes.iter().find(|n| n.lid == lid));
        let Some(start) = node("lid") else { return result };
        let end = node("end_lid").unwrap_or(start);
        let mut ranges = self.ranges.clone();
        ranges.push((start.span.start, end.span.end));
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in ranges {
            if let Some(last) = merged.last_mut().filter(|last| start <= last.1) { last.1 = last.1.max(end); }
            else { merged.push((start, end)); }
        }
        let used: usize = merged.iter().map(|(start, end)| end - start).sum();
        if used > 12_000 {
            return json!({"error_code":"EXPERIMENT_BODY_BUDGET", "category":"budget", "message":"Unique source budget is 12000 UTF-16 characters; select a smaller located passage or answer from observed evidence."}).to_string();
        }
        self.ranges = merged;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base_schema::sample_base;

    #[test]
    fn experiment_unique_body_union_and_rejected_read() {
        let mut base = sample_base();
        let mut extra = base.lid_nodes[1].clone();
        extra.lid = "1.2".into();
        extra.path = vec![1,2];
        base.lid_nodes.push(extra);
        base.lid_nodes[0].span.end = 20_000;
        base.lid_nodes[1].span.start = 0;
        base.lid_nodes[1].span.end = 8_000;
        base.lid_nodes[2].span.start = 4_000;
        base.lid_nodes[2].span.end = 12_000;
        let book = Book::new(base, &"x".repeat(20_000));
        let mut budget = BodyBudget::default();
        let result = json!({"text":"original"}).to_string();
        for i in [1, 1, 2] {
            let args = json!({"lid":book.base.lid_nodes[i].lid}).to_string();
            assert_eq!(budget.admit("book.text", &args, result.clone(), &book), result);
        }
        assert_eq!(budget.ranges, vec![(0,12_000)]);
        let args = json!({"lid":book.base.lid_nodes[0].lid}).to_string();
        assert!(budget.admit("book.text", &args, result.clone(), &book).contains("EXPERIMENT_BODY_BUDGET"));
        assert_eq!(budget.ranges, vec![(0,12_000)]);
    }

    #[test]
    fn experiment_search_previews_do_not_bypass_body_budget() {
        let book = Book::new(sample_base(), &"x".repeat(110));
        let body = json!({"occurrences":[{"start_lid":"1.1","excerpt":"BODY", "heading_path":["BODY"]}],"section_counts":[{"label":"BODY"}]}).to_string();
        let result = BodyBudget::default().admit("book.search_text", "{}", body, &book);
        assert!(!result.contains("BODY"));
        assert!(result.contains("1.1"));
    }
}
