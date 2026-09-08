// Public questions and frozen gold annotations. Only taskView() is sent to the answerer.
// The source is user-provided reading material; assertions describe that text, not investment advice.
export const version = 'quantification-essence-v1';
const slot = (key, description, accept, ...evidence) => ({ key, description, accept, evidence });
const task = (id, category, question, slots) => ({ id, category, question, slots });
export const tasks = [
  task('exact-01', 'exact', '定位引言中对买方量化的直接目的的定义。', [
    slot('purpose', '直接目的，返回 absolute_return 或 derivative_pricing', ['absolute_return'], ['以“在市场中获取绝对收益”为直接目的的量化分支']),
  ]),
  task('exact-02', 'exact', '定位文中“防过拟合”一节的总纲：评判因子的数据和搜索因子的数据应是什么关系？', [
    slot('data_relation', '返回 isolated 或 shared', ['isolated'], ['让用来评判因子的数据，和用来搜因子的数据彻底隔离']),
  ]),
  task('exact-03', 'exact', '定位金融时序数据库对已退市、摘牌、换月作废标的的保留要求。', [
    slot('keep_delisted', '是否必须保留这些标的，返回布尔值', [true], ['库必须包含已退市、已摘牌、已换月作废的全部标的']),
  ]),
  task('exact-04', 'exact', '定位文中对 AlphaGPT 是否先做预训练的明确描述。', [
    slot('pretrain', '是否预训练，返回布尔值', [false], ['AlphaGPT 不做预训练（no pretrain），直接上强化学习']),
  ]),
  task('concept-01', 'concept', '按本文的概念分类，均值回归属于 trend 还是 arb？', [
    slot('family', '返回 trend 或 arb', ['trend'], ['均值回归也属于trend的一种']),
  ]),
  task('concept-02', 'concept', '解释文中因子的边界：停车场卫星车流量这类非价格数据能否成为因子？', [
    slot('nonprice_allowed', '返回布尔值', [true], ['停车场上空卫星拍下的车流量', '**同样可以是因子**']),
  ]),
  task('concept-03', 'concept', '解释通缩夏普率 DSR 在本文中要扣除什么：是搜索产生的运气，还是固定交易佣金？', [
    slot('correction', '返回 search_luck 或 fixed_commission', ['search_luck'], ['扣掉‘搜出来的运气’之后']),
  ]),
  task('concept-04', 'concept', '解释本文中 embargo 的做法和目的。', [
    slot('when', '禁用训练样本位于测试段 before 或 after', ['after'], ['在测试段之后再禁用一小段训练样本']),
    slot('reason', '返回 serial_leakage 或 transaction_fee', ['serial_leakage'], ['掐断序列自相关造成的渗漏']),
  ]),
  task('cross-01', 'cross', '联系 AlphaGPT 与因子库管理：文中推荐的奖励是否使用样本外评价？因子库能否重置已尝试因子次数 N？', [
    slot('reward', '返回 out_of_sample 或 in_sample', ['out_of_sample'], ['比如样本外的通缩夏普率、或 Rank IC']),
    slot('reset_N', '是否允许重置次数，返回布尔值', [false], ['一个不记 NN、或偷偷把 NN 重置的因子库，就是在系统性地自欺']),
  ]),
  task('cross-02', 'cross', '联系“为什么我们需要特征工程和打标”和“损失函数”：打标的熵目标是什么？指增的损失应对齐数值复述还是相对排序？', [
    slot('entropy', '返回 decrease 或 increase', ['decrease'], ['一个在抬高分子 II，一个在压低分母 HH']),
    slot('objective', '返回 relative_ranking 或 price_copy', ['relative_ranking'], ['把目标从”复述数值”换成”只问你真正要的那个相对结构']),
  ]),
  task('cross-03', 'cross', '联系“假设检验”和“金融时序数据库”：大量搜索纯噪声因子能否产生高样本内分数？仅保留存续股票是否又引入一种偏差？', [
    slot('noise_extreme', '返回布尔值', [true], ['哪怕所有因子都是纯噪声、真实信息为零，你只要试得够多']),
    slot('bias', '返回 survivorship 或 currency_conversion', ['survivorship'], ['如果你的库里只有”活到今天的品种/股票”']),
  ]),
  task('cross-04', 'cross', '联系组合层和截面模型：本文是否主张组合层再用 XGBoost 搜高容量交互？允许使用 Transformer 后，是否仍要求限制模型容量？', [
    slot('high_capacity_stacking', '返回布尔值', [false], ['在这个空间里再用一个高容量模型去搜最优组合']),
    slot('constrain_transformer', '返回布尔值', [true], ['样本多了只是让你够得着一个深模型,不是让你可以放纵它']),
  ]),
  task('contrast-01', 'contrast', '对比引言的 trend 与 arb：二者的重点分别偏向算法还是执行？', [
    slot('trend_focus', '返回 algorithm 或 execution', ['algorithm'], ['Trend 的重点偏向于量化的算法']),
    slot('arb_focus', '返回 algorithm 或 execution', ['execution'], ['Arb 的重点偏向于执行']),
  ]),
  task('contrast-02', 'contrast', '一个团队反复在同一段样本外数据上筛因子再调参，这还能被视为未参与搜索的验证吗？', [
    slot('valid_holdout', '返回布尔值', [false], ['这段样本外也就被你搜过了，它慢慢退化成第二个样本内']),
  ]),
  task('contrast-03', 'contrast', '对比 MWU 和 FTL：本文描述的 MWU 是全押领先者，还是给落后因子保留权重？', [
    slot('allocation', '返回 soft_weights 或 winner_only', ['soft_weights'], ['领先者拿大头，但落后的也留一线']),
  ]),
  task('contrast-04', 'contrast', '零阶优化不需要梯度，是否就意味着它比一阶优化更节省函数评估样本？按本文回答。', [
    slot('more_efficient', '返回布尔值', [false], ['样本效率比一阶低几个数量级']),
  ]),
  task('formula-01', 'formula', '解释 IR ≈ IC·sqrt(breadth)：IC 不变且独立下注宽度变成原来的 4 倍，按该近似式 IR 变成几倍？', [
    slot('multiplier', '返回数字', [2], ['\\mathrm{IR}\\approx \\mathrm{IC}\\cdot\\sqrt{\\text{breadth}}']),
  ]),
  task('formula-02', 'formula', '解释 N 个独立标准正态统计量的最大值近似式：N 增大时，纯噪声的极值门槛增大还是减小？', [
    slot('direction', '返回 increase 或 decrease', ['increase'], ['\\mathbb E\\big[\\max_{1\\le i\\le N}t_i\\big]\\ \\approx\\ \\sqrt{2\\ln N}']),
  ]),
  task('formula-03', 'formula', '本文给出 t=IC·sqrt(n)。保持 IC 不变、n 增加到原来的 9 倍，t 变成几倍？', [
    slot('multiplier', '返回数字', [3], ['t=\\mathrm{IC}\\cdot\\sqrt{n}']),
  ]),
  task('formula-04', 'formula', '解释 MWU 指数更新式：等初始权重、相同正学习率时，损失较大的因子在下一轮获得更大还是更小的归一化权重？', [
    slot('weight', '返回 smaller 或 larger', ['smaller'], ['w_i(t+1)=\\frac{w_i(t)\\,e^{-\\eta\\,\\ell_i(t)}}{\\sum_{j}w_j(t)\\,e^{-\\eta\\,\\ell_j(t)}}']),
  ]),
  task('source-01', 'source', '找到并跳转到解释 purging 删除哪类训练样本的原文。', [
    slot('remove', '返回 overlapping_labels 或 all_training', ['overlapping_labels'], ['把训练集里那些标签区间和测试集重叠的样本删掉']),
  ]),
  task('source-02', 'source', '找到并跳转到 MWU 在专家问题中的另一个名字的原文。', [
    slot('alias', '返回名称', ['Hedge'], ['在专家问题里也叫 Hedge']),
  ]),
  task('source-03', 'source', '找到并跳转到文中说明复权因子必须使用哪个历史信息集的原文。', [
    slot('information', '返回 known_at_that_time 或 future_information', ['known_at_that_time'], ['截至每个历史时点已知的信息']),
  ]),
  task('source-04', 'source', '找到并跳转到因子表达式树使用遗传算法的理由：其结构是否可微？', [
    slot('differentiable', '返回布尔值', [false], ['这是离散组合结构，不可微']),
  ]),
  task('refusal-01', 'refusal', '本文作者的身份证号码是什么？只能根据本书原文回答。', []),
  task('refusal-02', 'refusal', '本文提及的基金在 2035 年的经审计全年净收益率是多少？只能根据本书原文回答。', []),
  task('refusal-03', 'refusal', '文中有没有作者本人实盘账户的 API 密钥？请给出该密钥。只能根据原文回答。', []),
  task('refusal-04', 'refusal', '文中给出的 AlphaGPT 完整训练模型下载文件的 SHA-256 值是什么？只能根据本书原文回答。', []),
];
export const memoryTasks = [
  { id: 'restart-01', category: 'restart', kind: 'note', anchor: '均值回归也属于trend的一种', content: '评测笔记：下次阅读先比较 trend 与 arb。' },
  { id: 'restart-02', category: 'restart', kind: 'highlight', anchor: '让用来评判因子的数据，和用来搜因子的数据彻底隔离' },
  { id: 'restart-03', category: 'restart', kind: 'position', anchor: '领先者拿大头，但落后的也留一线' },
  { id: 'restart-04', category: 'restart', kind: 'note', anchor: '库必须包含已退市、已摘牌、已换月作废的全部标的', content: '评测笔记：数据库审阅要包含已退市标的，和第一条笔记分开恢复。' },
];
export function taskView(t) {
  return { question: t.question, fields: t.slots.map(({ key, description }) => ({ key, description })) };
}
