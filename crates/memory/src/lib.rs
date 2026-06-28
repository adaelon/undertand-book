//! 最小 memory 层 `[ADR-0026/0015/0006]`:用户私有 · 跨书 · 与只读基座**物理隔离**。
//! 单 JSON 落盘;`save`=内容寻址 mem_id upsert + citation 自动派生;`recall`=线性过滤。
//! 切片0 type=note/highlight/position;consolidation / 跨书 concept recall 留议题7 `[ADR-0018]`。
//! 时间戳与落盘路径由调用方注入(确定性可测,守 A2)。
//! S7a 从 runtime 抽成独立 crate(拆 runtime↔reader 循环依赖,reader/runtime 共同依赖它)`[ADR-0027]`。
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 记忆记录(符 V3 §4.3 / `[ADR-0015]`)。`type` 是 Rust 保留词 ⇒ serde rename。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub mem_id: String,
    #[serde(rename = "type")]
    pub mem_type: String,
    pub layer: String,
    pub book_id: String,
    pub anchor: Anchor,
    pub content: String,
    /// 高亮的段内字符区间(UTF-16,相对 LID 文本)`[ADR-0031]`;note/整段高亮为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<TextRange>,
    #[serde(default)]
    pub citations: Vec<MemCitation>,
    pub usage: Usage,
    pub generated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
}

/// 锚:`{lid?}` | `{concept?}`(切片0 主用 lid)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Anchor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concept: Option<String>,
}

/// 高亮的段内字符区间 `[start, end)` `[ADR-0031]`:**UTF-16 code unit 偏移,相对该 LID 自身文本**
/// (非全书 source 绝对偏移)。与 DOM 选区偏移 / JS `string.slice` / Rust `encode_utf16` 同口径(承 [ADR-0024]),
/// 前端捕获↔后端切片↔前端重绘零换算。整段高亮(agent / 无选区)= range 缺省 None。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextRange {
    pub start: u32,
    pub end: u32,
}

/// 记忆引用锚定(`[ADR-0015]`,引用红线延伸 `[ADR-0004]`):recall 可验证、可跳原文。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemCitation {
    pub lid: String,
    pub book_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Usage {
    pub count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
}

/// 调用方提供的 save 入参:mem_id / citations 可缺(系统派生)。
#[derive(Debug, Clone)]
pub struct SaveInput {
    pub mem_id: Option<String>,
    pub mem_type: String,
    pub layer: String,
    pub book_id: String,
    pub anchor: Anchor,
    pub content: String,
    /// 段内字符区间(高亮选区)`[ADR-0031]`;缺省 None = 整段/note。
    pub range: Option<TextRange>,
    pub citations: Option<Vec<MemCitation>>,
    pub source_session_id: Option<String>,
}

/// recall 查询(切片0 维度;concept 维度留切片1+)`[ADR-0026]`。
#[derive(Debug, Clone, Default)]
pub struct RecallQuery {
    pub book_id: Option<String>,
    pub lid: Option<String>,
    pub mem_type: Option<String>,
    pub layer: Option<String>,
    pub text: Option<String>,
}

/// FNV-1a 64-bit:稳定确定性哈希(跨平台/版本恒定,内容寻址 mem_id 用,非 std DefaultHasher)。
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 内容寻址 mem_id `[ADR-0026]`:同 (book_id|type|anchor|content[|range]) 两存 = 同 id = 幂等去重。
/// range 段**仅当 Some 时追加** `[ADR-0031]`:None 时哈希与旧版逐字节相同 ⇒ 老 note 的 mem_id 不变;
/// 同段同子串不同位置(两个「the」)靠 range 入址区分成两条高亮。
fn content_mem_id(
    book_id: &str,
    mem_type: &str,
    anchor: &Anchor,
    content: &str,
    range: Option<&TextRange>,
) -> String {
    let a = anchor
        .lid
        .as_deref()
        .or(anchor.concept.as_deref())
        .unwrap_or("");
    let base = format!("{book_id}|{mem_type}|{a}|{content}");
    let key = match range {
        Some(r) => format!("{base}|{}:{}", r.start, r.end),
        None => base,
    };
    format!("mem_{:016x}", fnv1a(&key))
}

/// 用户私有 memory 库:与只读基座物理隔离的独立 JSON 文件 `[ADR-0006/0026]`。
pub struct MemoryStore {
    path: PathBuf,
    records: Vec<Record>,
}

impl MemoryStore {
    /// 默认库路径:`UNDERSTAND_BOOK_MEMORY_DIR` env 覆盖,否则 `<home>/.understand-book/memory/memory.json`。
    /// **绝不**落进 `.understand-book/<book_id>/`(只读基座),守物理隔离 `[ADR-0006]`。
    pub fn default_path() -> PathBuf {
        if let Ok(dir) = std::env::var("UNDERSTAND_BOOK_MEMORY_DIR") {
            return PathBuf::from(dir).join("memory.json");
        }
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into());
        PathBuf::from(home)
            .join(".understand-book")
            .join("memory")
            .join("memory.json")
    }

    /// 打开(或初始化)库;文件不存在 = 空库。
    pub fn open(path: impl Into<PathBuf>) -> Result<MemoryStore, ToolError> {
        let path = path.into();
        let records = if path.exists() {
            let s = std::fs::read_to_string(&path).map_err(|e| internal(format!("读 memory 失败: {e}")))?;
            serde_json::from_str(&s).map_err(|e| internal(format!("解析 memory 失败: {e}")))?
        } else {
            Vec::new()
        };
        Ok(MemoryStore { path, records })
    }

    fn persist(&self) -> Result<(), ToolError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| internal(format!("建 memory 目录失败: {e}")))?;
        }
        let s = serde_json::to_string_pretty(&self.records)
            .map_err(|e| internal(format!("序列化 memory 失败: {e}")))?;
        std::fs::write(&self.path, s).map_err(|e| internal(format!("写 memory 失败: {e}")))
    }

    /// `memory.save`:内容寻址 upsert + note/highlight citation 自动派生 `[ADR-0026]`。
    /// `now` = generated_at/last_used 时间戳(调用方注入,不进 mem_id ⇒ id 时间无关)。
    pub fn save(&mut self, input: SaveInput, now: &str) -> Result<Record, ToolError> {
        let mem_id = input.mem_id.clone().unwrap_or_else(|| {
            content_mem_id(
                &input.book_id,
                &input.mem_type,
                &input.anchor,
                &input.content,
                input.range.as_ref(),
            )
        });
        // citation 自动派生:note/highlight 未给 citations 且 anchor 有 lid → 锚回自身 LID。
        let citations = match input.citations {
            Some(c) => c,
            None => {
                if matches!(input.mem_type.as_str(), "note" | "highlight") {
                    if let Some(lid) = &input.anchor.lid {
                        vec![MemCitation {
                            lid: lid.clone(),
                            book_id: input.book_id.clone(),
                            note: None,
                        }]
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                }
            }
        };
        let prev_count = self
            .records
            .iter()
            .find(|r| r.mem_id == mem_id)
            .map(|r| r.usage.count)
            .unwrap_or(0);
        let record = Record {
            mem_id: mem_id.clone(),
            mem_type: input.mem_type,
            layer: input.layer,
            book_id: input.book_id,
            anchor: input.anchor,
            content: input.content,
            range: input.range,
            citations,
            usage: Usage {
                count: prev_count + 1,
                last_used: Some(now.to_string()),
            },
            generated_at: now.to_string(),
            source_session_id: input.source_session_id,
        };
        // upsert:同 mem_id 替换,否则追加。
        match self.records.iter_mut().find(|r| r.mem_id == mem_id) {
            Some(slot) => *slot = record.clone(),
            None => self.records.push(record.clone()),
        }
        self.persist()?;
        Ok(record)
    }

    /// `memory.delete(mem_id)`:用户**显式删**一条(区别于议题7 后台 usage 遗忘 `[ADR-0018]`)`[V3 §4.3]`。
    /// 找不到 → `MEMORY_NOT_FOUND`(禁静默降级,守 `[ADR-0015]`)。S10g:agent 提议「撤销」走它。
    pub fn delete(&mut self, mem_id: &str) -> Result<(), ToolError> {
        let before = self.records.len();
        self.records.retain(|r| r.mem_id != mem_id);
        if self.records.len() == before {
            return Err(ToolError {
                error_code: "MEMORY_NOT_FOUND".into(),
                category: "not_found".into(),
                message: format!("memory 记录不存在: {mem_id}"),
            });
        }
        self.persist()
    }

    /// `memory.recall`:线性过滤(每 Some 维度合取;lid 比 anchor.lid;text 子串)`[ADR-0026]`。
    /// 切片0 不实现 concept 维度(跨书概念对齐留切片1+)。结果按 mem_id 排序(确定性)。
    pub fn recall(&self, q: &RecallQuery) -> Vec<Record> {
        let mut out: Vec<Record> = self
            .records
            .iter()
            .filter(|r| q.book_id.as_ref().is_none_or(|b| &r.book_id == b))
            .filter(|r| q.mem_type.as_ref().is_none_or(|t| &r.mem_type == t))
            .filter(|r| q.layer.as_ref().is_none_or(|l| &r.layer == l))
            .filter(|r| q.lid.as_ref().is_none_or(|l| r.anchor.lid.as_deref() == Some(l.as_str())))
            .filter(|r| q.text.as_ref().is_none_or(|t| r.content.contains(t.as_str())))
            .cloned()
            .collect();
        out.sort_by(|a, b| a.mem_id.cmp(&b.mem_id));
        out
    }

    /// 确定性已读账本记账 `[ADR-0038]`(① 确定性账本,无 LLM):reader 翻到的 anchor LID
    /// 记入「真读过的 LID 历史」。复用 Record(`type="read"`,内容寻址天然去重)——同 LID 重复触达
    /// = 同 mem_id = upsert(`usage.count` 记触达次数,`generated_at` 刷新为最近触达)。
    /// **区别于 `type="position"`**(③ 会话临时·当前位置,不持久):`read` 是 ① 持久账本。
    /// content 空(已读 = 存在性,无散文);非 note/highlight ⇒ 不自动派生 citation(anchor.lid 本身即位置事实)。
    pub fn mark_read(&mut self, book_id: &str, lid: &str, now: &str) -> Result<Record, ToolError> {
        self.save(
            SaveInput {
                mem_id: None,
                mem_type: "read".into(),
                layer: "long_term".into(),
                book_id: book_id.into(),
                anchor: Anchor {
                    lid: Some(lid.into()),
                    concept: None,
                },
                content: String::new(),
                range: None,
                citations: None,
                source_session_id: None,
            },
            now,
        )
    }

    /// 已读集 / reading journey `[ADR-0038]`:某书真读过的 LID 历史,按 `generated_at` 触达序
    /// (tie-break `mem_id`)确定性排序、内容寻址去重。**解锁 P3-2 裸兜底真历史源**——
    /// `未读前置 = back ∩ (全集 \ 已读集)`(消费方在 P3-2,本刀不写)。
    pub fn read_lids(&self, book_id: &str) -> Vec<String> {
        let mut recs = self.recall(&RecallQuery {
            book_id: Some(book_id.into()),
            mem_type: Some("read".into()),
            ..Default::default()
        });
        recs.sort_by(|a, b| a.generated_at.cmp(&b.generated_at).then(a.mem_id.cmp(&b.mem_id)));
        recs.into_iter().filter_map(|r| r.anchor.lid).collect()
    }
}

fn internal(message: String) -> ToolError {
    ToolError {
        error_code: "INTERNAL_ERROR".into(),
        category: "internal".into(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-mem-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn note_input(book: &str, lid: &str, content: &str) -> SaveInput {
        SaveInput {
            mem_id: None,
            mem_type: "note".into(),
            layer: "long_term".into(),
            book_id: book.into(),
            anchor: Anchor {
                lid: Some(lid.into()),
                concept: None,
            },
            content: content.into(),
            range: None,
            citations: None,
            source_session_id: None,
        }
    }

    fn hl_input(book: &str, lid: &str, content: &str, start: u32, end: u32) -> SaveInput {
        SaveInput {
            mem_id: None,
            mem_type: "highlight".into(),
            layer: "long_term".into(),
            book_id: book.into(),
            anchor: Anchor { lid: Some(lid.into()), concept: None },
            content: content.into(),
            range: Some(TextRange { start, end }),
            citations: None,
            source_session_id: None,
        }
    }

    // save → recall 往返:存的记录能按 book_id 取回,字段完整。
    #[test]
    fn save_recall_roundtrip() {
        let path = tmp("roundtrip");
        let mut s = MemoryStore::open(&path).unwrap();
        let saved = s.save(note_input("bookA", "1.1", "命令模式即闭包"), "t0").unwrap();
        let got = s.recall(&RecallQuery {
            book_id: Some("bookA".into()),
            ..Default::default()
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0], saved);
        assert_eq!(got[0].content, "命令模式即闭包");
    }

    // citation 自动派生:note 未给 citations → 锚回 anchor.lid(兑现 recall 带可验证 LID citation)。
    #[test]
    fn note_auto_derives_lid_citation() {
        let path = tmp("autocite");
        let mut s = MemoryStore::open(&path).unwrap();
        let r = s.save(note_input("bookA", "11.18.4", "命令封装请求"), "t0").unwrap();
        assert_eq!(r.citations.len(), 1);
        assert_eq!(r.citations[0].lid, "11.18.4");
        assert_eq!(r.citations[0].book_id, "bookA");
    }

    // position 类型不自动派生 citation(只 note/highlight 派生)。
    #[test]
    fn position_no_auto_citation() {
        let path = tmp("position");
        let mut s = MemoryStore::open(&path).unwrap();
        let mut inp = note_input("bookA", "3.2", "");
        inp.mem_type = "position".into();
        inp.layer = "session".into();
        let r = s.save(inp, "t0").unwrap();
        assert!(r.citations.is_empty());
    }

    // 内容寻址 upsert 幂等:同 (book|type|anchor|content) 两存 = 同 mem_id = 不增条目,count 累加。
    #[test]
    fn content_addressed_upsert_is_idempotent() {
        let path = tmp("upsert");
        let mut s = MemoryStore::open(&path).unwrap();
        let r1 = s.save(note_input("bookA", "1.1", "同一条"), "t0").unwrap();
        let r2 = s.save(note_input("bookA", "1.1", "同一条"), "t1").unwrap();
        assert_eq!(r1.mem_id, r2.mem_id);
        assert_eq!(r2.usage.count, 2); // 第二次 upsert,count 累加
        let all = s.recall(&RecallQuery::default());
        assert_eq!(all.len(), 1); // 不重复
    }

    // recall 维度过滤:book_id/type/lid/text 各自精确/子串过滤,合取。
    #[test]
    fn recall_dimensions_filter() {
        let path = tmp("dims");
        let mut s = MemoryStore::open(&path).unwrap();
        s.save(note_input("bookA", "1.1", "alpha 内容"), "t0").unwrap();
        s.save(note_input("bookA", "2.2", "beta 内容"), "t0").unwrap();
        s.save(note_input("bookB", "1.1", "gamma 内容"), "t0").unwrap();
        assert_eq!(s.recall(&RecallQuery { book_id: Some("bookA".into()), ..Default::default() }).len(), 2);
        assert_eq!(s.recall(&RecallQuery { lid: Some("1.1".into()), ..Default::default() }).len(), 2);
        assert_eq!(
            s.recall(&RecallQuery { book_id: Some("bookA".into()), lid: Some("1.1".into()), ..Default::default() }).len(),
            1
        );
        assert_eq!(s.recall(&RecallQuery { text: Some("beta".into()), ..Default::default() }).len(), 1);
        assert_eq!(s.recall(&RecallQuery { mem_type: Some("highlight".into()), ..Default::default() }).len(), 0);
    }

    // delete:显式删一条后 recall 不再返;删不存在的 mem_id → MEMORY_NOT_FOUND(不静默)。
    #[test]
    fn delete_removes_and_missing_errors() {
        let path = tmp("delete");
        let mut s = MemoryStore::open(&path).unwrap();
        let r = s.save(note_input("bookA", "1.1", "待删"), "t0").unwrap();
        assert_eq!(s.recall(&RecallQuery::default()).len(), 1);
        s.delete(&r.mem_id).unwrap();
        assert_eq!(s.recall(&RecallQuery::default()).len(), 0);
        // 删后落盘:重开同路径已无该条。
        let s2 = MemoryStore::open(&path).unwrap();
        assert_eq!(s2.recall(&RecallQuery::default()).len(), 0);
        // 删不存在 → MEMORY_NOT_FOUND,禁静默。
        let e = s.delete("mem_nope").unwrap_err();
        assert_eq!(e.error_code, "MEMORY_NOT_FOUND");
        assert_eq!(e.category, "not_found");
    }

    // 高亮 range:save 存 range + 同段同子串不同 range = 两条不同 mem_id`[ADR-0031]`;range=None 的 note 哈希不变(向后兼容)。
    #[test]
    fn highlight_range_persists_and_distinguishes_by_position() {
        let path = tmp("hlrange");
        let mut s = MemoryStore::open(&path).unwrap();
        let a = s.save(hl_input("bookA", "1.1", "the", 0, 3), "t0").unwrap();
        let b = s.save(hl_input("bookA", "1.1", "the", 20, 23), "t0").unwrap();
        // 同 book|type|lid|content="the" 但 range 不同 ⇒ 两条不同高亮(range 入址)。
        assert_ne!(a.mem_id, b.mem_id);
        assert_eq!(a.range, Some(TextRange { start: 0, end: 3 }));
        assert_eq!(b.range, Some(TextRange { start: 20, end: 23 }));
        assert_eq!(s.recall(&RecallQuery::default()).len(), 2);
        // range=None 的 note 内容寻址与扩 range 字段前一致(向后兼容:不破老 note 幂等)。
        let n1 = s.save(note_input("bookA", "1.1", "笔记"), "t0").unwrap();
        let n2 = s.save(note_input("bookA", "1.1", "笔记"), "t1").unwrap();
        assert_eq!(n1.mem_id, n2.mem_id);
        assert!(n1.range.is_none());
    }

    // 落盘隔离 + 持久化:写入后重开同路径,记录仍在(独立文件,不碰只读基座)。
    #[test]
    fn persists_to_isolated_file_and_reloads() {
        let path = tmp("persist");
        {
            let mut s = MemoryStore::open(&path).unwrap();
            s.save(note_input("bookA", "1.1", "持久"), "t0").unwrap();
        }
        assert!(path.exists());
        let s2 = MemoryStore::open(&path).unwrap();
        assert_eq!(s2.recall(&RecallQuery::default()).len(), 1);
    }

    // 已读账本 `[ADR-0038]`:mark_read 后 read_lids 含该 LID(读过 vs 没读过确定性可分);
    // 重读同 LID 去重 + count 累加;按 generated_at 触达序;跨书隔离;read 不派生 citation。
    #[test]
    fn read_ledger_marks_and_lists_deterministically() {
        let path = tmp("readledger");
        let mut s = MemoryStore::open(&path).unwrap();
        // 没读过:空。
        assert!(s.read_lids("bookA").is_empty());
        // 读三处(触达序 1.3 → 1.1 → 1.2),再重读 1.1。
        let r = s.mark_read("bookA", "1.3", "t0").unwrap();
        assert_eq!(r.mem_type, "read");
        assert!(r.citations.is_empty()); // read 不派生 citation
        s.mark_read("bookA", "1.1", "t1").unwrap();
        s.mark_read("bookA", "1.2", "t2").unwrap();
        let again = s.mark_read("bookA", "1.1", "t3").unwrap();
        assert_eq!(again.usage.count, 2); // 重读 = 同 mem_id upsert,count 累加
        // 已读集去重 + 按 generated_at 序(1.1 刷新到 t3 ⇒ 排末):[1.3(t0), 1.2(t2), 1.1(t3)]。
        assert_eq!(s.read_lids("bookA"), vec!["1.3", "1.2", "1.1"]);
        // 跨书隔离:bookB 未读。
        assert!(s.read_lids("bookB").is_empty());
    }

    // 已读账本落盘持久(跨会话累积,区别于 ephemeral viewport):重开同库 read_lids 仍在。
    #[test]
    fn read_ledger_persists_across_reopen() {
        let path = tmp("readpersist");
        {
            let mut s = MemoryStore::open(&path).unwrap();
            s.mark_read("bookA", "1.1", "t0").unwrap();
            s.mark_read("bookA", "1.2", "t1").unwrap();
        }
        let s2 = MemoryStore::open(&path).unwrap();
        assert_eq!(s2.read_lids("bookA"), vec!["1.1", "1.2"]);
    }
}
