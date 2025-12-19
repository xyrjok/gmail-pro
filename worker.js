/**
 * Cloudflare Worker - 最终完美版 (D1 驱动 + 任务级控制 + 自动刷新)
 * 对应数据库表: send_tasks, accounts
 */

export default {
  async scheduled(event, env, ctx) {
    // 绑定您的 D1 数据库变量
    const db = env.XYRJ_GMAIL; 
    
    // 使用 waitUntil 确保代码执行完整
    ctx.waitUntil(handleCronJob(db));
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

// 1. 更新任务状态 (处理循环逻辑)
async function updateTaskStatus(db, task, isSuccess, errorMsg = '') {
  const now = Date.now();

  if (isSuccess) {
    if (task.is_loop === 1) {
      // === 循环任务 ===
      // 解析 delay_config。假设您存的是 "60" (分钟)，或者 JSON
      // 这里做一个简单的兼容处理，默认按分钟计算
      let delayMinutes = 1440; // 默认 24小时
      
      if (task.delay_config) {
        const parsed = parseInt(task.delay_config);
        if (!isNaN(parsed) && parsed > 0) {
          delayMinutes = parsed;
        }
      }
      
      const nextTime = now + (delayMinutes * 60 * 1000);

      // 更新 next_run_at，保持 status 为 pending (或者您可以有专门的 looping 状态)
      // 注意：这里我们只更新时间，status 依然保持 pending 以便下次被捞起
      // 或者您可以重置 status = 'pending' 确保万无一失
      await db.prepare(`
        UPDATE send_tasks 
        SET next_run_at = ?, success_count = success_count + 1, updated_at = ?, status = 'pending'
        WHERE id = ?
      `).bind(nextTime, now, task.id).run();

      console.log(`🔄 循环任务 ${task.id} 已推迟 ${delayMinutes} 分钟`);

    } else {
      // === 单次任务 ===
      await db.prepare(`
        UPDATE send_tasks 
        SET status = 'completed', success_count = success_count + 1, updated_at = ? 
        WHERE id = ?
      `).bind(now, task.id).run();
      
      console.log(`✅ 单次任务 ${task.id} 完成`);
    }
  } else {
    // === 失败 ===
    // 仅增加失败计数，不修改下次运行时间，等待下次 Cron 重试
    // 可选：如果 fail_count > 5，则标记为 'failed' 并不再重试
    await db.prepare(`
        UPDATE send_tasks 
        SET fail_count = fail_count + 1 
        WHERE id = ?
    `).bind(task.id).run();
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
