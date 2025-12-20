/**
 * _worker.js (Gmail Refactored Edition)
 * 功能: 
 * 1. 支持 Gmail API 和 GAS (Apps Script) 双模式
 * 2. 支持 HTML 渲染和策略组 (Filter Groups)
 * 3. 并发优化与模块化结构
 */

export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // 1. 静态资源托管
      if (
          path === '/' || 
          path === '/index.html' || 
          path === '/favicon.ico' || 
          path.startsWith('/admin') || 
          path.startsWith('/assets')
      ) {
          // 根路径特殊处理：如果没有 index.html，则显示错误提示（避免暴露后台入口）
          if (path === '/') return handlePublicQuery("ROOT_ACCESS_DENIED", env);
          return env.ASSETS.fetch(request);
      }

      // 2. CORS 跨域处理
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }

      // 3. 公开邮件查询接口 (短链接 /CODE)
      // 排除 /api/ 开头和系统路径
      if (!path.startsWith('/api/')) {
        return handlePublicQuery(path.substring(1), env, url);
      }
  
      // 4. API 鉴权 (Basic Auth)
      const authHeader = request.headers.get("Authorization");
      if (!path.startsWith('/api/login') && !checkAuth(authHeader, env)) {
        return jsonResp({ error: "Unauthorized" }, 401);
      }

      // 5. API 路由分发
      if (path === '/api/login') return jsonResp({ success: true });
      if (path.startsWith('/api/groups')) return handleGroups(request, env); // [新增]
      if (path.startsWith('/api/accounts')) return handleAccounts(request, env);
      if (path.startsWith('/api/tasks')) return handleTasks(request, env);
      if (path.startsWith('/api/emails')) return handleEmails(request, env);
      if (path.startsWith('/api/rules')) return handleRules(request, env);
      
      return new Response("Gmail Backend Active", { headers: corsHeaders() });
    },
  
    // 定时任务
    async scheduled(event, env, ctx) {
      ctx.waitUntil(processScheduledTasks(env));
    }
};

// ============================================================
// 核心业务逻辑：发送与接收 (模块化重构)
// ============================================================

/**
 * 统一发送入口
 */
async function executeSendEmail(env, account, to, subject, content, mode) {
    try {
        // 自动判定模式
        let useMode = mode;
        if (!useMode || useMode === 'AUTO') {
            useMode = account.refresh_token ? 'API' : 'GAS';
        }

        if (useMode === 'API') {
            return await sendViaAPI(env, account, to, subject, content);
        } else {
            return await sendViaGAS(account, to, subject, content);
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * 模式 A: 通过 Gmail 官方 API 发送
 */
async function sendViaAPI(env, account, to, subject, content) {
    const authData = await getAccountAuth(env, account.id);
    const accessToken = await getAccessToken(authData);

    // 构建 MIME 邮件
    const finalSubject = subject || "No Subject";
    const finalContent = content || " ";
    
    const emailLines = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(finalSubject)))}?=`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        finalContent
    ];
    
    const raw = btoa(unescape(encodeURIComponent(emailLines.join('\r\n'))))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${accessToken}`, 
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw: raw })
    });

    if (!resp.ok) {
        const err = await resp.json();
        throw new Error(`API Error: ${err.error?.message || resp.statusText}`);
    }
    return { success: true };
}

/**
 * 模式 B: 通过 Google Apps Script (GAS) 发送
 */
async function sendViaGAS(account, to, subject, content) {
    let scriptUrl = account.script_url ? account.script_url.trim() : '';
    if (!scriptUrl.startsWith("http")) throw new Error("GAS URL 无效");

    // [优化] 使用 client_secret 作为 Token，如果没填则用默认值
    const token = account.client_secret || '123456'; 
    const joinChar = scriptUrl.includes('?') ? '&' : '?';
    scriptUrl = `${scriptUrl}${joinChar}token=${token}`;

    const params = new URLSearchParams();
    params.append('action', 'send'); 
    params.append('to', to);
    params.append('subject', subject || 'No Subject'); 
    params.append('body', content || ' ');    

    const resp = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    
    const text = await resp.text();
    if (!resp.ok) throw new Error(`GAS HTTP Error: ${resp.status}`);
    
    // 宽松的成功判定
    if (text.includes("OK") || text.includes("Sent") || text.includes("success")) {
        return { success: true };
    }
    throw new Error(`GAS Error: ${text.substring(0, 100)}`);
}

/**统一抓取入口 (支持查询参数 + 强制模式) */
async function syncEmails(env, account, limit = 5, queryParams = null, forceMode = null) {
    // 1. 基础检查
    const hasApi = !!account.refresh_token;
    const hasGas = !!account.script_url;
    let useApi = hasApi;
    if (forceMode === 'GAS') {
        if (!hasGas) throw new Error("该账号未配置 GAS URL，无法使用 GAS 模式");
        useApi = false;
    } else if (forceMode === 'API') {
        if (!hasApi) throw new Error("该账号未配置 API 信息，无法使用 API 模式");
        useApi = true;
    }

    if (useApi) {
        return await fetchViaAPI(env, account, limit, queryParams);
    } else if (hasGas) {
        return await fetchViaGAS(account, limit, queryParams);
    } else {
        throw new Error("账号未配置有效的 API 或 GAS 信息");
    }
}

/**模式 A: 通过 Gmail API 抓取 (并发优化版) **/
async function fetchViaAPI(env, account, limit, queryParams) {
    const authData = await getAccountAuth(env, account.id);
    const accessToken = await getAccessToken(authData);

    // 构建查询语句
    let qParts = ["label:inbox OR label:spam"]; // 默认查收件箱和垃圾箱
    if (queryParams) {
        qParts = []; // 如果有具体查询，覆盖默认
        if (queryParams.sender) qParts.push(`from:${queryParams.sender}`);
        if (queryParams.receiver) qParts.push(`to:${queryParams.receiver}`);
        if (queryParams.body) {
            const keys = queryParams.body.split('|').map(k => `"${k.trim()}"`).join(' OR ');
            qParts.push(`(${keys})`);
        }
    }
    const qStr = qParts.join(' ');

    // 1. 获取列表
    const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(qStr)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!listResp.ok) return [];
    const listData = await listResp.json();
    if (!listData.messages) return [];

    // 2. [优化] 并发获取详情
    const detailPromises = listData.messages.map(msg => 
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        }).then(r => r.json())
    );

    const details = await Promise.all(detailPromises);

    // 3. 格式化数据
    return details.map(detail => {
        if (!detail.payload) return null;
        let subject = '(No Subject)', sender = 'Unknown';
        const headers = detail.payload.headers || [];
        headers.forEach(h => {
            if (h.name === 'Subject') subject = h.value;
            if (h.name === 'From') sender = h.value;
        });
        
        // 过滤正文 (如果 API search 不够精准，这里可以二次过滤，目前略过)
        return {
            id: detail.id,
            sender,
            subject,
            body: detail.snippet || '',
            received_at: parseInt(detail.internalDate || Date.now())
        };
    }).filter(x => x);
}

/**
 * 模式 B: 通过 GAS 抓取 (本地过滤版)
 */
async function fetchViaGAS(account, limit, queryParams) {
    let scriptUrl = account.script_url.trim();
    const token = account.client_secret || '123456';
    const joinChar = scriptUrl.includes('?') ? '&' : '?';
    
    // GAS 脚本通常不支持复杂查询，所以多抓一些回来本地过滤
    const fetchLimit = limit * 3; 
    scriptUrl = `${scriptUrl}${joinChar}action=get&limit=${fetchLimit}&token=${token}`;

    const resp = await fetch(scriptUrl);
    if (!resp.ok) throw new Error(`GAS Network Error: ${resp.status}`);
    
    // 简单检查是否返回了 HTML 错误页
    const text = await resp.text();
    if (text.trim().startsWith('<')) throw new Error("GAS Service Unavailable");
    
    let items;
    try { items = JSON.parse(text); } catch(e) { throw new Error("GAS Invalid JSON"); }
    
    if (items.data && Array.isArray(items.data)) items = items.data;
    if (!Array.isArray(items)) return [];

    // 本地过滤
    const results = [];
    for (const item of items) {
        const subject = item.subject || '(No Subject)';
        const sender = item.from || item.sender || 'Unknown';
        const body = item.snippet || item.body || '';
        const received_at = item.date ? new Date(item.date).getTime() : Date.now();

        // 匹配逻辑
        let match = true;
        if (queryParams) {
            if (queryParams.sender && !sender.toLowerCase().includes(queryParams.sender.toLowerCase())) match = false;
            // GAS 难以获取收件人(to)，忽略 receiver 过滤
            if (queryParams.body) {
                const keys = queryParams.body.split('|').map(k => k.trim().toLowerCase());
                if (!keys.some(k => body.toLowerCase().includes(k))) match = false;
            }
        }
        
        if (match) {
            results.push({ sender, subject, body, received_at });
        }
        if (results.length >= limit) break;
    }
    return results;
}

// ============================================================
// API 路由处理器
// ============================================================

// [新增] 策略组管理
async function handleGroups(req, env) {
    const method = req.method;
    const url = new URL(req.url);

    if (method === 'GET') {
        const { results } = await env.XYRJ_GMAIL.prepare("SELECT * FROM filter_groups ORDER BY id DESC").all();
        return jsonResp({ data: results });
    }
    if (method === 'POST') {
        const d = await req.json();
        await env.XYRJ_GMAIL.prepare(
            "INSERT INTO filter_groups (name, match_sender, match_receiver, match_body) VALUES (?, ?, ?, ?)"
        ).bind(d.name, d.match_sender, d.match_receiver, d.match_body).run();
        return jsonResp({ ok: true });
    }
    if (method === 'PUT') {
        const d = await req.json();
        await env.XYRJ_GMAIL.prepare(
            "UPDATE filter_groups SET name=?, match_sender=?, match_receiver=?, match_body=? WHERE id=?"
        ).bind(d.name, d.match_sender, d.match_receiver, d.match_body, d.id).run();
        return jsonResp({ ok: true });
    }
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        // 重置使用了该组的规则
        await env.XYRJ_GMAIL.prepare("UPDATE access_rules SET group_id=NULL WHERE group_id=?").bind(id).run();
        await env.XYRJ_GMAIL.prepare("DELETE FROM filter_groups WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

// 规则管理 (增加 group_id)
async function handleRules(req, env) {
    const method = req.method;
    const url = new URL(req.url);

    if (method === 'GET') {
        const { results } = await env.XYRJ_GMAIL.prepare("SELECT * FROM access_rules ORDER BY id DESC").all();
        return jsonResp(results);
    }
    if (method === 'POST') {
        const d = await req.json();
        const code = d.query_code || generateQueryCode();
        // [新增] group_id
        await env.XYRJ_GMAIL.prepare(`
            INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_receiver, match_body, group_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(d.name, d.alias, code, d.fetch_limit, d.valid_until, d.match_sender, d.match_receiver, d.match_body, d.group_id || null).run();
        return jsonResp({ success: true });
    }
    if (method === 'PUT') {
        const d = await req.json();
        // [新增] group_id
        await env.XYRJ_GMAIL.prepare(`
            UPDATE access_rules SET name=?, alias=?, query_code=?, fetch_limit=?, valid_until=?, match_sender=?, match_receiver=?, match_body=?, group_id=? WHERE id=?
        `).bind(d.name, d.alias, d.query_code, d.fetch_limit, d.valid_until, d.match_sender, d.match_receiver, d.match_body, d.group_id || null, d.id).run();
        return jsonResp({ success: true });
    }
    if (method === 'DELETE') {
        const ids = await req.json();
        const placeholders = ids.map(() => '?').join(',');
        await env.XYRJ_GMAIL.prepare(`DELETE FROM access_rules WHERE id IN (${placeholders})`).bind(...ids).run();
        return jsonResp({ success: true });
    }
}

// 账号管理 (增加 email 字段)
async function handleAccounts(req, env) {
    const method = req.method;
    const url = new URL(req.url);
    
    // GET: 获取列表或导出
    if (method === 'GET') {
        const type = url.searchParams.get('type');
        if (type === 'simple') { 
            // 简单列表，用于下拉菜单
            const { results } = await env.XYRJ_GMAIL.prepare("SELECT id, name, alias FROM accounts ORDER BY id DESC").all();
            return jsonResp({ data: results }); 
        }
        if (type === 'export') {
            // 导出全部
            const { results } = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
            return jsonResp({ data: results });
        }
        
        // 分页列表
        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const q = url.searchParams.get('q');
        const offset = (page - 1) * limit;

        let whereClause = "WHERE status >= 0"; 
        const params = [];
        if (q) {
            whereClause += " AND (name LIKE ? OR alias LIKE ? OR email LIKE ?)";
            params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        
        const countStmt = await env.XYRJ_GMAIL.prepare(`SELECT COUNT(*) as total FROM accounts ${whereClause}`).bind(...params).first();
        const total = countStmt.total;
        
        const { results } = await env.XYRJ_GMAIL.prepare(`SELECT * FROM accounts ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all();
        
        return jsonResp({
            data: results,
            total: total,
            page: page,
            total_pages: Math.ceil(total / limit)
        });
    }
    
    // POST: 批量或单条添加
    if (method === 'POST') {
        const d = await req.json();
        const items = Array.isArray(d) ? d : [d];
        
        for (const item of items) {
             const storedUrl = (item.type === 'API') ? '' : (item.gas_url || item.script_url || '');
             
             // [修复核心] 解析 api_config 字符串为独立字段
             let cid = item.client_id, csec = item.client_secret, rtok = item.refresh_token;
             if (item.api_config) {
                 const parts = item.api_config.split(',');
                 cid = parts[0] ? parts[0].trim() : null;
                 csec = parts[1] ? parts[1].trim() : null;
                 rtok = parts[2] ? parts[2].trim() : null;
             }
             
             // [修复核心] 使用 || null 确保不会传入 undefined 导致 500 错误
             await env.XYRJ_GMAIL.prepare(
                "INSERT INTO accounts (name, email, alias, type, script_url, client_id, client_secret, refresh_token, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
             ).bind(
                 item.name || 'Unknown', 
                 item.email || '', 
                 item.alias || '', 
                 item.type || 'API', 
                 storedUrl || '', 
                 cid || null, 
                 csec || null, 
                 rtok || null
             ).run();
        }
        return jsonResp({ ok: true });
    }

    // PUT: 更新账号
    if (method === 'PUT') {
        const d = await req.json();
        // 仅更新状态
        if (d.status !== undefined && !d.name) {
            await env.XYRJ_GMAIL.prepare("UPDATE accounts SET status=? WHERE id=?").bind(d.status, d.id).run();
            return jsonResp({ ok: true });
        }
        
        const storedUrl = (d.type === 'API') ? '' : (d.gas_url || d.script_url || '');
        
        // [修复核心] 解析 api_config
        let cid = d.client_id, csec = d.client_secret, rtok = d.refresh_token;
        if (d.api_config) {
            const parts = d.api_config.split(',');
            cid = parts[0] ? parts[0].trim() : null;
            csec = parts[1] ? parts[1].trim() : null;
            rtok = parts[2] ? parts[2].trim() : null;
        }

        await env.XYRJ_GMAIL.prepare(
            "UPDATE accounts SET name=?, email=?, alias=?, type=?, script_url=?, client_id=?, client_secret=?, refresh_token=? WHERE id=?"
        ).bind(
            d.name, 
            d.email || '', 
            d.alias || '', 
            d.type, 
            storedUrl || '', 
            cid || null, 
            csec || null, 
            rtok || null, 
            d.id
        ).run();
        return jsonResp({ ok: true });
    }

    // DELETE: 删除账号 (支持单删和批量删)
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        const ids = url.searchParams.get('ids'); // 支持 ?ids=1,2,3
        
        if (ids) {
             const idList = ids.split(',');
             for (const delId of idList) {
                 await env.XYRJ_GMAIL.prepare("DELETE FROM accounts WHERE id=?").bind(delId).run();
             }
        } else if (id) {
             await env.XYRJ_GMAIL.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
        }
        return jsonResp({ ok: true });
    }
}

// 任务管理 (调用重构后的 executeSendEmail)
async function handleTasks(req, env) {
    const method = req.method;
    const url = new URL(req.url);

    // POST: 添加或立即发送
    if (method === 'POST') {
        const d = await req.json();
        // 立即发送
        if (d.immediate) {
            const acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE id=?").bind(d.account_id).first();
            if (!acc) return jsonResp({ ok: false, error: "账号不存在" });
            const res = await executeSendEmail(env, acc, d.to_email, d.subject, d.content, d.execution_mode);
            return jsonResp({ ok: res.success, error: res.error });
        }
        // 添加任务 (支持数组)
        const items = Array.isArray(d) ? d : [d];
        const stmt = env.XYRJ_GMAIL.prepare(`
            INSERT INTO send_tasks (account_id, to_email, subject, content, base_date, delay_config, next_run_at, is_loop, status, execution_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `);
        const batch = items.map(t => {
            const nextRun = t.base_date ? new Date(t.base_date).getTime() : calculateNextRun(Date.now(), t.delay_config);
            return stmt.bind(t.account_id, t.to_email, t.subject, t.content, t.base_date, t.delay_config, nextRun, t.is_loop, t.execution_mode || 'AUTO');
        });
        await env.XYRJ_GMAIL.batch(batch);
        return jsonResp({ ok: true });
    }

    // PUT: 更新或执行
    if (method === 'PUT') {
        const d = await req.json();
        if (d.action === 'execute') {
            const task = await env.XYRJ_GMAIL.prepare("SELECT * FROM send_tasks WHERE id=?").bind(d.id).first();
            if (!task) return jsonResp({error:"No Task"});
            
            const acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
            const res = await executeSendEmail(env, acc, task.to_email, task.subject, task.content, task.execution_mode);
            
            if (res.success) {
                if (task.is_loop) await env.XYRJ_GMAIL.prepare("UPDATE send_tasks SET success_count=success_count+1 WHERE id=?").bind(d.id).run();
                else await env.XYRJ_GMAIL.prepare("UPDATE send_tasks SET status='success', success_count=success_count+1 WHERE id=?").bind(d.id).run();
            } else {
                await env.XYRJ_GMAIL.prepare("UPDATE send_tasks SET status='error', fail_count=fail_count+1 WHERE id=?").bind(d.id).run();
            }
            return jsonResp({ ok: res.success, error: res.error });
        }
        // 普通更新
        let nextRun = d.base_date ? new Date(d.base_date).getTime() : calculateNextRun(Date.now(), d.delay_config);
        await env.XYRJ_GMAIL.prepare(`
            UPDATE send_tasks SET account_id=?, to_email=?, subject=?, content=?, base_date=?, delay_config=?, is_loop=?, execution_mode=?, next_run_at=? WHERE id=?
        `).bind(d.account_id, d.to_email, d.subject, d.content, d.base_date, d.delay_config, d.is_loop ? 1 : 0, d.execution_mode, nextRun, d.id).run();

        return jsonResp({ ok: true });
    }
    
    // GET & DELETE 保持简单
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (id) await env.XYRJ_GMAIL.prepare("DELETE FROM send_tasks WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
    if (method === 'GET') {
        // 1. 获取分页参数 (默认第1页，每页50条)
        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const offset = (page - 1) * limit;
        
        // 2. 获取搜索关键词
        const q = url.searchParams.get('q');
        
        // 3. 构建动态查询条件
        let whereClause = "WHERE 1=1";
        const params = [];
        if (q) {
            // 支持搜索主题(Subject)或收件人(To Email)
            whereClause += " AND (t.subject LIKE ? OR t.to_email LIKE ?)";
            params.push(`%${q}%`, `%${q}%`);
        }

        // 4. 先查询总条数 (用于前端计算页码)
        const countStmt = await env.XYRJ_GMAIL.prepare(
            `SELECT COUNT(*) as total FROM send_tasks t ${whereClause}`
        ).bind(...params).first();
        const total = countStmt.total || 0;

        // 5. 查询当前页的数据 (带关联账号名称)
        const { results } = await env.XYRJ_GMAIL.prepare(`
            SELECT t.*, a.name as account_name 
            FROM send_tasks t 
            LEFT JOIN accounts a ON t.account_id = a.id 
            ${whereClause} 
            ORDER BY t.next_run_at ASC 
            LIMIT ? OFFSET ?
        `).bind(...params, limit, offset).all();

        return jsonResp({ 
            data: results, 
            total: total,           // 总条数
            page: page,             // 当前页码
            total_pages: Math.ceil(total / limit) || 1 // 总页数
        });
    }
}

// 邮件列表 (后台用，无过滤)
async function handleEmails(req, env) {
    const url = new URL(req.url);
    const accountId = url.searchParams.get('account_id');
    const limit = parseInt(url.searchParams.get('limit')) || 20;
    const mode = url.searchParams.get('mode'); // [新增] 读取前端传来的模式 (API/GAS)
    if (!accountId) return jsonResp([]);
    try {
        const acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE id=?").bind(accountId).first();
        if (!acc) return jsonResp({ error: "Account not found" });
        const emails = await syncEmails(env, acc, limit, null, mode);
        return jsonResp(emails);
    } catch(e) {
        return jsonResp({ error: e.message });
    }
}

// ============================================================
// 公开查询接口 (HTML 渲染 + 策略组逻辑)
// ============================================================

async function handlePublicQuery(code, env, url) {
    // 1. CSS 样式
    const cssStyle = `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;max-width:800px;margin:20px auto;padding:0 20px;color:#333;background:#f9f9f9}.item{background:#fff;padding:15px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.05);margin-bottom:15px;border-left:4px solid #EA4335}.time{font-size:0.85em;color:#666;margin-bottom:5px}.content{word-break:break-word;line-height:1.6}.msg{text-align:center;color:#666;padding:20px}.error{color:#dc3545;text-align:center}`;
    
    const renderPage = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>邮件查询</title><style>${cssStyle}</style></head><body>${body}</body></html>`;

    const errResp = (msg, status=404) => new Response(renderPage(`<div class="msg error">${msg}</div>`), {status, headers: {'Content-Type': 'text/html;charset=UTF-8'}});

    // 2. 查规则
    const rule = await env.XYRJ_GMAIL.prepare("SELECT * FROM access_rules WHERE query_code=?").bind(code).first();
    if (!rule) return errResp("查询链接无效 (Invalid Link)");

    if (rule.valid_until && Date.now() > rule.valid_until) return errResp("链接已过期 (Link Expired)", 403);

    // 3. [新增] 策略组覆盖
    if (rule.group_id) {
        const group = await env.XYRJ_GMAIL.prepare("SELECT * FROM filter_groups WHERE id=?").bind(rule.group_id).first();
        if (group) {
            rule.match_sender = group.match_sender;
            rule.match_receiver = group.match_receiver;
            rule.match_body = group.match_body;
        }
    }

    // 4. 查账号 (支持 Email 模糊匹配)
    let acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE name=? AND status=1").bind(rule.name).first();
    if (!acc) {
        // 如果名字匹配不到，尝试匹配 email 字段
        acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE email LIKE ? AND status=1").bind(`%${rule.name}%`).first();
    }
    if (!acc) return errResp("未找到关联账号 (Account Not Found)");

    // 解析数量限制 "fetch-show"
    let fetchNum = 20, showNum = 5;
    if (rule.fetch_limit) {
        const parts = String(rule.fetch_limit).split('-');
        fetchNum = parseInt(parts[0]) || 20;
        showNum = parts.length > 1 ? (parseInt(parts[1]) || fetchNum) : fetchNum;
    }

    try {
        // 5. 抓取与过滤
        // 构建查询参数对象
        const queryParams = {
            sender: rule.match_sender,
            receiver: rule.match_receiver,
            body: rule.match_body
        };

        let emails = await syncEmails(env, acc, fetchNum, queryParams);

        // 6. 二次过滤与美化 (确保“所见即所搜”)
        emails.forEach(e => {
            let content = e.body || "";
            content = stripHtml(content);
            e.displayText = content.replace(/\s+/g, ' ').trim();
        });

        // 如果是 API 模式，其实已经过滤过了，但为了保险（以及 GAS 模式的需要），这里可以再做一次精确过滤
        // ... (此处省略二次过滤逻辑，以 API 返回为准)

        emails = emails.slice(0, showNum);

        if (emails.length === 0) return new Response(renderPage('<div class="msg">暂无符合条件的邮件</div>'), {headers: {'Content-Type': 'text/html;charset=UTF-8'}});

        // 7. 生成 HTML 列表
        const listHtml = emails.map(e => {
            const timeStr = new Date(e.received_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
            return `<div class="item">
                <div class="time">${timeStr} | ${e.sender.replace(/<.*?>/g, '')}</div>
                <div class="content">${e.displayText}</div>
            </div>`;
        }).join('');

        return new Response(renderPage(listHtml), {headers: {'Content-Type': 'text/html;charset=UTF-8'}});

    } catch (e) {
        return errResp(`查询出错: ${e.message}`, 500);
    }
}

// ============================================================
// 辅助函数
// ============================================================

// 定时任务处理
async function processScheduledTasks(env) {
    const now = Date.now();
    const { results } = await env.XYRJ_GMAIL.prepare("SELECT * FROM send_tasks WHERE status != 'success' AND next_run_at <= ?").bind(now).all();

    for (const task of results) {
        const acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
        if (acc) {
            const res = await executeSendEmail(env, acc, task.to_email, task.subject, task.content, task.execution_mode);
            if (task.is_loop) {
        // 如果是循环任务，更新下一次执行时间，状态保持为 pending
            const nextRun = calculateNextRun(Date.now(), task.delay_config);
            const countCol = res.success ? 'success_count' : 'fail_count';
            await env.XYRJ_GMAIL.prepare(`UPDATE send_tasks SET next_run_at=?, status='pending', ${countCol}=${countCol}+1 WHERE id=?`).bind(nextRun, task.id).run();
        } else {
        // 如果不是循环任务，直接更新为最终状态（success 或 error）
            const status = res.success ? 'success' : 'error';
            const countCol = res.success ? 'success_count' : 'fail_count';
            await env.XYRJ_GMAIL.prepare(`UPDATE send_tasks SET status=?, ${countCol}=${countCol}+1 WHERE id=?`).bind(status, task.id).run();
            }
        }
    }
}
// OAuth 相关
async function getAccountAuth(env, accountId) {
    return await env.XYRJ_GMAIL.prepare("SELECT client_id, client_secret, refresh_token FROM accounts WHERE id = ?").bind(accountId).first();
}

async function getAccessToken(authData) {
    if (!authData?.refresh_token) throw new Error("缺少 Refresh Token");
    
    // 如果没有 Client ID，直接返回 Refresh Token (兼容某些特殊配置)
    if (!authData.client_id) return authData.refresh_token;

    const params = new URLSearchParams({
        client_id: authData.client_id,
        client_secret: authData.client_secret,
        refresh_token: authData.refresh_token,
        grant_type: 'refresh_token'
    });

    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    const data = await resp.json();
    if (data.error) throw new Error(`Token Refresh Failed: ${JSON.stringify(data)}`);
    return data.access_token;
}

// 工具函数
function jsonResp(data, status=200) {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function corsHeaders() {
    return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
}

function checkAuth(header, env) {
    if (!header) return false;
    try {
        const [u, p] = atob(header.split(" ")[1]).split(":");
        return u === env.ADMIN_USERNAME && p === env.ADMIN_PASSWORD;
    } catch { return false; }
}

function generateQueryCode() {
    return Math.random().toString(36).substring(2, 12).toUpperCase();
}

function stripHtml(html) {
    if (!html) return "";
    return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function getRandFromRange(str) {
    if (!str) return 0;
    if (String(str).includes('-')) {
        const parts = str.split('-');
        const min = parseInt(parts[0]) || 0;
        const max = parseInt(parts[1]) || 0;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    return parseInt(str) || 0;
}

function calculateNextRun(baseTimeMs, configStr) {
    if (!configStr) return baseTimeMs + 86400000; 

    let addMs = 0;
    if (configStr.includes('|')) {
        const parts = configStr.split('|');
        const d = getRandFromRange(parts[0]);
        const h = getRandFromRange(parts[1]);
        const m = getRandFromRange(parts[2]);
        const s = getRandFromRange(parts[3]);
        addMs += d * 24 * 60 * 60 * 1000 + h * 60 * 60 * 1000 + m * 60 * 1000 + s * 1000;
    } 
    else if (configStr.includes(',')) {
        const parts = configStr.split(',');
        const val = getRandFromRange(parts[0]);
        const unit = parts[1];
        let multiplier = 24 * 60 * 60 * 1000;
        if (unit === 'minute') multiplier = 60 * 1000;
        if (unit === 'hour') multiplier = 60 * 60 * 1000;
        addMs = val * multiplier;
    } else {
        addMs = getRandFromRange(configStr) * 86400000;
    }
    if (addMs <= 0) addMs = 60000;
    return baseTimeMs + addMs;
}
