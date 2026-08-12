# StoryForge 0.6.0 源码交接说明

## 项目状态

- Windows 桌面端技术栈：Electron、Vite、原生 JavaScript 和 CSS。
- 视频生成前五个阶段固定调用 `deepseek-v4-pro`：故事分析、分集大纲、短剧剧本、分镜提示词、视觉素材描述。
- 分镜生成规范位于 `electron/deepseek-prompt.cjs`，参考资料位于 `docs/SKILL.zh-CN.md`。
- 流程自动运行到“视频生成”之前停止；真实图片、配音和视频服务尚未接入。
- DeepSeek API Key 由用户在软件中填写，并通过 Electron `safeStorage` 在 Windows 本机加密保存，不包含在源码包内。

## 新电脑准备

1. 安装 Node.js 20 或更高版本，建议使用当前长期支持版。
2. 解压本源码包，进入项目根目录。
3. 执行 `npm install` 恢复依赖。
4. 执行 `npm run dev` 启动浏览器界面开发模式。
5. 执行 `npm run desktop` 构建并运行 Electron 桌面版。
6. 执行 `npm run desktop:pack` 生成 Windows 安装程序。

## 关键文件

- `src/main.js`：界面、项目状态、生成流程和结果渲染。
- `src/style.css`：完整界面样式和字体尺寸。
- `electron/main.cjs`：桌面主进程、DeepSeek 接口调用、密钥加密和结果校验。
- `electron/preload.cjs`：主进程与界面之间的安全通信桥。
- `electron/deepseek-prompt.cjs`：DeepSeek 系统提示词和结构化返回要求。
- `package.json`：开发、构建和 Windows 安装包配置。
- `package-lock.json`：精确依赖版本，交接时必须保留。
- `docs/SKILL.zh-CN.md`：即梦二点零提示词规范原文。

## DeepSeek 配置与测试

- 固定模型：`deepseek-v4-pro`。
- 接口地址：`https://api.deepseek.com/chat/completions`。
- 首次打开桌面应用后，点击 DeepSeek 设置，填写 API Key 并测试连接。
- 没有 API Key 或接口失败时，应用会显示真实错误，不会退回本地模板。
- API Key 和 Electron 用户数据均未包含在交接压缩包中；新电脑需要重新填写。

## 继续优化时的注意事项

- 必须保留剧本中的真实人物姓名，不能把标题、类型、规格等元数据识别成人物。
- 分镜提示词除 `@Image1`、`@Video1`、`@Audio1` 等平台引用标记外，应使用中文。
- 每个镜头单独列出上传素材、分段时间、画面动作、人物对白、镜头运动和声音。
- 不要将 DeepSeek API Key 写进前端源码、环境示例或安装包。
- 如果要在两台不处于同一局域网的电脑间同步项目，需要增加登录、后端接口和云端数据库；当前项目数据仍以每台电脑本地保存为主。

## 未包含的内容

为了减小体积并避免泄露本机数据，压缩包不包含：

- `node_modules`，可通过 `npm install` 恢复。
- `dist` 和 `release-*`，可通过构建命令重新生成。
- DeepSeek API Key、本机缓存、浏览器存储和 Electron 用户数据。
- Git 历史；当前仓库尚无提交记录，源码文件本身已全部打包。
