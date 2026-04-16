# easy-web-server

一个简单易用的内网 Web 文件服务器，支持文件管理、上传下载和静态站点托管。

## 功能特性

- **文件管理**：浏览、上传、下载、删除文件和文件夹
- **上传进度跟踪**：实时显示上传进度（支持多文件并发上传）
- **文件预览**：支持查看文本文件内容（限制 5MB 以内）
- **静态站点托管**：`files/` 目录下的子目录若包含 `index.html`，可作为静态站点访问
- **路径安全**：严格的路径验证，防止目录遍历攻击
- **中文支持**：支持非 ASCII 文件名和路径的 URL 解码

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
npm start
```

服务启动后，访问以下地址：

- **本地访问**：http://localhost:4000
- **局域网访问**：http://192.168.x.x:4000

## 目录结构

```
easy-web-server/
├── files/           # 文件存储目录（自动创建）
│   └── asr/        # 示例：包含 index.html 的子目录可作为站点访问
├── public/         # 前端静态资源
│   └── index.html  # Web 管理界面
├── server.js       # 服务端入口
├── package.json    # 项目配置
└── README.md       # 项目说明
```

## API 接口

### 文件管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files` | 列出目录内容 |
| POST | `/api/files/upload` | 上传文件 |
| GET | `/api/files/download` | 下载文件 |
| GET | `/api/files/view` | 查看文本文件内容 |
| DELETE | `/api/files` | 删除文件或文件夹 |
| POST | `/api/files/mkdir` | 创建文件夹 |

### 上传进度

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files/upload-progress` | SSE 实时上传进度 |

## 配置

可在 `server.js` 中修改以下配置：

- `PORT`：服务端口（默认 4000）
- `FILES_ROOT`：文件存储根目录
- `MAX_VIEW_FILE_SIZE`：文件预览大小限制（默认 5MB）

## 安全特性

- 路径遍历防护（Path Traversal）
- 文件名过滤和清理
- 上传文件大小限制（500MB）
- CORS 配置支持内网访问

## 技术栈

- Node.js
- Express.js
- Multer（文件上传）
- SSE（Server-Sent Events）

## 许可证

MIT
