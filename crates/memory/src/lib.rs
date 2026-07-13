//! 最小 memory 层 `[ADR-0026/0015/0006]`:用户私有 · 跨书 · 与只读基座**物理隔离**。
//! 单 JSON 落盘;`save`=内容寻址 mem_id upsert + citation 自动派生;`recall`=线性过滤。
//! 切片0 type=note/highlight/position;consolidation / 跨书 concept recall 留议题7 `[ADR-0018]`。
//! 时间戳与落盘路径由调用方注入(确定性可测,守 A2)。
//! S7a 从 runtime 抽成独立 crate(拆 runtime↔reader 循环依赖,reader/runtime 共同依赖它)`[ADR-0027]`。
use read_tools::ToolError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_context: Option<SelectionContext>,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SelectionResolution {
    Resolved,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectedRange {
    pub lid: String,
    pub range: TextRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectionContext {
    pub status: SelectionResolution,
    pub raw_quote: String,
    pub resolved_quote: String,
    pub ranges: Vec<SelectedRange>,
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
    pub selection_context: Option<SelectionContext>,
    pub citations: Option<Vec<MemCitation>>,
    pub source_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReplaceInput {
    pub mem_id: String,
    pub content: String,
    /// None = 继承旧 selection context;Some = 显式重新选择并移动锚。
    pub selection_context: Option<SelectionContext>,
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
    selection_context: Option<&SelectionContext>,
) -> String {
    let a = anchor
        .lid
        .as_deref()
        .or(anchor.concept.as_deref())
        .unwrap_or("");
    let base = format!("{book_id}|{mem_type}|{a}|{content}");
    let mut key = match range {
        Some(r) => format!("{base}|{}:{}", r.start, r.end),
        None => base,
    };
    if let Some(context) = selection_context {
        let canonical = serde_json::to_string(context)
            .expect("serializing SelectionContext with fixed fields cannot fail");
        key.push_str("|selection:");
        key.push_str(&canonical);
    }
    format!("mem_{:016x}", fnv1a(&key))
}

fn validate_selection_context(input: &SaveInput) -> Result<(), ToolError> {
    let Some(context) = &input.selection_context else {
        return Ok(());
    };
    if input.mem_type != "note" {
        return Err(invalid_selection_context(
            "selection_context 只允许用于 note".into(),
        ));
    }
    let Some(first) = context.ranges.first() else {
        return Err(invalid_selection_context(
            "selection_context.ranges 不得为空".into(),
        ));
    };
    if input.anchor.lid.as_deref() != Some(first.lid.as_str()) {
        return Err(invalid_selection_context(
            "anchor.lid 必须等于 selection_context 首个 LID".into(),
        ));
    }
    if context
        .ranges
        .iter()
        .any(|selected| selected.lid.is_empty() || selected.range.start >= selected.range.end)
    {
        return Err(invalid_selection_context(
            "selection_context range 需非空 LID 且 start < end".into(),
        ));
    }
    Ok(())
}

fn selection_citations(context: &SelectionContext, book_id: &str) -> Vec<MemCitation> {
    let mut seen = BTreeSet::new();
    context
        .ranges
        .iter()
        .filter(|selected| seen.insert(selected.lid.as_str()))
        .map(|selected| MemCitation {
            lid: selected.lid.clone(),
            book_id: book_id.to_string(),
            note: None,
        })
        .collect()
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

    fn persist_records_atomically(&self, records: &[Record]) -> Result<(), ToolError> {
        let Some(parent) = self.path.parent() else {
            return Err(internal("memory 路径缺少父目录".into()));
        };
        std::fs::create_dir_all(parent)
            .map_err(|e| internal(format!("建 memory 目录失败: {e}")))?;
        let serialized = serde_json::to_string_pretty(records)
            .map_err(|e| internal(format!("序列化 memory 失败: {e}")))?;
        let temporary = self.path.with_extension("replace.tmp");
        let backup = self.path.with_extension("replace.bak");
        if temporary.exists() {
            std::fs::remove_file(&temporary)
                .map_err(|e| internal(format!("清理 memory 临时文件失败: {e}")))?;
        }
        if backup.exists() {
            std::fs::remove_file(&backup)
                .map_err(|e| internal(format!("清理 memory 备份失败: {e}")))?;
        }
        std::fs::write(&temporary, serialized)
            .map_err(|e| internal(format!("写 memory 临时文件失败: {e}")))?;

        let had_original = self.path.exists();
        if had_original {
            if let Err(error) = std::fs::rename(&self.path, &backup) {
                let _ = std::fs::remove_file(&temporary);
                return Err(internal(format!("备份旧 memory 失败: {error}")));
            }
        }
        if let Err(error) = std::fs::rename(&temporary, &self.path) {
            if had_original {
                let _ = std::fs::rename(&backup, &self.path);
            }
            let _ = std::fs::remove_file(&temporary);
            return Err(internal(format!("切换 memory 快照失败: {error}")));
        }
        if had_original {
            let _ = std::fs::remove_file(backup);
        }
        Ok(())
    }

    /// `memory.save`:内容寻址 upsert + note/highlight citation 自动派生 `[ADR-0026]`。
    /// `now` = generated_at/last_used 时间戳(调用方注入,不进 mem_id ⇒ id 时间无关)。
    pub fn save(&mut self, input: SaveInput, now: &str) -> Result<Record, ToolError> {
        validate_selection_context(&input)?;
        let mem_id = input.mem_id.clone().unwrap_or_else(|| {
            content_mem_id(
                &input.book_id,
                &input.mem_type,
                &input.anchor,
                &input.content,
                input.range.as_ref(),
                input.selection_context.as_ref(),
            )
        });
        // citation 自动派生:note/highlight 未给 citations 且 anchor 有 lid → 锚回自身 LID。
        let citations = match input.citations {
            Some(c) => c,
            None => {
                if let Some(context) = &input.selection_context {
                    selection_citations(context, &input.book_id)
                } else if matches!(input.mem_type.as_str(), "note" | "highlight") {
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
            selection_context: input.selection_context,
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
        // P4-4:账本变更后重派生只读 .md 视图(best-effort,不阻断真相源)`[ADR-0040]`。
        let _ = self.write_profile_files();
        Ok(record)
    }

    /// 原子替换一条 memory:候选快照落盘成功后才切换内存状态。
    pub fn replace(&mut self, input: ReplaceInput, now: &str) -> Result<Record, ToolError> {
        let Some(index) = self.records.iter().position(|record| record.mem_id == input.mem_id)
        else {
            return Err(memory_not_found(&input.mem_id));
        };
        if input.content.trim().is_empty() {
            return Err(ToolError {
                error_code: "INVALID_MEMORY_CONTENT".into(),
                category: "validation".into(),
                message: "memory.replace content 不得为空".into(),
            });
        }

        let old = self.records[index].clone();
        let explicitly_reanchored = input.selection_context.is_some();
        let selection_context = input.selection_context.or_else(|| old.selection_context.clone());
        let anchor = if explicitly_reanchored {
            Anchor {
                lid: selection_context
                    .as_ref()
                    .and_then(|context| context.ranges.first())
                    .map(|selected| selected.lid.clone()),
                concept: None,
            }
        } else {
            old.anchor.clone()
        };
        let citations = if explicitly_reanchored {
            selection_context
                .as_ref()
                .map(|context| selection_citations(context, &old.book_id))
                .unwrap_or_default()
        } else {
            old.citations.clone()
        };
        let validation_input = SaveInput {
            mem_id: None,
            mem_type: old.mem_type.clone(),
            layer: old.layer.clone(),
            book_id: old.book_id.clone(),
            anchor: anchor.clone(),
            content: input.content.clone(),
            range: old.range.clone(),
            selection_context: selection_context.clone(),
            citations: Some(citations.clone()),
            source_session_id: old.source_session_id.clone(),
        };
        validate_selection_context(&validation_input)?;
        let mem_id = content_mem_id(
            &old.book_id,
            &old.mem_type,
            &anchor,
            &input.content,
            old.range.as_ref(),
            selection_context.as_ref(),
        );
        if self
            .records
            .iter()
            .enumerate()
            .any(|(candidate_index, record)| candidate_index != index && record.mem_id == mem_id)
        {
            return Err(ToolError {
                error_code: "MEMORY_REPLACE_CONFLICT".into(),
                category: "conflict".into(),
                message: format!("memory.replace 目标记录已存在: {mem_id}"),
            });
        }

        let replacement = Record {
            mem_id,
            mem_type: old.mem_type,
            layer: old.layer,
            book_id: old.book_id,
            anchor,
            content: input.content,
            range: old.range,
            selection_context,
            citations,
            usage: Usage {
                count: old.usage.count,
                last_used: Some(now.to_string()),
            },
            generated_at: now.to_string(),
            source_session_id: old.source_session_id,
        };
        let mut candidate = self.records.clone();
        candidate[index] = replacement.clone();
        self.persist_records_atomically(&candidate)?;
        self.records = candidate;
        let _ = self.write_profile_files();
        Ok(replacement)
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
        self.persist()?;
        // P4-4:删后重派生只读 .md 视图,旧条目从文件消失(单向覆写)`[ADR-0040]`。
        let _ = self.write_profile_files();
        Ok(())
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
                selection_context: None,
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

    /// 某书某类型记忆锚定的 LID 集(去重 + LID 序确定性)。reader_profile 关注点/疑惑点派生用。
    fn anchor_lids_of_type(&self, book_id: &str, types: &[&str]) -> Vec<String> {
        let mut lids: Vec<String> = self
            .records
            .iter()
            .filter(|r| r.book_id == book_id && types.contains(&r.mem_type.as_str()))
            .filter_map(|r| r.anchor.lid.clone())
            .collect();
        lids.sort();
        lids.dedup();
        lids
    }

    /// reader_profile 确定性派生 `[ADR-0038 决策3]`:从 ①② 确定性聚合,**无 LLM、不推断认知水平**。
    /// evidence 全是真 LID(来自已落账本/标注),可追溯。读时投影、**不物化落盘**(承 ADR-0012/0020)。
    /// 供 P3-3 已读降权 / P3-2 兜底。`qa` 类型未落地 ⇒ 疑惑点暂空(诚实,不假装)。
    pub fn derive_reader_profile(&self, book_id: &str) -> ReaderProfile {
        ReaderProfile {
            book_id: book_id.into(),
            read_lids: self.read_lids(book_id),
            focus_lids: self.anchor_lids_of_type(book_id, &["note", "highlight"]),
            puzzle_heat: self.qa_heat(book_id),
        }
    }

    /// qa 提问热度 `[ADR-0041]`:某书 qa 记录按 `anchor.lid` 聚合的条数(lid→问了几个不同问题)。
    /// 每条 qa record(内容寻址:不同问题=不同 record)计 1;heat = 该 LID 的卡点强度信号。
    /// 纯确定性聚合、无 LLM、无认知水平推断。读者私人 ②,供 back 组卡点升权 / 透明展示。
    fn qa_heat(&self, book_id: &str) -> BTreeMap<String, u32> {
        let mut heat: BTreeMap<String, u32> = BTreeMap::new();
        for r in &self.records {
            if r.book_id == book_id && r.mem_type == "qa" {
                if let Some(lid) = &r.anchor.lid {
                    *heat.entry(lid.clone()).or_insert(0) += 1;
                }
            }
        }
        heat
    }

    /// 某书某 LID 的 qa 提问文本 `[ADR-0041]`,按 `generated_at` 序(tie `mem_id`),供透明展示。
    /// 区别于 `qa_heat`(只数条数):此处取真实问题文本,让 reader-profile.md 卡点段可读"问了什么"。
    fn qa_questions(&self, book_id: &str, lid: &str) -> Vec<&str> {
        let mut recs: Vec<&Record> = self
            .records
            .iter()
            .filter(|r| {
                r.book_id == book_id
                    && r.mem_type == "qa"
                    && r.anchor.lid.as_deref() == Some(lid)
            })
            .collect();
        recs.sort_by(|a, b| a.generated_at.cmp(&b.generated_at).then(a.mem_id.cmp(&b.mem_id)));
        recs.into_iter().map(|r| r.content.as_str()).collect()
    }

    // ===== P4-4 四层产物物化(只读派生 .md · 单向覆写 · 真相源唯一 memory.json)`[ADR-0040]` =====

    /// 出现过的全部 book_id(distinct·排序,确定性)。
    fn all_book_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.records.iter().map(|r| r.book_id.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// 某书 context 记忆按成长时间线序(`generated_at`,tie `mem_id`)`[ADR-0039/0040]`。
    fn context_timeline(&self, book_id: &str) -> Vec<&Record> {
        let mut recs: Vec<&Record> = self
            .records
            .iter()
            .filter(|r| r.book_id == book_id && r.mem_type == "context")
            .collect();
        recs.sort_by(|a, b| a.generated_at.cmp(&b.generated_at).then(a.mem_id.cmp(&b.mem_id)));
        recs
    }

    /// 渲染 `reader-profile.md`(单书常驻画像,所有书分段)`[ADR-0040]`。纯确定性、无 LLM。
    pub fn render_reader_profile_md(&self) -> String {
        let mut s = String::from(
            "# 读者画像 (reader-profile)\n\n\
             > 自动派生只读快照 · 真相源 = memory.json · 改动走 memory.delete / 编 json `[ADR-0040]`\n",
        );
        for book_id in self.all_book_ids() {
            let p = self.derive_reader_profile(&book_id);
            s.push_str(&format!("\n## {book_id}\n"));
            s.push_str(&format!("### 已读 ({} 叶)\n", p.read_lids.len()));
            s.push_str(&if p.read_lids.is_empty() {
                "(暂无)\n".into()
            } else {
                format!("{}\n", p.read_lids.join(" "))
            });
            s.push_str("### 关注点 (note/highlight)\n");
            s.push_str(&if p.focus_lids.is_empty() {
                "(暂无)\n".into()
            } else {
                p.focus_lids.iter().map(|l| format!("- {l}\n")).collect::<String>()
            });
            s.push_str("### 卡点 (qa · 提问热度)\n");
            if p.puzzle_heat.is_empty() {
                s.push_str("(暂空)\n");
            } else {
                for (lid, count) in &p.puzzle_heat {
                    s.push_str(&format!("- {lid} (×{count})\n"));
                    for q in self.qa_questions(&book_id, lid) {
                        s.push_str(&format!("  - {q}\n"));
                    }
                }
            }
            s.push_str("### agent 记的上下文 (context · 成长时间线)\n");
            let timeline = self.context_timeline(&book_id);
            if timeline.is_empty() {
                s.push_str("(暂无)\n");
            } else {
                for r in timeline {
                    let cites = if r.citations.is_empty() {
                        String::new()
                    } else {
                        let lids: Vec<&str> = r.citations.iter().map(|c| c.lid.as_str()).collect();
                        format!(" [cite: {}]", lids.join(" "))
                    };
                    s.push_str(&format!("- {} {}{}\n", r.generated_at, r.content, cites));
                }
            }
        }
        s
    }

    /// 渲染阅读手册 `reading-handbook.md`(per-book × cross-book 双维)`[ADR-0040]`。纯确定性、无 LLM。
    pub fn render_handbook_md(&self) -> String {
        let books = self.all_book_ids();
        let mut s = String::from(
            "# 阅读手册 (memory)\n\n\
             > 自动派生只读快照 `[ADR-0040]`\n\n## per-book\n",
        );
        if books.is_empty() {
            s.push_str("(暂无)\n");
        }
        for book_id in &books {
            let p = self.derive_reader_profile(book_id);
            let ctx = self.context_timeline(book_id).len();
            s.push_str(&format!(
                "- **{book_id}** — 读到 {} 叶 / 关注 {} / 卡点 {} / context {}\n",
                p.read_lids.len(),
                p.focus_lids.len(),
                p.puzzle_heat.len(),
                ctx,
            ));
        }
        s.push_str("\n## cross-book\n");
        if books.is_empty() {
            s.push_str("(暂无)\n");
        } else {
            s.push_str(&format!("- 读过的书:{}\n", books.join(", ")));
            for book_id in &books {
                let ctx = self.context_timeline(book_id).len();
                s.push_str(&format!("- {book_id}: context {ctx} 条\n"));
            }
        }
        s.push_str("\n> 概念对齐(同名概念跨书)留 `[ADR-0006]`,v1 不做。\n");
        s
    }

    /// 物化两层产物到 memory.json 同目录(只读派生·单向覆写)`[ADR-0040]`。
    /// **best-effort 视图**:写失败不阻断账本(调用方 save/delete 忽略其 Err,真相源已 persist)。
    pub fn write_profile_files(&self) -> Result<(), ToolError> {
        let Some(dir) = self.path.parent() else {
            return Ok(());
        };
        std::fs::create_dir_all(dir).map_err(|e| internal(format!("建 profile 目录失败: {e}")))?;
        std::fs::write(dir.join("reader-profile.md"), self.render_reader_profile_md())
            .map_err(|e| internal(format!("写 reader-profile.md 失败: {e}")))?;
        std::fs::write(dir.join("reading-handbook.md"), self.render_handbook_md())
            .map_err(|e| internal(format!("写 reading-handbook.md 失败: {e}")))?;
        Ok(())
    }
}

/// reader_profile 确定性派生产物 `[ADR-0038 决策3]`:读者私人画像(② 读者私有,绝不外借访客)。
/// 三维全是确定性聚合 + 真 LID evidence,**不含认知水平推断**(novice/expert 是猜,ADR-0038 否决)。
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct ReaderProfile {
    pub book_id: String,
    /// 已读集 / reading journey(`read_lids`,触达序)。
    pub read_lids: Vec<String>,
    /// 关注点:note/highlight 锚定的 LID(去重,LID 序)。
    pub focus_lids: Vec<String>,
    /// 提问热度 / 卡点:qa 记录按 `anchor.lid` 聚合的条数(lid→问了几个不同问题)`[ADR-0041]`。
    /// 替代旧 `puzzle_lids` 去重平表——保留次数即"价值热度"信号,供 back 组卡点升权 / 透明展示。
    pub puzzle_heat: BTreeMap<String, u32>,
}

fn internal(message: String) -> ToolError {
    ToolError {
        error_code: "INTERNAL_ERROR".into(),
        category: "internal".into(),
        message,
    }
}

fn invalid_selection_context(message: String) -> ToolError {
    ToolError {
        error_code: "INVALID_SELECTION_CONTEXT".into(),
        category: "validation".into(),
        message,
    }
}

fn memory_not_found(mem_id: &str) -> ToolError {
    ToolError {
        error_code: "MEMORY_NOT_FOUND".into(),
        category: "not_found".into(),
        message: format!("memory 记录不存在: {mem_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY_MEMORY_V1: &str =
        include_str!("../tests/fixtures/legacy-memory-v1.json");
    const LEGACY_READER_PROFILE: &str =
        include_str!("../tests/fixtures/legacy-reader-profile.md");
    const LEGACY_READING_HANDBOOK: &str =
        include_str!("../tests/fixtures/legacy-reading-handbook.md");

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ub-mem-test-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn legacy_store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-mem-legacy-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        std::fs::write(&path, LEGACY_MEMORY_V1).unwrap();
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn normalize_newlines(value: &str) -> String {
        value.replace("\r\n", "\n")
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
            selection_context: None,
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
            selection_context: None,
            citations: None,
            source_session_id: None,
        }
    }

    fn selection_context() -> SelectionContext {
        SelectionContext {
            status: SelectionResolution::Resolved,
            raw_quote: "raw PDF quote".into(),
            resolved_quote: "resolved quote".into(),
            ranges: vec![
                SelectedRange {
                    lid: "1.1".into(),
                    range: TextRange { start: 1, end: 4 },
                },
                SelectedRange {
                    lid: "1.2".into(),
                    range: TextRange { start: 0, end: 3 },
                },
                SelectedRange {
                    lid: "1.1".into(),
                    range: TextRange { start: 8, end: 10 },
                },
            ],
        }
    }

    #[test]
    fn legacy_vec_fixture_opens_and_derives_current_views() {
        let raw: serde_json::Value = serde_json::from_str(LEGACY_MEMORY_V1).unwrap();
        assert!(raw.is_array(), "legacy memory must remain a bare JSON array");

        let (_path, store) = legacy_store("open-and-derive");
        let records = store.recall(&RecallQuery::default());
        assert_eq!(records.len(), 8);
        assert!(records.windows(2).all(|pair| pair[0].mem_id < pair[1].mem_id));

        let selected = records
            .iter()
            .find(|record| record.mem_id == "mem_a4acdf2b6f3df284")
            .unwrap();
        assert_eq!(selected.anchor.lid.as_deref(), Some("3.1"));
        assert_eq!(
            selected
                .selection_context
                .as_ref()
                .unwrap()
                .ranges
                .iter()
                .map(|range| range.lid.as_str())
                .collect::<Vec<_>>(),
            vec!["3.1", "3.2"]
        );
        assert_eq!(
            selected
                .citations
                .iter()
                .map(|citation| citation.lid.as_str())
                .collect::<Vec<_>>(),
            vec!["3.1", "3.2"]
        );

        assert_eq!(
            store.derive_reader_profile("book-a"),
            ReaderProfile {
                book_id: "book-a".into(),
                read_lids: vec!["1.2".into()],
                focus_lids: vec!["1.1".into(), "2.1".into(), "3.1".into()],
                puzzle_heat: BTreeMap::from([("4.1".into(), 2)]),
            }
        );
        assert_eq!(
            store.render_reader_profile_md(),
            normalize_newlines(LEGACY_READER_PROFILE)
        );
        assert_eq!(
            store.render_handbook_md(),
            normalize_newlines(LEGACY_READING_HANDBOOK)
        );
    }

    #[test]
    fn legacy_vec_fixture_preserves_save_replace_delete_and_reopen() {
        let (path, mut store) = legacy_store("mutations");

        let saved = store
            .save(
                note_input("book-a", "1.1", "legacy note"),
                "2026-02-01T00:00:00Z",
            )
            .unwrap();
        assert_eq!(saved.mem_id, "mem_620ddff409de9979");
        assert_eq!(saved.usage.count, 3);
        assert_eq!(saved.citations.len(), 1);
        assert_eq!(saved.citations[0].lid, "1.1");

        let replaced = store
            .replace(
                ReplaceInput {
                    mem_id: "mem_a4acdf2b6f3df284".into(),
                    content: "updated selected note".into(),
                    selection_context: None,
                },
                "2026-02-02T00:00:00Z",
            )
            .unwrap();
        assert_eq!(replaced.mem_id, "mem_350f3ef2974c5419");
        assert_eq!(replaced.anchor.lid.as_deref(), Some("3.1"));
        assert_eq!(
            replaced
                .selection_context
                .as_ref()
                .unwrap()
                .ranges
                .iter()
                .map(|range| range.lid.as_str())
                .collect::<Vec<_>>(),
            vec!["3.1", "3.2"]
        );
        assert_eq!(
            replaced
                .citations
                .iter()
                .map(|citation| citation.lid.as_str())
                .collect::<Vec<_>>(),
            vec!["3.1", "3.2"]
        );

        store.delete("mem_0dcc7e3a8f87d6c4").unwrap();
        let reopened = MemoryStore::open(path).unwrap();
        let records = reopened.recall(&RecallQuery::default());
        assert_eq!(records.len(), 7);
        assert!(records.iter().any(|record| {
            record.mem_id == "mem_620ddff409de9979" && record.usage.count == 3
        }));
        assert!(records
            .iter()
            .any(|record| record.mem_id == "mem_350f3ef2974c5419"));
        assert!(!records.iter().any(|record| {
            matches!(
                record.mem_id.as_str(),
                "mem_a4acdf2b6f3df284" | "mem_0dcc7e3a8f87d6c4"
            )
        }));
    }

    #[test]
    fn legacy_record_roundtrip_omits_selection_context_and_keeps_mem_id() {
        let legacy = r#"{
          "mem_id":"mem_6802d90a28719aac","type":"note","layer":"long_term",
          "book_id":"bookA","anchor":{"lid":"1.1"},"content":"笔记",
          "citations":[{"lid":"1.1","book_id":"bookA"}],
          "usage":{"count":1,"last_used":"t0"},"generated_at":"t0"
        }"#;
        let record: Record = serde_json::from_str(legacy).unwrap();
        assert!(record.selection_context.is_none());
        let encoded = serde_json::to_value(&record).unwrap();
        assert!(encoded.get("selection_context").is_none());

        let path = tmp("legacy-selection-context");
        let mut store = MemoryStore::open(&path).unwrap();
        let saved = store.save(note_input("bookA", "1.1", "笔记"), "t0").unwrap();
        assert_eq!(saved.mem_id, "mem_6802d90a28719aac");
    }

    #[test]
    fn selection_context_derives_ordered_unique_citations_and_enters_mem_id() {
        let path = tmp("selection-context");
        let mut store = MemoryStore::open(&path).unwrap();
        let mut input = note_input("bookA", "1.1", "跨段笔记");
        input.selection_context = Some(selection_context());
        let saved = store.save(input, "t0").unwrap();

        assert_eq!(saved.selection_context, Some(selection_context()));
        assert_eq!(
            saved.citations.iter().map(|c| c.lid.as_str()).collect::<Vec<_>>(),
            vec!["1.1", "1.2"]
        );

        let mut same = note_input("bookA", "1.1", "跨段笔记");
        same.selection_context = Some(selection_context());
        assert_eq!(store.save(same, "t1").unwrap().mem_id, saved.mem_id);

        let mut changed_context = selection_context();
        changed_context.raw_quote.push('!');
        let mut changed = note_input("bookA", "1.1", "跨段笔记");
        changed.selection_context = Some(changed_context);
        assert_ne!(store.save(changed, "t2").unwrap().mem_id, saved.mem_id);
    }

    #[test]
    fn selection_context_rejects_non_note_empty_ranges_invalid_ranges_and_anchor_mismatch() {
        let path = tmp("invalid-selection-context");
        let mut store = MemoryStore::open(&path).unwrap();

        let mut non_note = hl_input("bookA", "1.1", "raw", 0, 3);
        non_note.selection_context = Some(selection_context());
        assert_eq!(store.save(non_note, "t0").unwrap_err().error_code, "INVALID_SELECTION_CONTEXT");

        let mut empty = note_input("bookA", "1.1", "note");
        let mut empty_context = selection_context();
        empty_context.ranges.clear();
        empty.selection_context = Some(empty_context);
        assert_eq!(store.save(empty, "t0").unwrap_err().error_code, "INVALID_SELECTION_CONTEXT");

        let mut invalid_range = note_input("bookA", "1.1", "note");
        let mut invalid_context = selection_context();
        invalid_context.ranges[0].range.end = invalid_context.ranges[0].range.start;
        invalid_range.selection_context = Some(invalid_context);
        assert_eq!(store.save(invalid_range, "t0").unwrap_err().error_code, "INVALID_SELECTION_CONTEXT");

        let mut mismatch = note_input("bookA", "9.9", "note");
        mismatch.selection_context = Some(selection_context());
        assert_eq!(store.save(mismatch, "t0").unwrap_err().error_code, "INVALID_SELECTION_CONTEXT");
        assert!(store.recall(&RecallQuery::default()).is_empty());
    }

    #[test]
    fn replace_content_inherits_selection_context_anchor_citations_and_envelope() {
        let path = tmp("replace-inherit");
        let mut store = MemoryStore::open(&path).unwrap();
        let mut input = note_input("bookA", "1.1", "旧内容");
        input.selection_context = Some(selection_context());
        input.source_session_id = Some("session-a".into());
        let old = store.save(input, "t0").unwrap();

        let replaced = store
            .replace(
                ReplaceInput {
                    mem_id: old.mem_id.clone(),
                    content: "新内容".into(),
                    selection_context: None,
                },
                "t1",
            )
            .unwrap();

        assert_ne!(replaced.mem_id, old.mem_id);
        assert_eq!(replaced.content, "新内容");
        assert_eq!(replaced.anchor, old.anchor);
        assert_eq!(replaced.selection_context, old.selection_context);
        assert_eq!(replaced.citations, old.citations);
        assert_eq!(replaced.layer, old.layer);
        assert_eq!(replaced.mem_type, old.mem_type);
        assert_eq!(replaced.book_id, old.book_id);
        assert_eq!(replaced.source_session_id, old.source_session_id);
        assert_eq!(store.recall(&RecallQuery::default()), vec![replaced.clone()]);

        let reopened = MemoryStore::open(&path).unwrap();
        assert_eq!(reopened.recall(&RecallQuery::default()), vec![replaced]);
    }

    #[test]
    fn replace_with_explicit_selection_context_reanchors_and_rederives_citations() {
        let path = tmp("replace-reanchor");
        let mut store = MemoryStore::open(&path).unwrap();
        let old = store.save(note_input("bookA", "1.1", "旧内容"), "t0").unwrap();
        let context = SelectionContext {
            status: SelectionResolution::Partial,
            raw_quote: "new raw".into(),
            resolved_quote: "new resolved".into(),
            ranges: vec![
                SelectedRange {
                    lid: "2.1".into(),
                    range: TextRange { start: 2, end: 5 },
                },
                SelectedRange {
                    lid: "2.2".into(),
                    range: TextRange { start: 0, end: 4 },
                },
            ],
        };

        let replaced = store
            .replace(
                ReplaceInput {
                    mem_id: old.mem_id,
                    content: "新内容".into(),
                    selection_context: Some(context.clone()),
                },
                "t1",
            )
            .unwrap();

        assert_eq!(replaced.anchor.lid.as_deref(), Some("2.1"));
        assert_eq!(replaced.selection_context, Some(context));
        assert_eq!(
            replaced.citations.iter().map(|citation| citation.lid.as_str()).collect::<Vec<_>>(),
            vec!["2.1", "2.2"]
        );
    }

    #[test]
    fn replace_rejects_missing_empty_and_target_id_conflict_without_mutation() {
        let path = tmp("replace-validation");
        let mut store = MemoryStore::open(&path).unwrap();
        let first = store.save(note_input("bookA", "1.1", "first"), "t0").unwrap();
        let second = store.save(note_input("bookA", "1.1", "second"), "t0").unwrap();
        let before = store.recall(&RecallQuery::default());

        let missing = store
            .replace(
                ReplaceInput {
                    mem_id: "mem_missing".into(),
                    content: "new".into(),
                    selection_context: None,
                },
                "t1",
            )
            .unwrap_err();
        assert_eq!(missing.error_code, "MEMORY_NOT_FOUND");

        let empty = store
            .replace(
                ReplaceInput {
                    mem_id: first.mem_id.clone(),
                    content: "  ".into(),
                    selection_context: None,
                },
                "t1",
            )
            .unwrap_err();
        assert_eq!(empty.error_code, "INVALID_MEMORY_CONTENT");

        let conflict = store
            .replace(
                ReplaceInput {
                    mem_id: first.mem_id,
                    content: second.content,
                    selection_context: None,
                },
                "t1",
            )
            .unwrap_err();
        assert_eq!(conflict.error_code, "MEMORY_REPLACE_CONFLICT");
        assert_eq!(store.recall(&RecallQuery::default()), before);
    }

    #[test]
    fn replace_persistence_failure_preserves_memory_and_disk_record() {
        let path = tmp("replace-persist-old");
        let mut store = MemoryStore::open(&path).unwrap();
        let old = store.save(note_input("bookA", "1.1", "旧内容"), "t0").unwrap();

        let blocker = tmp("replace-parent-blocker");
        std::fs::write(&blocker, "not a directory").unwrap();
        store.path = blocker.join("memory.json");
        let error = store
            .replace(
                ReplaceInput {
                    mem_id: old.mem_id.clone(),
                    content: "不能落盘的新内容".into(),
                    selection_context: None,
                },
                "t1",
            )
            .unwrap_err();
        assert_eq!(error.category, "internal");
        assert_eq!(store.recall(&RecallQuery::default()), vec![old.clone()]);

        let reopened = MemoryStore::open(&path).unwrap();
        assert_eq!(reopened.recall(&RecallQuery::default()), vec![old]);
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

    // reader_profile 派生 `[ADR-0038]`:已读集(触达序)+ 关注点(note/highlight 去重·LID 序)
    // + 疑惑点(qa 暂空,诚实);跨书隔离;evidence 全真 LID。
    #[test]
    fn derive_reader_profile_aggregates_deterministically() {
        let path = tmp("profile");
        let mut s = MemoryStore::open(&path).unwrap();
        s.mark_read("bookA", "1.1", "t0").unwrap();
        s.mark_read("bookA", "1.2", "t1").unwrap();
        s.save(note_input("bookA", "2.1", "笔记"), "t2").unwrap();
        s.save(hl_input("bookA", "2.1", "X", 0, 1), "t3").unwrap(); // 同 LID 关注点去重
        s.save(hl_input("bookA", "2.3", "Y", 0, 1), "t4").unwrap();
        s.mark_read("bookB", "9.9", "t5").unwrap(); // 别书噪声
        let p = s.derive_reader_profile("bookA");
        assert_eq!(p.book_id, "bookA");
        assert_eq!(p.read_lids, vec!["1.1", "1.2"]); // 触达序
        assert_eq!(p.focus_lids, vec!["2.1", "2.3"]); // note+highlight 去重·LID 序(read 不计入)
        assert!(p.puzzle_heat.is_empty()); // 无 qa → 卡点热度空
    }

    // qa 提问热度派生 `[ADR-0041]`:qa 记录按 anchor.lid 聚合条数(不同问题=不同条目);
    // 重复同问题 upsert 不增条数;跨书隔离;read/note 锚同 lid 也不计入 puzzle_heat(维度隔离)。
    #[test]
    fn derive_reader_profile_qa_heat_aggregates() {
        let path = tmp("qaheat");
        let mut s = MemoryStore::open(&path).unwrap();
        let qa = |lid: &str, q: &str| SaveInput {
            mem_id: None,
            mem_type: "qa".into(),
            layer: "long_term".into(),
            book_id: "bookA".into(),
            anchor: Anchor { lid: Some(lid.into()), concept: None },
            content: q.into(),
            range: None,
            selection_context: None,
            citations: None,
            source_session_id: None,
        };
        s.save(qa("3.2", "所有权怎么传递"), "t0").unwrap();
        s.save(qa("3.2", "借用和所有权区别"), "t1").unwrap();
        s.save(qa("3.2", "move 语义"), "t2").unwrap();
        s.save(qa("3.2", "所有权怎么传递"), "t3").unwrap(); // 重复同问题 = upsert,不增条数
        s.save(qa("1.1", "这章讲啥"), "t4").unwrap();
        s.mark_read("bookA", "3.2", "t5").unwrap(); // read 不计入 puzzle_heat
        s.save(note_input("bookA", "3.2", "笔记"), "t6").unwrap(); // note 不计入
        let mut qb = qa("5.5", "B书问题");
        qb.book_id = "bookB".into();
        s.save(qb, "t7").unwrap(); // 跨书

        let p = s.derive_reader_profile("bookA");
        assert_eq!(p.puzzle_heat.get("3.2"), Some(&3)); // 3 个不同问题(重复不增)
        assert_eq!(p.puzzle_heat.get("1.1"), Some(&1));
        assert!(!p.puzzle_heat.contains_key("5.5")); // 跨书隔离
        assert_eq!(p.puzzle_heat.len(), 2); // 仅 3.2 / 1.1
        // 维度隔离:3.2 同时被 read + note,但 puzzle_heat 只数 qa。
        assert_eq!(p.read_lids, vec!["3.2"]);
        assert_eq!(p.focus_lids, vec!["3.2"]);
    }

    // qa-2 透明展示 `[ADR-0041]`:reader-profile.md 卡点段渲染 `lid (×count)` + 嵌套真实问题文本(generated_at 序)。
    #[test]
    fn reader_profile_md_renders_qa_questions() {
        let path = tmp("qa-render");
        let mut s = MemoryStore::open(&path).unwrap();
        let qa = |lid: &str, q: &str| SaveInput {
            mem_id: None,
            mem_type: "qa".into(),
            layer: "long_term".into(),
            book_id: "bookA".into(),
            anchor: Anchor { lid: Some(lid.into()), concept: None },
            content: q.into(),
            range: None,
            selection_context: None,
            citations: None,
            source_session_id: None,
        };
        s.save(qa("3.2", "所有权怎么传递"), "t0").unwrap();
        s.save(qa("3.2", "move 语义"), "t1").unwrap();
        let md = s.render_reader_profile_md();
        assert!(md.contains("3.2 (×2)")); // lid + 提问热度
        assert!(md.contains("- 所有权怎么传递")); // 真实问题文本(嵌套渲染)
        assert!(md.contains("- move 语义"));
    }

    // P4-4 四层产物物化 `[ADR-0040]`:save/delete 后确定性派生 reader-profile.md + reading-handbook.md
    // 落 memory.json 同目录;含已读/关注/context 时间线+cite/qa 暂空/cross-book;delete 后单向覆写不再含旧条目。
    #[test]
    fn profile_files_materialize_and_overwrite_on_delete() {
        // 专属子目录隔离(parent 唯一,避与其他测试共享 temp_dir 根踩 .md)。
        let dir = std::env::temp_dir().join("ub-mem-p4-4-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let mut s = MemoryStore::open(&path).unwrap();

        s.mark_read("bookA", "1.1", "t0").unwrap();
        s.mark_read("bookA", "1.2", "t1").unwrap();
        s.save(note_input("bookA", "2.1", "命令封装请求"), "t2").unwrap();
        // context 记忆带 citation + 时间线。
        let mut ctx = note_input("bookA", "3.2", "读者反复追问所有权,像卡在这");
        ctx.mem_type = "context".into();
        ctx.citations = Some(vec![MemCitation {
            lid: "3.2".into(),
            book_id: "bookA".into(),
            note: None,
        }]);
        s.save(ctx, "t3").unwrap();

        let profile = std::fs::read_to_string(dir.join("reader-profile.md")).unwrap();
        let handbook = std::fs::read_to_string(dir.join("reading-handbook.md")).unwrap();
        // reader-profile:已读/关注/context 时间线+cite/qa 诚实空/只读快照标注。
        assert!(profile.contains("已读 (2 叶)") && profile.contains("1.1 1.2"));
        assert!(profile.contains("2.1")); // 关注点
        assert!(profile.contains("读者反复追问所有权") && profile.contains("[cite: 3.2]")); // context + cite
        assert!(profile.contains("ADR-0040")); // 只读快照护栏标注
        assert!(profile.contains("(暂空)")); // qa 诚实空
        // 阅读手册:per-book + cross-book。
        assert!(handbook.contains("**bookA**") && handbook.contains("context 1"));
        assert!(handbook.contains("cross-book") && handbook.contains("读过的书:bookA"));

        // 单向覆写:delete context 后重派生,文件不再含该 context。
        let recs = s.recall(&RecallQuery {
            book_id: Some("bookA".into()),
            mem_type: Some("context".into()),
            ..Default::default()
        });
        assert_eq!(recs.len(), 1);
        s.delete(&recs[0].mem_id).unwrap();
        let profile2 = std::fs::read_to_string(dir.join("reader-profile.md")).unwrap();
        assert!(!profile2.contains("读者反复追问所有权")); // 覆写后旧 context 消失
        assert!(profile2.contains("已读 (2 叶)")); // 已读账本仍在
    }
}
