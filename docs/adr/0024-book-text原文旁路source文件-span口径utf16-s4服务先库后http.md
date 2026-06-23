# ADR-0024 book.text 原文来源=旁路 source 文件 / span 单位=UTF-16 口径定型 / S4 服务先库后 HTTP

状态:已接受(2026-06-23,切片0 S4 开工前 §0.5 对齐)

## 背景
S4(读时 Rust 确定性叶子工具)开工前盘点基座与原文供给,发现三处需定型:
- **book.text 无料**:当前 `.understand-book/<id>/base.json`(`pass1-batch.ts` 固化)含 `lid_nodes`(LID 树 + `span`)、`graph_nodes/edges`,**不含原文 source**。`manifest/context/concept` 三工具的数据基座里全有,唯 `book.text` 取真原文缺料。
- **span 单位口径矛盾**:`segment.ts:20` 写死「切片0 用 JS 串下标(**UTF-16** code unit),字节精确化留后」;而 `crates/base-schema/src/lib.rs` 的 `Span` 注释却写「**字节**区间」。两处矛盾,实际值是 UTF-16。Rust `String` 是 UTF-8,直接拿此 offset 切原文会把中文切错位(中文 UTF-16=1 unit、UTF-8=3 bytes)。此即 S1 未闭项「字节精确 span」在 `book.text` 落地的第一道坎。
- **服务形态留白**:切片方案 S4 称「启 localhost 查询服务」,但判据只要求「4 工具确定性/毫秒级/schema 符 V3 §4.1」,未强制 HTTP server。

## 决策
1. **原文旁路固化为独立文件**:预构建期把整本原文写入 `.understand-book/<id>/source.txt`,与 `base.json` 并置同 `book_id` 目录、同生命周期(`pass1-batch.ts` 同时产)。`book.text` 读它 + 按 `LID.span` 切。**`ReadOnlyBase` schema 不加 `source` 字段**——原文不是冻结图谱结构的一部分,是其**旁路只读伴随物**;base.json 保持「LID 表 + 图谱」纯结构,体积不膨胀。
2. **span 单位 = UTF-16 code unit offset(切片0 口径)**:Rust `book.text` 切原文**必须按 UTF-16 语义**(`source.encode_utf16()` 索引切片后 `String::from_utf16`,或预构建期把 source 也按 UTF-16 对齐输出),**不可按 UTF-8 字节直切**。同步**修 `lib.rs` 的 `Span` 注释**「字节区间」→「UTF-16 code unit 区间(切片0;字节精确化留后)」,消除 schema↔实现矛盾。
3. **S4 服务形态 = Rust 库 crate + CLI 驱动**:4 叶子工具做成纯函数库(S5/S6 直接调),一个 CLI 子命令逐个验证(读 base.json+source.txt → 调工具 → 打印 JSON);判据用 `cargo test` + CLI 驱动。**HTTP / localhost 暴露推到 S7**(阅读器真正要连 localhost 时立)。承 [[ADR-0014]](叶子工具=确定性 primitive)/[[ADR-0021]](读时 Rust)。

## 命门
- **span 跨语言单位口径是 TS↔Rust 接缝隐患**:UTF-16 必须两侧一致;字节精确化(切片1+)时 `source.txt` 编码 + `span` 口径**同步改**,否则错位。修注释只是止血,根治在 S1 未闭项。
- **原文旁路文件与 base.json 强绑**:同目录、同 `book_id`、`pass1-batch` 一次产出二者;缺 `source.txt` 则 `book.text` 应报错(禁宽松降级 [[ADR-0015]]),不静默返空。
- **服务先库不返工**:命令优先([[ADR-0007]])= headless core 可独立验闭环,S7 上 axum 只是包一层薄壳,库为核心不重写。

## 否决
- **原文塞 base.json `source` 字段**:基座体积翻倍、改冻结 schema、原文非图谱结构(违「base 只装 LID 表+图谱」)。
- **每叶 LidNode 内嵌 `text`**:span + text 冗余双存,基座膨胀,且 span 仍在、两套真相。
- **Rust 读时重解 epub 拿原文**:确定性切分/解析归 TS([[ADR-0021]]),Rust 重写 epub 解析违单一真相源,且 span 单位难对齐。
- **现在就上 axum HTTP 服务**:切片0 验 headless 闭环,tokio/axum 异步栈 + 端口/生命周期是过早依赖,收益有限。

## 何时回头
- **字节精确 span**(S1 未闭项 / 切片1+ 句级 LID)落地时:重定 span 口径 + `source.txt` 编码,本 ADR 决策2 的 UTF-16 临时口径退役。
- 大书原文加载慢 → 评估 mmap / 分片读 `source.txt`,不回灌 base.json。
- **HTTP 暴露**在 S7 阅读器接入时立(axum 薄壳包库),届时定端口/生命周期/并发。

## 影响
- **改 `pass1-batch.ts`**:固化 base.json 时同时 `writeFileSync(source.txt, source)`。
- **改 `lib.rs`**:`Span` 注释口径修正(不改字段,ts-rs 重生成仅注释变)。
- **新增 Rust read crate**(命名 S4a 定,如 `crates/read-tools`)+ CLI;`cargo test` 锁 4 工具行为。
- **不回填 CONTEXT**:原文供给/span 编码是实现细节,守 [[ADR-0021]] CONTEXT 纯术语表纪律。
- **承** [[ADR-0014]](book.* 叶子工具签名)/[[ADR-0008]](LID 可跳原文 ⇒ 原文须随基座可达)/[[ADR-0021]](读时 Rust + 单一真相源)/[[ADR-0015]](禁宽松降级)。
