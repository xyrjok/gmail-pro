/**
 * Cloudflare Worker - 纯后台定时任务版
 * 功能：读取 D1 数据库 -> 发送邮件 -> 更新任务状态
 */

export default {
  // 唯一的入口：CRON 触发器
  async scheduled(event, env, ctx) {
    console.log("⏰ 定时任务触发，开始检查...");

    // 使用 waitUntil 确保异步操作在 Worker 结束前完成
    ctx.waitUntil(handleCronJob(env));
  }
};

/**
 * 主处理逻辑
 */
async function handleCronJob(env) {
  const db = env.XYRJ_GMAIL; // 确保您在后台绑定的变量名是 DB

  try {
    // 1. 从数据库获取待处理任务
    // 假设表名是 tasks，必须满足：状态是等待中(pending) 且 触发时间到了(<= 当前时间)
    // 这里的 SQL 语句请根据您的实际表结构微调
    const query = `
      SELECT * FROM tasks 
      WHERE status = 'pending' 
      AND next_run_time <= ? 
      LIMIT 10
    `; 
    // LIMIT 10 是为了防止一次处理太多超时，反正每分钟都会运行

    const { results } = await db.prepare(query)
      .bind(Date.now()) // 传入当前时间戳
      .all();

    if (!results || results.length === 0) {
      console.log("💤 暂无待处理任务");
      return;
    }

    console.log(`🔎 发现 ${results.length} 个任务，开始执行...`);

    // 2. 循环处理每一个任务
    for (const task of results) {
      await processSingleTask(db, task, env);
    }

  } catch (error) {
    console.error("❌ 全局错误 (可能是数据库连接失败):", error);
  }
}

/**
 * 处理单个任务逻辑
 */
async function processSingleTask(db, task, env) {
  try {
    console.log(`🚀 开始处理任务 ID: ${task.id}, 类型: ${task.type || '邮件'}`);

    // --- A. 执行发送逻辑 (发送邮件) ---
    const sendSuccess = await sendEmail(task, env);

    if (!sendSuccess) {
      throw new Error("邮件发送函数返回失败");
    }

    // --- B. 任务后处理 (更新数据库) ---
    if (task.is_recurring === 1) {
      // 场景1：如果是循环任务 -> 计算下一次时间
      // 假设 task.interval_minutes 是间隔分钟数
      const interval = (task.interval_minutes || 60) * 60 * 1000; 
      const nextTime = Date.now() + interval;

      await db.prepare(`
        UPDATE tasks 
        SET next_run_time = ?, updated_at = ? 
        WHERE id = ?
      `)
      .bind(nextTime, Date.now(), task.id)
      .run();
      
      console.log(`🔄 循环任务 ID ${task.id} 已更新至下一次: ${new Date(nextTime).toISOString()}`);

    } else {
      // 场景2：单次任务 -> 标记为已完成
      await db.prepare(`
        UPDATE tasks 
        SET status = 'completed', updated_at = ? 
        WHERE id = ?
      `)
      .bind(Date.now(), task.id)
      .run();
      
      console.log(`✅ 单次任务 ID ${task.id} 已标记完成`);
    }

  } catch (err) {
    console.error(`⚠️ 任务 ID ${task.id} 处理失败:`, err);
    
    // 出错时，可以标记为 'failed' 或者增加 'retry_count'，防止死循环卡死
    await db.prepare("UPDATE tasks SET status = 'failed', error_log = ? WHERE id = ?")
      .bind(String(err), task.id)
      .run();
  }
}

/**
 * --- 发送邮件的核心函数 ---
 * 这里粘贴您之前的 Gmail / Microsoft Graph / SMTP 代码
 */
async function sendEmail(task, env) {
  // 模拟发送过程，请替换为您的真实代码
  
  // 比如您之前用的 Gmail API 或 自动发卡逻辑：
  /* const response = await fetch("https://www.googleapis.com/...", {
     method: "POST",
     headers: { Authorization: `Bearer ${env.GMAIL_TOKEN}` ... },
     body: JSON.stringify(...)
  });
  return response.ok;
  */

  // 临时演示代码：假设发送成功
  console.log(`📧 [模拟发送] 向 ${task.email} 发送内容: ${task.content}`);
  return true; 
}
