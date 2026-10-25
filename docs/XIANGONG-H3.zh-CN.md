# 仙宫云 GPU + ComfyUI + MiniMax H3 接入

本版在第四步新增「仙宫云 GPU · H3 Ref2VA」。每个分镜使用独立的官方 H3 节点工作流，不读取导演台里的公共提示词、素材组或示例剧情。现有 Seedance 入口和历史视频继续保留。

## 使用

1. 在仙宫云启动 GPU 实例及 ComfyUI。需要支持官方 `MiniMaxH3ReferenceToVideo` 节点；你之前使用的 H3 导演台镜像可先用连接测试检查。
2. 打开 StoryForge → 第四步 → 视频设置 → 视频生成服务选择「仙宫云 GPU · H3 Ref2VA」。
3. 粘贴「打开 ComfyUI」的完整访问地址，包括查询参数中的密钥。只有镜像要求 Bearer 认证时才填访问令牌；无需仙宫云账户 API Key。
4. 点「测试连接」。程序只读取系统、节点和模型列表，不创建视频任务。成功后自动填入四个模型文件名，再点「保存并使用仙宫云」。
5. 第三步保留人物、场景和道具的本地图片；第四步按 `@精确素材名` 绑定相应图片。先用480p、20步、5秒、逐镜确认测试，再批量生成。
6. 生成完成后自动下载到 `文档/StoryForge/项目名称/项目ID/视频片段/`。同名文件添加版本号，旧视频保留。

## 实例要求

- Ref2VA：`minimax_h3_ref2va_pruned_int8_convrot.safetensors` 或兼容的 H3 Ref2VA 权重。
- 文本编码器：`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`。
- 视频 VAE：H3 video VAE（支持镜像已有的 fp16 或 int8_convrot 文件）。
- 音频 VAE：`minimax_h3_audio_vae_fp32.safetensors`。
- 节点：官方 H3 ReferenceToVideo、SamplerCustomAdvanced、音视频解码和 SaveVideo 等。连接测试会提示具体缺少的节点或模型。

模型文件已在镜像中时不需要重新下载。程序拒绝把 FL2VA 作为参考图模型使用。若返回的是仙宫云门户或登录页面，请换用实例的直接 ComfyUI 服务地址及有效访问密钥；本版不自动登录仙宫云网页。

## 支持范围

- 图片参考1—9张；同一素材反复引用只上传一个已选版本，图片编号与实际输入顺序一致。
- 单镜4—15秒、24fps。按官方17k+5帧网格向上对齐：5秒对应124帧，约5.17秒；15秒对应362帧，约15.08秒。保存请求时长和实际时长，不擅自改写分镜对白。
- 16:9、9:16、1:1、4:3、3:4；按32像素取整。16:9试片864×480、成片1344×768；其他比例按同等像素面积计算。
- 基础模型20—50步，可保存同步音频；关闭音频仅省略音轨，不改变 H3 的联合采样。
- 本版暂不接入视频参考、音频参考、动作迁移、首尾帧及 Turbo LoRA。

## 任务、连接和费用

访问地址和令牌使用 Windows safeStorage 加密，独立于项目 JSON。项目只保存视频渠道、任务编号和生成参数，远端输出地址不包含访问密钥。

任务编号持久化在本机。停止、切换项目或重新打开应用后，继续生成会先查询原 H3 任务。提交响应丢失时通过客户端编号查找原任务，不自动重发；如果无法确认，请先到 ComfyUI 队列和历史核对，再主动重新生成。

「停止」用于停止本机后续提交和轮询，已经提交的远端任务可能继续运行；不会对共享队列发起全局 interrupt。结束 GPU 租赁仍须在仙宫云控制台操作「关机并释放GPU」或「销毁」。更换实例地址后，旧任务只能恢复原地址查询，不能从新实例下载旧输出。

## 开发与验证

```powershell
npm ci
npm test
npm run build
npm run desktop
```

接口使用 ComfyUI 的 `/system_stats`、`/object_info`、`/upload/image`、`/prompt`、`/queue`、`/history/{prompt_id}` 和 `/view`。没有调用 MiniMax 付费视频 API，也没有自动租赁或销毁仙宫云实例。

参考：
- https://docs.comfy.org/development/comfyui-server/comms_routes
- https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native
- https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_r2v.json
