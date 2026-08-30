# 语录收集工具

> 把散落在手机截图里的内容，变成可校对、可整理、可继续编辑的 Markdown。

**Screenshot to Markdown · Windows x64 · Electron 28 · v2.0.0**

语录收集工具是一款本地优先的桌面应用，适合整理来自小红书、抖音、网页、电子书或聊天记录的截图。它不会把所有步骤藏在一次请求里，而是将处理过程拆成素材整理、OCR 校对、内容整理和 Markdown 导出四个阶段，让每一步都可见、可修改、可重试。

## 核心能力

- **任务式管理**：每批截图独立保存，可随时关闭应用并继续处理。
- **截图排序与分组**：拖动调整阅读顺序，将连续截图合并为同一文章组。
- **逐张 OCR**：严格按顺序识别，实时显示等待、处理中、成功和失败状态。
- **人工校对**：OCR 原文可以直接编辑，修改内容自动保存。
- **分组整理**：每个文章组独立生成 Markdown，失败时只需重试当前组。
- **结果可控**：支持 Markdown 原文、解析预览、复制、保存和撤销上次整理。
- **两套 API 配置**：OCR 与内容整理可以使用不同的服务、模型和密钥。
- **本地数据保护**：完整原图保存在本机，API Key 优先使用系统安全存储加密。

## 工作流程

```text
素材整理 → 识别与校对 → 内容整理 → 导出 Markdown
```

### 1. 素材整理

导入 JPG、JPEG、PNG、GIF、WebP 或 BMP 图片。可以拖动截图排序，也可以把一张截图拖到另一张上创建文章组。未分组的截图会作为独立摘录保留，不会丢失。

### 2. 识别与校对

应用逐张调用视觉 OCR 模型。识别结果会与原图并排显示，可以手动修正文字，也可以单独重试失败的截图。取消处理不会清除已经完成的结果。

### 3. 内容整理

应用按照确认后的文章组调用文本模型，合并跨页内容、清理重复片段和平台 UI 噪音，并生成简短主题标题。各文章组独立保存，单组失败不会影响其他结果。

### 4. 导出 Markdown

在原文和解析预览之间切换，完成最终检查后复制到剪贴板，或保存为本地 `.md` 文件。

## API 配置

应用本身不附带 OCR 或大模型额度。打开右上角的 **设置**，分别填写 OCR API 与整理 API。两者都使用 OpenAI 兼容的 Chat Completions 接口。

| 配置项 | OCR API | 整理 API |
| --- | --- | --- |
| 用途 | 从图片中提取文字 | 合并、清理并生成 Markdown |
| 模型要求 | 支持图片输入的视觉或多模态模型 | 支持文本对话的模型 |
| API Key | 可以独立设置 | 可以独立设置，也可复制 OCR 配置 |
| API 地址 | 仅支持 HTTPS | 仅支持 HTTPS |

地址可以填写域名、`/v1` 地址或完整的 `/v1/chat/completions` 地址，应用会自动规范化请求路径。

配置模型时请注意：

- OCR 模型必须支持 OpenAI 兼容消息中的图片内容。
- 整理模型需要稳定返回正文；支持 JSON 输出的模型效果更可靠。
- DeepSeek 模型会自动关闭思考输出并请求 JSON 结果。
- API 产生的费用、速率限制和数据处理政策由所选服务商决定。

## 数据与隐私

任务数据默认保存在：

```text
%APPDATA%\screenshot-md-tool\workspace
```

- 导入后会在任务目录中保存完整原图。
- 图片长边超过 2400px 时，只为 API 上传生成缩小副本；完整原图不受影响。
- 任务状态和 Markdown 使用临时文件替换方式写入，降低中断时损坏的风险。
- API Key 优先通过 Electron `safeStorage` 加密，渲染界面不会读取已保存的明文密钥。
- 如果系统安全存储不可用，API Key 只在本次应用运行期间保留。
- 图片和识别文本只有在执行 OCR、分组分析或内容整理时才会发送到所配置的 API。

删除任务会同时删除该任务保存的截图和结果，请先确认不再需要这些内容。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl + O` | 导入截图 |
| `Ctrl + S` | 在导出阶段保存 Markdown |
| `Esc` | 关闭图片查看器、设置或任务抽屉 |

## 安装与运行

当前构建目标为 Windows x64。获得安装包后，运行：

```text
语录收集工具 Setup 2.0.0.exe
```

安装程序支持自定义安装目录。首次启动后，在右上角完成 API 配置即可开始使用。

## 本地开发

### 环境要求

- Node.js 18 或更高版本
- npm
- Windows 10/11（构建配置当前面向 Windows x64）

### 启动开发版本

```bash
npm ci
npm start
```

### 运行测试

```bash
npm test
```

测试覆盖工作流阶段守卫、任务持久化、图片排序、文章分组、API 地址处理、密钥存储、OCR 错误恢复和 Markdown 生成等关键逻辑。

### 构建

| 命令 | 输出 | 用途 |
| --- | --- | --- |
| `npm run build` | `dist/语录收集工具 Setup 2.0.0.exe` | 生成可分发的 NSIS 安装包 |
| `npm run build:dir` | `dist/win-unpacked/` | 生成未压缩目录，适合调试 |

当前配置中，安装包约 67MB，`win-unpacked` 约 217MB。实际大小会随 Electron 版本和构建环境变化。未压缩目录包含完整的 Electron/Chromium 运行时，正常分发时建议使用安装包，而不是发送整个 `win-unpacked`。

## 项目结构

```text
screenshot-md-tool/
├── main.js                       # Electron 主进程与窗口
├── preload.js                    # 安全的渲染进程桥接
├── index.html                    # 应用页面结构
├── main/
│   ├── ipc/index.js              # IPC 处理与任务调度
│   ├── services/
│   │   ├── grouping.js           # 本地/AI 分组与 Markdown 合成
│   │   ├── http-openai.js        # OpenAI 兼容 HTTPS 请求
│   │   ├── ocr.js                # OCR 请求与响应解析
│   │   ├── organize.js           # 内容整理流程
│   │   ├── settings-store.js     # API 配置与安全存储
│   │   ├── task-store.js         # 任务、截图和结果持久化
│   │   └── prompts.js            # 提示词
│   └── utils/image.js            # 图片读取和上传副本优化
├── renderer/
│   ├── app.js                    # 界面状态与交互
│   ├── flow.js                   # 四阶段工作流规则
│   ├── dom.js                    # DOM 辅助方法
│   ├── styles.css                # 全局样式
│   └── groups.css                # 分组、校对和预览样式
├── vendor/
│   ├── lucide.min.js             # 图标运行文件
│   └── marked.min.js             # Markdown 解析
├── build/icons/                  # 应用图标
├── test/core.test.js             # 核心逻辑测试
├── DESIGN.md                     # 视觉设计参考
└── package.json
```

## 技术栈

- Electron 28
- 原生 HTML、CSS 和 JavaScript
- Node.js `https` 模块
- OpenAI 兼容 Chat Completions API
- Marked Markdown 解析器
- Lucide 图标
- Electron Builder + NSIS

项目不依赖本地 OCR 引擎，安装包中也不包含模型文件。OCR 与内容整理能力由用户配置的远程 API 提供。

## 常见问题

### API 测试失败

确认地址使用 HTTPS，模型名称正确，API Key 有效，并且服务商支持 `/v1/chat/completions`。如果 OCR API 能连接但无法识别图片，请确认所选模型支持视觉输入。

### 某张截图识别失败

进入“识别与校对”阶段单独重试。应用会保留其他已经成功的结果，不需要重新处理整批截图。

### 整理结果缺少某个文章组

返回“内容整理”阶段查看失败项并重试。导出页会明确提示当前文稿缺少多少个文章组。

### 为什么未压缩目录仍然超过 200MB

业务代码和资源已经压缩在较小的 `app.asar` 中，主要体积来自 Electron 自带的 Chromium、V8、媒体组件和图形运行库。对外分发请使用压缩后的安装包。

## License

[MIT](LICENSE)
