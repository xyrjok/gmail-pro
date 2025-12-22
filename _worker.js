/**
 * _worker.js (Gmail Refactored Edition - Ultimate Fix)
 * 功能: 
 * 1. 实现了类似 Outlook 的查重功能，但更强大（支持名称+邮箱双重验证）。
 * 2. 修复了任务和规则的重复导入问题。
 * 3. 忽略大小写差异 (COLLATE NOCASE)。
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
          if (path === '/') return handlePublicQuery("ROOT_ACCESS_DENIED", env);
          return env.ASSETS.fetch(request);
      }

      // 2. CORS 跨域处理
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }

      // 3. 公开邮件查询接口
      if (!path.startsWith('/api/')) {
        return handlePublicQuery(path.substring(1), env, url);
      }
  
      // 4. API 鉴权
      const authHeader = request.headers.get("Authorization");
      if (!path.startsWith('/api/login') && !checkAuth(authHeader, env)) {
        return jsonResp({ error: "Unauthorized" }, 401);
      }

      // 5. API 路由分发
      if (path === '/api/login') return jsonResp({ success: true });
      if (path.startsWith('/api/groups')) return handleGroups(request, env);
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
// 核心业务逻辑
// ============================================================

async function executeSendEmail(env, account, to, subject, content, mode) {
    try {
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

async function sendViaAPI(env, account, to, subject, content) {
    const authData = await getAccountAuth(env, account.id);
    const accessToken = await getAccessToken(authData);

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

async function sendViaGAS(account, to, subject, content) {
    let scriptUrl = account.script_url ? account.script_url.trim() : '';
    if (!scriptUrl.startsWith("http")) throw new Error("GAS URL 无效");

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
    
    if (text.includes("OK") || text.includes("Sent") || text.includes("success")) {
        return { success: true };
    }
    throw new Error(`GAS Error: ${text.substring(0, 100)}`);
}

async function syncEmails(env, account, limit = 5, queryParams = null, forceMode = null) {
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

async function fetchViaAPI(env, account, limit, queryParams) {
    const authData = await getAccountAuth(env, account.id);
    const accessToken = await getAccessToken(authData);

    let qParts = ["label:inbox OR label:spam"]; 
    if (queryParams) {
        qParts = []; 
        if (queryParams.sender) qParts.push(`from:${queryParams.sender}`);
        if (queryParams.receiver) qParts.push(`to:${queryParams.receiver}`);
        if (queryParams.body) {
            const keys = queryParams.body.split('|').map(k => `"${k.trim()}"`).join(' OR ');
            qParts.push(`(${keys})`);
        }
    }
    const qStr = qParts.join(' ');

    const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(qStr)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!listResp.ok) return [];
    const listData = await listResp.json();
    if (!listData.messages) return [];

    const detailPromises = listData.messages.map(msg => 
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        }).then(r => r.json())
    );

    const details = await Promise.all(detailPromises);

    return details.map(detail => {
        if (!detail.payload) return null;
        let subject = '(No Subject)', sender = 'Unknown';
        const headers = detail.payload.headers || [];
        headers.forEach(h => {
            if (h.name === 'Subject') subject = h.value;
            if (h.name === 'From') sender = h.value;
        });
        
        return {
            id: detail.id,
            sender,
            subject,
            body: detail.snippet || '',
            received_at: parseInt(detail.internalDate || Date.now())
        };
    }).filter(x => x);
}

async function fetchViaGAS(account, limit, queryParams) {
    let scriptUrl = account.script_url.trim();
    const token = account.client_secret || '123456';
    const joinChar = scriptUrl.includes('?') ? '&' : '?';
    
    const fetchLimit = limit * 3; 
    scriptUrl = `${scriptUrl}${joinChar}action=get&limit=${fetchLimit}&token=${token}`;

    const resp = await fetch(scriptUrl);
    if (!resp.ok) throw new Error(`GAS Network Error: ${resp.status}`);
    
    const text = await resp.text();
    if (text.trim().startsWith('<')) throw new Error("GAS Service Unavailable");
    
    let items;
    try { items = JSON.parse(text); } catch(e) { throw new Error("GAS Invalid JSON"); }
    
    if (items.data && Array.isArray(items.data)) items = items.data;
    if (!Array.isArray(items)) return [];

    const results = [];
    for (const item of items) {
        const subject = item.subject || '(No Subject)';
        const sender = item.from || item.sender || 'Unknown';
        const body = item.snippet || item.body || '';
        const received_at = item.date ? new Date(item.date).getTime() : Date.now();

        let match = true;
        if (queryParams) {
            if (queryParams.sender && !sender.toLowerCase().includes(queryParams.sender.toLowerCase())) match = false;
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

async function handleGroups(req, env) {
    const method = req.method;
    const url = new URL(req.url);

    if (method === 'GET') {
        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 30;
        const offset = (page - 1) * limit;
        const { results } = await env.XYRJ_GMAIL.prepare("SELECT * FROM filter_groups ORDER BY id DESC LIMIT ? OFFSET ?").bind(limit, offset).all();
        const total = (await env.XYRJ_GMAIL.prepare("SELECT COUNT(*) as c FROM filter_groups").first()).c;
        return jsonResp({ data: results, total: total, page: page, total_pages: Math.ceil(total / limit) });
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
        await env.XYRJ_GMAIL.prepare("UPDATE access_rules SET group_id=NULL WHERE group_id=?").bind(id).run();
        await env.XYRJ_GMAIL.prepare("DELETE FROM filter_groups WHERE id=?").bind(id).run();
        return jsonResp({ ok: true });
    }
}

async function handleRules(req, env) {
    const method = req.method;
    const url = new URL(req.url);

    if (method === 'GET') {
        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 30;
        const q = url.searchParams.get('q');
        const offset = (page - 1) * limit;
        
        let where = "WHERE 1=1";
        const params = [];
        if (q) {
            where += " AND (name LIKE ? OR query_code LIKE ?)";
            params.push(`%${q}%`, `%${q}%`);
        }

        const total = (await env.XYRJ_GMAIL.prepare(`SELECT COUNT(*) as c FROM access_rules ${where}`).bind(...params).first()).c;
        const { results } = await env.XYRJ_GMAIL.prepare(`SELECT * FROM access_rules ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all();
        
        return jsonResp({ data: results, total: total, page: page, total_pages: Math.ceil(total / limit) });
    }
    
    // POST: 添加规则 (加强查重: 忽略大小写, 查 code 或 name+alias)
    if (method === 'POST') {
        const d = await req.json();
        const items = Array.isArray(d) ? d : [d];
        const skipped = [];
        let count = 0;

        for (const item of items) {
            const code = item.query_code || generateQueryCode();
            
            // [加强版查重]
            let exists;
            if (item.query_code) {
                exists = await env.XYRJ_GMAIL.prepare("SELECT 1 FROM access_rules WHERE query_code = ? COLLATE NOCASE").bind(code).first();
            } else {
                exists = await env.XYRJ_GMAIL.prepare("SELECT 1 FROM access_rules WHERE name = ? COLLATE NOCASE AND alias = ? COLLATE NOCASE").bind(item.name, item.alias).first();
            }

            if (exists) {
                skipped.push(`${item.name} (${code})`);
                continue;
            }

            await env.XYRJ_GMAIL.prepare(`
                INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_receiver, match_body, group_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(item.name, item.alias, code, item.fetch_limit, item.valid_until, item.match_sender, item.match_receiver, item.match_body, item.group_id || null).run();
            count++;
        }
        return jsonResp({ success: true, imported: count, skipped });
    }

    if (method === 'PUT') {
        const d = await req.json();
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

async function handleAccounts(req, env) {
    const method = req.method;
    const url = new URL(req.url);
    
    if (method === 'GET') {
        const type = url.searchParams.get('type');
        if (type === 'simple') { 
            const { results } = await env.XYRJ_GMAIL.prepare("SELECT id, name, alias FROM accounts ORDER BY id DESC").all();
            return jsonResp({ data: results }); 
        }
        if (type === 'export') {
            const { results } = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
            return jsonResp({ data: results });
        }
        
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
    
    // POST: 批量或单条添加 (加强查重: 即使没邮箱，名字重复也拦截)
    if (method === 'POST') {
        const d = await req.json();
        const items = Array.isArray(d) ? d : [d];
        const skipped = [];
        let count = 0;
        
        for (const item of items) {
             let exists = null;
             // [核心逻辑]
             // 如果有邮箱，检查 邮箱 OR 名字 是否重复 (忽略大小写)
             // 如果没邮箱，直接检查 名字 是否重复 (忽略大小写)
             if (item.email && item.email.trim() !== '') {
                 exists = await env.XYRJ_GMAIL.prepare("SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE OR name = ? COLLATE NOCASE").bind(item.email, item.name).first();
             } else {
                 exists = await env.XYRJ_GMAIL.prepare("SELECT 1 FROM accounts WHERE name = ? COLLATE NOCASE").bind(item.name).first();
             }

             if (exists) {
                 skipped.push(`${item.name} (${item.email||'无邮箱'})`);
                 continue;
             }

             const storedUrl = (item.type === 'API') ? '' : (item.gas_url || item.script_url || '');
             
             let cid = item.client_id, csec = item.client_secret, rtok = item.refresh_token;
             if (item.api_config) {
                 const parts = item.api_config.split(',');
                 cid = parts[0] ? parts[0].trim() : null;
                 csec = parts[1] ? parts[1].trim() : null;
                 rtok = parts[2] ? parts[2].trim() : null;
             }
             
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
             count++;
        }
        return jsonResp({ ok: true, imported: count, skipped });
    }

    if (method === 'PUT') {
        const d = await req.json();
        if (d.status !== undefined && !d.name) {
            await env.XYRJ_GMAIL.prepare("UPDATE accounts SET status=? WHERE id=?").bind(d.status, d.id).run();
            return jsonResp({ ok: true });
        }
        
        const storedUrl = (d.type === 'API') ? '' : (d.gas_url || d.script_url || '');
        
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

    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        const ids = url.searchParams.get('ids'); 
        
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

async function handleTasks(req, env) {
    const method = req.method;
    const url = new URL(req.url);

    if (method === 'POST') {
        const d = await req.json();
        if (d.immediate) {
            const acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE id=?").bind(d.account_id).first();
            if (!acc) return jsonResp({ ok: false, error: "账号不存在" });
            const res = await executeSendEmail(env, acc, d.to_email, d.subject, d.content, d.execution_mode);
            return jsonResp({ ok: res.success, error: res.error });
        }
        
        const items = Array.isArray(d) ? d : [d];
        const skipped = [];
        const validItems = [];

        for (const t of items) {
            // [加强版查重]
            // 不管状态是 Pending/Success/Error，只要收件人、主题、内容完全一致，就视为重复任务，跳过。
            const exists = await env.XYRJ_GMAIL.prepare(
                "SELECT 1 FROM send_tasks WHERE account_id=? AND to_email=? AND subject=? AND content=?"
            ).bind(t.account_id, t.to_email, t.subject, t.content).first();

            if (exists) {
                skipped.push(`${t.to_email} (${t.subject})`);
                continue;
            }
            validItems.push(t);
        }

        if (validItems.length > 0) {
            const stmt = env.XYRJ_GMAIL.prepare(`
                INSERT INTO send_tasks (account_id, to_email, subject, content, base_date, delay_config, next_run_at, is_loop, status, execution_mode)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            `);
            const batch = validItems.map(t => {
                const nextRun = t.base_date ? new Date(t.base_date).getTime() : calculateNextRun(Date.now(), t.delay_config);
                return stmt.bind(t.account_id, t.to_email, t.subject, t.content, t.base_date, t.delay_config, nextRun, t.is_loop, t.execution_mode || 'AUTO');
            });
            await env.XYRJ_GMAIL.batch(batch);
        }
        
        return jsonResp({ ok: true, imported: validItems.length, skipped });
    }

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
        let nextRun = d.base_date ? new Date(d.base_date).getTime() : calculateNextRun(Date.now(), d.delay_config);
        await env.XYRJ_GMAIL.prepare(`
        UPDATE send_tasks 
        SET account_id=?, to_email=?, subject=?, content=?, base_date=?, delay_config=?, is_loop=?, execution_mode=?, next_run_at=?, status='pending' 
        WHERE id=?
        `).bind(d.account_id, d.to_email, d.subject, d.content, d.base_date, d.delay_config, d.is_loop ? 1 : 0, d.execution_mode, nextRun, d.id).run();

        return jsonResp({ ok: true });
    }
    
    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        const ids = url.searchParams.get('ids');
        if (ids) {
            const batch = ids.split(',').map(i => env.XYRJ_GMAIL.prepare("DELETE FROM send_tasks WHERE id=?").bind(i));
            await env.XYRJ_GMAIL.batch(batch);
        } else if (id) {
            await env.XYRJ_GMAIL.prepare("DELETE FROM send_tasks WHERE id=?").bind(id).run();
        }
        return jsonResp({ ok: true });
    }
    if (method === 'GET') {
        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const offset = (page - 1) * limit;
        
        const q = url.searchParams.get('q');
        
        let whereClause = "WHERE 1=1";
        const params = [];
        if (q) {
            whereClause += " AND (t.subject LIKE ? OR t.to_email LIKE ?)";
            params.push(`%${q}%`, `%${q}%`);
        }

        const countStmt = await env.XYRJ_GMAIL.prepare(
            `SELECT COUNT(*) as total FROM send_tasks t ${whereClause}`
        ).bind(...params).first();
        const total = countStmt.total || 0;

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
            total: total,           
            page: page,            
            total_pages: Math.ceil(total / limit) || 1 
        });
    }
}

async function handleEmails(req, env) {
    const url = new URL(req.url);
    const accountId = url.searchParams.get('account_id');
    const limit = parseInt(url.searchParams.get('limit')) || 20;
    const mode = url.searchParams.get('mode'); 
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
    const cssStyle = `
        body { font-size: 16px; font-family: sans-serif; line-height: 1.3; color: #333; background: #fff; }
        .item, .msg { margin-bottom: 12px;}
    `;
    
    const renderPage = (content) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>邮件查询</title><style>${cssStyle}</style></head><body>${content}</body></html>`;

    const rule = await env.XYRJ_GMAIL.prepare("SELECT * FROM access_rules WHERE query_code=?").bind(code).first();
    
    if (!rule) return new Response(renderPage('<div class="msg">查询链接无效 (Link Invalid)</div>'), {status: 404, headers: {"Content-Type": "text/html;charset=UTF-8"}});

    if (rule.valid_until && Date.now() > rule.valid_until) {
        return new Response(renderPage('<div class="msg">链接已过期 (Link Expired)</div>'), {status: 403, headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    if (rule.group_id) {
        const group = await env.XYRJ_GMAIL.prepare("SELECT * FROM filter_groups WHERE id=?").bind(rule.group_id).first();
        if (group) {
            rule.match_sender = group.match_sender;
            rule.match_receiver = group.match_receiver;
            rule.match_body = group.match_body;
        }
    }

    // 查账号：优先按名字查
    let acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE name=? AND status=1").bind(rule.name).first();
    if (!acc) {
        // 没找到名字，再模糊匹配邮箱 (Outlook 风格的宽容匹配)
        acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE email LIKE ? AND status=1").bind(`%${rule.name}%`).first();
    }
    
    if (!acc) return new Response(renderPage('<div class="msg">号码错误！</div>'), {status: 404, headers: {"Content-Type": "text/html;charset=UTF-8"}});

    let fetchNum = 20, showNum = 5;
    if (rule.fetch_limit) {
        const parts = String(rule.fetch_limit).split('-');
        fetchNum = parseInt(parts[0]) || 20;
        showNum = parts.length > 1 ? (parseInt(parts[1]) || fetchNum) : fetchNum;
    }

    try {
        const queryParams = {
            sender: rule.match_sender,
            receiver: rule.match_receiver,
            body: rule.match_body
        };

        let emails = await syncEmails(env, acc, fetchNum, queryParams);

        emails.forEach(e => {
            let content = e.body || ""; 
            content = content.replace(/<a[^>]+href=["'](.*?)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)');
            content = content.replace(/<[^>]+>/g, '');
            e.displayText = content.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        });

        emails = emails.slice(0, showNum);

        if (emails.length === 0) {
            return new Response(renderPage('<div class="msg">暂无符合条件的邮件</div>'), {headers: {'Content-Type': 'text/html;charset=UTF-8'}});
        }

        const listHtml = emails.map(e => {
            const timeStr = new Date(e.received_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
            return `<div class="item">${timeStr} | ${e.displayText}</div>`;
        }).join('');

        return new Response(renderPage(listHtml), {headers: {'Content-Type': 'text/html;charset=UTF-8'}});

    } catch (e) {
        return new Response(renderPage(`<div class="msg">查询出错: ${e.message}</div>`), {status: 500, headers: {'Content-Type': 'text/html;charset=UTF-8'}});
    }
}

// ============================================================
// 辅助函数
// ============================================================

async function processScheduledTasks(env) {
    const now = Date.now();
    const { results } = await env.XYRJ_GMAIL.prepare("SELECT * FROM send_tasks WHERE status != 'success' AND next_run_at <= ?").bind(now).all();

    for (const task of results) {
        const acc = await env.XYRJ_GMAIL.prepare("SELECT * FROM accounts WHERE id=?").bind(task.account_id).first();
        if (acc) {
            const res = await executeSendEmail(env, acc, task.to_email, task.subject, task.content, task.execution_mode);
            if (task.is_loop) {
            const nextRun = calculateNextRun(Date.now(), task.delay_config);
            const countCol = res.success ? 'success_count' : 'fail_count';
            await env.XYRJ_GMAIL.prepare(`UPDATE send_tasks SET next_run_at=?, status='pending', ${countCol}=${countCol}+1 WHERE id=?`).bind(nextRun, task.id).run();
        } else {
            const status = res.success ? 'success' : 'error';
            const countCol = res.success ? 'success_count' : 'fail_count';
            await env.XYRJ_GMAIL.prepare(`UPDATE send_tasks SET status=?, ${countCol}=${countCol}+1 WHERE id=?`).bind(status, task.id).run();
            }
        }
    }
}

async function getAccountAuth(env, accountId) {
    return await env.XYRJ_GMAIL.prepare("SELECT client_id, client_secret, refresh_token FROM accounts WHERE id = ?").bind(accountId).first();
}

async function getAccessToken(authData) {
    if (!authData?.refresh_token) throw new Error("缺少 Refresh Token");
    
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
