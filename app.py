import os
import json
import asyncio
import shutil
import threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Flask, render_template, jsonify, request

from checker import check_account_status, parse_proxy, validate_proxy

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS_DIR = os.path.join(BASE_DIR, 'accounts', 'actual')
FROZEN_DIR = os.path.join(BASE_DIR, 'accounts', 'frozen')
DEAD_DIR = os.path.join(BASE_DIR, 'accounts', 'dead')
PROXY_FILE = os.path.join(BASE_DIR, 'proxy.txt')
AVATAR_DIR = os.path.join(BASE_DIR, 'static', 'avatars')
CHECK_COOLDOWN = 6 * 3600  # 6 hours in seconds
MAX_THREADS = 5


def load_proxies():
    """Load proxies from proxy.txt, one per line: host:port:user:pass"""
    if not os.path.exists(PROXY_FILE):
        return []
    with open(PROXY_FILE, 'r', encoding='utf-8') as f:
        return [line.strip() for line in f if line.strip()]


def get_proxy_for_account(index):
    """Round-robin proxy assignment."""
    proxies = load_proxies()
    if not proxies:
        return None
    return parse_proxy(proxies[index % len(proxies)])


def save_check_result(json_path, status, spambot):
    """Update the account JSON with check results and timestamp."""
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        data['last_check_status'] = status
        data['last_check_spambot'] = spambot
        data['last_check_time'] = datetime.now().isoformat()
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f'[app] Failed to save check result: {e}')


def should_skip_check(acc):
    """Return True if account was checked less than 6 hours ago."""
    last_check = acc.get('last_check_time')
    if not last_check:
        return False
    try:
        last_dt = datetime.fromisoformat(last_check)
        elapsed = (datetime.now() - last_dt).total_seconds()
        return elapsed < CHECK_COOLDOWN
    except (ValueError, TypeError):
        return False


def move_account(acc, dest_dir):
    """Move .json + .session to the target folder (frozen/ or dead/)."""
    os.makedirs(dest_dir, exist_ok=True)
    base = acc['_session_path']  # path without extension
    json_path = acc['_json_path']
    session_path = base + '.session'

    basename = os.path.basename(base)
    new_json = os.path.join(dest_dir, basename + '.json')
    new_session = os.path.join(dest_dir, basename + '.session')

    try:
        if os.path.exists(json_path):
            shutil.move(json_path, new_json)
        if os.path.exists(session_path):
            shutil.move(session_path, new_session)
        return True
    except Exception as e:
        print(f'[app] Failed to move account {basename}: {e}')
        return False


def scan_accounts():
    """
    Recursively scan accounts/actual/, accounts/frozen/, accounts/dead/.
    Returns (valid_accounts, broken_entries).

    A valid account has both .json and .session with the same basename.
    A broken entry has only one of them.
    """
    scan_dirs = [
        (ACCOUNTS_DIR, True, None),
        (FROZEN_DIR, False, 'frozen'),
        (DEAD_DIR, False, 'dead'),
    ]

    valid = []
    broken = []

    for scan_dir, moveable, forced_status in scan_dirs:
        if not os.path.exists(scan_dir):
            continue

        json_files = {}
        session_files = {}

        for dirpath, _, filenames in os.walk(scan_dir):
            for fname in filenames:
                full = os.path.join(dirpath, fname)
                ext = os.path.splitext(fname)[1]
                base = full.rsplit('.', 1)[0]
                if ext == '.json':
                    json_files[base] = full
                elif ext == '.session':
                    session_files[base] = full

        all_bases = set(json_files.keys()) | set(session_files.keys())

        for base in sorted(all_bases):
            has_json = base in json_files
            has_session = base in session_files

            if has_json and has_session:
                try:
                    with open(json_files[base], 'r', encoding='utf-8') as f:
                        data = json.load(f)
                except (json.JSONDecodeError, OSError):
                    broken.append({
                        'file': os.path.basename(base),
                        'path': json_files[base],
                        'reason': 'json parse error',
                    })
                    continue

                data['_session_path'] = base
                data['_json_path'] = json_files[base]
                data['_folder'] = os.path.relpath(os.path.dirname(json_files[base]), scan_dir)
                data['_index'] = len(valid)
                data['_moveable'] = moveable

                # Determine status: saved check > folder > block flag > unknown
                if data.get('last_check_status'):
                    data['status'] = data['last_check_status']
                elif forced_status:
                    data['status'] = forced_status
                elif data.get('block') is True:
                    data['status'] = 'dead'
                else:
                    data['status'] = 'unknown'

                valid.append(data)
            else:
                missing = 'session' if has_json else 'json'
                existing = json_files.get(base) or session_files.get(base)
                broken.append({
                    'file': os.path.basename(base),
                    'path': existing,
                    'reason': f'missing .{missing}',
                })

    return valid, broken


def get_avatar_url(phone):
    """Check if avatar file exists and return its URL."""
    for ext in ('.jpg', '.png', '.jpeg'):
        if os.path.exists(os.path.join(AVATAR_DIR, phone + ext)):
            return f'/static/avatars/{phone}{ext}'
    return ''


def account_to_dict(acc):
    """Convert raw account data to a safe dict for the frontend."""
    proxies = load_proxies()
    idx = acc.get('_index', 0)
    proxy_str = proxies[idx % len(proxies)] if proxies else None
    phone = acc.get('phone', '')

    # Use saved status from last check if available
    status = acc.get('status', 'unknown')
    if acc.get('last_check_status'):
        status = acc['last_check_status']

    return {
        'phone': phone,
        'username': acc.get('username', ''),
        'first_name': acc.get('first_name', ''),
        'last_name': acc.get('last_name', ''),
        'user_id': acc.get('id') or acc.get('user_id', ''),
        'is_premium': acc.get('is_premium', False),
        'spamblock': acc.get('spamblock', 'free'),
        'status': status,
        'last_connect': acc.get('last_connect_date', ''),
        'session_created': acc.get('session_created_date', ''),
        'app_version': acc.get('app_version', ''),
        'device': acc.get('device', '') or acc.get('device_model', ''),
        'device_model': acc.get('device_model', ''),
        'sdk': acc.get('sdk', ''),
        'lang_pack': acc.get('lang_pack', ''),
        'system_lang_pack': acc.get('system_lang_pack', ''),
        'register_time': acc.get('register_time', ''),
        'has_profile_pic': acc.get('has_profile_pic', False),
        'proxy': proxy_str.split(':')[0] + ':' + proxy_str.split(':')[1] if proxy_str else 'none',
        'twoFA': 'yes' if acc.get('twoFA') or acc.get('2FA') else 'no',
        'stats_spam_count': acc.get('stats_spam_count', 0),
        'stats_invites_count': acc.get('stats_invites_count', 0),
        'folder': acc.get('_folder', '.'),
        'avatar': get_avatar_url(phone),
        'last_check': acc.get('last_check_time', ''),
    }


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def build_check_params(acc):
    return {
        'session_path': acc['_session_path'],
        'api_id': acc['app_id'],
        'api_hash': acc['app_hash'],
        'proxy': get_proxy_for_account(acc['_index']),
        'device_model': acc.get('device_model', '') or acc.get('device', 'Unknown'),
        'system_version': acc.get('sdk', 'Unknown'),
        'app_version': acc.get('app_version', '1.0'),
        'lang_code': acc.get('lang_pack', 'en'),
        'system_lang_code': acc.get('system_lang_pack', 'en'),
        'avatar_dir': AVATAR_DIR,
        'phone': acc.get('phone', ''),
    }


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/accounts')
def api_accounts():
    valid, broken = scan_accounts()
    return jsonify({
        'accounts': [account_to_dict(a) for a in valid],
        'broken': broken,
    })


@app.route('/api/proxy/check', methods=['POST'])
def api_check_proxy():
    """Validate all proxies via sunrisetelegram.ru API."""
    proxies = load_proxies()
    if not proxies:
        return jsonify({'results': [], 'all_valid': True, 'message': 'No proxies configured'})

    results = []
    for proxy_line in proxies:
        result = validate_proxy(proxy_line)
        results.append(result)

    all_valid = all(r.get('valid') for r in results)
    return jsonify({'results': results, 'all_valid': all_valid})


def do_check_account(acc, force=False):
    """Check a single account: run Telethon, save result, move if needed."""
    phone = acc.get('phone', '')

    # Skip if checked recently (unless forced)
    if not force and should_skip_check(acc):
        return {
            'phone': phone,
            'status': acc.get('last_check_status', 'unknown'),
            'spambot': acc.get('last_check_spambot', 'unknown'),
            'avatar': get_avatar_url(phone),
            'skipped': True,
        }

    params = build_check_params(acc)
    result = run_async(check_account_status(**params))
    status = result['status']
    spambot = result.get('spambot', 'unknown')

    # Save result to JSON
    save_check_result(acc['_json_path'], status, spambot)

    # Only move accounts that are still in actual/
    moved = False
    if acc.get('_moveable', True):
        if status == 'dead':
            moved = move_account(acc, DEAD_DIR)
        elif status == 'frozen':
            moved = move_account(acc, FROZEN_DIR)

    return {
        'phone': phone,
        'status': status,
        'spambot': spambot,
        'avatar': get_avatar_url(phone),
        'moved': moved,
        'skipped': False,
    }


@app.route('/api/accounts/<phone>/check', methods=['POST'])
def api_check_account(phone):
    force = request.args.get('force', '0') == '1'
    valid, _ = scan_accounts()
    target = next((a for a in valid if a.get('phone') == phone), None)
    if not target:
        return jsonify({'error': 'Account not found'}), 404

    result = do_check_account(target, force=force)
    return jsonify(result)


@app.route('/api/accounts/check-all', methods=['POST'])
def api_check_all():
    """Check all accounts in parallel using thread pool."""
    force = request.args.get('force', '0') == '1'
    valid, _ = scan_accounts()
    results = []

    with ThreadPoolExecutor(max_workers=MAX_THREADS) as pool:
        futures = {pool.submit(do_check_account, acc, force): acc for acc in valid}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                acc = futures[future]
                results.append({
                    'phone': acc.get('phone', ''),
                    'status': 'unknown',
                    'spambot': 'unknown',
                    'avatar': '',
                    'error': str(e),
                })

    return jsonify(results)


def run_flask():
    """Run Flask in a background thread (no reloader)."""
    app.run(host='127.0.0.1', port=5000, debug=False, use_reloader=False)


if __name__ == '__main__':
    os.makedirs(ACCOUNTS_DIR, exist_ok=True)
    os.makedirs(FROZEN_DIR, exist_ok=True)
    os.makedirs(DEAD_DIR, exist_ok=True)
    os.makedirs(AVATAR_DIR, exist_ok=True)

    try:
        import webview
        # Start Flask in background thread
        t = threading.Thread(target=run_flask, daemon=True)
        t.start()
        # Open native window
        webview.create_window('Telepanel', 'http://127.0.0.1:5000', width=1280, height=800)
        webview.start()
    except ImportError:
        # Fallback: run Flask normally if pywebview not installed
        import webbrowser
        threading.Timer(1.0, lambda: webbrowser.open('http://127.0.0.1:5000')).start()
        app.run(host='127.0.0.1', port=5000, debug=True)
