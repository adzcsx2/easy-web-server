# AGENT.md

This file provides general AI coding guidelines for working in this repository.

## Project Overview

easy-web-server is a Chinese-language internal network web file server built with Node.js/Express. It supports file management (browse/upload/download/delete), real-time upload progress via SSE, text file preview, and static site hosting for subdirectories.

**Tech Stack:** Node.js, Express, Multer, iconv-lite, vanilla JavaScript (no framework), SSE

**Project Type:** Single-file backend (server.js) + single-file frontend (public/index.html)

**Source of Truth:** package.json for dependencies, server.js for all routes/middleware, public/index.html for all frontend code

## Coding Conventions

- **File naming:** camelCase for JS files, kebab-case for directories (when applicable)
- **Code style:** camelCase variables/functions, UPPER_SNAKE_CASE constants, 2-space indentation
- **Language:** Chinese comments and UI text throughout the codebase
- **ES6+ patterns:** const/let, arrow functions, async/await, template literals
- **Error handling:** { error: "message" } JSON responses with appropriate HTTP status codes

## File Size and Organization Guidelines

- **Target:** Keep source files under 500 lines when possible
- **Large file exceptions:** Framework entry points, generated files, migrations, vendored code, legacy files
- **Single responsibility:** Each file/module should have one clear purpose
- **No unnecessary additions:** Don't append unrelated logic to already-large files
- **Refactoring:** Only refactor large files when actively working on them, not preemptively

## Modification Guidelines

- **Scope:** Only modify files directly related to current requirements or bug fixes
- **No drive-by changes:** Avoid formatting, import reordering, or lint fixes on untouched files
- **Minimum changes:** Make the smallest change that solves the problem
- **Local consistency:** Match existing patterns in the same file/directory
- **Reuse first:** Search for existing implementations before writing new code
- **No new architectures:** Don't introduce new frameworks, libraries, or patterns unless explicitly requested

## Planning Triggers

Plan before executing when:
- Modifying more than 3 source files
- Making cross-module changes
- Adding dependencies or changing configuration
- Modifying public APIs, data models, or routes
- Refactoring or moving files
- Requirements are unclear

## Verification

- **No test framework configured:** Manual verification required
- **After changes:** Test the specific functionality that was modified
- **Server restart:** Required after server.js changes (npm start)
- **Documentation-only changes:** Verify links, paths, and consistency
- **Verification failure:** Fix only current changes, not unrelated historical issues

## Key Entry Points

- **Server:** server.js (1137 lines) — all Express routes, middleware, helpers
- **Frontend:** public/index.html (2442 lines) — complete SPA with embedded CSS/JS
- **File storage:** files/ directory (gitignored)
- **Upload temp:** .tmp/ directory (gitignored)

## Common Patterns

- **Path validation:** All file operations must use validatePath() for security
- **Upload tracking:** In-memory Maps (uploadProgress, canceledUploads, activeUploadRequests, uploadGroups)
- **Encoding:** iconv-lite for Chinese filename conversion (UTF-8/Latin-1/GBK)
- **Progress streaming:** Server-Sent Events (SSE) via EventSource on client
- **Upload queue:** Concurrency limit of 5 simultaneous uploads with group support

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/files` | List directory |
| POST | `/api/files/upload` | Upload files |
| POST | `/api/files/upload/cancel` | Cancel single upload |
| POST | `/api/files/upload/cancel-group` | Cancel upload group |
| GET | `/api/files/upload-progress` | SSE progress stream |
| GET | `/api/files/download` | Download file |
| GET | `/api/files/view` | View text file |
| DELETE | `/api/files` | Delete file/folder |
| POST | `/api/files/mkdir` | Create directory |

## Documentation Structure

- **Standard docs root:** /docs
- **Standard categories:** plan, product, design, guide, modules, references, checklist, reports
- **New documents:** Always check existing /docs categories first, reuse semantically equivalent directories
- **No root-level docs:** Don't add new .md files to repository root

## Commands

```bash
npm install        # Install dependencies
npm start          # Start server (port 4000)
```

**Note:** This is a simple server with no build step, no tests, no linter.
