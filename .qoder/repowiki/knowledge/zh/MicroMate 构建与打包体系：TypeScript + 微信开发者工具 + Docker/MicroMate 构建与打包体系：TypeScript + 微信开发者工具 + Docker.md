---
kind: build_system
name: MicroMate 构建与打包体系：TypeScript + 微信开发者工具 + Docker
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - tsconfig.json
    - project.config.json
    - cloudrun/package.json
    - cloudrun/Dockerfile
    - cloudrun/smoke-test.ps1
---

## 1. 使用的构建系统与工具

仓库采用多阶段、多工具的轻量构建方案：
- **TypeScript**（`typescript@^5.6.3`）作为唯一语言编译层，根目录与 `cloudrun/` 各自维护一份 `tsconfig.json`。
- **微信开发者工具**通过 `project.config.json` 驱动小程序的 TS 编译与打包，启用 TypeScript 编译器插件（`useCompilerPlugins: ["typescript"]`），并开启 WXML/WXSS 压缩、Source Map 上传等发布选项。
- **Docker**（`node:20-alpine`）用于云托管服务的容器化镜像构建。
- **PowerShell** 脚本 `cloudrun/smoke-test.ps1` 在本地对已部署的云托管服务执行冒烟测试。

仓库中未发现 Makefile、CI YAML（`.github/workflows`）、`build.sh` 或版本发布脚本；所有构建入口均通过 npm scripts 暴露。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 根工作区脚本：`type-check` / `build` 均调用 `tsc --noEmit`，仅做类型检查不产出 JS |
| `tsconfig.json` | 根级 TS 配置：`target: ES2020`、`module: ESNext`、`strict: true`、`noEmit: true`，路径别名 `@/* → miniprogram/src/*`，仅包含 `miniprogram/**/*.ts` |
| `project.config.json` | 微信开发者工具工程配置：`compileType: "miniprogram"`、`libVersion: "3.0.0"`、`miniprogramRoot: "miniprogram/"`、启用 TS 编译器插件与 Source Map |
| `cloudrun/package.json` | 云托管后端脚本：`build` → `tsc -p .`（产出 `dist/`），`start` → `node dist/server.js` |
| `cloudrun/tsconfig.json` | 云托管端 TS 配置（独立于根 tsconfig） |
| `cloudrun/Dockerfile` | 基于 `node:20-alpine` 的单阶段镜像，先安装 devDependencies（typescript/@types/node），再 `npm run build` 编译 TS |
| `cloudrun/smoke-test.ps1` | PowerShell 冒烟测试，依次调用 `/healthz`、`/api/skill/skill.train.12306/search_train`、`/api/skill/skill.coffee.starbucks/place_order`、`/api/llm/chat` 等端点 |

## 3. 架构与约定

### 3.1 双包结构
- 根 `package.json` 是聚合工作区，仅声明 `typescript` 依赖并提供统一的 `type-check` / `build` 脚本，实际产物由子模块自行管理。
- `miniprogram/` 是微信小程序源码目录，由微信开发者工具负责编译与上传，不在本仓库内生成 JS 产物。
- `cloudrun/` 是独立的 Node.js 服务包，通过 `tsc -p .` 将 `src/` 编译到 `dist/`，运行时直接 `node dist/server.js`。

### 3.2 TypeScript 策略
- 根 tsconfig 设置 `noEmit: true`，意味着根脚本只做类型校验，不产出任何 JS 文件。
- 小程序侧依赖微信开发者工具的 TS 编译器插件进行编译（`project.config.json` 中 `useCompilerPlugins: ["typescript"]`）。
- 云托管侧使用独立的 `cloudrun/tsconfig.json`，并通过 `npm run build` 显式产出 `dist/`。

### 3.3 容器构建
- `cloudrun/Dockerfile` 采用单阶段构建（注释明确说明“MVP 从简採單階段鏡像；正式版可改 multi-stage”）。
- 先 `COPY package.json package-lock.json*` 再 `npm install`，利用 Docker 层缓存只拉取 devDependencies（typescript/@types/node）。
- 随后复制 `tsconfig.json` 与 `src/` 并执行 `npm run build`，最终 CMD 为 `node dist/server.js`。
- 镜像固定 `ENV PORT=80`，符合微信雲托管要求（注释写明“服務監聽 PORT 環境變數指定的埠（預設 80）”）。

### 3.4 测试与验证
- 无自动化 CI 流水线；本地通过 `cloudrun/smoke-test.ps1` 手动验证云托管服务。
- 该脚本模拟微信雲托管注入的 `x-wx-openid` 请求头，按顺序调用健康检查、训练查询、订票、取消订单、LLM 聊天（预期 503）、咖啡下单等端点。

## 4. 约定与约束

- **语言与目标**：所有 TS 代码以 `ES2020` 为目标、`ESNext` 模块系统，严格模式（`strict: true`、`noImplicitAny: true`、`strictNullChecks: true`）。
- **路径别名**：根 tsconfig 定义 `@/* → miniprogram/src/*`，供小程序源码使用。
- **小程序库版本**：锁定 `libVersion: "3.0.0"`，由微信开发者工具编译。
- **云托管端口**：镜像强制 `ENV PORT=80`，服务必须监听该环境变量指定的端口。
- **依赖来源**：Docker 构建使用淘宝镜像源 `--registry=https://registry.npmmirror.com`。
- **无 CI/CD**：仓库未包含 `.github/workflows`、Makefile 或 `build.sh`，构建与发布流程未在仓库内自动化。
- **版本号**：根包 `version: "0.0.0"`（占位），云托管包 `version: "0.1.0"`，未见统一的版本同步机制。