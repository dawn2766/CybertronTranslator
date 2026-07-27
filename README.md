# 塞伯坦翻译器

一个可离线安装的 PWA，支持汽车人和霸天虎两套字形、双向翻译、图片导出与本地图片识别。

## 目录结构

```text
index.html              PWA 根入口
app/                    JavaScript、CSS 与运行素材
	assets/               字体、字形和界面图片
public/icons/           固定路径的 PWA 与 Apple 安装图标
tests/                  单元测试与浏览器烟雾测试
.github/workflows/      GitHub Pages 自动部署
dist/                   本地构建产物（不提交）
```

## 本地开发

```powershell
npm install
npm run dev
```

生产构建与本地预览：

```powershell
npm run build
npm run preview
```

## 部署到 GitHub Pages

1. 将仓库默认分支设为 `main`，并推送代码。
2. 在 GitHub 仓库的 **Settings > Pages > Build and deployment** 中，将 Source 设为 **GitHub Actions**。
3. 打开 **Actions**，等待 **Deploy PWA to GitHub Pages** 工作流完成。
4. Pages 地址通常是 `https://<用户名>.github.io/<仓库名>/`。

构建使用相对资源路径，因此无需在配置中写死仓库名，也支持项目级 Pages 子路径。

## 安装

- Android/桌面 Chrome 或 Edge：打开 Pages 地址，通过地址栏安装图标或浏览器菜单选择“安装应用”。
- iPhone/iPad：使用 Safari 打开 Pages 地址，点击“分享”，再选择“添加到主屏幕”。

首次完整打开后，应用资源会缓存到设备，可离线启动。浏览器不会自动弹出 iOS 安装提示，这是 Safari 的平台行为。

## 验证

```powershell
npm run build
node --test ./tests/translator.test.mjs ./tests/recognizer.test.mjs
$env:BROWSER_SMOKE_COMPACT='1'
node ./tests/browser-smoke.mjs
Remove-Item Env:BROWSER_SMOKE_COMPACT
```