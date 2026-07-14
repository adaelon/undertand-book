use crate::{internal, MemoryStore};
use read_tools::ToolError;

impl MemoryStore {
    /// 渲染 `reader-profile.md`(单书常驻画像,所有书分段)`[ADR-0040]`。纯确定性、无 LLM。
    pub fn render_reader_profile_md(&self) -> String {
        let mut s = String::from(
            "# 读者画像 (reader-profile)\n\n\
             > 自动派生只读快照 · 真相源 = memory.json · 改动走 memory.delete / 编 json `[ADR-0040]`\n",
        );
        for book_id in self.all_book_ids() {
            let p = self
                .derive_book_reading_state(&book_id)
                .legacy_reader_profile();
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
                p.focus_lids
                    .iter()
                    .map(|l| format!("- {l}\n"))
                    .collect::<String>()
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
            let p = self
                .derive_book_reading_state(book_id)
                .legacy_reader_profile();
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
        std::fs::write(
            dir.join("reader-profile.md"),
            self.render_reader_profile_md(),
        )
        .map_err(|e| internal(format!("写 reader-profile.md 失败: {e}")))?;
        std::fs::write(dir.join("reading-handbook.md"), self.render_handbook_md())
            .map_err(|e| internal(format!("写 reading-handbook.md 失败: {e}")))?;
        Ok(())
    }
}
