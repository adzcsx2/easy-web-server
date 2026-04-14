const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PORT = 4000;
const FILES_ROOT = path.join(__dirname, 'files');
const PROJECT_ROOT = __dirname;
const IGNORE_DIRS = ['node_modules', '.git'];
const MAX_PROGRESS_ENTRIES = 50;
const UPLOAD_PROGRESS_CLEANUP_INTERVAL = 60_000; // 1 minute
const SSE_POLL_INTERVAL = 500; // 500ms

// ---------------------------------------------------------------------------
// Upload progress tracking (shared across all requests / SSE clients)
// ---------------------------------------------------------------------------
const uploadProgress = new Map();

/**
 * Generate a short unique id for each upload operation.
 */
function generateUploadId() {
  return crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
}

/**
 * Keep only the most recent MAX_PROGRESS_ENTRIES in the map.
 */
function pruneProgressEntries() {
  if (uploadProgress.size <= MAX_PROGRESS_ENTRIES) return;
  // Maps iterate in insertion order – drop oldest entries
  const excess = uploadProgress.size - MAX_PROGRESS_ENTRIES;
  let count = 0;
  for (const key of uploadProgress.keys()) {
    if (count >= excess) break;
    uploadProgress.delete(key);
    count++;
  }
}

// Periodically clean old progress entries
setInterval(pruneProgressEntries, UPLOAD_PROGRESS_CLEANUP_INTERVAL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `resolvedPath` starts with `allowedRoot`.
 * Returns the resolved path if valid, otherwise throws.
 */
function validatePath(unsafeRelativePath, allowedRoot) {
  const resolved = path.resolve(allowedRoot, unsafeRelativePath || '');
  if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
    const err = new Error('Path traversal detected');
    err.status = 403;
    throw err;
  }
  return resolved;
}

/**
 * Sanitize a filename by removing path separators and null bytes.
 */
function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_').replace(/\0/g, '');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Trust proxy on internal networks
app.set('trust proxy', true);

// CORS – allow internal network access
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

// Body parsing
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ---------------------------------------------------------------------------
// Serve files/ sub-directories as static sites
// e.g. /asr -> files/asr/index.html
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  // Only handle GET requests for paths that look like sub-directory access
  if (req.method !== 'GET') return next();
  const decodedPath = decodeURIComponent(req.path);
  const dirName = decodedPath.split('/').filter(Boolean)[0];
  if (!dirName) return next();
  const dirPath = path.join(FILES_ROOT, dirName);
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return next();

  // Redirect /dirname -> /dirname/ so relative paths in HTML resolve correctly
  const afterDir = decodedPath.slice(dirName.length + 1);
  if (!afterDir) {
    return res.redirect(301, req.path + '/');
  }

  const subPath = afterDir || '/';  // path after /dirName
  // Serve the requested file from the sub-directory
  const filePath = path.join(dirPath, subPath);
  // Security: ensure resolved path stays within the sub-directory
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dirPath) + path.sep) && resolved !== path.resolve(dirPath)) {
    return next();
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return res.sendFile(resolved);
  }
  // Try index.html for directory paths
  const indexPath = path.join(dirPath, subPath, 'index.html');
  const resolvedIndex = path.resolve(indexPath);
  if (resolvedIndex.startsWith(path.resolve(dirPath) + path.sep) && fs.existsSync(resolvedIndex)) {
    return res.sendFile(resolvedIndex);
  }
  // Fallback: try index.html at the sub-directory root for bare path
  if (subPath === '/') {
    const rootIndex = path.join(dirPath, 'index.html');
    if (fs.existsSync(rootIndex)) {
      return res.sendFile(rootIndex);
    }
  }
  next();
});

// ---------------------------------------------------------------------------
// Serve frontend public/
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not found');
  }
});

// ---------------------------------------------------------------------------
// File Management API
// ---------------------------------------------------------------------------

// --- GET /api/files -------------------------------------------------------
app.get('/api/files', (req, res) => {
  try {
    const relativePath = req.query.path || '';
    const resolved = validatePath(relativePath, FILES_ROOT);

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = entries
      .filter((e) => !e.name.startsWith('.'))
      .map((entry) => {
        const fullPath = path.join(resolved, entry.name);
        const isDir = entry.isDirectory();
        let size = 0;
        let modified = null;
        let hasIndexHtml = false;
        try {
          const s = fs.statSync(fullPath);
          size = s.size;
          modified = s.mtime;
          if (isDir) {
            hasIndexHtml = fs.existsSync(path.join(fullPath, 'index.html'));
          }
        } catch (_) {
          // skip stat errors
        }
        return {
          name: entry.name,
          type: isDir ? 'folder' : 'file',
          isDir,
          hasIndexHtml,
          size,
          modified,
        };
      });

    // Sort: folders first, then files, alphabetical within each group
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Check if the current directory itself is a site (contains index.html)
    const isSite = relativePath ? fs.existsSync(path.join(resolved, 'index.html')) : false;

    res.json({ path: relativePath, items, isSite });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('Error in GET /api/files:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// --- POST /api/files/upload -----------------------------------------------
app.post('/api/files/upload', (req, res) => {
  const uploadId = generateUploadId();
  const totalSize = parseInt(req.headers['content-length'] || '0', 10);

  // Register initial progress
  const progressEntry = {
    uploadId,
    filename: 'batch',
    total: totalSize,
    loaded: 0,
    percent: 0,
    status: 'uploading',
    timestamp: Date.now(),
  };
  uploadProgress.set(uploadId, progressEntry);
  pruneProgressEntries();

  // We need to parse targetPath from the multipart body, so multer must run first.
  // Use a two-pass approach: first multer to parse fields, then validate and save.
  const tempUpload = multer({ limits: { fileSize: 500 * 1024 * 1024, files: 50 } }).array('files', 50);

  tempUpload(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      progressEntry.status = 'error';
      progressEntry.error = err.message;
      progressEntry.timestamp = Date.now();
      if (!res.headersSent) {
        return res.status(400).json({ error: err.message, uploadId });
      }
      return;
    }

    // Now req.body is populated by multer
    const targetPath = (req.body && req.body.targetPath) || '';
    let resolvedTarget;
    try {
      resolvedTarget = validatePath(targetPath, FILES_ROOT);
    } catch (pathErr) {
      return res.status(403).json({ error: pathErr.message });
    }

    // Ensure target directory exists
    if (!fs.existsSync(resolvedTarget)) {
      try {
        fs.mkdirSync(resolvedTarget, { recursive: true });
      } catch (mkdirErr) {
        console.error('Failed to create target directory:', mkdirErr);
        return res.status(500).json({ error: 'Failed to create target directory' });
      }
    }

    // Move files from temp to target directory
    const files = req.files || [];
    const savedFiles = [];

    for (const file of files) {
      const safeName = sanitizeFilename(file.originalname);
      let finalName = safeName;
      const destPath = path.join(resolvedTarget, finalName);

      if (fs.existsSync(destPath)) {
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        let counter = 1;
        while (fs.existsSync(path.join(resolvedTarget, `${base}_${counter}${ext}`))) {
          counter++;
        }
        finalName = `${base}_${counter}${ext}`;
      }

      const finalDest = path.join(resolvedTarget, finalName);
      try {
        fs.renameSync(file.path, finalDest);
        savedFiles.push({ originalName: file.originalname, savedName: finalName, size: file.size });
      } catch (renameErr) {
        console.error('Failed to move uploaded file:', renameErr);
        // Clean up temp file
        try { fs.unlinkSync(file.path); } catch (_) {}
      }
    }

    progressEntry.loaded = totalSize;
    progressEntry.percent = 100;
    progressEntry.status = 'done';
    progressEntry.fileCount = savedFiles.length;
    progressEntry.timestamp = Date.now();

    res.json({
      success: true,
      uploadId,
      files: savedFiles,
    });
  });
});

// --- GET /api/files/upload-progress (SSE) ---------------------------------
app.get('/api/files/upload-progress', (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial comment to establish connection
  res.write(': connected\n\n');

  // Poll uploadProgress map every 500ms and send updates
  const interval = setInterval(() => {
    try {
      const data = {};
      for (const [key, value] of uploadProgress) {
        data[key] = value;
      }
      res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (writeErr) {
      // Client disconnected
      clearInterval(interval);
    }
  }, SSE_POLL_INTERVAL);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
  });
});

// --- GET /api/files/download -----------------------------------------------
app.get('/api/files/download', (req, res) => {
  try {
    const relativePath = req.query.path || '';
    if (!relativePath) {
      return res.status(400).json({ error: 'Path parameter is required' });
    }

    const resolved = validatePath(relativePath, FILES_ROOT);

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a directory' });
    }

    res.download(resolved, path.basename(resolved), (err) => {
      if (err) {
        console.error('Download error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        }
      }
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('Error in GET /api/files/download:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// --- DELETE /api/files -----------------------------------------------------
app.delete('/api/files', (req, res) => {
  try {
    const relativePath = req.query.path || '';
    if (!relativePath) {
      return res.status(400).json({ error: 'Path parameter is required' });
    }

    const resolved = validatePath(relativePath, FILES_ROOT);

    // Prevent deletion of the root FILES_ROOT itself
    if (resolved === FILES_ROOT) {
      return res.status(403).json({ error: 'Cannot delete the root files directory' });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File or folder not found' });
    }

    const stat = fs.statSync(resolved);

    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }

    res.json({ success: true });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('Error in DELETE /api/files:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// --- POST /api/files/mkdir ------------------------------------------------
app.post('/api/files/mkdir', (req, res) => {
  try {
    const { path: relativePath, name } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const sanitizedName = sanitizeFilename(name);
    if (!sanitizedName) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }

    const parentResolved = validatePath(relativePath || '', FILES_ROOT);

    if (!fs.existsSync(parentResolved)) {
      return res.status(404).json({ error: 'Parent directory not found' });
    }

    const parentStat = fs.statSync(parentResolved);
    if (!parentStat.isDirectory()) {
      return res.status(400).json({ error: 'Parent path is not a directory' });
    }

    const newDirPath = path.join(parentResolved, sanitizedName);

    // Double-check the new dir is still within FILES_ROOT
    if (!newDirPath.startsWith(FILES_ROOT + path.sep) && newDirPath !== FILES_ROOT) {
      return res.status(403).json({ error: 'Path traversal detected' });
    }

    if (fs.existsSync(newDirPath)) {
      return res.status(409).json({ error: 'Folder already exists' });
    }

    fs.mkdirSync(newDirPath, { recursive: true });

    res.json({ success: true, path: path.join(relativePath || '', sanitizedName) });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('Error in POST /api/files/mkdir:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Ensure FILES_ROOT exists
if (!fs.existsSync(FILES_ROOT)) {
  try {
    fs.mkdirSync(FILES_ROOT, { recursive: true });
    console.log('Created files directory:', FILES_ROOT);
  } catch (err) {
    console.error('Failed to create files directory:', err.message);
    process.exit(1);
  }
}

/**
 * Get the first non-internal IPv4 address for network display.
 */
function isPrivateIPv4(addr) {
  const parts = addr.split('.').map(Number);
  if (parts[0] === 10) return true;                        // 10.0.0.0/8
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
  if (parts[0] === 192 && parts[1] === 168) return true;   // 192.168.0.0/16
  return false;
}

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  // Prefer 192.168.x.x, then other private ranges, then any non-internal
  let fallback = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (isPrivateIPv4(iface.address)) return iface.address;
        if (!fallback) fallback = iface.address;
      }
    }
  }
  return fallback || '127.0.0.1';
}

// Start server
app.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  const networkUrl = `http://${getLocalIPv4()}:${PORT}`;

  console.log();
  console.log(`  Local:   ${localUrl}`);
  console.log(`  Network: ${networkUrl}`);
  console.log();
});

module.exports = app;
