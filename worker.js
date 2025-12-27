/**
 * Cloudflare Worker - 最终完美版 (D1 驱动 + 任务级控制 + 自动刷新)
 * 对应数据库表: send_tasks, accounts
 */

export default {
  async scheduled(event, env, ctx) {
    // 绑定您的 D1 数据库变量
    const db = env.XYRJ_GMAIL; 
    // 获取当前触发的时间代码
    const cron = event.cron;

    // 1. 如果是保活任务 (每2个小时)
    if (cron === "0 */5 * * *") {
        ctx.waitUntil(keepTokensAlive(db));
    } 
    // 2. 否则是常规发信任务 (原逻辑)
    else {
        ctx.waitUntil(handleCronJob(db));
    }
  }
};

async function handleCronJob(db) {
  try {
    // ============================================================
    // 1. 核心查询：同时获取任务信息和账号鉴权信息
    // ============================================================
    // 我们把 accounts 表的数据重命名 (如 acc_type, acc_client_id) 以免混淆
    const query = `
      SELECT 
        t.*, 
        a.id as acc_id,
        a.type as acc_type,            -- 账号类型: 'GAS', 'API', 'API/GAS'
        a.script_url as acc_gas_url,   -- GAS 模式专用链接
        a.client_id as acc_client_id,  -- API 模式专用 ID
        a.client_secret as acc_client_secret, -- API 模式专用 Secret
        a.refresh_token as acc_refresh_token  -- API 模式专用 Refresh Token
      FROM send_tasks t
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.status = 'pending' 
      AND t.next_run_at <= ? 
      LIMIT 10
    `;

    // 绑定当前时间戳进行查询
    const { results } = await db.prepare(query).bind(Date.now()).all();

    if (!results || results.length === 0) {
      // console.log("💤 暂无到期任务"); // 日志太多可以注释掉
      return;
    }

    console.log(`🔎 发现 ${results.length} 个到期任务，开始执行...`);

    // 创建一个临时缓存，避免同一次运行中重复刷新同一个账号的 Token
    const apiTokenCache = new Map();

    // 逐个处理任务
    for (const task of results) {
      await processSingleTask(db, task, apiTokenCache);
    }

  } catch (error) {
    console.error("❌ Worker 全局错误:", error);
  }
}

async function processSingleTask(db, task, apiTokenCache) {
  try {
    // 检查：如果任务关联的账号被删了，直接报错
    if (!task.acc_id) {
      throw new Error(`任务关联的 Account ID (${task.account_id}) 在 accounts 表中不存在`);
    }

    // ============================================================
    // 2. 决策模式：确定到底用什么方式发送
    // ============================================================
    // 逻辑优先级：任务指定的 execution_mode > 账号本身的 acc_type
    
    const taskMode = (task.execution_mode || 'AUTO').toUpperCase(); // 任务指令
    const accType = (task.acc_type || 'API').toUpperCase();         // 账号能力
    
    let finalMode = 'API'; // 默认回退

    if (taskMode === 'GAS') {
      finalMode = 'GAS';
    } else if (taskMode === 'API') {
      finalMode = 'API';
    } else {
      // 如果任务是 AUTO，则根据账号能力决定
      if (accType === 'GAS') finalMode = 'GAS';
      else if (accType === 'API') finalMode = 'API';
      else if (accType === 'API/GAS') finalMode = 'API'; // 双模账号优先用 API (更稳定)
    }

    console.log(`🚀 [任务ID:${task.id}] 账号:${task.acc_id} [${finalMode}模式] -> ${task.to_email}`);

    // ============================================================
    // 3. 执行发送
    // ============================================================
    let isSuccess = false;

    if (finalMode === 'GAS') {
      // --- 通道 A: Google Apps Script ---
      if (!task.acc_gas_url) throw new Error("模式为 GAS，但该账号未配置 script_url");
      
      isSuccess = await sendViaGAS(task.to_email, task.subject, task.content, task.acc_gas_url);

    } else {
      // --- 通道 B: Gmail API (OAuth2) ---
      
      // 先尝试从缓存拿 Token
      let accessToken = apiTokenCache.get(task.acc_id);

      if (!accessToken) {
        // 缓存没有，去 Google 刷新
        // 注意：这里用的是 accounts 表里的字段
        accessToken = await refreshGoogleToken(
          task.acc_client_id,
          task.acc_client_secret,
          task.acc_refresh_token
        );

        if (accessToken) {
          apiTokenCache.set(task.acc_id, accessToken); // 存入缓存
        } else {
          throw new Error("API Token 刷新失败，请检查 client_id/secret/refresh_token 是否正确");
        }
      }

      isSuccess = await sendViaAPI(task.to_email, task.subject, task.content, accessToken);
    }

    if (!isSuccess) throw new Error(`${finalMode} 发送请求返回失败`);

    // ============================================================
    // 4. 善后处理 (更新数据库)
    // ============================================================
    await updateTaskStatus(db, task, true);

  } catch (err) {
    console.error(`⚠️ [任务ID:${task.id}] 处理异常:`, err.message);
    await updateTaskStatus(db, task, false, err.message);
  }
}

// ----------------------------------------------------------------
// 辅助工具函数
// ----------------------------------------------------------------

// 1. 更新任务状态 (修复版：移除不存在的 updated_at 字段)
async function updateTaskStatus(db, task, isSuccess, errorMsg = '') {
const now = Date.now();

if (isSuccess) {
  if (task.is_loop === 1) {
    // === 循环任务 ===
    const nextTime = calculateNextRun(now, task.delay_config);

    // [修正] 删除了 updated_at 字段
    await db.prepare(`
      UPDATE send_tasks 
      SET next_run_at = ?, success_count = success_count + 1, status = 'pending'
      WHERE id = ?
    `).bind(nextTime, task.id).run();

    console.log(`🔄 循环任务 ${task.id} 成功，下次运行: ${new Date(nextTime).toLocaleString()}`);

  } else {
    // === 单次任务 ===
    // [修正] 删除了 updated_at 字段
    await db.prepare(`
      UPDATE send_tasks 
      SET status = 'success', success_count = success_count + 1
      WHERE id = ?
    `).bind(task.id).run();
    
    console.log(`✅ 单次任务 ${task.id} 完成`);
  }
} else {
  // === 失败 ===
  const retryTime = now + 5 * 60 * 1000; 
  
  // 失败逻辑里本来就没加 updated_at，所以这里不用改，但为了保险还是贴完整
  await db.prepare(`
      UPDATE send_tasks 
      SET fail_count = fail_count + 1, next_run_at = ?
      WHERE id = ?
  `).bind(retryTime, task.id).run();
  console.log(`⚠️ 任务 ${task.id} 失败，已推迟 5 分钟重试`);
}
}

// 2. GAS 发送实现
async function sendViaGAS(to, subject, content, gasUrl) {
  try {
    const resp = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        recipient: to, 
        subject: subject, 
        body: content 
      })
    });
    // GAS Web App 只要没有抛出异常，通常返回 200 或 302
    return resp.ok;
  } catch (e) { 
    console.error("GAS Network Error:", e);
    return false; 
  }
}

// 3. API 发送实现 (Standard Gmail API)
async function sendViaAPI(to, subject, content, accessToken) {
  // 构建邮件体 (UTF-8 + Base64Url 编码)
  const emailBody = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    content
  ].join("\r\n");

  const raw = btoa(unescape(encodeURIComponent(emailBody)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${accessToken}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({ raw: raw })
  });
  
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("Gmail API Error:", errText);
  }
  return resp.ok;
}

// 4. Token 刷新逻辑 (实现长效永久的关键)
async function refreshGoogleToken(clientId, clientSecret, refreshToken) {
  if (!clientId || !clientSecret || !refreshToken) {
    console.error("API模式缺少必要的鉴权参数 (Client ID/Secret/Refresh Token)");
    return null;
  }

  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    
    const data = await resp.json();
    if (data.access_token) {
      return data.access_token;
    } else {
      console.error("刷新 Token 失败:", JSON.stringify(data));
      return null;
    }
  } catch (e) { 
    console.error("刷新 Token 网络异常:", e);
    return null; 
  }
}
// ==========================================
// [新增] 时间计算辅助函数 (移植自 _worker.js)
// ==========================================

function calculateNextRun(baseTimeMs, configStr) {
// 默认推迟 1 天
if (!configStr) return baseTimeMs + 86400000; 

let addMs = 0;

// 格式 1: "d|h|m|s" (例如 0|0|10|0 表示10分钟)
if (configStr.includes('|')) {
    const parts = configStr.split('|');
    const d = getRandFromRange(parts[0]);
    const h = getRandFromRange(parts[1]);
    const m = getRandFromRange(parts[2]);
    const s = getRandFromRange(parts[3]);
    addMs += d * 24 * 60 * 60 * 1000 + h * 60 * 60 * 1000 + m * 60 * 1000 + s * 1000;
} 
// 格式 2: "val,unit" (例如 "10,minute")
else if (configStr.includes(',')) {
    const parts = configStr.split(',');
    const val = getRandFromRange(parts[0]);
    const unit = parts[1];
    let multiplier = 24 * 60 * 60 * 1000; // 默认为天
    if (unit === 'minute') multiplier = 60 * 1000;
    if (unit === 'hour') multiplier = 60 * 60 * 1000;
    addMs = val * multiplier;
} 
// 格式 3: 纯数字 (例如 "1" 表示 1天)
else {
    addMs = getRandFromRange(configStr) * 86400000;
}

// 最小间隔 1 分钟，防止死循环
if (addMs <= 0) addMs = 60000;

return baseTimeMs + addMs;
}

function getRandFromRange(str) {
if (!str) return 0;
// 支持 "1-3" 这种随机范围
if (String(str).includes('-')) {
    const parts = str.split('-');
    const min = parseInt(parts[0]) || 0;
    const max = parseInt(parts[1]) || 0;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
return parseInt(str) || 0;
}
// === 最终完美版：精准轮询 (按时间排序) ===
async function keepTokensAlive(db) {
  // 延时工具 (1秒)
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    // 1. 【核心修改】找出 "最久没刷新" 的 5 个账号
    // 排序：last_refresh_time 从小到大 (0 或 老时间 排在最前面)
    const { results } = await db.prepare(
      "SELECT id, name, client_id, client_secret, refresh_token FROM accounts WHERE type = 'API' AND status = 1 ORDER BY last_refresh_time ASC LIMIT 5"
    ).all();

    if (!results || results.length === 0) return;

    console.log(`🛡️ [精准轮询] 本次处理最久未刷新的 ${results.length} 个账号`);

    for (const [index, acc] of results.entries()) {
      try {
        // 执行刷新
        await refreshGoogleToken(acc.client_id, acc.client_secret, acc.refresh_token);
        
        // 2. 【核心修改】标记该账号为 "刚刚已刷新"
        // 这样下次排序它就会跑到最后面去了
        await db.prepare("UPDATE accounts SET last_refresh_time = ? WHERE id = ?")
          .bind(Date.now(), acc.id)
          .run();

        console.log(`✅ 账号 ${acc.name} 刷新完成 (时间已更新)`);

        // 拟人化：暂停 1 秒
        if (index < results.length - 1) await delay(1000);

      } catch (err) {
        console.error(`❌ 账号 ${acc.name} 失败:`, err);
        // 即使失败，也可以选择更新时间，避免它卡死在这里，一直重试它
        // await db.prepare("UPDATE accounts SET last_refresh_time = ? WHERE id = ?").bind(Date.now(), acc.id).run();
      }
    }
  } catch (e) {
    console.error("保活任务错误:", e);
  }
}
