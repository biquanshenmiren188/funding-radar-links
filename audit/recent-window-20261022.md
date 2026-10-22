# 2026-10-22 最近 5–10 分钟固定溢价情景

用户要求不是预测未来指数趋势，而是假设最近 5–10 分钟的指数水平持续到结算，计算最终费率。这里的输入是对应合约的官方溢价指数，不用交易价格或 mark/index 价差代替。沿用原来各家已经发生部分的计算逻辑，仅替换未知未来部分的固定水平。

## 计算

最近 W 个完整分钟的溢价平均值作为固定未来溢价，W 为 5 或 10。将本周期已确认历史的加权和与剩余采样权重乘该平均值相加，再除以整周期总权重；最后应用该交易所的利率、阻尼、周期折算与实时上下限。Bybit 保留原来的分钟端点对齐和一分发布等待，Gate 保留实际三序列换算及官方累计费率一致性检查。

刚进入新周期时，近期窗口可以跨越上次结算，但上周期分钟仅用于形成外推假设，不计入本周期已发生累计。历史迟到最多五分钟的既有处理保持不变，窗口随最近已确认的完整分钟回退；不是把旧数据称作当前瞬时指数。缺失分钟不补零、不缩短窗口，先回补再计算。正在形成的分钟不纳入。

HY 暂保留官方预测：本轮公共接口没有提供可回补的完整分钟溢价序列，不能用小时已结算费率或交易 K 线伪造该输入。72 笔 BTC 小时历史和当前预测接口已读取，不计入六家的模型误差比较。

## 数据及复算

采集日期 2026-10-22，固定币种 BTC、ETH、SOL、BLUR、WAL、ZEREBRO、RLC、IRYS、BULLA、SAND。每个可用市场请求最近 25 笔结算，并取得相邻结算之间的分钟溢价。原始官方响应按 URL 的 SHA256 缓存，数据公开且不涉及账户。失败、已下架或不支持的市场保留失败记录，未拿其他币种补齐。

| 交易所 | 完整周期 | 历史不完整排除 | 完整周期复算 MAE（百分点） |
|---|---:|---:|---:|
| Binance | 240 | 0 | 0.00071923 |
| Aster | 228 | 12 | 0.00097129 |
| Bybit | 216 | 0 | 0.00001428 |
| Bitget | 168 | 0 | 0.00054901 |
| Gate | 224 | 0 | 0.00001860 |
| OKX | 141 | 27 | 约 2.2e-15 |

合计 1,217 个完整周期，39 个不完整周期排除。分钟历史 BN/AS/BG 使用 OHLC 均值近似五秒采样，全部本轮完整周期的实际结算落在原低/高采样包络内；不能据此称逐笔精确重建。Gate 最大复算误差 0.00004905 个百分点以内。Bybit 95% 复算误差约 0.00000081 个百分点以内，最大 0.00266729，两个最旧周期仍有差异，原因未独立确证；没有以能否符合公式筛选样本。

历史限幅和历史利率变动没有完整档案，因此离线统一按原普通币利率、无实际限幅重放；这是同口径相对比较，不是每笔旧版插件输出的完整复现。运行时仍使用实时参数。详细异常和分组统计见 `recent-window-20261022.json`。

## 窗口选择和独立测试

只比较最近 5、10 分钟两种恒定情景。BTC、ETH、SOL、BLUR、WAL、ZEREBRO 为开发币组；该组按结算时点前 65% 选窗口，后段为时间测试，跨边界周期排除。RLC、IRYS、BULLA、SAND 整组作为独立币种测试，不参与窗口选择。

每周期在已过 5%、10%、25%、50%、75%、90%、95% 回放；最早从已过第 11 分钟开始，重复分钟去重。实际未来样本和最终结算值不作为预测输入。该离线比较不覆盖开始十分钟，开始十分钟另由跨周期合成回归验证。历史网络迟到分布未被完整记录，不能宣称已覆盖所有真实请求延迟。

| 交易所 | 窗口 | 时间测试 MAE 降幅 | 独立币种测试 MAE 降幅 |
|---|---:|---:|---:|
| Binance | 10 分钟 | 13.5% | 8.8% |
| Aster | 10 分钟 | 16.1% | 7.4% |
| Bybit | 5 分钟 | 8.4% | 5.0% |
| Bitget | 10 分钟 | 24.7% | **-0.3%** |
| Gate | 10 分钟 | 9.0% | **-6.7%** |
| OKX | 10 分钟 | 15.8% | 6.6% |

基线是本机 1.8.14 的实际外推方法：BN/AS minute，Bybit/BG/OKX last，Gate ema30。负降幅表示误差增加。部分组最坏误差也上升，不声称六家都更准。开发组定下窗口后未根据测试结果重新选取。用户看到 BG/Gate 未稳定改善后，明确选择六家统一使用最近 5–10 分钟情景，因此仍采纳这两家。

## 验证与复现

- 139 项 Node 测试通过，包含原有取消、缓存、过期、分钟秒偏移和新跨周期固定窗口。
- 独立逐样本权重计算覆盖 1/2/4/8 小时、分钟/五秒采样、等权/递增权重，以及缺口、重复、未完成与未来样本隔离。
- 新版生产客户端七家 BTC 全部成功；另外 BN/AS/BG IRYS、Gate BULLA、BN RLC 成功。BN/AS/BG/Gate/OKX 返回 mean10，Bybit mean5，HY official。
- 未修改界面及权限，未创建或执行交易策略。安装文件更新不等于浏览器已重载。

PowerShell 复现：

```powershell
$env:BACKTEST_COINS='BTC,ETH,SOL,BLUR,WAL,ZEREBRO,RLC,IRYS,BULLA,SAND'
$env:BACKTEST_PERIODS='25'
node scripts/collect-funding-backtest.cjs LOCAL_DATA_DIRECTORY
node scripts/audit-recent-window.cjs LOCAL_DATA_DIRECTORY REPORT.json
node scripts/check-recent-window-live.cjs LOCAL_SMOKE_DIRECTORY
node --test test/*.test.js
```

重跑会取得当时最近的周期，结果不会必然相同。此次原始证据保存在工作区 `outputs/funding-accuracy-20261022/collected/raw/`，公开结果和可复现代码随本 PR 提交。

## 规则来源

- [Binance 资金费规则](https://www.binance.com/en/support/faq/detail/360033525031)：当前滚动显示费率与下一次结算情景不是同一量。
- [Aster 资金费文档](https://docs.asterdex.com/astherusex-orderbook-perp-guide/funding-rate)；细粒度采样适配的历史证据沿用 `funding-algorithms.audit.json`。
- [Bitget 公式调整](https://www.bitget.com/en-CA/support/articles/12560603838070)：固定基础利率后按周期折算。
- [Bybit 资金费规则](https://www.bybit.com/en/help-center/article/Introduction-to-Funding-Rate)：分钟加权；接口时间对齐还由实际历史回放核验。
- [OKX 资金费机制](https://www.okx.com/help/perps-funding-fee-mechanism)；未套用其他地区产品或链上产品的公式。
- [Gate 规则及实测记录](../funding-algorithms.audit.json)：实际数据接口的溢价换算是历史验证的适配，不冒称官方公式文本。
- [Hyperliquid 资金费规则](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)：五秒溢价采样、每小时结算；缺分钟历史时保留官方预测。
