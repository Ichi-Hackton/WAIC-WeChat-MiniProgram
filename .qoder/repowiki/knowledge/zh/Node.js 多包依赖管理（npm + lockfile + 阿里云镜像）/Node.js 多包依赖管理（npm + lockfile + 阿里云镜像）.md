---
kind: dependency_management
name: Node.js 多包依赖管理（npm + lockfile + 阿里云镜像）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - cloudrun/package.json
    - cloudrun/package-lock.json
    - cloudrun/Dockerfile
    - tsconfig.json
    - cloudrun/tsconfig.json
---

## 1. 使用的系统/方法

仓库采用 **npm** 作为唯一的包管理器，使用 `package.json` + `package-lock.json` 双文件锁定依赖版本。仓库是单根 npm workspace 风格的聚合工程，但并未声明 `workspaces` 字段，而是以两个独立 npm 包的形式存在：
- 根目录 `micromate`（微信小程序前端，仅含 TypeScript 类型检查工具）
- `cloudrun/micromate-cloudrun`（微信雲托管 Node.js 后端）

两个子项目各自维护独立的 `package.json`、`package-lock.json`、`tsconfig.json`，互不共享依赖。

## 2. 关键文件

- `package.json` — 根包，仅声明 `typescript: ^5.6.3` 为 devDependency，脚本 `type-check` / `build` 均调用 `tsc --noEmit`，用于对 `miniprogram/src` 做跨模块类型检查。
- `cloudrun/package.json` — 后端包，devDependencies 为 `@types/node: ^20.14.0` 与 `typescript: ^5.6.3`；运行时零第三方依赖（描述中明确“零運行時依賴，僅 Node 內建模組”），通过内置 `http` 模块实现 LLM 代理与 SKILL 端点。
- `package-lock.json`（根）— 锁定根包依赖（当前只有 typescript）。
- `cloudrun/package-lock.json` — 锁定 cloudrun 包的依赖树。
- `cloudrun/Dockerfile` — 构建镜像时固定使用阿里云 npm 镜像：`RUN npm install --no-audit --no-fund --registry=https://registry.npmmirror.com`。
- `tsconfig.json`（根）— 将 `@/*` 路径映射到 `miniprogram/src/*`，使根 tsc 能跨目录检查小程序源码。
- `cloudrun/tsconfig.json` — 后端编译配置，target ES2022，module CommonJS，outDir `dist`。

## 3. 架构与约定

- **分层依赖**：前端（miniprogram）由微信开发者工具负责打包，本仓库只引入 TypeScript 进行类型检查；后端（cloudrun）用 Node.js 内置模块，无运行时 npm 依赖，便于容器化部署。
- **TypeScript 统一类型检查**：根 tsconfig 通过 `paths` 别名 `@/* → miniprogram/src/*`，配合 `include: ["miniprogram/**/*.ts"]`，在根目录执行 `npm run type-check` 即可对小程序源码做跨文件类型校验。
- **Docker 构建镜像**：cloudrun 的 Dockerfile 显式指定 `--registry=https://registry.npmmirror.com`，确保国内镜像源拉取依赖。
- **私有包策略**：未发现 `.npmrc`、`GOPRIVATE` 或私有 registry 配置；所有依赖来自公共 npm 源（lockfile 中 `resolved` 指向 `https://registry.npmjs.org/...`）。

## 4. 约定与约束

- 依赖版本通过 `package-lock.json` 锁定，提交变更时需同步更新 lockfile（npm 默认行为）。
- 云托管服务运行时不安装任何第三方 npm 包，仅依赖 Node.js 内建模块（见 `cloudrun/package.json` 的 devDependencies 与描述）。该约束由 Dockerfile 中的 `npm install` 产物决定。
- 构建镜像强制使用阿里云 npm 镜像 `https://registry.npmmirror.com`（见 `cloudrun/Dockerfile` 第 9 行）。
- 根脚本 `build` 与 `type-check` 等价，均为 `tsc --noEmit`，即仓库不做 JS 产出，只做类型检查（根与 cloudrun 均如此）。
- 未使用 pnpm/yarn/bun 等替代包管理器；`.gitignore` 中保留 yarn 日志模式仅为兼容性，实际未启用。