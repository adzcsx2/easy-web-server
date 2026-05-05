const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const iconv = require('iconv-lite');
const { spawn, execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PORT = 4000;
const FILES_ROOT = path.join(__dirname, 'files');
const PROJECT_ROOT = __dirname;
const UPLOAD_TEMP_DIR = path.join(__dirname, '.tmp');
const IGNORE_DIRS = ['node_modules', '.git'];
const MAX_PROGRESS_ENTRIES = 50;
const UPLOAD_PROGRESS_CLEANUP_INTERVAL = 60_000; // 1 minute
const SSE_POLL_INTERVAL = 500; // 500ms
const MAX_VIEW_FILE_SIZE = 5 * 1024 * 1024; // 5MB - maximum file size for text viewing
const TEXT_FILE_EXTENSIONS = [
  'md', 'txt', 'json', 'xml', 'yaml', 'yml', 'js', 'jsx', 'ts', 'tsx',
  'css', 'scss', 'less', 'py', 'java', 'go', 'rs', 'c',
  'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'php', 'rb', 'swift', 'kt',
  'sql', 'csv', 'tsv', 'ini', 'toml', 'conf', 'config', 'log', 'markdown',
  'rest', 'graphql', 'vue', 'svelte'
];

// ---------------------------------------------------------------------------
// Upload progress tracking (shared across all requests / SSE clients)
// ---------------------------------------------------------------------------
const uploadProgress = new Map();
const canceledUploads = new Map();
const activeUploadRequests = new Map();

// 上传分组：key=groupId, value={groupId, rootLabel, groupRootPath, baseTargetPath, taskIds, writtenPaths, createdAt, cancelled}
const uploadGroups = new Map();

/**
 * Generate a short unique id for each upload operation.
 */
function generateUploadId() {
  return crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
}

/**
 * Prune stale progress entries: remove entries older than 24 hours
 * or entries stuck in non-terminal states for too long.
 */
function pruneProgressEntries() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours – large file uploads may take very long
  for (const [key, entry] of uploadProgress) {
    if (now - entry.timestamp > maxAge) {
      uploadProgress.delete(key);
    }
  }
  for (const [key, ts] of canceledUploads) {
    if (now - ts > maxAge) {
      canceledUploads.delete(key);
    }
  }
  // 清理所有任务都已消失的分组
  for (const [gid, group] of uploadGroups) {
    const hasActiveTasks = Array.from(group.taskIds).some(id => uploadProgress.has(id));
    if (!hasActiveTasks) {
      uploadGroups.delete(gid);
    }
  }
  if (uploadProgress.size <= MAX_PROGRESS_ENTRIES) return;
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

/**
 * Decode filename that may be encoded with non-UTF-8 charset.
 * This handles cases where Chinese filenames are garbled due to encoding mismatches.
 *
 * Common issue: UTF-8 bytes of Chinese characters are misinterpreted as Latin-1/CP1252
 * Example: "文档.doc" becomes "ææ¡£.doc" when UTF-8 bytes are read as Latin-1
 */
function decodeFilename(filename) {
  if (!filename) return filename;

  // If filename already contains valid Chinese characters, return as-is
  if (/[\u4e00-\u9fa5]/.test(filename)) {
    return filename;
  }

  // Try to detect and fix UTF-8 bytes interpreted as Latin-1 (most common issue)
  // When UTF-8 Chinese bytes are misread as Latin-1, they appear as accented characters
  const hasLatin1Artifacts = /[ÃÂÄÀÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(filename);
  if (hasLatin1Artifacts) {
    try {
      const latin1Buffer = Buffer.from(filename, 'latin1');
      const decoded = iconv.decode(latin1Buffer, 'utf8');
      // Verify the decoded string contains Chinese
      if (/[\u4e00-\u9fa5]/.test(decoded)) {
        return decoded;
      }
    } catch (e) {
      // Continue to next attempt
    }
  }

  // Try GBK encoding (some Windows systems use GBK for filenames)
  // Check for patterns that look like GBK bytes interpreted as Latin-1
  const hasGBKPatter = /[Â¼Ã«Â½ÃÂÃÃÃÃÃÃª]/.test(filename) ||
                       /[€'ƒ"…†‡ˆ‰Š‹ŒŽ'""•–—˜™š›œžŸ]/.test(filename);
  if (hasGBKPatter) {
    try {
      const gbkBuffer = Buffer.from(filename, 'latin1');
      const decoded = iconv.decode(gbkBuffer, 'gbk');
      if (/[\u4e00-\u9fa5]/.test(decoded)) {
        return decoded;
      }
    } catch (e) {
      // Continue
    }
  }

  // Fallback: return original filename
  return filename;
}

/**
 * Check if a file extension is in the text file whitelist.
 */
function isTextFileExtension(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

/**
 * Detect if a file is likely binary by checking for null bytes.
 */
function isBinaryContent(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
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
      .filter((e) => e.name !== '.' && e.name !== '..' && !IGNORE_DIRS.includes(e.name))
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
  // Read uploadId and group info from query params (available before multer parses body)
  const uploadId = req.query.uploadId || generateUploadId();
  const filename = req.query.filename || '上传中...';
  const totalSize = parseInt(req.headers['content-length'] || '0', 10);
  // 分组相关参数（文件夹上传时由客户端传入）
  const groupId = req.query.groupId || uploadId; // 无 groupId 时退化为 uploadId（单文件兼容）
  const relPath = req.query.relPath ? decodeURIComponent(req.query.relPath) : '';
  const groupRoot = req.query.groupRoot ? decodeURIComponent(req.query.groupRoot) : '';
  const rootLabel = req.query.rootLabel ? decodeURIComponent(req.query.rootLabel) : filename;

  const isCancelled = () => canceledUploads.has(uploadId) ||
    (uploadGroups.has(groupId) && uploadGroups.get(groupId).cancelled);

  function markUploadCancelled(reason) {
    progressEntry.status = 'canceled';
    progressEntry.error = reason || 'Upload cancelled';
    progressEntry.timestamp = Date.now();
    setTimeout(() => uploadProgress.delete(progressEntry.uploadId), 8000);
  }

  // Register progress entry with client-provided ID
  const progressEntry = {
    uploadId,
    groupId,
    relativePath: relPath,
    filename,
    total: totalSize,
    loaded: 0,
    percent: 0,
    speed: 0,          // bytes/sec，滑动窗口计算
    persistedPath: '', // 文件落盘后的绝对路径（用于取消时清理）
    status: 'uploading',
    timestamp: Date.now(),
    _speedSamples: [], // [{t, loaded}] 用于滑动窗口计算速率
  };
  uploadProgress.set(uploadId, progressEntry);
  activeUploadRequests.set(uploadId, req);

  // 注册/更新分组信息
  if (!uploadGroups.has(groupId)) {
    uploadGroups.set(groupId, {
      groupId,
      rootLabel,
      groupRootPath: groupRoot,
      taskIds: new Set(),
      writtenPaths: new Set(),
      createdAt: Date.now(),
      cancelled: false,
    });
  }
  uploadGroups.get(groupId).taskIds.add(uploadId);

  pruneProgressEntries();

  // Track client disconnect so we can skip processing an aborted upload
  let clientAborted = false;
  req.on('aborted', () => {
    clientAborted = true;
  });
  req.on('close', () => {
    if (!req.complete) {
      clientAborted = true;
    }
  });

  // Update server-side progress for SSE consumers.
  req.on('data', (chunk) => {
    if (!chunk || !chunk.length) return;
    progressEntry.loaded += chunk.length;
    if (progressEntry.total > 0) {
      progressEntry.percent = Math.min(100, Math.round((progressEntry.loaded / progressEntry.total) * 100));
    }
    const now = Date.now();
    progressEntry.timestamp = now;

    // 滑动窗口速率计算（1500ms 窗口）
    const samples = progressEntry._speedSamples;
    samples.push({ t: now, loaded: progressEntry.loaded });
    // 移除 1500ms 以外的旧样本
    const cutoff = now - 1500;
    while (samples.length > 1 && samples[0].t < cutoff) {
      samples.shift();
    }
    if (samples.length >= 2) {
      const dt = samples[samples.length - 1].t - samples[0].t;
      const dl = samples[samples.length - 1].loaded - samples[0].loaded;
      progressEntry.speed = dt > 0 ? Math.round((dl / dt) * 1000) : 0;
    }
  });

  // We need to parse targetPath from the multipart body, so multer must run first.
  // Use a two-pass approach: first multer to parse fields, then validate and save.
  const tempDir = UPLOAD_TEMP_DIR;
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const uploadStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tempDir),
    filename: (_req, file, cb) => {
      const safeOriginal = sanitizeFilename(file.originalname || 'upload.bin');
      const suffix = crypto.randomBytes(4).toString('hex');
      cb(null, `${uploadId}-${Date.now()}-${suffix}-${safeOriginal}`);
    },
  });
  const tempUpload = multer({
    storage: uploadStorage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024, files: 50 },
  }).array('files', 50);

  tempUpload(req, res, async (err) => {
    // Helper to clean up temp files from multer disk storage
    async function cleanupTempFiles(fileList) {
      for (const file of (fileList || [])) {
        try { await fs.promises.unlink(file.path); } catch (_) {}
      }
    }

    try {
      if (isCancelled()) {
        await cleanupTempFiles(req.files);
        markUploadCancelled('Upload cancelled by user');
        if (!res.headersSent) {
          return res.status(499).json({ error: 'Upload cancelled', uploadId: progressEntry.uploadId, cancelled: true });
        }
        return;
      }

      if (err) {
        if (isCancelled() || clientAborted) {
          await cleanupTempFiles(req.files);
          markUploadCancelled('Upload cancelled by client');
          if (!res.headersSent) {
            return res.status(499).json({ error: 'Upload cancelled', uploadId: progressEntry.uploadId, cancelled: true });
          }
          return;
        }

        console.error('Upload error:', err);
        progressEntry.status = 'error';
        progressEntry.error = err.message;
        progressEntry.timestamp = Date.now();
        setTimeout(() => uploadProgress.delete(progressEntry.uploadId), 8000);
        await cleanupTempFiles(req.files);
        if (!res.headersSent) {
          return res.status(400).json({ error: err.message, uploadId: progressEntry.uploadId });
        }
        return;
      }

      // Client already disconnected – skip file processing, just clean up temp files
      if (clientAborted) {
        markUploadCancelled('Upload aborted by client');
        await cleanupTempFiles(req.files);
        if (!res.headersSent) {
          return res.status(499).json({ error: 'Upload cancelled', uploadId: progressEntry.uploadId, cancelled: true });
        }
        return;
      }

      // Now req.body is populated by multer
      const targetPath = (req.body && req.body.targetPath) || '';

      let resolvedTarget;
      try {
        resolvedTarget = validatePath(targetPath, FILES_ROOT);
      } catch (pathErr) {
        await cleanupTempFiles(req.files);
        return res.status(403).json({ error: pathErr.message });
      }

      // Ensure target directory exists (create recursively if needed)
      if (!fs.existsSync(resolvedTarget)) {
        try {
          fs.mkdirSync(resolvedTarget, { recursive: true });
        } catch (mkdirErr) {
          console.error('Failed to create target directory:', mkdirErr);
          await cleanupTempFiles(req.files);
          return res.status(500).json({ error: 'Failed to create target directory' });
        }
      }

      // Verify resolved target is a directory
      try {
        if (!fs.statSync(resolvedTarget).isDirectory()) {
          await cleanupTempFiles(req.files);
          return res.status(400).json({ error: 'Target path is not a directory' });
        }
      } catch (statErr) {
        console.error('Failed to stat target directory:', statErr);
        await cleanupTempFiles(req.files);
        return res.status(500).json({ error: 'Target directory not accessible' });
      }

      // Move files from temp to target directory (async to avoid blocking event loop)
      const files = req.files || [];
      const savedFiles = [];

      // Network transfer finished; now server is processing final persistence.
      progressEntry.status = 'processing';
      progressEntry.percent = Math.min(100, progressEntry.percent || 100);
      progressEntry.timestamp = Date.now();

      async function moveTempFile(src, dest) {
        try {
          await fs.promises.rename(src, dest);
        } catch (renameErr) {
          if (renameErr && renameErr.code === 'EXDEV') {
            await fs.promises.copyFile(src, dest);
            await fs.promises.unlink(src);
            return;
          }
          throw renameErr;
        }
      }

      for (const file of files) {
        if (isCancelled() || clientAborted) {
          await cleanupTempFiles(files);
          markUploadCancelled('Upload cancelled by user');
          if (!res.headersSent) {
            return res.status(499).json({ error: 'Upload cancelled', uploadId: progressEntry.uploadId, cancelled: true });
          }
          return;
        }

        // Decode filename to handle Chinese characters correctly
        const decodedName = decodeFilename(file.originalname);
        const safeName = sanitizeFilename(decodedName);
        let finalName = safeName;
        let finalDest = path.join(resolvedTarget, finalName);

        if (fs.existsSync(finalDest)) {
          const ext = path.extname(safeName);
          const base = path.basename(safeName, ext);
          let counter = 1;
          while (fs.existsSync(path.join(resolvedTarget, `${base}_${counter}${ext}`))) {
            counter++;
          }
          finalName = `${base}_${counter}${ext}`;
          finalDest = path.join(resolvedTarget, finalName);
        }

        try {
          const src = file.path;
          if (src) {
            await moveTempFile(src, finalDest);
          } else {
            // Fallback: write from buffer if disk storage didn't set path
            await fs.promises.writeFile(finalDest, file.buffer);
          }
          savedFiles.push({ originalName: decodedName, savedName: finalName, size: file.size });
          // 记录落盘路径，供取消时清理
          progressEntry.persistedPath = finalDest;
          if (uploadGroups.has(groupId)) {
            uploadGroups.get(groupId).writtenPaths.add(finalDest);
          }
        } catch (moveErr) {
          console.error('Failed to move uploaded file:', moveErr);
          try { await fs.promises.unlink(file.path); } catch (_) {}
        }
      }

      // Check for total failure BEFORE setting success status
      if (savedFiles.length === 0 && files.length > 0) {
        console.error('All file moves failed for upload', progressEntry.uploadId);
        progressEntry.status = 'error';
        progressEntry.error = 'Failed to save all files';
        progressEntry.timestamp = Date.now();
        setTimeout(() => uploadProgress.delete(progressEntry.uploadId), 8000);
        return res.status(500).json({ error: 'Failed to save uploaded files', uploadId: progressEntry.uploadId });
      }

      progressEntry.loaded = totalSize;
      progressEntry.percent = 100;
      progressEntry.status = 'done';
      progressEntry.fileCount = savedFiles.length;
      progressEntry.timestamp = Date.now();

      // Update filename to show actual uploaded file names
      if (savedFiles.length === 1) {
        progressEntry.filename = savedFiles[0].savedName;
      } else if (savedFiles.length > 1) {
        progressEntry.filename = savedFiles[0].savedName + ' 等' + savedFiles.length + '个文件';
      }

      // Remove progress entry after 8 seconds so SSE stops broadcasting it
      setTimeout(() => uploadProgress.delete(progressEntry.uploadId), 8000);

      res.json({
        success: true,
        uploadId: progressEntry.uploadId,
        files: savedFiles,
      });
    } catch (unhandledErr) {
      if (isCancelled() || clientAborted) {
        markUploadCancelled('Upload cancelled by client');
        await cleanupTempFiles(req.files);
        if (!res.headersSent) {
          return res.status(499).json({ error: 'Upload cancelled', uploadId: progressEntry.uploadId, cancelled: true });
        }
        return;
      }

      console.error('Unhandled error in upload handler:', unhandledErr);
      progressEntry.status = 'error';
      progressEntry.error = unhandledErr.message || 'Internal upload error';
      progressEntry.timestamp = Date.now();
      setTimeout(() => uploadProgress.delete(progressEntry.uploadId), 8000);
      await cleanupTempFiles(req.files);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Upload processing failed', uploadId: progressEntry.uploadId });
      }
    } finally {
      activeUploadRequests.delete(uploadId);
    }
  });
});

// --- POST /api/files/upload/cancel ----------------------------------------
app.post('/api/files/upload/cancel', (req, res) => {
  try {
    const uploadId = (req.body && req.body.uploadId) || req.query.uploadId;
    if (!uploadId) {
      return res.status(400).json({ error: 'uploadId is required' });
    }
    // removeFiles=true（默认）时删除已落盘文件；false 时仅清历史
    const removeFiles = req.body && req.body.removeFiles !== undefined
      ? req.body.removeFiles !== false && req.body.removeFiles !== 'false'
      : true;

    canceledUploads.set(uploadId, Date.now());

    const entry = uploadProgress.get(uploadId);
    const wasTerminal = entry && (entry.status === 'done' || entry.status === 'error' || entry.status === 'canceled');

    if (entry && !wasTerminal) {
      entry.status = 'canceled';
      entry.error = 'Upload cancelled by user';
      entry.timestamp = Date.now();
      setTimeout(() => uploadProgress.delete(uploadId), 8000);
    }

    const activeReq = activeUploadRequests.get(uploadId);
    if (activeReq && !activeReq.destroyed) {
      try {
        activeReq.destroy(new Error('Upload cancelled by user'));
      } catch (_) {}
    }

    // 清理 .tmp 下的临时文件
    try {
      if (fs.existsSync(UPLOAD_TEMP_DIR)) {
        const tempFiles = fs.readdirSync(UPLOAD_TEMP_DIR);
        for (const name of tempFiles) {
          if (!name.startsWith(`${uploadId}-`)) continue;
          try {
            fs.rmSync(path.join(UPLOAD_TEMP_DIR, name), { recursive: true, force: true });
          } catch (_) {}
        }
      }
    } catch (_) {}

    // 若未完成且要求清理，删除已落盘的文件
    if (removeFiles && !wasTerminal && entry && entry.persistedPath) {
      try {
        const p = entry.persistedPath;
        validatePath(path.relative(FILES_ROOT, p), FILES_ROOT);
        fs.rmSync(p, { force: true });
      } catch (_) {}
    }

    res.json({ success: true, uploadId, cancelled: true });
  } catch (err) {
    console.error('Error in POST /api/files/upload/cancel:', err);
    res.status(500).json({ error: 'Failed to cancel upload' });
  }
});

// --- POST /api/files/upload/cancel-group ----------------------------------
app.post('/api/files/upload/cancel-group', (req, res) => {
  try {
    const groupId = (req.body && req.body.groupId) || req.query.groupId;
    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }
    const removeFiles = req.body && req.body.removeFiles !== undefined
      ? req.body.removeFiles !== false && req.body.removeFiles !== 'false'
      : true;

    const group = uploadGroups.get(groupId);

    // 标记分组为已取消，正在上传的任务会在下次循环中检测到
    if (group) {
      group.cancelled = true;
    }

    // 取消所有属于此组的活跃请求并标记进度条目
    const taskIds = group ? Array.from(group.taskIds) : [];
    for (const uploadId of taskIds) {
      canceledUploads.set(uploadId, Date.now());
      const entry = uploadProgress.get(uploadId);
      if (entry && entry.status !== 'done' && entry.status !== 'error' && entry.status !== 'canceled') {
        entry.status = 'canceled';
        entry.error = 'Cancelled by group cancel';
        entry.timestamp = Date.now();
        setTimeout(() => uploadProgress.delete(uploadId), 8000);
      }
      const activeReq = activeUploadRequests.get(uploadId);
      if (activeReq && !activeReq.destroyed) {
        try { activeReq.destroy(new Error('Group cancel')); } catch (_) {}
      }
    }

    // 清理 .tmp 下属于此组所有任务的临时文件
    // 用 Set 做前缀匹配，避免 O(M×N) 嵌套扫描
    try {
      if (fs.existsSync(UPLOAD_TEMP_DIR)) {
        const taskIdSet = new Set(taskIds);
        const tempFiles = fs.readdirSync(UPLOAD_TEMP_DIR);
        for (const name of tempFiles) {
          // 文件名格式为 "<uploadId>-<originalName>"，取第一段作为 uploadId
          const dashIdx = name.indexOf('-');
          const fileUploadId = dashIdx >= 0 ? name.substring(0, dashIdx) : name;
          if (!taskIdSet.has(fileUploadId)) continue;
          try { fs.rmSync(path.join(UPLOAD_TEMP_DIR, name), { recursive: true, force: true }); } catch (_) {}
        }
      }
    } catch (_) {}

    if (!removeFiles || !group) {
      uploadGroups.delete(groupId);
      return res.json({ success: true, groupId, cancelled: true, cleaned: 0 });
    }

    // 延迟 300ms 让正在 rename 的 moveTempFile 操作完成，再统一清理落盘文件
    setTimeout(() => {
      let cleaned = 0;
      const writtenPaths = group ? Array.from(group.writtenPaths) : [];

      for (const p of writtenPaths) {
        try {
          validatePath(path.relative(FILES_ROOT, p), FILES_ROOT);
          fs.rmSync(p, { force: true });
          cleaned++;
        } catch (_) {}
      }

      // 尝试递归删除分组根目录（如果是由此次上传创建的文件夹）
      if (group && group.groupRootPath) {
        try {
          const rootAbs = validatePath(group.groupRootPath, FILES_ROOT);
          if (fs.existsSync(rootAbs)) {
            fs.rmSync(rootAbs, { recursive: true, force: true });
            cleaned++;
          }
        } catch (_) {}
      }

      uploadGroups.delete(groupId);
    }, 300);

    res.json({ success: true, groupId, cancelled: true, cleaned: -1 }); // cleaned=-1 表示异步清理中
  } catch (err) {
    console.error('Error in POST /api/files/upload/cancel-group:', err);
    res.status(500).json({ error: 'Failed to cancel group upload' });
  }
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
      // tasks：所有任务条目（去掉内部 _speedSamples 不对外暴露）
      const tasks = {};
      for (const [key, value] of uploadProgress) {
        const { _speedSamples, ...rest } = value;
        tasks[key] = rest;
      }

      // groups：聚合每个分组的进度、速率、状态
      const groups = {};
      for (const [gid, group] of uploadGroups) {
        let totalBytes = 0;
        let bytesUploaded = 0;
        let speed = 0;
        let doneCount = 0;
        let errorCount = 0;
        let canceledCount = 0;
        let uploadingCount = 0;
        const taskCount = group.taskIds.size;

        for (const tid of group.taskIds) {
          const t = uploadProgress.get(tid);
          if (!t) continue;
          totalBytes += t.total || 0;
          bytesUploaded += t.loaded || 0;
          if (t.status === 'uploading' || t.status === 'processing') {
            speed += t.speed || 0;
            uploadingCount++;
          } else if (t.status === 'done') {
            doneCount++;
          } else if (t.status === 'error') {
            errorCount++;
          } else if (t.status === 'canceled') {
            canceledCount++;
          }
        }

        // 推导分组状态
        let groupStatus = 'uploading';
        if (group.cancelled || canceledCount === taskCount) {
          groupStatus = 'canceled';
        } else if (uploadingCount === 0 && taskCount > 0) {
          if (errorCount > 0) {
            groupStatus = doneCount > 0 ? 'done-with-errors' : 'error';
          } else {
            groupStatus = 'done';
          }
        }

        groups[gid] = {
          groupId: gid,
          rootLabel: group.rootLabel,
          groupRootPath: group.groupRootPath,
          taskCount,
          totalBytes,
          bytesUploaded,
          speed,
          status: groupStatus,
          doneCount,
          errorCount,
          canceledCount,
          uploadingCount,
        };
      }

      res.write(`event: progress\ndata: ${JSON.stringify({ tasks, groups })}\n\n`);
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

// --- GET /api/files/view ---------------------------------------------------
app.get('/api/files/view', (req, res) => {
  try {
    const relativePath = req.query.path || '';
    if (!relativePath) {
      return res.status(400).json({ error: '路径参数不能为空' });
    }

    const resolved = validatePath(relativePath, FILES_ROOT);

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: '无法查看目录' });
    }

    // Check file size limit
    if (stat.size > MAX_VIEW_FILE_SIZE) {
      return res.status(413).json({ error: `文件过大，无法查看（最大${MAX_VIEW_FILE_SIZE / 1024 / 1024}MB）` });
    }

    // Check file extension
    if (!isTextFileExtension(relativePath)) {
      return res.status(415).json({ error: '不支持的文件类型' });
    }

    // Read file content
    const content = fs.readFileSync(resolved);

    // Binary content detection
    if (isBinaryContent(content)) {
      return res.status(415).json({ error: '不支持查看二进制文件' });
    }

    // Set content type and encoding
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(content.toString('utf-8'));
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('Error in GET /api/files/view:', err);
    res.status(500).json({ error: '读取文件失败' });
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
// Tunnel URL 同步相关常量
// ---------------------------------------------------------------------------
const REDIRECT_HTML_PATH = path.join(__dirname, 'docs', 'redirect.html');
const REDIRECT_PLACEHOLDER = '__TUNNEL_URL_PLACEHOLDER__';
const REDIRECT_PUBLIC_URL = 'https://adzcsx2.github.io/easy-web-server/redirect.html';

// --- GET /api/tunnel -------------------------------------------------------
let tunnelUrl = null;
let tunnelState = 'starting'; // 'starting' | 'ready' | 'failed'

app.get('/api/tunnel', (_req, res) => {
  res.json({ url: tunnelUrl, redirectUrl: REDIRECT_PUBLIC_URL, status: tunnelState, retryCount: tunnelRetryCount });
});

// --- POST /api/clipboard ---------------------------------------------------
app.post('/api/clipboard', express.json({ limit: '100kb' }), (req, res) => {
  const text = req.body.text;
  if (typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ error: '请输入文字' });
  }
  if (text.length > 100_000) {
    return res.status(400).json({ error: '文字过长' });
  }

  // Windows: 使用 clip 命令，通过 stdin 管道传递（避免命令注入）
  const proc = spawn('clip', [], { shell: true });
  proc.stdin.write(text, 'utf8');
  proc.stdin.end();
  proc.on('close', (code) => {
    if (code === 0) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: '服务器剪贴板写入失败' });
    }
  });
  proc.on('error', () => {
    res.status(500).json({ error: '服务器剪贴板写入失败' });
  });
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

// Clean up stale temp files from previous uploads
if (fs.existsSync(UPLOAD_TEMP_DIR)) {
  try {
    const tempFiles = fs.readdirSync(UPLOAD_TEMP_DIR);
    for (const f of tempFiles) {
      try { fs.rmSync(path.join(UPLOAD_TEMP_DIR, f), { recursive: true, force: true }); } catch (_) {}
    }
    if (tempFiles.length > 0) {
      console.log(`Cleaned up ${tempFiles.length} stale temp file(s)`);
    }
  } catch (_) {}
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
const server = app.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  const networkUrl = `http://${getLocalIPv4()}:${PORT}`;

  console.log();
  console.log(`  Local:   ${localUrl}`);
  console.log(`  Network: ${networkUrl}`);
  console.log();
});

// Disable timeouts so large file uploads/downloads are not cut off.
// Default Node.js timeout is 120s which aborts big transfers on fast LAN.
server.timeout = 0;           // socket idle timeout (0 = disabled for large file transfers)
server.keepAliveTimeout = 0;  // HTTP keep-alive timeout
server.headersTimeout = 60_000; // header timeout – prevents Slowloris DoS

// ---------------------------------------------------------------------------
// Cloudflare Quick Tunnel
// ---------------------------------------------------------------------------
const CLOUDFLARED_EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const CLOUDFLARED_PATH = path.join(PROJECT_ROOT, CLOUDFLARED_EXE);
let cloudflaredProc = null;

/**
 * 检测 cloudflared 是否可用（PATH 或项目目录下）
 */
function findCloudflared() {
  // 项目目录下优先
  if (fs.existsSync(CLOUDFLARED_PATH)) return CLOUDFLARED_PATH;
  // 系统 PATH
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = require('child_process').execSync(`${whichCmd} ${CLOUDFLARED_EXE}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const p = result.trim().split(/\r?\n/)[0];
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return null;
}

/**
 * Windows 平台自动下载 cloudflared 到项目目录
 */
function installCloudflared() {
  return new Promise((resolve, reject) => {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`;
    console.log(`  正在下载 cloudflared (${arch}) ...`);

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${CLOUDFLARED_PATH}'`
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let stderr = '';
    ps.stderr.on('data', (d) => { stderr += d; });

    ps.on('close', (code) => {
      if (code === 0 && fs.existsSync(CLOUDFLARED_PATH)) {
        console.log('  cloudflared 下载完成');
        resolve(CLOUDFLARED_PATH);
      } else {
        reject(new Error(`下载 cloudflared 失败 (code=${code}): ${stderr}`));
      }
    });
    ps.on('error', reject);
  });
}

/**
 * 启动 Quick Tunnel 并解析公网 URL
 */
function startTunnel(cloudflaredBin) {
  return new Promise((resolve, reject) => {
    // tunnel 子域名是长随机串（如 xxx-yyy-zzz-aaa-bbb），至少 20 字符
    // 排除 api.trycloudflare.com 等短子域名
    const urlRegex = /https:\/\/[a-zA-Z0-9\-]{20,}\.trycloudflare\.com/;
    let resolved = false;
    let stderrBuf = '';

    const proc = spawn(cloudflaredBin, [
      'tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    cloudflaredProc = proc;

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrBuf += chunk;
      if (!resolved) {
        const match = chunk.match(urlRegex);
        if (match) {
          resolved = true;
          tunnelUrl = match[0];
          tunnelState = 'ready';
          console.log(`  Tunnel:  ${tunnelUrl}`);
          console.log();
          resolve(tunnelUrl);
        }
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        reject(new Error(`启动 cloudflared 失败: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      cloudflaredProc = null;
      if (!resolved) {
        reject(new Error(`cloudflared 意外退出 (code=${code}): ${stderrBuf}`));
      }
    });

    // 30 秒超时：如果没拿到 URL 就放弃
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        reject(new Error('等待 tunnel URL 超时 (30s)'));
      }
    }, 30_000);
  });
}

// ---------------------------------------------------------------------------
// Tunnel URL 自动同步到 GitHub Pages（docs/redirect.html）
// ---------------------------------------------------------------------------

/**
 * 将 tunnel URL 写入 docs/redirect.html 并 git push 到远程
 */
function syncTunnelUrlToGitHub(url) {
  try {
    if (!fs.existsSync(REDIRECT_HTML_PATH)) {
      console.log('  [redirect] docs/redirect.html 不存在，跳过同步');
      return;
    }

    let html = fs.readFileSync(REDIRECT_HTML_PATH, 'utf8');
    // 精确替换 const TUNNEL_URL = '...' 这一整行
    const newContent = html.replace(
      /const TUNNEL_URL = '(https:\/\/[a-zA-Z0-9\-]{20,}\.trycloudflare\.com|__TUNNEL_URL_PLACEHOLDER__)'/,
      `const TUNNEL_URL = '${url}'`
    );

    if (html === newContent) {
      // URL 没变（理论上不会走到这里，因为每次重启 URL 都不同）
      return;
    }

    fs.writeFileSync(REDIRECT_HTML_PATH, newContent, 'utf8');
    console.log('  [redirect] 已写入 tunnel URL 到 docs/redirect.html');

    // git add + commit + push
    const gitOpts = { cwd: __dirname, windowsHide: true };
    const gitCmd = process.platform === 'win32' ? 'git.exe' : 'git';

    execFile(gitCmd, ['add', 'docs/redirect.html'], gitOpts, (addErr) => {
      if (addErr) {
        console.error('  [redirect] git add 失败:', addErr.message);
        return;
      }
      execFile(gitCmd, ['commit', '-m', `chore: update tunnel URL`], gitOpts, (commitErr) => {
        if (commitErr) {
          // 可能没有变更（比如内容相同），静默忽略
          return;
        }
        console.log('  [redirect] git commit 成功');
        execFile(gitCmd, ['push', 'origin', 'main'], gitOpts, (pushErr) => {
          if (pushErr) {
            console.error('  [redirect] git push 失败:', pushErr.message);
            return;
          }
          console.log('  [redirect] git push 成功 — redirect.html 已同步到 GitHub');
        });
      });
    });
  } catch (err) {
    console.error('  [redirect] 同步失败:', err.message);
  }
}

// 自动安装 + 启动隧道（异步，不阻塞 server 启动，失败自动重试）
const TUNNEL_RETRY_DELAY = 10_000; // 10 秒
let tunnelRetryCount = 0;

(async () => {
  try {
    let bin = findCloudflared();
    if (!bin) {
      if (process.platform === 'win32') {
        await installCloudflared();
        bin = CLOUDFLARED_PATH;
      } else {
        console.log('  未找到 cloudflared，跳过隧道。安装方法: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
        tunnelState = 'failed';
        return;
      }
    }

    while (true) {
      tunnelRetryCount++;
      try {
        console.log(`  启动隧道 (第 ${tunnelRetryCount} 次)...`);
        const url = await startTunnel(bin);
        tunnelRetryCount = 0;
        syncTunnelUrlToGitHub(url);
        return; // 成功，退出
      } catch (err) {
        console.error(`  第 ${tunnelRetryCount} 次尝试失败: ${err.message}`);
        console.log(`  ${TUNNEL_RETRY_DELAY / 1000} 秒后重试...`);
        await new Promise(r => setTimeout(r, TUNNEL_RETRY_DELAY));
      }
    }
  } catch (err) {
    console.error(`  Tunnel 启动失败: ${err.message}`);
    tunnelState = 'failed';
  }
})();

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭...`);

  // 重置 redirect.html 中的 tunnel URL 为占位符，并同步 push
  if (tunnelUrl && fs.existsSync(REDIRECT_HTML_PATH)) {
    try {
      let html = fs.readFileSync(REDIRECT_HTML_PATH, 'utf8');
      const reset = html.replace(
        /const TUNNEL_URL = '(https:\/\/[a-zA-Z0-9\-]{20,}\.trycloudflare\.com|__TUNNEL_URL_PLACEHOLDER__)'/,
        `const TUNNEL_URL = '${REDIRECT_PLACEHOLDER}'`
      );
      if (html !== reset) {
        fs.writeFileSync(REDIRECT_HTML_PATH, reset, 'utf8');
        console.log('  [redirect] 已重置 tunnel URL 占位符');
        // 关闭阶段用同步操作确保 push 完成再退出
        const syncOpts = { cwd: __dirname, windowsHide: true, timeout: 10_000, stdio: 'pipe' };
        require('child_process').execSync('git add docs/redirect.html', syncOpts);
        require('child_process').execSync('git commit -m "chore: reset tunnel URL (offline)"', syncOpts);
        require('child_process').execSync('git push origin main', syncOpts);
        console.log('  [redirect] 已同步离线状态到 GitHub');
      }
    } catch (e) {
      console.error('  [redirect] 离线同步失败:', e.message);
    }
  }

  if (cloudflaredProc && !cloudflaredProc.killed) {
    cloudflaredProc.kill('SIGTERM');
  }
  server.close(() => {
    process.exit(0);
  });
  // 5 秒强制退出
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = app;
