const API_BASE = "";

// ================== 全局变量定义 ==================
// [添加] 全局分页大小
let globalPageSize = 30;
const pageSizeOptions = [10, 20, 30, 50, 100, 200, 500];

// [添加] 渲染分页选择器 HTML 的辅助函数
function renderPageSizeSelect(currentSize) {
    const opts = pageSizeOptions.map(s => `<option value="${s}" ${s == currentSize ? 'selected' : ''}>${s}条/页</option>`).join('');
    return `<select class="form-select form-select-sm d-inline-block w-auto ms-2" onchange="changeGlobalPageSize(this.value)">${opts}</select>`;
}

// [添加] 切换分页大小的处理函数
function changeGlobalPageSize(size) {
    globalPageSize = parseInt(size);
    // 根据当前激活的 Tab 刷新数据
    if ($("#section-accounts").hasClass("active")) loadAccounts(1);
    else if ($("#section-tasks").hasClass("active")) loadTasks(1);
    else if ($("#section-rules").hasClass("active")) loadRules(1); // Rules 现在支持分页了
    else if ($("#section-groups").hasClass("active")) loadGroups(1); // Groups 现在支持分页了
    else if ($("#section-receive").hasClass("active")) { 
        // 收件箱特殊处理，可能需要更新 limit
        if(currentInboxAccountId) { setLimit(globalPageSize); }
        else loadInboxAccounts(1);
    }
}

// 1. 邮箱管理
let cachedAccounts = []; 
let currentAccountPage = 1;
let currentAccountTotalPages = 1;
let accountSearchTimer = null;

// 2. 任务管理
let cachedTasks = []; 
let currentTaskPage = 1;
let currentTaskTotalPages = 1;
let taskSearchTimer = null;

// 3. 收件查看
let currentInboxPage = 1;
let currentInboxTotalPages = 1;
let inboxSearchTimer = null;
let currentInboxAccountId = null;
let currentEmailLimit = 0; 
let currentFetchMode = 'API'; 

// 4. 收件规则
let cachedRules = [];
let ruleSearchTimer = null;
let currentRulePage = 1;
let currentRuleTotalPages = 1;

// 5. [新增] 策略组
let cachedGroups = [];
let currentGroupPage = 1;
let currentGroupTotalPages = 1;

// 鼠标位置 (Toast)
let lastMouseX = 0, lastMouseY = 0;

// ================== 工具函数 ==================

function formatChinaTime(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai', 
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function toLocalISOString(date) {
    const pad = (n) => n < 10 ? '0' + n : n;
    return date.getFullYear() + '-' +
        pad(date.getMonth() + 1) + '-' +
        pad(date.getDate()) + 'T' +
        pad(date.getHours()) + ':' +
        pad(date.getMinutes());
}

function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

document.addEventListener('mousemove', (e) => {
    lastMouseX = e.pageX;
    lastMouseY = e.pageY;
});

function showToast(msg) {
    const el = document.getElementById('mouse-toast');
    el.innerText = msg;
    el.style.left = (lastMouseX + 10) + 'px';
    el.style.top = (lastMouseY + 10) + 'px';
    el.style.display = 'block';
    el.style.opacity = 1;
    setTimeout(() => {
        el.style.opacity = 0;
        setTimeout(() => el.style.display = 'none', 300);
    }, 2000);
}

function copyText(text) {
    if (!text || text === 'null' || text === '-') return;
    navigator.clipboard.writeText(text)
        .then(() => showToast("已复制！"))
        .catch(() => showToast("复制失败"));
}

function getHeaders() {
    return {
        'Authorization': 'Basic ' + localStorage.getItem("auth_token"),
        'Content-Type': 'application/json'
    };
}

// ================== 登录/注销 ==================

function doLogin() {
    const u = $("#admin-user").val();
    const p = $("#admin-pass").val();
    const token = btoa(u + ":" + p);
    localStorage.setItem("auth_token", token);
    
    fetch(API_BASE, { headers: { 'Authorization': 'Basic ' + token } })
        .then(res => {
            if(res.ok) {
                $("#login-overlay").fadeOut();
                loadAccounts();
                loadAllAccountNames(); 
                loadGroups(); // [新增] 登录后加载策略组
            } else {
                showToast("账号或密码错误");
            }
        }).catch(()=> showToast("连接失败"));
}
$("#admin-pass").keyup(function(e) {
    if (e.key === "Enter" || e.keyCode === 13) doLogin();
});
function doLogout() {
    localStorage.removeItem("auth_token");
    location.reload();
}

// ================== 页面切换逻辑 ==================

function showSection(id) {
    $(".content-section").removeClass("active");
    $("#" + id).addClass("active");
    $(".list-group-item").removeClass("active");
    $(event.currentTarget).addClass("active");
    
    if(id === 'section-accounts') {
        loadAccounts(currentAccountPage);
    }
    if(id === 'section-groups') { // [新增]
        loadGroups();
    }
    if(id === 'section-rules') {
        loadRules();
    }
    if(id === 'section-send') {
        if ($("#account-list-options option").length === 0) {
            loadAllAccountNames();
        }
        loadTasks(currentTaskPage);
    }
    if(id === 'section-receive') {
        loadInboxAccounts(currentInboxPage);
    }
}

// ================== 1. 邮箱管理 (Accounts) ==================

function loadAccounts(page = 1) {
    const searchQuery = $("#section-accounts input[placeholder*='搜索']").val().trim();
    currentAccountPage = page;
    
    $("#account-list-body").html('<tr><td colspan="9" class="text-center py-4"><div class="spinner-border text-primary spinner-border-sm"></div> 加载中...</td></tr>');

    return fetch(`${API_BASE}/api/accounts?page=${page}&limit=${globalPageSize}&q=${encodeURIComponent(searchQuery)}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || [];
            cachedAccounts = list; 
            currentAccountTotalPages = res.total_pages || 1;
            renderAccounts(list);
            $("#acc-page-info").html(`第 ${res.page} / ${res.total_pages} 页 (共 ${res.total} 条)` + renderPageSizeSelect(globalPageSize));
            $("#btn-prev-acc").prop("disabled", res.page <= 1);
            $("#btn-next-acc").prop("disabled", res.page >= res.total_pages);
        });
}

function renderAccounts(data) {
    let html = '';
    data.forEach(acc => {
        const statusSwitch = `
        <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" ${acc.status ? 'checked' : ''} onchange="toggleAccountStatus(${acc.id}, this.checked)">
        </div>`;
        
        // 构造 API 显示文本
        let apiText = '-';
        let apiFull = '';
        if (acc.client_id) {
            apiText = `ID:${acc.client_id}, Secret:${acc.client_secret}, Token:${acc.refresh_token}`;
            apiFull = apiText;
        } else if (acc.type.includes('API')) {
            apiText = '无配置';
        }
        
        // 构造 GAS 显示文本
        let gasText = '-';
        if (acc.script_url && acc.script_url.startsWith('http')) {
            gasText = acc.script_url;
        }

        let badgeClass = 'bg-secondary';
        if (acc.type === 'API') badgeClass = 'bg-success';
        else if (acc.type === 'GAS') badgeClass = 'bg-primary';
        else if (acc.type === 'API/GAS') badgeClass = 'bg-info text-dark';

        html += `<tr>
            <td><input type="checkbox" class="acc-check" value="${acc.id}"></td>
            
            <td class="cursor-pointer fw-bold" onclick="copyText('${acc.name}')" style="white-space:nowrap;">
                ${acc.name}
            </td>
            
            <td>
                <div class="text-truncate" style="max-width: 150px;" title="${acc.email || ''}">${acc.email || '-'}</div>
            </td>
            
            <td class="cursor-pointer" onclick="copyText('${acc.alias}')">
                <div class="text-truncate" style="max-width: 100px;" title="${acc.alias || ''}">${acc.alias || '-'}</div>
            </td>
            
            <td class="cursor-pointer" onclick="copyText('${apiFull}')" title="${apiFull}">
                <div class="text-truncate" style="max-width: 150px;">${apiText}</div>
            </td>
            
            <td class="cursor-pointer" onclick="copyText('${gasText}')" title="${gasText}">
                <div class="text-truncate" style="max-width: 150px;">${gasText}</div>
            </td>
            
            <td><span class="badge ${badgeClass}">${acc.type}</span></td>
            <td>${statusSwitch}</td>
            <td>
                <button class="btn btn-sm btn-light text-primary py-0" onclick="openEditModal(${acc.id})"><i class="fas fa-edit"></i></button> 
                <button class="btn btn-sm btn-light text-danger py-0" onclick="delAccount(${acc.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });
    if(data.length === 0) html = '<tr><td colspan="9" class="text-center text-muted">无数据</td></tr>';
    $("#account-list-body").html(html);
}

function filterAccounts(text) {
    if (accountSearchTimer) clearTimeout(accountSearchTimer);
    accountSearchTimer = setTimeout(() => {
        loadAccounts(1);
    }, 300);
}

function changeAccountPage(delta) {
    const newPage = currentAccountPage + delta;
    if (newPage > 0 && newPage <= currentAccountTotalPages) {
        loadAccounts(newPage);
    }
}

function loadAllAccountNames() {
    fetch(`${API_BASE}/api/accounts?type=simple`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            const list = data.data || data;   
            let optionsHtml = '';
            window.accountNameMap = {}; 
            
            if (Array.isArray(list)) {
                list.forEach(acc => {
                    optionsHtml += `<option value="${acc.name}">别名: ${acc.alias || '-'}</option>`;
                    window.accountNameMap[acc.name] = acc.id;
                });
            }
            $("#account-list-options").html(optionsHtml);
        });
}

function exportAccounts() {
    const btn = $(event.target).closest('button');
    const orgHtml = btn.html();
    btn.html('<i class="fas fa-spinner fa-spin"></i> 导出中...');
    
    fetch(`${API_BASE}/api/accounts?type=export`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || res;
            if (!Array.isArray(list)) throw new Error("数据格式错误");
            const lines = list.map(acc => {
                let apiConf = '';
                if (acc.client_id) apiConf = `${acc.client_id},${acc.client_secret || ''},${acc.refresh_token || ''}`;
                let gasUrl = '';
                if (acc.script_url && acc.script_url.startsWith('http')) gasUrl = acc.script_url;
                return `${acc.name}\t${acc.alias || ''}\t${apiConf}\t${gasUrl}`;
            });
            const txtContent = lines.join('\n');
            const dataStr = "data:text/plain;charset=utf-8," + encodeURIComponent(txtContent);
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "accounts_backup.txt");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
            btn.html(orgHtml);
        })
        .catch(() => {
            showToast("导出失败");
            btn.html(orgHtml);
        });
}

function toggleAccountStatus(id, isActive) {
    const acc = cachedAccounts.find(a => a.id === id);
    if (!acc) return;
    const originalStatus = acc.status;
    acc.status = isActive ? 1 : 0;
    fetch(API_BASE + '/api/accounts', { method: 'PUT', headers: getHeaders(), body: JSON.stringify(acc) })
        .then(r => r.json()).then(res => {
            if(res.ok) { showToast(isActive ? "邮箱已启用" : "邮箱已禁用"); }
            else { 
                showToast("更新失败"); 
                acc.status = originalStatus; 
                loadAccounts(currentAccountPage); 
            }
        });
}

function openAddModal() {
    $("#accModalTitle").text("添加邮箱");
    $("#acc-id").val(""); 
    $("#acc-name").val("");
    $("#acc-email").val(""); // [新增]
    $("#acc-alias").val("");
    $("#acc-api-config").val(""); 
    $("#acc-gas-url").val("");
    $("#acc-status").prop("checked", true);
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function openEditModal(id) {
    const acc = cachedAccounts.find(a => a.id === id);
    if(!acc) return;
    $("#accModalTitle").text("编辑邮箱");
    $("#acc-id").val(acc.id);
    $("#acc-name").val(acc.name);
    $("#acc-email").val(acc.email || ""); // [新增]
    $("#acc-alias").val(acc.alias);
    if (acc.client_id) {
        $("#acc-api-config").val(`${acc.client_id},${acc.client_secret},${acc.refresh_token}`);
    } else {
        $("#acc-api-config").val("");
    }
    $("#acc-gas-url").val(acc.script_url && acc.script_url.startsWith('http') ? acc.script_url : "");
    $("#acc-status").prop("checked", acc.status == 1);
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function saveAccount() {
    const id = $("#acc-id").val();
    const apiConfig = $("#acc-api-config").val().trim();
    const gasUrl = $("#acc-gas-url").val().trim();
    
    let type = "";
    if (apiConfig && gasUrl) type = "API/GAS";
    else if (apiConfig) type = "API";
    else if (gasUrl) type = "GAS";
    else {
        showToast("请至少填写 API 配置或 GAS URL 其中一项");
        return;
    }

    const data = {
        name: $("#acc-name").val(),
        email: $("#acc-email").val(), // [新增]
        alias: $("#acc-alias").val(),
        api_config: apiConfig,
        gas_url: gasUrl,
        type: type, 
        status: $("#acc-status").is(":checked")
    };

    const method = id ? 'PUT' : 'POST';
    if(id) data.id = id;
    
    const btn = $(event.target);
    btn.prop('disabled', true);

    fetch(API_BASE + '/api/accounts', { method, headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json())
    .then(res => {
        btn.prop('disabled', false); 
        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('addAccountModal')).hide();
            showToast(id ? "更新成功" : "添加成功");
            loadAccounts(currentAccountPage);
            loadAllAccountNames(); 
        } else {
            alert("错误: " + res.error);
        }
    })
    .catch(err => {
        btn.prop('disabled', false);
        showToast("网络请求失败");
    });
}

function batchDelAccounts() {
    const ids = $(".acc-check:checked").map(function(){return this.value;}).get();
    if(ids.length === 0) return showToast("请先选择");
    if(confirm("确定删除选中邮箱?")) {
        fetch(API_BASE + '/api/accounts?ids=' + ids.join(','), { method: 'DELETE', headers: getHeaders() })
            .then(() => { showToast("删除成功"); loadAccounts(currentAccountPage); loadAllAccountNames(); });
    }
}

function delAccount(id) {
    if(confirm("删除此邮箱?")) {
        fetch(API_BASE + '/api/accounts?id=' + id, { method: 'DELETE', headers: getHeaders() })
            .then(() => { loadAccounts(currentAccountPage); loadAllAccountNames(); });
    }
}

// ================== 2. [新增] 策略组管理 ==================

function loadGroups(page = 1) {
    $("#group-list-body").html('<tr><td colspan="6" class="text-center"><div class="spinner-border text-primary spinner-border-sm"></div> 加载中...</td></tr>');
    currentGroupPage = page;

    fetch(`${API_BASE}/api/groups?page=${page}&limit=${globalPageSize}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            cachedGroups = res.data || [];
            currentGroupTotalPages = res.total_pages || 1;
            renderGroups(cachedGroups);
            if($("#group-page-info").length) {
                $("#group-page-info").html(`第 ${res.page} / ${res.total_pages} 页` + renderPageSizeSelect(globalPageSize));
                $("#btn-prev-group").prop("disabled", res.page <= 1);
                $("#btn-next-group").prop("disabled", res.page >= res.total_pages);
            }
        });
}
function changeGroupPage(d) {
    if (currentGroupPage + d > 0 && currentGroupPage + d <= currentGroupTotalPages) {
        loadGroups(currentGroupPage + d);
    }
}
function renderGroups(list) {
    let html = '';
    list.forEach(g => {
        html += `<tr>
            <td>${g.id}</td>
            <td class="fw-bold">${escapeHtml(g.name)}</td>
            <td>${g.match_sender ? `<span class="badge bg-light text-dark border">${escapeHtml(g.match_sender)}</span>` : '-'}</td>
            <td>${g.match_receiver ? `<span class="badge bg-light text-dark border">${escapeHtml(g.match_receiver)}</span>` : '-'}</td>
            <td>${g.match_body ? `<span class="badge bg-light text-dark border">${escapeHtml(g.match_body)}</span>` : '-'}</td>
            <td>
                <button class="btn btn-sm btn-light text-primary" onclick="openGroupModal(${g.id})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-light text-danger" onclick="delGroup(${g.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });
    if(list.length === 0) html = '<tr><td colspan="6" class="text-center text-muted">暂无策略组</td></tr>';
    $("#group-list-body").html(html);
}

function openGroupModal(id) {
    $("#group-id").val(""); 
    $("#group-name").val("");
    $("#group-match-sender").val("");
    $("#group-match-receiver").val("");
    $("#group-match-body").val("");
    
    if (id) {
        const g = cachedGroups.find(x => x.id === id);
        if (g) {
            $("#group-id").val(g.id);
            $("#group-name").val(g.name);
            $("#group-match-sender").val(g.match_sender);
            $("#group-match-receiver").val(g.match_receiver);
            $("#group-match-body").val(g.match_body);
            $("#groupModalTitle").text("编辑策略组");
        }
    } else {
        $("#groupModalTitle").text("新建策略组");
    }
    new bootstrap.Modal(document.getElementById('groupModal')).show();
}

function saveGroup() {
    const id = $("#group-id").val();
    const data = {
        name: $("#group-name").val(),
        match_sender: $("#group-match-sender").val(),
        match_receiver: $("#group-match-receiver").val(),
        match_body: $("#group-match-body").val()
    };
    if (!data.name) return showToast("名称必填");
    
    const method = id ? 'PUT' : 'POST';
    if (id) data.id = id;
    
    fetch(API_BASE + '/api/groups', { method, headers: getHeaders(), body: JSON.stringify(data) })
        .then(r => r.json())
        .then(res => {
            if (res.ok) {
                bootstrap.Modal.getInstance(document.getElementById('groupModal')).hide();
                loadGroups();
                showToast(id ? "更新成功" : "创建成功");
            } else {
                showToast("失败: " + res.error);
            }
        });
}

function delGroup(id) {
    if (confirm("警告：删除策略组将重置所有绑定该组的规则！确定删除吗？")) {
        fetch(API_BASE + '/api/groups?id=' + id, { method: 'DELETE', headers: getHeaders() })
            .then(() => { 
                loadGroups(); 
                showToast("已删除"); 
                // 同时重新加载规则，因为规则的状态可能变了
                loadRules();
            });
    }
}

// ================== 3. 收件规则管理 (Rules) ==================

function loadRules(page = 1) {
    const searchQuery = $("#section-rules input[placeholder*='搜索']").val().trim();
    currentRulePage = page; // [补全] 更新当前页码变量

    $("#rule-list-body").html('<tr><td colspan="9" class="text-center py-4"><div class="spinner-border text-primary spinner-border-sm"></div> 加载中...</td></tr>');

    // 现在 page 变量有值了，不会报错
    fetch(`${API_BASE}/api/rules?page=${page}&limit=${globalPageSize}&q=${encodeURIComponent(searchQuery)}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || (Array.isArray(res) ? res : []); 
            cachedRules = list;
            currentRuleTotalPages = res.total_pages || 1; // [补全] 更新总页数
            renderRules(list);
            
            if(res.total_pages) {
                // [注意] 这里的 HTML 按钮 ID (btn-prev-rule) 需要你在 index.html 对应位置添加
                $("#rule-page-info").html(`第 ${res.page} / ${res.total_pages} 页 (共 ${res.total} 条)` + renderPageSizeSelect(globalPageSize));
                $("#btn-prev-rule").prop("disabled", res.page <= 1);
                $("#btn-next-rule").prop("disabled", res.page >= res.total_pages);
            } else {
                $("#rule-page-info").text(`共 ${list.length} 条规则`);
            }
        });
}
function changeRulePage(d) {
    if (currentRulePage + d > 0 && currentRulePage + d <= currentRuleTotalPages) {
        loadRules(currentRulePage + d);
    }
}

function renderRules(data) {
    let html = '';
    const host = window.location.origin; // 使用 origin 获取完整域名

    data.forEach(r => {
        // [修改] 移植 Outlook 的匹配条件显示逻辑 (合并策略组和本地条件)
        let matchInfo = [];
        if(r.group_id) {
            const group = cachedGroups.find(g => g.id == r.group_id);
            const groupName = group ? group.name : `(ID:${r.group_id})`;
            matchInfo.push(`<span class="badge bg-primary text-white" title="策略组">组: ${escapeHtml(groupName)}</span>`);
        } else {
            if(r.match_sender) matchInfo.push(`<span class="badge bg-light text-dark border" title="发件人">发: ${escapeHtml(r.match_sender)}</span>`);
            if(r.match_receiver) matchInfo.push(`<span class="badge bg-light text-dark border" title="收件人">收: ${escapeHtml(r.match_receiver)}</span>`);
            if(r.match_body) matchInfo.push(`<span class="badge bg-light text-dark border" title="正文关键字">文: ${escapeHtml(r.match_body)}</span>`);
        }
        const matchHtml = matchInfo.length ? matchInfo.join('<br>') : '<span class="text-muted small">-</span>';

        // 构造链接和有效期
        const fullLink = `${host}/${r.query_code}`;
        const fullLinkStr = `${r.alias}---${fullLink}`;
        
        let validStr = '<span class="text-success">永久</span>';
        if (r.valid_until) {
            if (r.valid_until < Date.now()) {
                validStr = `<span class="text-danger">已过期</span>`;
            } else {
                const days = Math.ceil((r.valid_until - Date.now()) / 86400000);
                // 简单格式化日期 YYYY/M/D
                const d = new Date(r.valid_until);
                const dateStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
                validStr = `${days}天 (${dateStr})`;
            }
        }

        html += `<tr>
            <td><input type="checkbox" class="rule-check" value="${r.id}"></td>
            <td class="text-primary cursor-pointer fw-bold" onclick="copyText('${escapeHtml(r.name)}')" title="点击复制">${escapeHtml(r.name)}</td>
            <td class="text-primary cursor-pointer" onclick="copyText('${escapeHtml(r.alias)}')" title="点击复制">${escapeHtml(r.alias)}</td>
            <td>
                <div class="input-group input-group-sm" style="width:160px">
                    <input class="form-control bg-white" style="padding:.25rem .39rem;" value="${r.query_code}" readonly>
                    <button class="btn btn-outline-secondary" onclick="window.open('${fullLink}')" title="打开链接"><i class="fas fa-external-link-alt"></i></button>
                    <button class="btn btn-outline-secondary" onclick="copyText('${fullLinkStr}')" title="复制: 别名---链接"><i class="fas fa-copy"></i></button>
                </div>
            </td>
            <td class="small">${matchHtml}</td>
            <td>${r.fetch_limit || 5}</td>
            <td>${validStr}</td>
            <td>
                <button class="btn btn-sm btn-light text-primary py-0" onclick="openEditRuleModal(${r.id})"><i class="fas fa-edit"></i></button> 
                <button class="btn btn-sm btn-light text-danger py-0" onclick="delRule(${r.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });

    if(data.length === 0) html = '<tr><td colspan="8" class="text-center text-muted">暂无规则</td></tr>';
    $("#rule-list-body").html(html);
}

function filterRules(text) {
    if (ruleSearchTimer) clearTimeout(ruleSearchTimer);
    ruleSearchTimer = setTimeout(() => {
        loadRules();
    }, 300);
}

function generateRandomRuleCode() {
    $("#rule-code").val(generateRandomString(10));
}
function openAddRuleModal() {
    openEditRuleModal();
}
function openEditRuleModal(id) {
    // 填充策略组下拉
    let opts = '<option value="">-- 不绑定 (使用本地条件) --</option>';
    cachedGroups.forEach(g => {
        opts += `<option value="${g.id}">${escapeHtml(g.name)}</option>`;
    });
    $("#rule-group-select").html(opts);

    if (id) {
        const r = cachedRules.find(x => x.id === id);
        if (!r) return;
        $("#ruleModalTitle").text("编辑收件规则");
        $("#rule-id").val(r.id);
        $("#rule-name").val(r.name);
        $("#rule-alias").val(r.alias);
        $("#rule-code").val(r.query_code);
        $("#rule-limit").val(r.fetch_limit || 5);
        
        let validDays = "";
        if (r.valid_until && r.valid_until > Date.now()) {
            validDays = Math.ceil((r.valid_until - Date.now()) / (24 * 60 * 60 * 1000));
        }
        $("#rule-valid").val(validDays);

        $("#rule-group-select").val(r.group_id || "");
        $("#rule-match-sender").val(r.match_sender);
        $("#rule-match-receiver").val(r.match_receiver);
        $("#rule-match-body").val(r.match_body);
    } else {
        $("#ruleModalTitle").text("添加收件规则");
        $("#rule-id").val("");
        $("#rule-name").val("");
        $("#rule-alias").val("");
        $("#rule-code").val(""); 
        $("#rule-limit").val("5");
        $("#rule-valid").val("");
        $("#rule-group-select").val("");
        $("#rule-match-sender").val("");
        $("#rule-match-receiver").val("");
        $("#rule-match-body").val("");
    }
    toggleRuleFilters(); // 刷新UI状态
    new bootstrap.Modal(document.getElementById('addRuleModal')).show();
}

function toggleRuleFilters() {
    const hasGroup = !!$("#rule-group-select").val();
    const box = $("#local-filters-box");
    box.find("input").prop("disabled", hasGroup);
    box.css("opacity", hasGroup ? 0.5 : 1);
    $("#group-hint").toggle(hasGroup);
}

function saveRule() {
    const id = $("#rule-id").val();
    const name = $("#rule-name").val().trim();
    const alias = $("#rule-alias").val().trim();

    if (!name || !alias) {
        return showToast("名称和别名不能为空");
    }
    let validUntil = null;
    const daysVal = $("#rule-valid").val();
    if (daysVal && parseFloat(daysVal) > 0) {
        validUntil = Date.now() + parseFloat(daysVal) * 24 * 60 * 60 * 1000;
    }
    
    const data = {
        name: name,
        alias: alias,
        query_code: $("#rule-code").val().trim(),
        fetch_limit: $("#rule-limit").val().trim() || "5",
        valid_until: validUntil,
        // [新增]
        group_id: $("#rule-group-select").val() || null,
        match_sender: $("#rule-match-sender").val().trim(),
        match_receiver: $("#rule-match-receiver").val().trim(),
        match_body: $("#rule-match-body").val().trim()
    };

    const method = data.id = id ? 'PUT' : 'POST';
    if(id) data.id = id;

    const btn = $(event.target);
    btn.prop('disabled', true);

    fetch(API_BASE + '/api/rules', { method, headers: getHeaders(), body: JSON.stringify(data) })
        .then(r => r.json())
        .then(res => {
            btn.prop('disabled', false);
            if (res.success) {
                bootstrap.Modal.getInstance(document.getElementById('addRuleModal')).hide();
                showToast(id ? "规则已更新" : "规则已添加");
                loadRules();
            } else {
                alert("错误: " + (res.error || "未知错误"));
            }
        })
        .catch(err => {
            btn.prop('disabled', false);
            showToast("请求失败");
        });
}

function delRule(id) {
    if(!confirm("确定删除该规则吗？")) return;
    fetch(API_BASE + '/api/rules', { method: 'DELETE', headers: getHeaders(), body: JSON.stringify([id]) })
        .then(r => r.json()).then(res => {
            if(res.success) { showToast("删除成功"); loadRules(); } 
            else showToast("删除失败");
        });
}

function batchDelRules() {
    const ids = $(".rule-check:checked").map(function(){return parseInt(this.value);}).get();
    if(ids.length === 0) return showToast("请先选择");
    if(!confirm(`确定删除选中的 ${ids.length} 条规则吗？`)) return;

    fetch(API_BASE + '/api/rules', { method: 'DELETE', headers: getHeaders(), body: JSON.stringify(ids) })
        .then(r => r.json()).then(res => {
            if(res.success) { showToast("批量删除成功"); loadRules(); } 
            else showToast("删除失败");
        });
}

function exportRules() {
    fetch(`${API_BASE}/api/rules?limit=10000`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => { 
            const list = res.data || (Array.isArray(res) ? res : []);

            const lines = list.map(r => {
                let days = '';
                if (r.valid_until && r.valid_until > Date.now()) {
                    days = Math.ceil((r.valid_until - Date.now()) / (24 * 60 * 60 * 1000));
                }
                const gName = (cachedGroups.find(g => g.id == r.group_id) || {}).name || '';
                return `${r.name}\t${r.alias}\t${r.query_code}\t${r.fetch_limit||5}\t${days}\t${r.match_sender||''}\t${r.match_receiver||''}\t${r.match_body||''}\t${gName}`;
            });
            
            const txtContent = lines.join('\n');
            const dataStr = "data:text/plain;charset=utf-8," + encodeURIComponent(txtContent);
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "rules_backup.txt");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
        })
        .catch((e) => {
            console.error(e); // 建议打印错误以便调试
            showToast("导出失败");
        });
}
function submitBatchRuleImport() {
    const activeTab = $("#ruleImportTabs .active").attr("data-bs-target");
    if(activeTab === "#tab-rule-paste") {
        processRuleImport($("#import-rule-text").val());
    } else {
        const file = document.getElementById('import-rule-file-input').files[0];
        if(!file) return alert("请选择文件");
        const reader = new FileReader();
        reader.onload = e => processRuleImport(e.target.result);
        reader.readAsText(file);
    }
}

function openBatchRuleModal() {
    $("#import-rule-text").val("");
    $("#import-rule-file-input").val("");
    const tabEl = document.querySelector('#ruleImportTabs button[data-bs-target="#tab-rule-paste"]');
    if(tabEl) new bootstrap.Tab(tabEl).show();
    new bootstrap.Modal(document.getElementById('batchRuleImportModal')).show();
}

function processRuleImport(content) {
    try {
        const lines = content.split('\n').filter(line => line.trim());
        const json = lines.map(line => {
            const p = line.split('\t').map(s => s.trim());
            let validUntil = null;
            if (p[4] && parseInt(p[4]) > 0) validUntil = Date.now() + parseInt(p[4]) * 86400000;
            const gName = p[8] || '';
            const gId = (cachedGroups.find(g => g.name === gName) || {}).id || null;
            return {
                name: p[0], alias: p[1] || '', query_code: p[2] || '',
                fetch_limit: p[3] || '5', valid_until: validUntil,
                match_sender: p[5] || '', match_receiver: p[6] || '', match_body: p[7] || '',
                group_id: gId // [在此处添加] 存入 group_id
            };
        });
        if (json.length === 0) throw new Error("内容为空");

        // 逐条添加或者批量添加，这里保持原逻辑（注意：如果后端支持批量，可以直接传数组）
        // 原 gmail-pro 是批量接口 /import，这里保持不变
        fetch(API_BASE + '/api/rules/import', { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) })
            .then(r => r.json()).then(res => {
                if (res.success) {
                    bootstrap.Modal.getInstance(document.getElementById('batchRuleImportModal')).hide();
                    alert(`成功导入 ${res.count} 条规则`);
                    loadRules();
                } else alert("导入失败");
            });
    } catch(err) {
        alert("格式错误");
        console.error(err);
    }
}
// ================== 4. 发件任务管理 (Tasks) ==================

function loadTasks(page = 1) {
    const searchQuery = $("#section-send input[placeholder*='搜主题']").val().trim();
    currentTaskPage = page;
    $("#task-list-body").html('<tr><td colspan="7" class="text-center text-muted py-3"><i class="fas fa-spinner fa-spin"></i> 加载中...</td></tr>');
    fetch(`${API_BASE}/api/tasks?page=${page}&limit=${globalPageSize}&q=${encodeURIComponent(searchQuery)}&_t=${Date.now()}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            cachedTasks = res.data || [];
            currentTaskTotalPages = res.total_pages || 1;
            renderTaskList(cachedTasks);
            $("#task-page-info").html(`第 ${res.page} / ${res.total_pages} 页 (共 ${res.total} 条)` + renderPageSizeSelect(globalPageSize));
            $("#btn-prev-task").prop("disabled", res.page <= 1);
            $("#btn-next-task").prop("disabled", res.page >= res.total_pages);
        });
}

function renderTaskList(taskList) {
    let html = '';
    taskList.forEach(task => {
        let statusColor = task.status === 'success' ? 'text-success' : (task.status === 'error' ? 'text-danger' : 'text-warning');
        const statusMap = { 'pending': '等待中', 'success': '成功', 'error': '失败', 'running': '运行中' };
        const loopSwitch = `<div class="form-check form-switch"><input class="form-check-input" type="checkbox" ${task.is_loop ? 'checked' : ''} onchange="toggleTaskLoop(${task.id}, this.checked)"></div>`;

        html += `<tr>
            <td><input type="checkbox" class="task-check" value="${task.id}"></td>
            <td>${escapeHtml(task.account_name)}</td>
            <td>${escapeHtml(task.subject || '-')}</td>
            <td>${formatChinaTime(task.next_run_at)}</td>
            <td>${loopSwitch}</td>
            <td class="${statusColor} fw-bold">
                ${statusMap[task.status] || task.status} <small class="text-muted">(${task.success_count||0}/${task.fail_count||0})</small>
            </td>
            <td>
                <button class="btn btn-sm btn-outline-primary py-0" onclick="manualRun(${task.id})"><i class="fas fa-play"></i></button>
                <button class="btn btn-sm btn-outline-secondary py-0" onclick="editTask(${task.id})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-outline-danger py-0" onclick="delTask(${task.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });
    if(taskList.length === 0) html = '<tr><td colspan="7" class="text-center text-muted">无任务</td></tr>';
    $("#task-list-body").html(html);
}

function filterTasks(text) {
    clearTimeout(taskSearchTimer);
    taskSearchTimer = setTimeout(() => loadTasks(1), 300);
}

function changeTaskPage(d) {
    if (currentTaskPage + d > 0 && currentTaskPage + d <= currentTaskTotalPages) loadTasks(currentTaskPage + d);
}

function getSelectedAccountId() {
    const name = $("#send-account-input").val();
    return window.accountNameMap ? window.accountNameMap[name] : null;
}

function toggleTaskLoop(id, isLoop) {
    const task = cachedTasks.find(t => t.id === id);
    if (!task) return;
    const data = { ...task, is_loop: isLoop };
    fetch(API_BASE + '/api/tasks', { method: 'PUT', headers: getHeaders(), body: JSON.stringify(data) })
        .then(r => r.json()).then(res => { if(res.ok) task.is_loop = isLoop; else showToast("失败"); });
}

function saveTask() {
    const id = $("#edit-task-id").val();
    const accId = getSelectedAccountId();
    if (!accId) { showToast("请填写正确的发件邮箱名称"); return; }

    const d = $("#delay-d").val() || "0", h = $("#delay-h").val() || "0", m = $("#delay-m").val() || "0", s = $("#delay-s").val() || "0";
    
    const localDateStr = $("#date-a").val();
    let utcDateStr = localDateStr ? new Date(localDateStr).toISOString() : "";

    const data = {
        account_id: accId,
        to_email: $("#send-to").val(), 
        subject: $("#send-subject").val() || "Remind",
        content: $("#send-content").val() || ("Reminder of current time: " + new Date().toUTCString()),
        base_date: utcDateStr, delay_config: `${d}|${h}|${m}|${s}`,
        is_loop: $("#loop-switch").is(":checked"),
        execution_mode: $("#pref-api").is(":checked") ? 'API' : ($("#pref-gas").is(":checked") ? 'GAS' : 'AUTO')
    };

    const method = id ? 'PUT' : 'POST';
    if(id) data.id = id;

    fetch(API_BASE + '/api/tasks', { method, headers: getHeaders(), body: JSON.stringify(data) }).then(() => {
        showToast("保存成功"); cancelEditTask(); loadTasks(currentTaskPage);
    });
}

function editTask(id) {
    const task = cachedTasks.find(t => t.id === id);
    if(!task) return;
    $("#edit-task-id").val(task.id);
    $("#send-account-input").val(task.account_name || '');
    $("#send-to").val(task.to_email); $("#send-subject").val(task.subject); $("#send-content").val(task.content);
    if (task.base_date) $("#date-a").val(toLocalISOString(new Date(task.base_date)));
    
    if (task.delay_config) {
        const p = task.delay_config.includes('|') ? task.delay_config.split('|') : [0,0,0,0];
        $("#delay-d").val(p[0]); $("#delay-h").val(p[1]); $("#delay-m").val(p[2]); $("#delay-s").val(p[3]);
    }
    $("#loop-switch").prop("checked", !!task.is_loop);
    $("#task-card-title").text("编辑任务 " + id);
    $("#btn-save-task").html('更新任务'); $("#btn-cancel-edit").removeClass("d-none");
}

function cancelEditTask() {
    $("#edit-task-id").val(""); $("#task-card-title").text("创建任务");
    $("#btn-save-task").html('添加任务'); $("#btn-cancel-edit").addClass("d-none");
    $("#send-to,#send-subject,#send-content,#date-a,#delay-d,#delay-h,#delay-m,#delay-s").val("");
}

function manualRun(id) {
    if(!confirm("立即执行?")) return;
    fetch(API_BASE + '/api/tasks', { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ id, action: 'execute' }) }).then(()=>loadTasks(currentTaskPage));
}
function delTask(id) { if(confirm("删除?")) fetch(API_BASE+'/api/tasks?id='+id, {method:'DELETE',headers:getHeaders()}).then(()=>loadTasks(currentTaskPage)); }
function batchDelTasks() {
    const ids = $(".task-check:checked").map(function(){return this.value}).get();
    if(ids.length && confirm("删除选中?")) fetch(API_BASE+'/api/tasks?ids='+ids.join(','), {method:'DELETE',headers:getHeaders()}).then(()=>loadTasks(currentTaskPage));
}
function openBatchTaskModal() {
    $("#import-task-txt").val("");
    $("#import-task-file-input").val("");
    // 激活第一个 Tab
    const tabEl = document.querySelector('#taskImportTabs button[data-bs-target="#tab-task-paste"]');
    if(tabEl) new bootstrap.Tab(tabEl).show();
    new bootstrap.Modal(document.getElementById('batchTaskModal')).show();
}

function exportTasks() {
    const btn = $(event.target).closest('button');
    const orgHtml = btn.html();
    btn.html('<i class="fas fa-spinner fa-spin"></i> 导出中...');

    // 获取大量数据用于导出
    fetch(`${API_BASE}/api/tasks?limit=10000`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || [];
            if (!list.length) { btn.html(orgHtml); return showToast("暂无任务数据"); }

            const lines = list.map(t => {
                // 清理换行符，防止破坏 TXT 结构
                const sub = (t.subject || '').replace(/[\r\n]+/g, ' ');
                const con = (t.content || '').replace(/[\r\n]+/g, ' ');
                const next = t.next_run_at ? toLocalISOString(new Date(t.next_run_at)) : ''; // 使用 ISO 格式方便再次导入
                // 格式: 账号名 [TAB] 收件人 [TAB] 主题 [TAB] 内容 [TAB] 延迟配置 [TAB] 循环(0/1) [TAB] 下次运行时间
                return `${t.account_name||''}\t${t.to_email||''}\t${sub}\t${con}\t${t.delay_config||''}\t${t.is_loop?1:0}\t${next}`;
            });

            const txtContent = lines.join('\n');
            const dataStr = "data:text/plain;charset=utf-8," + encodeURIComponent(txtContent);
            const a = document.createElement('a');
            a.href = dataStr;
            a.download = "tasks_backup.txt";
            document.body.appendChild(a);
            a.click();
            a.remove();
            btn.html(orgHtml);
        })
        .catch(() => { btn.html(orgHtml); showToast("导出失败"); });
}

function submitBatchTasks() {
    const activeTab = $("#taskImportTabs .active").attr("data-bs-target");
    if (activeTab === "#tab-task-paste") {
        processTaskImport($("#import-task-txt").val());
    } else {
        const file = document.getElementById('import-task-file-input').files[0];
        if (!file) return showToast("请选择文件");
        const reader = new FileReader();
        reader.onload = e => processTaskImport(e.target.result);
        reader.readAsText(file);
    }
}

function processTaskImport(content) {
    if (!content.trim()) return showToast("内容为空");

    // 1. 先获取所有账号信息，用于将导入的"账号名称"转换为"ID"
    fetch(`${API_BASE}/api/accounts?type=simple`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const accounts = res.data || res;
            if (!accounts.length) return alert("系统内无发件账号，无法导入任务");

            try {
                const lines = content.split('\n').filter(l => l.trim());
                const json = lines.map(line => {
                    const p = line.split('\t'); // 不要 trim split 后的结果，保留空格
                    const accName = (p[0]||"").trim();
                    const acc = accounts.find(a => a.name === accName);
                    
                    return {
                        account_id: acc ? acc.id : null, // 如果没匹配到，后端会报错或忽略
                        to_email: (p[1]||"").trim(),
                        subject: (p[2]||"").trim(),
                        content: (p[3]||"").trim(),
                        delay_config: (p[4]||"").trim(),
                        is_loop: (p[5]||"").trim() === '1',
                        base_date: (p[6]||"").trim(),
                        execution_mode: 'AUTO'
                    };
                });

                // 2. 发送到后端
                fetch(API_BASE + '/api/tasks', { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) })
                    .then(r => r.json()).then(res => {
                        if (res.ok) {
                            bootstrap.Modal.getInstance(document.getElementById('batchTaskModal')).hide();
                            showToast("批量添加成功");
                            loadTasks(currentTaskPage);
                        } else {
                            alert("添加失败: " + (res.error || "未知错误"));
                        }
                    });
            } catch (e) { alert("解析错误: " + e.message); }
        });
}

function sendNow() {
    const accId = getSelectedAccountId();
    if(!accId) { showToast("请填写发件邮箱"); return; }
    const data = {
        account_id: accId,
    	to_email: $("#send-to").val(), 
    	subject: $("#send-subject").val() || "Remind",
        content: $("#send-content").val() || ("Reminder of current time: " + new Date().toUTCString()),
    	immediate: true, execution_mode: 'AUTO'
    };
    fetch(API_BASE + '/api/tasks', { method: 'POST', headers: getHeaders(), body: JSON.stringify(data) }).then(r=>r.json()).then(res=>{
        showToast(res.ok ? "发送成功" : "失败: "+res.error);
    });
}

// ================== 5. 收件管理 (Inbox) ==================

function loadInboxAccounts(page = 1) {
    const q = $("#section-receive input[placeholder*='搜索']").val().trim();
    currentInboxPage = page;
    $("#inbox-account-list").html('加载中...');
    fetch(`${API_BASE}/api/accounts?page=${page}&limit=${globalPageSize}&q=${encodeURIComponent(q)}`, { headers: getHeaders() })
        .then(r => r.json()).then(res => {
            currentInboxTotalPages = res.total_pages;
            renderInboxAccounts(res.data || []);
            $("#inbox-page-info").html(`${res.page}/${res.total_pages}` + renderPageSizeSelect(globalPageSize));
            $("#btn-prev-inbox").prop("disabled", res.page <= 1);
            $("#btn-next-inbox").prop("disabled", res.page >= res.total_pages);
        });
}

function renderInboxAccounts(accounts) {
    let html = '';
    accounts.forEach((acc) => {
        if (acc.status) { 
            const activeClass = (currentInboxAccountId == acc.id) ? 'active' : '';
            const hasApi = acc.type.includes('API');
            const hasGas = acc.type.includes('GAS');     
            html += `
            <div class="list-group-item list-group-item-action py-2 account-row ${activeClass}" onclick="selectAccount(${acc.id}, this)">
                <div class="d-flex w-100 justify-content-between align-items-center">
                    <span class="fw-bold text-truncate">${acc.name}</span>
                    <div class="btn-group btn-group-sm">
                        <input type="radio" class="btn-check" name="mode_${acc.id}" id="btn_api_${acc.id}" value="API" 
                               ${hasApi ? 'checked' : ''} ${!hasApi ? 'disabled' : ''} 
                               onchange="updateFetchMode(${acc.id}, 'API')">
                        <label class="btn btn-outline-success py-0" for="btn_api_${acc.id}" style="font-size:0.7rem">API</label>
                        
                        <input type="radio" class="btn-check" name="mode_${acc.id}" id="btn_gas_${acc.id}" value="GAS" 
                               ${!hasApi && hasGas ? 'checked' : ''} ${!hasGas ? 'disabled' : ''} 
                               onchange="updateFetchMode(${acc.id}, 'GAS')">
                        <label class="btn btn-outline-primary py-0" for="btn_gas_${acc.id}" style="font-size:0.7rem">GAS</label>
                    </div>
                </div>
            </div>`;
        }
    });
    $("#inbox-account-list").html(html || '无账号');
}

function filterInboxAccounts() { clearTimeout(inboxSearchTimer); inboxSearchTimer = setTimeout(() => loadInboxAccounts(1), 300); }
function changeInboxPage(d) { if (currentInboxPage+d > 0 && currentInboxPage+d <= currentInboxTotalPages) loadInboxAccounts(currentInboxPage+d); }
function selectAccount(id, el) {
    currentInboxAccountId = id;
    currentFetchMode = $(`input[name="mode_${id}"]:checked`).val() || 'API';
    
    $(".account-row").removeClass("active");
    $(el).addClass("active");
    
    const badgeClass = currentFetchMode === 'API' ? 'bg-success' : 'bg-primary';
    const accName = $(el).find('.fw-bold').text();

    $("#email-content-view").html(`
        <div class="text-center mt-5 text-muted">
            <i class="fas fa-envelope-open-text fa-3x mb-3 text-secondary"></i>
            <p>已选中邮箱: <b>${accName}</b></p>
            <p class="my-2">
                当前模式: <span class="badge ${badgeClass}" id="current-mode-display">${currentFetchMode}</span>
            </p>
            <div class="mt-4 p-3 bg-light d-inline-block rounded border">
                <p class="mb-1 small"><i class="fas fa-mouse-pointer me-1"></i> 点击上方 <b>"1封" / "3封"</b> 按钮</p>
                <p class="mb-0 small text-secondary">将自动同步并显示最新邮件</p>
            </div>
        </div>
    `);
}
function updateFetchMode(id, mode) {
    if (currentInboxAccountId == id) {
        currentFetchMode = mode;
        const badge = $("#current-mode-display");
        if (badge.length) {
            badge.text(mode);
            badge.removeClass("bg-success bg-primary")
                 .addClass(mode === 'API' ? 'bg-success' : 'bg-primary');
        }
        showToast(`已切换为 ${mode} 模式`);
    }
}
function setLimit(n) { currentEmailLimit=n; syncAndLoad(); }
function setCustomLimit(n) { currentEmailLimit=n; syncAndLoad(); }

function syncAndLoad() {
    if (!currentInboxAccountId) return showToast("请先选择邮箱");
    $("#email-content-view").html('<div class="text-center mt-5"><div class="spinner-border text-primary"></div><p>同步中...</p></div>');
    fetch(API_BASE + '/api/emails', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ account_id: currentInboxAccountId, mode: currentFetchMode }) })
        .then(() => fetchEmailsAfterSync());
}

function fetchEmailsAfterSync() {
    fetch(`${API_BASE}/api/emails?account_id=${currentInboxAccountId}&limit=${currentEmailLimit}&mode=${currentFetchMode}`, { headers: getHeaders() })
    .then(r => r.json()).then(data => {
        if (!data || !data.length) return $("#email-content-view").html('<div class="text-center mt-5">暂无邮件</div>');
        let html = '<div class="list-group p-3">';
        data.forEach(e => {
            html += `<div class="list-group-item list-group-item-action p-3 mb-2 border rounded">
                <div class="d-flex w-100 justify-content-between"><h6 class="mb-1 fw-bold">${escapeHtml(e.subject)}</h6><small>${formatChinaTime(e.received_at)}</small></div>
                <p class="mb-1 small text-secondary">发件人: ${escapeHtml(e.sender)}</p>
                <div class="mt-2 p-2 bg-light rounded text-break small">${escapeHtml(e.body)}</div>
            </div>`;
        });
        $("#email-content-view").html(html + '</div>');
    });
}

// 批量导入逻辑 (Accounts) - 修复版
function openBatchAccountModal() {
    $("#import-acc-json").val(""); $("#import-acc-file-input").val("");
    new bootstrap.Tab(document.querySelector('#importTabs button[data-bs-target="#tab-paste"]')).show();
    new bootstrap.Modal(document.getElementById('batchAccountImportModal')).show();
}

function submitBatchAccountImport() {
    const activeTab = $("#importTabs .active").attr("data-bs-target");
    if (activeTab === "#tab-paste") {
        const text = $("#import-acc-json").val();
        if (!text.trim()) return showToast("请输入内容");
        processImportContent(text);
    } else {
        const file = document.getElementById('import-acc-file-input').files[0];
        if (!file) return showToast("请选择文件");
        const reader = new FileReader();
        reader.onload = e => processImportContent(e.target.result);
        reader.readAsText(file);
    }
}

function processImportContent(content) {
    try {
        const lines = content.split('\n').filter(l => l.trim());
        const json = lines.map(line => {
            // 1. 严格按 Tab 分割，不进行智能猜测
            // 注意：如果中间有空的，split 会得到空字符串，这是符合预期的
            const parts = line.split('\t').map(s => s.trim());
            
            // 2. 严格对应 5 个列位置
            // 顺序: [0]名称  [1]邮箱  [2]别名  [3]API配置  [4]GAS链接
            const name = parts[0] || "";
            const email = parts[1] || "";
            const alias = parts[2] || "";
            const api = parts[3] || "";
            const gas = parts[4] || "";

            // 3. 自动判断账号类型
            let type = 'API'; // 默认
            if (api && gas) type = 'API/GAS';
            else if (gas) type = 'GAS';
            
            // 简单校验
            if (!name) return null; // 忽略没有名字的行

            return { 
                name: name, 
                email: email, 
                alias: alias, 
                api_config: api, 
                gas_url: gas, 
                type: type 
            };
        }).filter(item => item !== null); // 过滤掉无效行

        if (!json.length) throw new Error("有效内容为空");

        fetch(API_BASE + '/api/accounts', { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) })
            .then(r => r.json()).then(res => {
                if (res.ok) {
                    bootstrap.Modal.getInstance(document.getElementById('batchAccountImportModal')).hide();
                    alert(`导入成功: ${res.imported || json.length} 个`);
                    loadAccounts(currentAccountPage); 
                    loadAllAccountNames();
                } else {
                    alert("导入失败: " + res.error);
                }
            });
    } catch(err) { 
        alert("解析错误: " + err.message); 
    }
}

function toggleAll(type) {
    $("." + type + "-check").prop("checked", $("#check-all-" + type).is(":checked"));
}
if (localStorage.getItem("auth_token")) {
    $("#login-overlay").hide(); 
    loadAccounts();
    loadGroups();
    loadAllAccountNames();
} else {
    $("#login-overlay").show();
}
