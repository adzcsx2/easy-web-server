# Copilot Instructions

easy-web-server is a Chinese-language internal network file server (Node.js/Express).

## Tech Stack & Architecture

- **Backend:** Node.js + Express (single file: server.js)
- **Frontend:** Vanilla JS SPA (single file: public/index.html)
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
- Modifying public APIs or routes
- Refactoring or moving files

## Key Patterns

- All file operations MUST use validatePath() for security (server.js)
- Chinese comments and UI text throughout
- camelCase variables/functions, UPPER_SNAKE_CASE constants
- Error responses: { error: "message" } with HTTP status codes
- Upload progress via in-memory Maps + SSE

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
