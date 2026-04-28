#!/usr/bin/env node
// Phase 1 后端测试脚本
// 使用方法：node docs/test-phase1.js

const fs = require('fs');
const http = require('http');
const path = require('path');

const BASE_HOST = 'localhost';
const BASE_PORT = 4000;

// 使用时间戳前缀确保每次运行的 uploadId 都是全新的（不与之前的 canceledUploads 冲突）
const RUN_ID = Date.now().toString(36);

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}`);
    if (detail) console.log(`    ${detail}`);
    fail++;
  }
}

function httpRequest(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BASE_HOST,
      port: BASE_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const reqBody = body ? JSON.stringify(body) : undefined;
    if (reqBody) opts.headers['Content-Length'] = Buffer.byteLength(reqBody);

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

function uploadFile(uploadPath, fileContent, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----TestBoundary' + Date.now();
    const fileBuf = Buffer.isBuffer(fileContent)
      ? fileContent
      : Buffer.from(fileContent);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="targetPath"\r\n\r\n\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
      fileBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = http.request({
      hostname: BASE_HOST, port: BASE_PORT,
      path: uploadPath,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readSSE(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let buf = '';
    const req = http.request({
      hostname: BASE_HOST, port: BASE_PORT,
      path: '/api/files/upload-progress',
      headers: { Accept: 'text/event-stream' },
    }, res => {
      res.on('data', d => { buf += d.toString(); });
    });
    req.on('error', () => {});
    req.end();
    setTimeout(() => { req.destroy(); resolve(buf); }, timeoutMs);
  });
}

async function cleanup(paths) {
  for (const p of paths) {
    try {
      await httpRequest('DELETE', `/api/files?path=${encodeURIComponent(p)}`);
    } catch (_) {}
  }
}

async function main() {
  console.log('\n=== Phase 1 Backend Tests ===\n');

  // ---------- Test 1: 单文件上传（向后兼容，无 groupId）----------
  const uid1 = `t01_${RUN_ID}`;
  console.log('[1] 单文件上传（向后兼容）');
  const r1 = await uploadFile(
    `/api/files/upload?uploadId=${uid1}&filename=p1test.txt`,
    'hello phase1',
    'p1test.txt',
  );
  check('上传成功返回 success:true', r1.body && r1.body.success === true, JSON.stringify(r1.body));
  check('上传返回正确 uploadId', r1.body && r1.body.uploadId === uid1, JSON.stringify(r1.body));
  console.log('');

  // ---------- Test 2: 带 groupId 的文件上传 ----------
  const uid2 = `t02_${RUN_ID}`;
  const grp1 = `grp001_${RUN_ID}`;
  console.log('[2] 带 groupId 的文件上传');
  const r2 = await uploadFile(
    `/api/files/upload?uploadId=${uid2}&groupId=${grp1}&relPath=MyFolder%2Fa.txt&groupRoot=MyFolder&rootLabel=MyFolder&filename=p1a.txt`,
    'hello group',
    'p1a.txt',
  );
  check('带 groupId 上传成功', r2.body && r2.body.success === true, JSON.stringify(r2.body));
  console.log('');

  // ---------- Test 3: SSE 返回 tasks + groups 格式 ----------
  const uid3 = `t03_${RUN_ID}`;
  const grp2 = `grp002_${RUN_ID}`;
  console.log('[3] SSE 返回 tasks + groups 格式');
  // 上传文件后 8 秒内 SSE 仍有条目
  await uploadFile(
    `/api/files/upload?uploadId=${uid3}&groupId=${grp2}&rootLabel=SSETest&filename=p1b.txt`,
    'sse test',
    'p1b.txt',
  );
  const sseData = await readSSE(1500);
  check('SSE 包含 tasks 字段', sseData.includes('"tasks"'), `Got: ${sseData.substring(0, 200)}`);
  check('SSE 包含 groups 字段', sseData.includes('"groups"'), `Got: ${sseData.substring(0, 200)}`);
  console.log('');

  // ---------- Test 4: SSE tasks 包含 speed 字段 ----------
  const uid4 = `t04_${RUN_ID}`;
  const grp3 = `grp003_${RUN_ID}`;
  console.log('[4] SSE tasks 包含 speed 字段');
  // 在上传期间并发读取 SSE
  const uploadPromise = uploadFile(
    `/api/files/upload?uploadId=${uid4}&groupId=${grp3}&rootLabel=SpeedTest&filename=p1speed.txt`,
    Buffer.alloc(1024 * 10, 'a'), // 10KB
    'p1speed.txt',
  );
  const sseSpeedData = await readSSE(1000);
  await uploadPromise;
  // speed 字段应该在 tasks 里（即使值为 0）
  // 还需确认上传完成后 8 秒内 SSE 仍可读到
  const sseAfter = await readSSE(1000);
  const allSSE = sseSpeedData + sseAfter;
  check('SSE tasks 条目存在 speed 字段', allSSE.includes('"speed"'), `Got snippet: ${allSSE.substring(allSSE.indexOf('"tasks"'), allSSE.indexOf('"tasks"') + 200)}`);
  console.log('');

  // ---------- Test 5: 取消单文件（removeFiles=true）----------
  console.log('[5] 取消单文件（removeFiles）');
  const r5 = await httpRequest('POST', '/api/files/upload/cancel', { uploadId: uid1, removeFiles: true });
  check('cancel 返回 success', r5.body && r5.body.success === true, JSON.stringify(r5.body));
  check('cancel 返回 cancelled:true', r5.body && r5.body.cancelled === true, JSON.stringify(r5.body));
  console.log('');

  // ---------- Test 6: cancel-group 端点 ----------
  console.log('[6] cancel-group 端点');
  const r6 = await httpRequest('POST', '/api/files/upload/cancel-group', { groupId: grp1, removeFiles: true });
  check('cancel-group 返回 success', r6.body && r6.body.success === true, JSON.stringify(r6.body));
  check('cancel-group 返回 cancelled:true', r6.body && r6.body.cancelled === true, JSON.stringify(r6.body));
  check('cancel-group 包含 groupId', r6.body && r6.body.groupId === grp1, JSON.stringify(r6.body));
  console.log('');

  // ---------- Test 7: cancel-group 参数校验 ----------
  console.log('[7] cancel-group 参数校验');
  const r7 = await httpRequest('POST', '/api/files/upload/cancel-group', {});
  check('缺少 groupId 返回错误', r7.body && r7.body.error, JSON.stringify(r7.body));
  check('返回 400 状态码', r7.status === 400, `Status: ${r7.status}`);
  console.log('');

  // ---------- Test 8: SSE groups 包含聚合状态 ----------
  const grpAgg = `grpAgg_${RUN_ID}`;
  console.log('[8] SSE groups 聚合状态');
  await uploadFile(
    `/api/files/upload?uploadId=t08a_${RUN_ID}&groupId=${grpAgg}&rootLabel=AggTest&filename=p1agg1.txt`,
    'agg test 1',
    'p1agg1.txt',
  );
  await uploadFile(
    `/api/files/upload?uploadId=t08b_${RUN_ID}&groupId=${grpAgg}&rootLabel=AggTest&filename=p1agg2.txt`,
    'agg test 2',
    'p1agg2.txt',
  );
  const sseAgg = await readSSE(1500);
  check('SSE groups 包含 AggTest 组', sseAgg.includes(`"${grpAgg}"`), `Got: ${sseAgg.substring(0, 200)}`);
  console.log('');

  // 结果汇总
  console.log(`=== 结果: ${pass} 通过, ${fail} 失败 ===\n`);

  // 清理测试文件
  await cleanup(['p1test.txt', 'p1a.txt', 'p1b.txt', 'p1speed.txt', 'p1agg1.txt', 'p1agg2.txt', 'test50k.txt', 'upload-test.txt']);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
