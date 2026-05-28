# 语录收集工具 · Screenshot to MD

一个 Electron 桌面应用，用来把手机截图里的短语、语录、摘抄整理成 Markdown 文档。适合从抖音、小红书等平台的截图中批量提取文字。

## 功能

- 添加或拖入多张手机截图（JPG / PNG / GIF / WebP / BMP）
- 两步处理：视觉 OCR API 识别文字 → 文本大模型整理为 Markdown
- OCR 与整理可使用**两套独立的 API 配置**（Key、地址、模型可分别设置）
- 可选「跳过整理」，仅输出 OCR 原文，便于调试或自行编辑
- 暗色 / 明亮主题，编辑与预览 Markdown，导出 `.md` 文件

## 工作流程

```text
截图列表 → OCR API（逐张识别）→ [可选] 大模型 API（整理）→ Markdown
```

1. 添加或拖入手机截图。
2. 应用调用 **OCR API**（需支持视觉/多模态的 OpenAI 兼容接口）逐张提取文字。
3. 若未开启「跳过整理」，再将 OCR 文本交给 **大模型 API** 清洗、合并、去重，输出纯 Markdown。
4. 在编辑器中修改后，可保存为本地 `.md` 文件。

相比直接把截图交给多模态模型一步出结果，分步 OCR + 整理更稳定，也便于检查中间识别是否正确。

## 环境要求

- [Node.js](https://nodejs.org/) 18 或更高版本
- npm

## 安装与启动

```bash
npm install
npm start
```

## 配置

在应用右上角 **设置** 中填写两套 API（均使用 OpenAI 兼容的 `POST /v1/chat/completions`，仅支持 **HTTPS** 地址）：

### OCR API（识别图片文字）

| 项 | 说明 |
| --- | --- |
| API Key | 服务商提供的密钥 |
| API 地址 | 主机名或完整 URL，例如 `api.hunyuan.cloud.tencent.com` |
| 模型 | 需支持视觉/多模态，例如 `hunyuan-vision` |

### 大模型 API（整理 Markdown）

| 项 | 说明 |
| --- | --- |
| API Key | 可与 OCR 相同或不同 |
| API 地址 | 可与 OCR 相同或不同 |
| 模型 | 文本模型，例如 `hunyuan-turbo` |

### 识别选项

- **跳过整理**：开启后只调用 OCR API，按截图分节输出原始识别文本，不消耗大模型额度。
- 从旧版本升级时，若曾保存过单一 API 配置，会自动迁移为 OCR 与大模型共用同一组 Key/地址。

## 整理规则

大模型整理时会尽量遵守以下约定（与内置提示一致）：

- **覆盖全部截图**：每张截图中的有效正文都应出现在结果中；彼此独立的内容用 `## 截图 N` 分节，不要只保留其中一张。
- **忽略 UI 噪音**：按钮、导航栏、评论、点赞数、用户名、时间戳、话题标签、广告、OCR 误识别符号等。
- **合并原则**：仅当多张连续截图明确属于同一段长文时，才按顺序合并并去掉重复页眉/页脚；否则分节保留。
- **格式**：单句语录使用 `> 引用`；长段落可按主题或来源使用二级标题。
- **忠实原文**：尽量保留 OCR 已有内容，不补写、不改写；只删除能明确判断为 UI 或乱码的片段。

## 项目结构

```text
screenshot-md-tool/
├── main.js      # Electron 主进程：窗口、IPC、API 调用、文件读写
├── preload.js   # 渲染进程桥接
├── index.html   # 界面与交互逻辑
└── package.json
```

## 技术栈

- Electron 28
- 原生 `https` 请求 OpenAI 兼容 Chat Completions 接口
- 无本地 OCR 依赖（已移除 Tesseract）
