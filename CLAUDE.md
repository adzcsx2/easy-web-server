# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

easy-web-server is a Chinese-language internal network web file server built with Node.js/Express. It supports file management (browse/upload/download/delete), real-time upload progress via SSE, text file preview, and static site hosting for subdirectories containing `index.html`.

## Commands

```bash
npm install        # Install dependencies
npm start          # Start server (runs node server.js, port 4000)
```

No build step, no test framework, no linter configured.

## Architecture

**Single-file backend + single-file frontend:**
- `server.js` (1137 lines) — All Express routes, middleware, helpers, and startup logic
- `public/index.html` (2442 lines) — Complete SPA with embedded CSS and JS (no framework)

**Data flow:**
- Files stored in `files/` (gitignored, auto-created)
- Uploads go to `.tmp/` first, then moved to final location
- Upload progress tracked via in-memory Maps with SSE push to clients
- Upload groups: batch tracking with group-level cancel support
- Static sites: subdirectory under `files/` with `index.html` served as a site

**Key server sections:**
- Constants/config at top (port, paths, size limits, text file extensions)
- Upload progress Maps (`uploadProgress`, `canceledUploads`, `activeUploadRequests`, `uploadGroups`) and cleanup logic
- Helper functions: `validatePath` (path traversal guard), `sanitizeFilename`, `decodeFilename` (UTF-8/Latin-1/GBK via iconv-lite), `isTextFileExtension`, `isBinaryContent`, `generateUploadId`, `pruneProgressEntries`, `isPrivateIPv4`, `getLocalIPv4`
- Cloudflare Quick Tunnel: auto-install cloudflared (Windows), spawn tunnel on startup, `GET /api/tunnel` endpoint, graceful shutdown
- Express middleware (CORS, body parser 50MB, trust proxy)
- Route handlers: file CRUD, upload with multer (10GB limit, 50 files), SSE progress, upload/group cancellation
- Static site detection and serving

**Frontend patterns:**
- Vanilla JS with global state variables (current path, file list, upload queue)
- XMLHttpRequest for uploads (not fetch — needed for progress events)
- EventSource for SSE upload progress
- Upload queue with concurrency limit (5 simultaneous), FAB button + history panel
- CSS custom properties for theming

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve SPA frontend |
| GET | `/api/files` | List directory contents |
| POST | `/api/files/upload` | Upload files (multipart, multer) |
| POST | `/api/files/upload/cancel` | Cancel a single in-progress upload |
| POST | `/api/files/upload/cancel-group` | Cancel all uploads in a group |
| GET | `/api/files/upload-progress` | SSE stream for upload progress |
| GET | `/api/files/download` | Download file |
| GET | `/api/files/view` | View text file (5MB limit, extension whitelist) |
| DELETE | `/api/files` | Delete file or folder |
| POST | `/api/files/mkdir` | Create directory |
| POST | `/api/clipboard` | Write text to server clipboard |
| GET | `/api/tunnel` | Get current Cloudflare Quick Tunnel URL (`{ url }` or `{ url: null }`) |

## Conventions

- Chinese comments and UI text throughout
- camelCase variables/functions, kebab-case CSS, UPPER_SNAKE_CASE constants
- ES6+ (const/let, arrow functions, async/await, template literals)
- 2-space indentation
- All file operations must go through `validatePath()` for security
- Error responses use `{ error: "message" }` JSON shape with appropriate HTTP status codes

## Dependencies

| Package | Purpose |
|---------|---------|
| express | Web framework, routing, static serving |
| cors | Cross-origin for internal network access |
| multer | Multipart upload parsing (disk storage, 10GB/file) |
| iconv-lite | Chinese filename encoding conversion (UTF-8/Latin-1/GBK) |

## Configuration

All config is in `server.js` constants at the top:
- `PORT` — 4000
- `FILES_ROOT` — `./files`
- `UPLOAD_TEMP_DIR` — `./.tmp`
- `MAX_VIEW_FILE_SIZE` — 5MB
- `TEXT_FILE_EXTENSIONS` — whitelist for file preview
- `MAX_PROGRESS_ENTRIES` — 50
- `SSE_POLL_INTERVAL` — 500ms

## AI Working Guidelines

### Single Source of Truth

- Build, version, dependencies: package.json
- Module structure: server.js (backend), public/index.html (frontend)
- Project rules: This CLAUDE.md file
- Directory structure: Source code scan results
- Default commands: package.json scripts (npm start)
- When docs conflict with code, follow code

### Reuse Priority Rules

1. **Search first:** Before modifying, search target file directory and similar implementations
2. **Reuse existing:** Prioritize reusing existing implementations, utilities, and call chains
3. **Minimum changes:** Make smallest changes, avoid unrelated refactoring
4. **Local consistency:** Match target directory and adjacent code patterns
5. **No new architectures:** Don't introduce new frameworks, libraries, or abstractions unless explicitly requested
6. **Follow local:** When old and new patterns mix locally, follow the local pattern rather than forcing global consistency

### AI Vibe Coding Constraints

- **File size preference:** Keep source files under 500 lines when possible
- **Large file exceptions:** Generated files, lockfiles, migrations, snapshots, vendor code, third-party code, protocol-generated artifacts, framework-forced entry points, and existing large legacy files
- **Single responsibility:** Each file should have one clear purpose
- **No bloat:** Don't append unrelated logic to already-large files
- **Refactoring only when active:** Only refactor large files when actively working on them or when user explicitly requests it
- **This standard applies to:** New code and files being modified, not proactive refactoring of untouched code

### Change Scope & Planning

**Touched-file discipline:**
- Only modify files directly related to current requirement, bug, or user instruction
- No drive-by formatting, batch import reordering, or repository-wide lint fixes unless explicitly requested
- Preserve existing uncommitted changes; don't overwrite, rollback, or rewrite user changes
- When editing large files, only touch necessary sections
- Before creating new files, confirm existing directories/modules can't handle the responsibility

**Plan-first triggers:**
- Modifying more than 3 source files
- Cross-module, cross-package, cross-service, or cross-platform changes
- Adding dependencies, build configs, scripts, CI, or runtime configs
- Changing public APIs, data models, routes, permissions, persistence formats, or migration logic
- Refactoring, moving files, splitting modules, or changing directory boundaries
- Unclear requirements, acceptance criteria, or impact scope

**Standard verification:**
- After code changes, run minimum related test/lint/typecheck/build/smoke verification
- If repository provides default verification commands, use them (currently: none configured — manual verification required)
- If no verification commands available, explicitly state "not verified" — don't claim verification
- For docs-only changes, check links, paths, categories, and rule file consistency
- On verification failure, fix issues introduced by current changes; don't fix unrelated historical issues

### Documentation Taxonomy

**Standard docs root:** `/docs`

**Standard categories (all created):**
| Category | Directory | Purpose |
|----------|-----------|---------|
| plan | `/docs/plan` | Plans, proposals, roadmaps, todos |
| product | `/docs/product` | PRDs, user stories, acceptance criteria |
| design | `/docs/design` | Architecture, ADRs, specs |
| guide | `/docs/guide` | Onboarding, usage, runbooks |
| modules | `/docs/modules` | Module docs, directory boundaries |
| references | `/docs/references` | Reference materials, terminology, indexes |
| checklist | `/docs/checklist` | Checklists, audit lists |
| reports | `/docs/reports` | Test reports, audits, postmortems |

**New document rules:**
- Default new documents to `/docs` under appropriate category
- Before creating new docs, check `/docs` for existing semantically-equivalent categories
- Reuse existing semantically-equivalent directories; don't create duplicate directories with singular/plural variations
- Only create new doc category directories when semantic is clear and no equivalent exists
- Avoid adding scattered `.md` files to repository root
- Existing uncategorized file `/docs/REFACTOR_UPLOAD.md` should be moved to `/docs/design` or `/docs/reports`

### Stack-Specific Consistency

**For this Node.js/Express project:**
- Maintain existing ES6+ patterns (const/let, arrow functions, async/await)
- Preserve existing middleware structure and error handling patterns
- Keep existing route organization in server.js
- Maintain vanilla JS approach in frontend (no framework migration unless requested)
- Preserve existing Chinese-language UI and comments
- Keep existing helper function patterns (validatePath, sanitizeFilename, decodeFilename, etc.)

### Upgrade Notes

This CLAUDE.md has been upgraded to the current init skill standard. The new standards (AI vibe coding constraints, touched-file discipline, plan-first triggers, documentation taxonomy) apply to subsequent AI coding work. They do not require proactive refactoring of existing source code that hasn't been touched by current requirements.

When future requirements touch specific files, apply the new standards at that time. The existing large files (server.js at 1137 lines, public/index.html at 2442 lines) are legacy exceptions and should only be refactored when actively working on them or when explicitly requested.
