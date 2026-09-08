| Agent 工具                 | 实际依赖                                                     | 对应预构建阶段                          | 缗失后的表现                 |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------- | ---------------------------- |
| `book.text`                | `base.json.lid_nodes`、`source.txt`                          | 立即可读基础层                          | 无法读取                     |
| `book.search_text`         | `lid_nodes/span`、`source.txt`                               | 立即可读基础层                          | 无法搜索；没有独立全文索引   |
| `book.context`             | LID 树、graph、可选 discourse                                | 基础层 + Pass1/Profile/Pass2            | 仅基础层时基本只剩树邻接     |
| `book.concept`             | `graph_nodes`、`graph_edges`                                 | Pass1 + Pass2                           | 概念找不到或关联不足         |
| `book.query`               | graph、可选 `paper_lexicon`、`source.txt`；可选 discourse/formula 扩展 | Pass1/Profile/Pass2；paper 可加 lexicon | graph 为空时通常无法解析指代 |
| `book.synthesize`          | 调用者给定的 LID、`source.txt`；可选 formula/discourse；graph 只用于附加概念提示 | 基础层即可，Profile/graph 增强          | 仍能综合原文，但结构提示变弱 |
| `book.structure`           | `book_structure.json`                                        | BookStructure                           | 返回 `available=false`       |
| `book.guide_path`          | `book_structure.json`                                        | BookStructure                           | 返回 `available=false`       |
| `book.paper_metadata`      | `paper_metadata.json`                                        | paper_metadata                          | 返回 `available=false`       |
| `book.paper_lexicon`       | `paper_lexicon.json`                                         | paper_lexicon                           | 返回 `available=false`       |
| `book.paper_reading_guide` | source、base graph、discourse、metadata、lexicon、BookStructure | paper 标准深读全链                      | 允许部分降级并返回 warnings  |

hybrid_foundation
  ├─ source.txt
  └─ base.json
       ├─ lid_nodes
       ├─ graph_nodes = []
       └─ graph_edges = []

pass1
  └─ base.json.graph_nodes + local graph_edges

profile_sidecar
  ├─ discourse_index.json
  └─ formula_semantics.json

pass2
  └─ base.json.graph_edges += long_range edges

book_structure
  └─ book_structure.json

paper_metadata
  └─ paper_metadata.json

paper_lexicon
  └─ paper_lexicon.json