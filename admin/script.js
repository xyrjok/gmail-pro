const API_BASE = "";

// ================== 全局变量定义 ==================

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

// 5. [新增] 策略组
let cachedGroups = [];

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

    return fetch(`${API_BASE}/api/accounts?page=${page}&limit=50&q=${encodeURIComponent(searchQuery)}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || [];
            cachedAccounts = list; 
            currentAccountTotalPages = res.total_pages || 1;
            renderAccounts(list);
            $("#acc-page-info").text(`第 ${res.page} / ${res.total_pages} 页 (共 ${res.total} 条)`);
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
        
        let apiDisplay = '-';
        if (acc.client_id) {
            apiDisplay = `ID:${acc.client_id}...`;
        } else if (acc.type.includes('API') && !acc.client_id) {
            apiDisplay = `<span class="text-muted">无配置</span>`;
        }
        
        let gasDisplay = '-';
        if (acc.script_url && acc.script_url.startsWith('http')) {
            gasDisplay = `YES`;
        }

        let badgeClass = 'bg-secondary';
        if (acc.type === 'API') badgeClass = 'bg-success';
        else if (acc.type === 'GAS') badgeClass = 'bg-primary';
        else if (acc.type === 'API/GAS') badgeClass = 'bg-info text-dark';

        // [新增] 显示 Email 字段
        html += `<tr>
            <td><input type="checkbox" class="acc-check" value="${acc.id}"></td>
            <td class="cursor-pointer fw-bold" onclick="copyText('${acc.name}')">${acc.name}</td>
            <td>${acc.email || '-'}</td>
            <td class="cursor-pointer" onclick="copyText('${acc.alias}')">${acc.alias || '-'}</td>
            <td class="cursor-pointer" title="点击复制详细配置" onclick="copyText('${acc.client_id},${acc.client_secret},${acc.refresh_token}')">${apiDisplay}</td>
            <td class="cursor-pointer" title="${acc.script_url}" onclick="copyText('${acc.script_url}')">${gasDisplay}</td>
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
            let optionsHtml = '';
            window.accountNameMap = {}; 
            data.forEach(acc => {
                optionsHtml += `<option value="${acc.name}">别名: ${acc.alias || '-'}</option>`;
                window.accountNameMap[acc.name] = acc.id;
            });
            $("#account-list-options").html(optionsHtml);
        });
}

function exportAccounts() {
    const btn = $(event.target).closest('button');
    const orgHtml = btn.html();
    btn.html('<i class="fas fa-spinner fa-spin"></i> 导出中...');
    
    fetch(`${API_BASE}/api/accounts?type=export`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            const lines = data.map(acc => {
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

function loadGroups() {
    $("#group-list-body").html('<tr><td colspan="6" class="text-center"><div class="spinner-border text-primary spinner-border-sm"></div> 加载中...</td></tr>');
    fetch(API_BASE + '/api/groups', { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            cachedGroups = res.data || [];
            renderGroups(cachedGroups);
        });
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

function loadRules() {
    const searchQuery = $("#section-rules input[placeholder*='搜索']").val().trim();
    $("#rule-list-body").html('<tr><td colspan="9" class="text-center py-4"><div class="spinner-border text-primary spinner-border-sm"></div> 加载中...</td></tr>');

    fetch(`${API_BASE}/api/rules`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            // 前端过滤
            let filtered = data;
            if (searchQuery) {
                const lowerQ = searchQuery.toLowerCase();
                filtered = data.filter(r => 
                    r.name.toLowerCase().includes(lowerQ) || 
                    (r.alias && r.alias.toLowerCase().includes(lowerQ)) ||
                    r.query_code.toLowerCase().includes(lowerQ)
                );
            }
            cachedRules = filtered;
            renderRules(filtered);
            $("#rule-page-info").text(`共 ${filtered.length} 条规则`);
        });
}

function renderRules(data) {
    let html = '';
    const host = window.location.host; 

    data.forEach(r => {
        // [新增] 策略组逻辑
        const groupName = r.group_id ? (cachedGroups.find(g => g.id == r.group_id)?.name || `ID:${r.group_id}`) : null;
        const groupBadge = groupName ? `<span class="badge bg-primary cursor-pointer" title="使用策略组">${escapeHtml(groupName)}</span>` : '<span class="text-muted">-</span>';
        
        // 构造本地条件显示
        let localCond = [];
        if (!r.group_id) {
            if(r.match_sender) localCond.push(`发:${r.match_sender}`);
            if(r.match_receiver) localCond.push(`收:${r.match_receiver}`);
            if(r.match_body) localCond.push(`文:${r.match_body}`);
            if (localCond.length === 0) localCond.push('无限制');
        } else {
            localCond.push('<small class="text-muted fst-italic">继承策略组</small>');
        }

        const fullLink = `//${host}/${r.query_code}`;
        const daysLeft = r.valid_until ? Math.ceil((r.valid_until - Date.now()) / 86400000) : null;
        const validStr = daysLeft ? (daysLeft > 0 ? `${daysLeft}天` : '<span class="text-danger">过期</span>') : '永久';

        html += `<tr>
            <td><input type="checkbox" class="rule-check" value="${r.id}"></td>
            <td class="fw-bold">${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.alias)}</td>
            <td>
                <a href="${fullLink}" target="_blank" class="text-decoration-none font-monospace small" title="点击打开">${r.query_code}</a>
            </td>
            <td>${groupBadge}</td>
            <td>${r.fetch_limit || 5}</td>
            <td>${validStr}</td>
            <td class="small text-truncate" style="max-width:150px">${escapeHtml(localCond.join(' '))}</td>
            <td>
                <button class="btn btn-sm btn-light text-primary py-0" onclick="openEditRuleModal(${r.id})"><i class="fas fa-edit"></i></button> 
                <button class="btn btn-sm btn-light text-danger py-0" onclick="delRule(${r.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });

    if(data.length === 0) html = '<tr><td colspan="9" class="text-center text-muted">暂无规则</td></tr>';
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
    fetch(`${API_BASE}/api/rules`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            const lines = data.map(r => {
                let days = '';
                if (r.valid_until && r.valid_until > Date.now()) {
                    days = Math.ceil((r.valid_until - Date.now()) / (24 * 60 * 60 * 1000));
                }
                return `${r.name}\t${r.alias}\t${r.query_code}\t${r.fetch_limit||5}\t${days}\t${r.match_sender||''}\t${r.match_receiver||''}\t${r.match_body||''}`;
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
        .catch(() => showToast("导出失败"));
}

function openBatchRuleModal() {
    $("#import-rule-text").val("");
    new bootstrap.Modal(document.getElementById('batchRuleImportModal')).show();
}

function processRuleImport(content) {
    try {
        const lines = content.split('\n').filter(line => line.trim());
        const json = lines.map(line => {
            const p = line.split('\t').map(s => s.trim());
            let validUntil = null;
            if (p[4] && parseInt(p[4]) > 0) validUntil = Date.now() + parseInt(p[4]) * 86400000;
            return {
                name: p[0], alias: p[1] || '', query_code: p[2] || '',
                fetch_limit: p[3] || '5', valid_until: validUntil,
                match_sender: p[5] || '', match_receiver: p[6] || '', match_body: p[7] || ''
            };
        });
        if (json.length === 0) throw new Error("内容为空");

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
    }
}

// ================== 4. 发件任务管理 (Tasks) ==================

function loadTasks(page = 1) {
    const searchQuery = $("#section-send input[placeholder*='搜主题']").val().trim();
    currentTaskPage = page;
    $("#task-list-body").html('<tr><td colspan="7" class="text-center text-muted py-3"><i class="fas fa-spinner fa-spin"></i> 加载中...</td></tr>');

    fetch(`${API_BASE}/api/tasks?page=${page}&limit=50&q=${encodeURIComponent(searchQuery)}&_t=${Date.now()}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            cachedTasks = res.data || [];
            currentTaskTotalPages = res.total_pages || 1;
            renderTaskList(cachedTasks);
            $("#task-page-info").text(`第 ${res.page} / ${res.total_pages} 页 (共 ${res.total} 条)`);
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
        to_email: $("#send-to").val(), subject: $("#send-subject").val(), content: $("#send-content").val(),
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
function openBatchTaskModal() { new bootstrap.Modal(document.getElementById('batchTaskModal')).show(); }
function submitBatchTasks() {
    try {
        const json = JSON.parse($("#batch-task-json").val());
        fetch(API_BASE + '/api/tasks', { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) })
            .then(() => { bootstrap.Modal.getInstance(document.getElementById('batchTaskModal')).hide(); loadTasks(currentTaskPage); });
    } catch(e) { alert("JSON错误"); }
}

function sendNow() {
    const accId = getSelectedAccountId();
    if(!accId) { showToast("请填写发件邮箱"); return; }
    const data = {
        account_id: accId, to_email: $("#send-to").val(), subject: $("#send-subject").val(), content: $("#send-content").val(),
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
    fetch(`${API_BASE}/api/accounts?page=${page}&limit=20&q=${encodeURIComponent(q)}`, { headers: getHeaders() })
        .then(r => r.json()).then(res => {
            currentInboxTotalPages = res.total_pages;
            renderInboxAccounts(res.data || []);
            $("#inbox-page-info").text(`${res.page}/${res.total_pages}`);
            $("#btn-prev-inbox").prop("disabled", res.page <= 1);
            $("#btn-next-inbox").prop("disabled", res.page >= res.total_pages);
        });
}

function renderInboxAccounts(accounts) {
    let html = '';
    accounts.forEach((acc) => {
        if (acc.status) { 
            const activeClass = (currentInboxAccountId == acc.id) ? 'active' : '';
            html += `
            <div class="list-group-item list-group-item-action py-2 account-row ${activeClass}" onclick="selectAccount(${acc.id}, this)">
                <div class="d-flex w-100 justify-content-between align-items-center">
                    <span class="fw-bold text-truncate">${acc.name}</span>
                    <div class="btn-group btn-group-sm">
                        <input type="radio" class="btn-check" name="mode_${acc.id}" value="API" ${acc.type.includes('API')?'checked':''} onchange="updateFetchMode(${acc.id}, 'API')">
                        <label class="btn btn-outline-success py-0" style="font-size:0.7rem">API</label>
                        <input type="radio" class="btn-check" name="mode_${acc.id}" value="GAS" ${!acc.type.includes('API')&&acc.type.includes('GAS')?'checked':''} onchange="updateFetchMode(${acc.id}, 'GAS')">
                        <label class="btn btn-outline-primary py-0" style="font-size:0.7rem">GAS</label>
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
    $("#email-content-view").html(`<div class="text-center mt-5 text-muted"><p>已选中: ${$(el).find('.fw-bold').text()}</p><p>点击上方按钮加载邮件</p></div>`);
}
function updateFetchMode(id, mode) { if(currentInboxAccountId==id) currentFetchMode=mode; }

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

// 批量导入逻辑 (Accounts)
function openBatchAccountModal() { $("#import-acc-json").val(""); new bootstrap.Modal(document.getElementById('batchAccountImportModal')).show(); }
function processImport(jsonStr) {
    try {
        const lines = jsonStr.split('\n').filter(l=>l.trim());
        const json = lines.map(l => {
            const p = l.split('\t').map(s=>s.trim());
            const type = (p[2]&&p[3]) ? 'API/GAS' : (p[2]?'API':'GAS');
            return { name: p[0], alias: p[1], api_config: p[2], gas_url: p[3], type };
        });
        fetch(API_BASE+'/api/accounts', {method:'POST',headers:getHeaders(),body:JSON.stringify(json)}).then(()=>{
            bootstrap.Modal.getInstance(document.getElementById('batchAccountImportModal')).hide(); loadAccounts(); showToast("导入完成");
        });
    } catch(e){ alert("格式错误"); }
}

function toggleAll(type) {
    $("." + type + "-check").prop("checked", $("#check-all-" + type).is(":checked"));
}

// 初始化
if(localStorage.getItem("auth_token")) {
    $("#login-overlay").hide();
    loadAccounts();
    loadGroups();
    loadAllAccountNames();
}
