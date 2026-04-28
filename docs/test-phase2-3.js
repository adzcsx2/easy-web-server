#!/usr/bin/env node
// Phase 2+3 前端+UI 测试脚本（无头验证：代码结构 + API 集成）
// 使用方法：node docs/test-phase2-3.js

const fs = require('fs');
const http = require('http');

const BASE_HOST = 'localhost';
const BASE_PORT = 4000;

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

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: BASE_HOST, port: BASE_PORT, path: urlPath }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n=== Phase 2+3 Frontend/UI Structural Tests ===\n');

  // 读取 index.html 源码
  const html = fs.readFileSync('./public/index.html', 'utf8');

  // ---------- Test 1: 旧状态变量已被删除 ----------
  console.log('[1] 旧状态变量已清除');
  check('无 globalUploads 引用', !html.includes('globalUploads'), 'globalUploads 仍存在');
  check('无 uploadBatches 引用', !html.includes('uploadBatches'), 'uploadBatches 仍存在');
  check('无 hiddenGlobalIds 引用', !html.includes('hiddenGlobalIds'), 'hiddenGlobalIds 仍存在');
  check('无 nextBatchId 引用', !html.includes('nextBatchId'), 'nextBatchId 仍存在');
  check('无旧 upload-panel div', !html.includes('id="uploadPanel"'), '旧 uploadPanel 仍存在');
  console.log('');

  // ---------- Test 2: UploadStore 存在 ----------
  console.log('[2] UploadStore 存在');
  check('UploadStore 定义', html.includes('const UploadStore'), 'UploadStore 未找到');
  check('registerGroup 方法', html.includes('function registerGroup'), '');
  check('registerTask 方法', html.includes('function registerTask'), '');
  check('computeGroupAggregate 方法', html.includes('function computeGroupAggregate'), '');
  check('cancelGroup 方法', html.includes('function cancelGroup'), '');
  check('cancelTask 方法', html.includes('function cancelTask'), '');
  check('removeFromHistory 方法', html.includes('function removeFromHistory'), '');
  check('clearCompleted 方法', html.includes('function clearCompleted'), '');
  check('syncFromSSE 方法', html.includes('function syncFromSSE'), '');
  console.log('');

  // ---------- Test 3: 上传队列函数正确 ----------
  console.log('[3] 上传队列函数');
  check('queueUploads 使用 UploadStore.registerGroup', html.includes('UploadStore.registerGroup') && html.includes('queueUploads'), '');
  check('queueFolderUploads 按顶层目录分组', html.includes('topFolderMap'), '');
  check('startUpload 传递 groupId query 参数', html.includes('groupId') && html.includes('urlParams'), '');
  check('startUpload 使用滑动窗口速率', html.includes('speedSamples') && html.includes('1500'), '');
  check('onTaskTerminal 使用 computeGroupAggregate', html.includes('computeGroupAggregate') && html.includes('onTaskTerminal'), '');
  console.log('');

  // ---------- Test 4: FAB + 面板 HTML 元素 ----------
  console.log('[4] FAB + 面板 HTML 元素');
  check('FAB 按钮存在', html.includes('id="uploadFab"'), '');
  check('FAB badge 存在', html.includes('id="fabBadge"'), '');
  check('历史面板存在', html.includes('id="uploadHistoryPanel"'), '');
  check('列表视图存在', html.includes('id="uploadPanelListView"'), '');
  check('详情视图存在', html.includes('id="uploadPanelDetailView"'), '');
  check('分组列表容器存在', html.includes('id="uploadGroupList"'), '');
  check('任务列表容器存在', html.includes('id="uploadTaskList"'), '');
  check('返回按钮存在', html.includes('closeUploadDetail'), '');
  check('清空已完成按钮', html.includes('clearCompletedGroups'), '');
  console.log('');

  // ---------- Test 5: CSS 类 ----------
  console.log('[5] 新 CSS 类存在');
  check('.upload-fab CSS', html.includes('.upload-fab'), '');
  check('.upload-history-panel CSS', html.includes('.upload-history-panel'), '');
  check('.upload-group-row CSS', html.includes('.upload-group-row'), '');
  check('.upload-task-row CSS', html.includes('.upload-task-row'), '');
  check('.upload-group-action CSS', html.includes('.upload-group-action'), '');
  check('移动端 @media 响应式', html.includes('max-width: 600px') && html.includes('upload-history-panel'), '');
  console.log('');

  // ---------- Test 6: SSE 消费新格式 ----------
  console.log('[6] SSE 消费新格式');
  check('connectSSE 读取 data.tasks', html.includes('data.tasks') && html.includes('syncFromSSE'), '');
  check('不再有旧 renderGlobalProgress(data) 逻辑', !html.includes('hiddenGlobalIds'), '');
  console.log('');

  // ---------- Test 7: beforeunload beacon ----------
  console.log('[7] beforeunload beacon');
  check('beforeunload 监听', html.includes('beforeunload'), '');
  check('sendBeacon 调用', html.includes('sendBeacon'), '');
  check('beacon 发送 cancel-group', html.includes('cancel-group') && html.includes('sendBeacon'), '');
  console.log('');

  // ---------- Test 8: 页面可正常加载 ----------
  console.log('[8] 页面正常加载');
  const page = await httpGet('/');
  check('服务器返回 200', page.status === 200, `Status: ${page.status}`);
  check('页面包含 upload-fab 元素', page.body.includes('upload-fab'), '');
  check('页面包含 UploadStore', page.body.includes('UploadStore'), '');
  console.log('');

  // ---------- Test 9: 取消 API 仍正常工作 ----------
  console.log('[9] 取消 API 向后兼容');
  const cancelResp = await new Promise(resolve => {
    const body = JSON.stringify({ uploadId: 'nonexistent', removeFiles: false });
    const req = http.request({
      hostname: BASE_HOST, port: BASE_PORT,
      path: '/api/files/upload/cancel',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.write(body);
    req.end();
  });
  check('cancel 返回 success', cancelResp.body && cancelResp.body.success, JSON.stringify(cancelResp.body));
  console.log('');

  console.log(`=== 结果: ${pass} 通过, ${fail} 失败 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
