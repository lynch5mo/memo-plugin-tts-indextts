# 故障排查

按症状查。每条都给"怎么判断"和"怎么解决"。

## 合成突然全部失败，`/health` 却还是 ok

**判断**：服务端日志里出现

```
Assertion `probability tensor contains either inf, nan or element < 0`
CUDA error: device-side assert triggered
```

**原因**：采样出现 inf/nan，一旦触发，CUDA 上下文就损坏了，进程还在但再也合成不出来。

**解决**：

1. 重启服务端进程，立刻恢复
2. 长期办法：`temperature` 不要低于 0.5，`TTS_REP_PENALTY` 保持 3 左右
3. 想要自动恢复，把服务放进 systemd/launchd 托管（`Restart=on-failure`）

本仓库的 `api_server.py` 检测到这个错误会主动退出，交给外部守护重启，不会卡在"活着但不能用"的状态。

## 导出报 `Replacement audio does not support export timeline trimming yet`

**判断**：Memo 日志里有这行 `MediaRendererError`。

**原因**：这是 Memo 1.8.x 的限制——用 TTS 替换音轨时，不允许时间轴存在裁剪。而只要某段音频比它的槽位（range = 下一段起点 − 本段起点）长，Memo 就会把后面的字幕整体往后推，导出前重算时长超出出点，就被判定成"裁剪"。

**解决**：

1. 用槽位助手，让每段严格等于 `et−st`（见 [TOOLS.md](TOOLS.md)）
2. 已经生成过的项目，把 `tts/` 目录清掉重跑，否则 Memo 会复用旧音频
3. 实在不行：关掉"合并配音"导出无声视频，再用外部工具替换音轨

## 进度条一直不结束

**原因**：同上的时长问题。Memo 在后台不停重排时间轴，看起来像没跑完，其实音频已经生成完毕。

**判断**：日志里出现 `Audio segments have been merged successfully`，说明后台已经结束；之后看 `tts/` 目录里 `tts_info.info`、`tts_sprite.info` 等文件是否齐全。

**解决**：同"导出报错"。

## 中文里夹的英文词被吞或念成字母

**原因**：语言标记错了。模型用 `lang` 选语言嵌入，把中文句子标成 `EN` 会毁掉整句。

**解决**：插件的语言判定已经改成"含任一汉字即 ZH"，配置里的语言只是兜底。如果仍有个别词读音不对，可以在服务端做术语替换，比如把 `ETF` 换成 `E T F` 让模型逐字母念。

## 音色不像

**按影响从大到小排查**：

1. 参考音质量：16 kHz 单声道视频音轨是上限，换 44.1 kHz 干净素材差别很大
2. 参考音语速：主讲人 4 词/秒而参考音 2 词/秒时，整篇要加速近两倍，音色会明显失真
3. 参考音长度：10–15 秒比 5 秒稳
4. `temperature`：0.5–0.8 之间调，越低越稳但越平

## 每段合成很慢

**判断**：服务端日志里的 `Total inference time` 和 `RTF`。

**参考值**：RTF 1.1–1.3。明显更高时：

- 检查是否同时跑了别的模型（显存争抢会拖慢）
- 检查是否有人并发调用（服务是单线程串行，排队会让单段看起来变慢）

## 隧道断了

```bash
lsof -nP -iTCP:7861 -sTCP:LISTEN     # 没有输出说明隧道没了
ssh -f -N -L 127.0.0.1:7861:127.0.0.1:7861 你的主机
```

Mac 休眠后隧道必断，建议用 launchd 托管。

## 插件装上了但 Memo 里看不到

**判断**：`~/Library/Application Support/Memo/plugins/index.json` 里有没有你的 `pluginId`。

**原因**：Memo 需要两处登记——`plugins[]` 数组和 `versions{}` 对象。只写数组会出现"显示已安装但点了没反应"。

**解决**：用 `.memox` 正规导入，让 Memo 自己写这两处。

## 换音色后听感没变

**原因**：Memo 按内容哈希缓存音频，哈希包含插件配置。改了音色但配置没保存，或者缓存没清。

**解决**：清掉项目下的 `tts/` 目录再重跑。

## 想确认槽位助手有没有在工作

```bash
curl -s http://127.0.0.1:7872/healthz
tail -5 /tmp/oracle-access.log      # 每条查询一条记录，hit 为 true 表示命中
tail -5 /tmp/oracle-miss.log        # 未命中的句子
```
