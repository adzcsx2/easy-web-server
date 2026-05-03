# Copilot Instructions

easy-web-server is a Chinese-language internal network file server (Node.js/Express).

## Tech Stack & Architecture

- **Backend:** Node.js + Express (single file: server.js, 1137 lines)
- **Frontend:** Vanilla JS SPA (single file: public/index.html, 2442 lines)
- **Storage:** files/ directory (gitignored)
- **Key packages:** express, multer, iconv-lite, cors

## File Size Guidelines

- Keep source files under 500 lines when possible
- Large file exceptions: framework entry points, generated files, migrations, vendor code, legacy files
- Don't append unrelated logic to already-large files
- Only refactor large files when actively working on them

## Modification Rules

- Only modify files directly related to current task
- No drive-by changes (formatting, lint fixes on untouched files)
- Make minimum changes to solve the problem
- Match existing patterns in same file/directory
- Search for existing implementations before writing new code
- Don't introduce new frameworks/libraries unless explicitly requested

## Plan Before Executing When

- Modifying more than 3 source files
- Making cross-module changes
- Adding dependencies or changing config
- Modifying public APIs, data models, or routes
- Refactoring or moving files
- Requirements are unclear

## Key Patterns

- All file operations MUST use validatePath() for security (server.js)
- Chinese comments and UI text throughout
- camelCase variables/functions, UPPER_SNAKE_CASE constants
- Error responses: { error: "message" } with HTTP status codes
- Upload progress via in-memory Maps (uploadProgress, canceledUploads, activeUploadRequests, uploadGroups) + SSE
- Upload groups support batch cancel via /api/files/upload/cancel-group

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

## Documentation

- New docs go in /docs (not repository root)
- Standard categories: plan, product, design, guide, modules, references, checklist, reports
- Reuse existing semantically-equivalent directories (e.g., use /docs/guides if it exists)

## Commands

```bash
npm install    # Install dependencies
npm start      # Start server (port 4000)
```

**No build step, no tests, no linter configured.**
