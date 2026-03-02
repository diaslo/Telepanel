import os
import asyncio

import socks
import requests
from telethon import TelegramClient, errors


def parse_proxy(proxy_line: str) -> tuple | None:
    """Parse 'host:port:user:pass' into PySocks SOCKS5 tuple."""
    if not proxy_line or not proxy_line.strip():
        return None
    parts = proxy_line.strip().split(':')
    if len(parts) < 4:
        return None
    host = parts[0]
    port = int(parts[1])
    username = parts[2]
    password = parts[3]
    return (socks.SOCKS5, host, port, True, username, password)


def parse_proxy_dict(proxy_line: str) -> dict | None:
    """Parse 'host:port:user:pass' into a dict."""
    if not proxy_line or not proxy_line.strip():
        return None
    parts = proxy_line.strip().split(':')
    if len(parts) < 4:
        return None
    return {
        'ip': parts[0],
        'port': parts[1],
        'username': parts[2],
        'password': parts[3],
    }


def validate_proxy(proxy_line: str) -> dict:
    """
    Validate a proxy via sunrisetelegram.ru API.
    Returns dict with 'valid', 'time', 'external_ip', 'country'.
    """
    p = parse_proxy_dict(proxy_line)
    if not p:
        return {'valid': False, 'error': 'invalid format'}

    url = "https://sunrisetelegram.ru/tools/system/proxy_checker.php"
    data = {
        'ip': p['ip'],
        'port': p['port'],
        'login': p['username'],
        'password': p['password'],
        'type': 'socks5',
    }
    try:
        resp = requests.post(url, data=data, timeout=20)
        resp.raise_for_status()
        result = resp.json()
        return {
            'valid': result.get('success', False),
            'time': result.get('time', 0),
            'external_ip': result.get('external_ip', ''),
            'country': result.get('country', ''),
            'country_code': result.get('country_code', ''),
            'proxy': f"{p['ip']}:{p['port']}",
        }
    except Exception as e:
        return {'valid': False, 'error': str(e), 'proxy': f"{p['ip']}:{p['port']}"}


async def check_spambot(client: TelegramClient, phone: str) -> str:
    """
    Check account via SpamBot.
    Returns: 'free', 'spamblock', 'frozen'
    """
    try:
        entity = await client.get_entity("SpamBot")
        await client.send_message(entity, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(entity, limit=1)

        if messages and messages[0]:
            text = messages[0].message.lower()

            ok_phrases = [
                "свободен от каких-либо ограничений",
                "no limits are currently applied",
                "free as a bird",
                "good news",
            ]
            frozen_phrases = [
                "your account was blocked",
                "ваш аккаунт был заблокирован",
            ]
            limited_phrases = [
                "ограничен по ошибке",
                "limited until",
                "ваш аккаунт ограничен",
                "you're temporarily banned",
                "account is currently limited",
                "ограничения",
            ]

            if any(phrase in text for phrase in ok_phrases):
                return 'free'
            elif any(phrase in text for phrase in frozen_phrases):
                return 'frozen'
            elif any(phrase in text for phrase in limited_phrases):
                return 'spamblock'
            else:
                return 'spamblock'

        return 'free'
    except Exception as e:
        print(f'[checker] SpamBot check failed for {phone}: {e}')
        return 'unknown'


async def check_account_status(
    session_path: str,
    api_id: int,
    api_hash: str,
    proxy: tuple | None = None,
    device_model: str = 'Unknown',
    system_version: str = 'Unknown',
    app_version: str = '1.0',
    lang_code: str = 'en',
    system_lang_code: str = 'en',
    avatar_dir: str | None = None,
    phone: str = '',
) -> dict:
    """
    Connect to Telegram using the session file and determine account status.
    Also checks SpamBot and downloads profile photo.

    Returns dict: {'status': str, 'spambot': str, 'avatar_downloaded': bool}
    """
    client = TelegramClient(
        session=session_path,
        api_id=api_id,
        api_hash=api_hash,
        device_model=device_model,
        system_version=system_version,
        app_version=app_version,
        lang_code=lang_code,
        system_lang_code=system_lang_code,
    )
    client.set_proxy(proxy)

    result = {'status': 'unknown', 'spambot': 'unknown', 'avatar_downloaded': False}

    try:
        await client.connect()

        if not await client.is_user_authorized():
            result['status'] = 'dead'
            return result

        me = await client.get_me()
        if me is None:
            result['status'] = 'dead'
            return result

        if me.restricted:
            result['status'] = 'frozen'
        else:
            result['status'] = 'active'

        # Check SpamBot for spamblock status
        if result['status'] == 'active':
            spambot_status = await check_spambot(client, phone)
            result['spambot'] = spambot_status
            if spambot_status == 'frozen':
                result['status'] = 'frozen'
            elif spambot_status == 'spamblock':
                result['status'] = 'spamblock'

        # Download profile photo
        if avatar_dir and phone and me.photo:
            try:
                photo_path = os.path.join(avatar_dir, f'{phone}.jpg')
                await client.download_profile_photo(me, file=photo_path)
                if os.path.exists(photo_path):
                    result['avatar_downloaded'] = True
            except Exception as e:
                print(f'[checker] Avatar download failed for {phone}: {e}')

        return result

    except (
        errors.UserDeactivatedError,
        errors.UserDeactivatedBanError,
        errors.PhoneNumberBannedError,
        errors.AuthKeyUnregisteredError,
        errors.AuthKeyInvalidError,
        errors.UnauthorizedError,
    ):
        result['status'] = 'dead'
        return result
    except (ConnectionError, OSError):
        return result
    except Exception as e:
        print(f'[checker] Error for {session_path}: {type(e).__name__}: {e}')
        return result
    finally:
        await client.disconnect()
