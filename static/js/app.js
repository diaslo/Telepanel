var allAccounts = [];
var isChecking = false;
var activeTab = '';
var proxyDismissTimer = null;
var watchInterval = null;
var lastProxyCheckTime = 0;
var PROXY_CHECK_INTERVAL = 24 * 3600 * 1000; // 24 hours

document.addEventListener('DOMContentLoaded', function () {
    loadAccountsThenCheck();
    document.getElementById('btnRefresh').addEventListener('click', loadAccountsThenCheck);
    document.getElementById('btnCheckAll').addEventListener('click', function () { checkAllAccounts(true); });
    document.getElementById('filterSearch').addEventListener('input', applyFilters);
    document.getElementById('filterFolder').addEventListener('change', applyFilters);
    document.getElementById('brokenToggle').addEventListener('click', function () {
        document.getElementById('brokenSection').classList.toggle('open');
    });
    document.getElementById('proxyBannerClose').addEventListener('click', dismissProxyBanner);

    // Tab clicks
    document.querySelectorAll('.tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
            tab.classList.add('active');
            activeTab = tab.dataset.status;
            applyFilters();
        });
    });

    // Watch for new accounts every 10 seconds
    watchInterval = setInterval(watchForNewAccounts, 10000);
});

async function loadAccountsThenCheck() {
    await loadAccounts();
    var proxyOk = await checkProxy();
    if (proxyOk) {
        lastProxyCheckTime = Date.now();
        checkAllAccounts();
    }
}

async function loadAccounts() {
    var list = document.getElementById('accountList');
    var loading = document.getElementById('loading');
    var emptyState = document.getElementById('emptyState');
    var brokenSection = document.getElementById('brokenSection');

    loading.style.display = 'block';
    emptyState.style.display = 'none';
    brokenSection.style.display = 'none';
    list.innerHTML = '';

    try {
        var resp = await fetch('/api/accounts');
        var data = await resp.json();
        var accounts = data.accounts;
        var broken = data.broken;

        loading.style.display = 'none';
        allAccounts = accounts;

        document.getElementById('accountCount').textContent =
            accounts.length + ' account' + (accounts.length !== 1 ? 's' : '');

        // Broken accounts
        if (broken.length > 0) {
            brokenSection.style.display = 'block';
            document.getElementById('brokenCount').textContent = '(' + broken.length + ')';
            var brokenList = document.getElementById('brokenList');
            brokenList.innerHTML = '';
            broken.forEach(function (b) {
                var item = document.createElement('div');
                item.className = 'broken-item';
                item.innerHTML =
                    '<span class="broken-file">' + esc(b.file) + '</span>' +
                    '<span class="broken-reason">' + esc(b.reason) + '</span>';
                brokenList.appendChild(item);
            });
        }

        // Populate folder filter
        var folders = [];
        accounts.forEach(function (a) {
            if (a.folder && folders.indexOf(a.folder) === -1) folders.push(a.folder);
        });
        var folderSelect = document.getElementById('filterFolder');
        folderSelect.innerHTML = '<option value="">All folders</option>';
        folders.sort().forEach(function (f) {
            var opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            folderSelect.appendChild(opt);
        });

        updateTabCounts();

        if (accounts.length === 0 && broken.length === 0) {
            emptyState.style.display = 'block';
            return;
        }

        renderAccounts(accounts);
    } catch (err) {
        loading.textContent = 'Error: ' + err.message;
    }
}

function showProxyBanner(type, icon, text) {
    var banner = document.getElementById('proxyBanner');
    if (proxyDismissTimer) clearTimeout(proxyDismissTimer);
    banner.classList.remove('hiding', 'banner-ok', 'banner-fail', 'banner-checking');
    banner.classList.add('banner-' + type);
    banner.style.display = 'flex';
    document.getElementById('proxyBannerIcon').textContent = icon;
    document.getElementById('proxyBannerText').textContent = text;
}

function dismissProxyBanner() {
    var banner = document.getElementById('proxyBanner');
    banner.classList.add('hiding');
    setTimeout(function () { banner.style.display = 'none'; }, 300);
    if (proxyDismissTimer) clearTimeout(proxyDismissTimer);
}

async function checkProxy() {
    showProxyBanner('checking', '...', 'Checking proxies...');

    try {
        var resp = await fetch('/api/proxy/check', { method: 'POST' });
        var data = await resp.json();

        if (data.results.length === 0) {
            showProxyBanner('fail', '!', 'No proxies configured');
            proxyDismissTimer = setTimeout(dismissProxyBanner, 60000);
            return true;
        }

        if (data.all_valid) {
            var r = data.results[0];
            showProxyBanner('ok', '\u2713', data.results.length + ' proxy OK \u2014 ' + r.external_ip + ' ' + r.country + ' (' + r.time + 'ms)');
            proxyDismissTimer = setTimeout(dismissProxyBanner, 60000);
            return true;
        } else {
            var failCount = data.results.filter(function (r) { return !r.valid; }).length;
            showProxyBanner('fail', '\u2717', failCount + '/' + data.results.length + ' proxies failed');
            proxyDismissTimer = setTimeout(dismissProxyBanner, 60000);
            return false;
        }
    } catch (err) {
        showProxyBanner('fail', '!', 'Proxy error: ' + err.message);
        proxyDismissTimer = setTimeout(dismissProxyBanner, 60000);
        return false;
    }
}

async function checkProxyIfNeeded() {
    var now = Date.now();
    if (lastProxyCheckTime > 0 && (now - lastProxyCheckTime) < PROXY_CHECK_INTERVAL) {
        return true; // proxy validated recently, skip
    }
    var result = await checkProxy();
    if (result) {
        lastProxyCheckTime = now;
    }
    return result;
}

function setBarChecking(phone, checking) {
    var bar = document.querySelector('.acc-bar[data-phone="' + phone + '"]');
    if (!bar) return;
    var btn = bar.querySelector('.btn-check-sm');
    if (!btn) return;
    if (checking) {
        btn.classList.add('loading');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner spinner-sm"></span>';
    } else {
        btn.classList.remove('loading');
        btn.disabled = false;
        btn.textContent = 'Check';
    }
}

async function watchForNewAccounts() {
    if (isChecking) return;
    try {
        var resp = await fetch('/api/accounts');
        var data = await resp.json();
        var localPhones = allAccounts.map(function (a) { return a.phone; });

        // Find new accounts not in our current list
        var newAccounts = data.accounts.filter(function (a) {
            return localPhones.indexOf(a.phone) === -1;
        });

        // Also update existing accounts with fresh server data (status, folder)
        data.accounts.forEach(function (serverAcc) {
            for (var i = 0; i < allAccounts.length; i++) {
                if (allAccounts[i].phone === serverAcc.phone) {
                    allAccounts[i].status = serverAcc.status;
                    allAccounts[i].folder = serverAcc.folder;
                    allAccounts[i].last_check = serverAcc.last_check;
                    allAccounts[i].avatar = serverAcc.avatar;
                    break;
                }
            }
        });
        updateTabCounts();

        if (newAccounts.length === 0) return;

        // Merge new accounts into allAccounts
        newAccounts.forEach(function (a) { allAccounts.push(a); });

        // Update UI
        document.getElementById('accountCount').textContent =
            allAccounts.length + ' account' + (allAccounts.length !== 1 ? 's' : '');
        updateTabCounts();
        applyFilters();

        // Show spinners on new account bars
        var newPhones = newAccounts.map(function (a) { return a.phone; });
        newPhones.forEach(function (phone) { setBarChecking(phone, true); });

        // Check only the new accounts (no proxy re-check)
        var batch = [];
        for (var i = 0; i < allAccounts.length; i++) {
            if (newPhones.indexOf(allAccounts[i].phone) !== -1) {
                batch.push(fireCheck(i, true));
                if (batch.length >= 5) {
                    await Promise.all(batch);
                    batch = [];
                }
            }
        }
        if (batch.length > 0) await Promise.all(batch);
    } catch (err) {
        // Silently ignore polling errors
    }
}

var statusOrder = { active: 0, spamblock: 1, frozen: 2, unknown: 3, dead: 4 };

function renderAccounts(accounts) {
    var list = document.getElementById('accountList');
    list.innerHTML = '';
    if (accounts.length === 0) {
        list.innerHTML = '<div class="no-results" style="display:block">No accounts match filters</div>';
        return;
    }
    var sorted = accounts.slice().sort(function (a, b) {
        return (statusOrder[a.status] || 3) - (statusOrder[b.status] || 3);
    });
    sorted.forEach(function (acc) { list.appendChild(createBar(acc)); });
}

function updateTabCounts() {
    var counts = { '': 0, active: 0, spamblock: 0, frozen: 0, dead: 0 };
    allAccounts.forEach(function (acc) {
        counts['']++;
        if (counts[acc.status] !== undefined) counts[acc.status]++;
    });
    document.getElementById('countAll').textContent = counts[''];
    document.getElementById('countActive').textContent = counts.active;
    document.getElementById('countSpamblock').textContent = counts.spamblock;
    document.getElementById('countFrozen').textContent = counts.frozen;
    document.getElementById('countDead').textContent = counts.dead;
}

function applyFilters() {
    var search = document.getElementById('filterSearch').value.toLowerCase();
    var folder = document.getElementById('filterFolder').value;

    var filtered = allAccounts.filter(function (acc) {
        if (activeTab && acc.status !== activeTab) return false;
        if (folder && acc.folder !== folder) return false;
        if (search) {
            var hay = (
                '+' + acc.phone + ' ' +
                acc.username + ' ' +
                acc.first_name + ' ' +
                acc.last_name
            ).toLowerCase();
            if (hay.indexOf(search) === -1) return false;
        }
        return true;
    });

    renderAccounts(filtered);
}

function createBar(acc) {
    var bar = document.createElement('div');
    bar.className = 'acc-bar';
    bar.dataset.phone = acc.phone;

    var statusClass = 'status-' + acc.status;
    var statusLabel = acc.status === 'spamblock' ? 'spam block' : acc.status;
    var fullName = [acc.first_name, acc.last_name].filter(Boolean).join(' ');

    var avatarHtml = acc.avatar
        ? '<img class="acc-avatar" src="' + esc(acc.avatar) + '" alt="">'
        : '<span class="acc-avatar-placeholder">' + esc((acc.first_name || '?').charAt(0)) + '</span>';

    var h = '<div class="acc-bar-header">' +
        '<span class="acc-expand-icon">&#9654;</span>' +
        avatarHtml +
        '<span class="acc-phone">+' + esc(acc.phone) + '</span>' +
        '<span class="acc-username">@' + esc(acc.username || '—') + '</span>' +
        '<span class="acc-name">' + esc(fullName || '—') + '</span>';

    if (acc.folder && acc.folder !== '.') {
        h += '<span class="acc-folder-tag">' + esc(acc.folder) + '</span>';
    }

    h += '<span class="acc-proxy-tag">' + esc(acc.proxy || 'no proxy') + '</span>' +
        '<span class="acc-bar-right">';

    if (acc.is_premium) {
        h += '<span class="premium-tag">PRO</span>';
    }

    h += '<span class="status-badge ' + statusClass + '">' + esc(statusLabel) + '</span>' +
        '<button class="btn-check-sm" onclick="event.stopPropagation(); checkAccount(\'' + acc.phone + '\', this)">Check</button>' +
        '</span></div>';

    var d = '<div class="acc-details"><div class="acc-details-inner">' +
        detail('Phone', '+' + acc.phone) +
        detail('Username', '@' + (acc.username || '—')) +
        detail('Name', fullName || '—') +
        detail('User ID', acc.user_id) +
        detail('Status', statusLabel) +
        detail('Spamblock', acc.spamblock) +
        detail('2FA', acc.twoFA) +
        detail('Premium', acc.is_premium ? 'Yes' : 'No') +
        detail('Device', acc.device || acc.device_model || '—') +
        detail('SDK', acc.sdk || '—') +
        detail('App Version', acc.app_version || '—') +
        detail('Lang', acc.lang_pack || '—') +
        detail('Sys Lang', acc.system_lang_pack || '—') +
        detail('Profile Pic', acc.has_profile_pic ? 'Yes' : 'No') +
        detail('Proxy', acc.proxy || 'none') +
        detail('Folder', acc.folder || '.') +
        detail('Last Connect', formatDate(acc.last_connect)) +
        detail('Session Created', formatDate(acc.session_created)) +
        detail('Registered', acc.register_time ? formatTs(acc.register_time) : '—') +
        detail('Last Check', acc.last_check ? formatDate(acc.last_check) : 'never') +
        detail('Spam Count', acc.stats_spam_count) +
        detail('Invites Count', acc.stats_invites_count) +
        '</div></div>';

    bar.innerHTML = h + d;
    bar.querySelector('.acc-bar-header').addEventListener('click', function () {
        bar.classList.toggle('open');
    });
    return bar;
}

function detail(label, value) {
    return '<div class="detail-item">' +
        '<span class="detail-label">' + esc(label) + ':</span>' +
        '<span class="detail-value">' + esc(String(value != null ? value : '—')) + '</span></div>';
}

function setCheckingState(active) {
    isChecking = active;
    var btn = document.getElementById('btnCheckAll');
    btn.disabled = active;
    if (active) {
        btn.innerHTML = '<span class="spinner spinner-sm"></span> Checking...';
    } else {
        btn.textContent = 'Check All';
    }
    document.querySelectorAll('.btn-check-sm').forEach(function (b) {
        b.disabled = active;
        if (active) {
            b.classList.add('loading');
            b.innerHTML = '<span class="spinner spinner-sm"></span>';
        } else {
            b.classList.remove('loading');
            b.textContent = 'Check';
        }
    });
}

async function checkAccount(phone, btnEl) {
    if (isChecking) return;
    btnEl.classList.add('loading');
    btnEl.disabled = true;
    btnEl.innerHTML = '<span class="spinner spinner-sm"></span>';
    try {
        var resp = await fetch('/api/accounts/' + phone + '/check?force=1', { method: 'POST' });
        var result = await resp.json();
        updateBarStatus(phone, result.status, result.avatar, result.skipped);
        allAccounts.forEach(function (a) {
            if (a.phone === phone) {
                a.status = result.status;
                a.last_check = new Date().toISOString();
                if (result.avatar) a.avatar = result.avatar;
            }
        });
        updateTabCounts();
    } catch (err) {
        console.error('Check failed:', err);
    } finally {
        btnEl.classList.remove('loading');
        btnEl.disabled = false;
        btnEl.textContent = 'Check';
    }
}

async function checkAllAccounts(force) {
    if (isChecking) return;
    var proxyOk = await checkProxyIfNeeded();
    if (!proxyOk) return;
    setCheckingState(true);

    try {
        // Fire all checks in parallel batches of 5
        var batch = [];
        for (var i = 0; i < allAccounts.length; i++) {
            batch.push(fireCheck(i, !!force));
            if (batch.length >= 5 || i === allAccounts.length - 1) {
                await Promise.all(batch);
                batch = [];
            }
        }
    } finally {
        setCheckingState(false);
    }
}

function isCheckExpired(lastCheck) {
    if (!lastCheck) return true;
    try {
        var elapsed = Date.now() - new Date(lastCheck).getTime();
        return elapsed > 6 * 3600 * 1000;
    } catch (e) { return true; }
}

async function fireCheck(index, force) {
    var phone = allAccounts[index].phone;
    try {
        var url = '/api/accounts/' + phone + '/check' + (force ? '?force=1' : '');
        var resp = await fetch(url, { method: 'POST' });
        var r = await resp.json();
        updateBarStatus(r.phone, r.status, r.avatar, r.skipped);
        allAccounts[index].status = r.status;
        allAccounts[index].last_check = new Date().toISOString();
        if (r.avatar) allAccounts[index].avatar = r.avatar;
        if (r.moved) {
            allAccounts[index].moved = true;
        }
        updateTabCounts();
        // Remove spinner from this account's button
        var bar = document.querySelector('.acc-bar[data-phone="' + phone + '"]');
        if (bar) {
            var btn = bar.querySelector('.btn-check-sm');
            if (btn) {
                btn.classList.remove('loading');
                btn.textContent = 'Check';
            }
        }
    } catch (err) {
        console.error('Check failed for ' + phone + ':', err);
    }
}

function updateBarStatus(phone, status, avatar, skipped) {
    var bar = document.querySelector('.acc-bar[data-phone="' + phone + '"]');
    if (!bar) return;
    var badge = bar.querySelector('.status-badge');
    var label = status === 'spamblock' ? 'spam block' : status;
    badge.className = 'status-badge status-' + status;
    badge.textContent = label;
    // Update avatar if downloaded
    if (avatar) {
        var placeholder = bar.querySelector('.acc-avatar-placeholder');
        if (placeholder) {
            var img = document.createElement('img');
            img.className = 'acc-avatar';
            img.src = avatar;
            img.alt = '';
            placeholder.replaceWith(img);
        }
    }
    // Dim moved accounts
    if (status === 'dead' || status === 'frozen') {
        bar.classList.add('acc-moved');
    }
    // Re-sort: move bar to correct position by status priority
    var list = bar.parentElement;
    if (!list) return;
    var myOrder = statusOrder[status] || 3;
    var bars = Array.from(list.querySelectorAll('.acc-bar'));
    var insertBefore = null;
    for (var i = 0; i < bars.length; i++) {
        if (bars[i] === bar) continue;
        var otherBadge = bars[i].querySelector('.status-badge');
        var otherStatus = '';
        if (otherBadge) {
            otherBadge.classList.forEach(function (c) {
                if (c.indexOf('status-') === 0 && c !== 'status-badge') otherStatus = c.replace('status-', '');
            });
        }
        var otherOrder = statusOrder[otherStatus] || 3;
        if (otherOrder > myOrder) {
            insertBefore = bars[i];
            break;
        }
    }
    if (insertBefore) {
        list.insertBefore(bar, insertBefore);
    }
}

function formatDate(s) {
    if (!s) return '—';
    try { var d = new Date(s); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return s; }
}

function formatTs(ts) {
    if (!ts) return '—';
    try { var d = new Date(ts * 1000); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(ts); }
}

function esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
