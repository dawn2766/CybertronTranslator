<div align="center">
	<img src="./app/assets/autobot-logo.png" width="76" alt="汽车人徽标">
	&nbsp;&nbsp;&nbsp;
	<img src="./app/assets/decepticon-logo.png" width="76" alt="霸天虎徽标">

# 塞伯坦译码器

**把一句普通英文，翻译成能在塞伯坦街头亮相的文字。**

汽车人 / 霸天虎双字形 · 双向翻译 · 本地图片识别 · PNG 导出 · PWA 离线安装

[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![PWA](https://img.shields.io/badge/PWA-离线可用-5A0FC8?logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![Tests](https://img.shields.io/badge/tests-Node.js%20%2B%20Browser-2D8C3C)](#测试与质量)
[![Privacy](https://img.shields.io/badge/privacy-纯本地处理-111111)](#隐私与边界)

</div>

> 这不是把英文字母换个字体那么简单的小把戏。应用会保留空格、换行和标点，支持阵营切换、反向识图，并能把翻译结果导出为可再次识别的 PNG。通讯频道已接通，请选择你的阵营。

## 应用一览

### 电脑端

宽屏下采用双栏工作台：左边输入英文，右边实时生成塞伯坦字形。翻译、调字号、查字表和导出一气呵成，不必在控制面板里曲速航行。

![塞伯坦译码器电脑端界面：英文到霸天虎字形的双栏翻译工作台](./docs/screenshots/desktop.png)

### 手机端

在手机上，输入区与译文区会自动纵向排列；阵营选择、字号调节和导出功能全部保留。装进主屏幕后，它就是一台随身塞伯坦终端。

<p align="center">
	<img src="./docs/screenshots/mobile.png" width="45%" alt="塞伯坦译码器手机端界面：响应式英文到霸天虎字形翻译工作台">
</p>

## 能做什么

| 能力 | 说明 |
| --- | --- |
| **双阵营字形** | 在汽车人和霸天虎字母体系间即时切换，预览、字表与导出同步更新 |
| **英文 → 塞伯坦文** | 输入即翻译；空格、标点、换行和不支持的字符会按原顺序保留 |
| **塞伯坦文 → 英文** | 上传、拖放或粘贴 PNG、JPEG、WebP、GIF 图片，在浏览器中完成本地识别 |
| **无损回译** | 应用导出的 PNG 带有可校验载荷，重新导入时可优先精确恢复原文 |
| **智能识图** | 对普通塞伯坦字形图片使用本地模板识别，并显示置信度与不确定字形 |
| **字号与字表** | 通过滑杆实时调整 16–52 px 字号；随时打开完整 A–Z 阵营字表 |
| **PNG 导出** | 按当前阵营、字号、标点和自动换行布局生成清晰图片 |
| **离线 PWA** | 首次完整加载后缓存核心资源，可安装到桌面或手机主屏幕离线启动 |

## 三步发出讯息

1. **选择阵营**：点击“霸天虎”或“汽车人”，让终端换上对应字形。
2. **开始翻译**：输入英文，或点击中间的方向按钮，切换到图片识别模式。
3. **带走结果**：调整字号后导出 PNG；反向模式下则可一键复制识别出的英文。

图片识别时，建议使用正视、清晰、对比度较高的字形图片。模糊、透视严重或背景复杂的图片可能产生 `?`，终端不是读心术机器，这一点汽车人和霸天虎难得意见一致。

## 技术路线

```mermaid
flowchart LR
		A[英文输入] --> B[字符分词与顺序保留]
		B --> C{阵营字表}
		C -->|汽车人| D[Autobot 字形渲染]
		C -->|霸天虎| E[Decepticon 字形渲染]
		D --> F[预览与 PNG 导出]
		E --> F
		F --> G[可校验识别载荷]
		H[图片上传 / 拖放 / 粘贴] --> I{本地识别}
		I -->|应用导出图| J[精确恢复]
		I -->|普通字形图| K[模板匹配与置信度]
		J --> L[英文输出]
		K --> L
```

项目保持轻量，没有后端服务，也不依赖在线 OCR：

- **Vite 7**：开发服务器、生产构建和静态资源处理。
- **原生 JavaScript**：翻译状态、DOM 渲染、Canvas 导出与交互逻辑。
- **Canvas API**：图片预处理、字形匹配、识别预览和 PNG 生成。
- **vite-plugin-pwa**：Web App Manifest、Service Worker 与离线缓存。
- **Node.js Test Runner + Edge CDP**：单元测试与真实浏览器烟雾测试。

## 本地开发

### 环境要求

- Node.js `20.19+` 或 `22.12+`
- npm `10+`
- 浏览器烟雾测试需要 Windows 上安装 Microsoft Edge

### 启动项目

```powershell
git clone <你的仓库地址>
cd <仓库目录>
npm install
npm run dev
```

Vite 会在终端打印本地访问地址。保存代码后页面会自动热更新，不需要手动重启引擎舱。

生产构建与本地预览：

```powershell
npm run build
npm run preview
```

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动可供局域网访问的 Vite 开发服务器 |
| `npm test` | 运行翻译器与识别器单元测试 |
| `npm run build` | 生成生产构建到 `dist/` |
| `npm run preview` | 本地预览生产构建 |
| `npm run check` | 依次运行单元测试和生产构建 |
| `npm run test:browser` | 启动真实 Edge 会话，执行端到端烟雾测试 |

## 项目结构

```text
.
├── index.html                 # PWA 入口与无障碍语义结构
├── app/
│   ├── app.js                 # 页面状态、交互、渲染与 PNG 导出
│   ├── translator.js          # 字表注册、方向定义与字符分词
│   ├── recognizer.js          # 本地图片识别与可校验载荷
│   ├── styles.css             # 响应式视觉系统
│   └── assets/                # 字体、阵营徽标与 A–Z 字形素材
├── public/icons/              # PWA 与 Apple Touch 图标
├── docs/screenshots/          # README 使用的真实应用截图
├── tests/                     # 单元测试与浏览器烟雾测试
├── vite.config.js             # Vite / PWA 构建配置
└── package.json               # 项目脚本与开发依赖
```

## 测试与质量

日常提交前运行：

```powershell
npm run check
```

需要验证完整交互、响应式布局、字体加载、图片导出和反向识别时运行：

```powershell
$env:BROWSER_SMOKE_COMPACT='1'
npm run test:browser
Remove-Item Env:BROWSER_SMOKE_COMPACT
```

浏览器烟雾测试覆盖 `1440 × 900`、`1366 × 768`、`430 × 932`、`390 × 844` 与 `320 × 720` 等视口，并检查横向溢出、控件重叠、阵营切换、A–Z 字表、PNG 下载以及导出图回译。

## 安装为应用

- **Windows / macOS / Android**：使用 Chrome 或 Edge 打开部署地址，点击地址栏安装图标，或在浏览器菜单中选择“安装应用”。
- **iPhone / iPad**：使用 Safari 打开部署地址，点击“分享” → “添加到主屏幕”。

首次完整打开后，核心资源会缓存到设备。iOS Safari 不会自动弹出安装提示，这是平台行为，不是通讯故障。

## 部署到 GitHub Pages

1. 将默认分支设为 `main` 并推送代码。
2. 进入仓库 **Settings → Pages → Build and deployment**。
3. 将 **Source** 设为 **GitHub Actions**。
4. 在 **Actions** 中等待 **Deploy PWA to GitHub Pages** 工作流完成。
5. 访问 `https://<用户名>.github.io/<仓库名>/`。

构建使用相对资源路径，无需把仓库名写死在配置中，因此也适用于项目级 GitHub Pages 子路径。

## 隐私与边界

所有翻译、图片解析与识别都在当前浏览器内完成；应用不上传文本或图片，也不需要账号和 API Key。浏览器测试还会断言运行期间没有外部网络请求。

本项目识别的是随仓库提供的汽车人 / 霸天虎字形体系，并非通用 OCR。对于被裁切、旋转、强透视或严重压缩的图片，请先整理画面再呼叫塞伯坦总部。