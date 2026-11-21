import os
import re
import io
import time
import uuid
import json
import base64
import hmac
import hashlib
import asyncio
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
import requests
import httpx
from user_agent import generate_user_agent
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.helpers import escape_markdown
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes
)

# @FF_MZ
BOT_TOKEN = "xxxxxxxxxxxxx"
ACCOUNTS_FILE = "qwen_accounts.json"
TEMP_API_URL = "https://api.internal.temp-mail.io/api/v3"
BASE_QWEN_URL = "https://chat.qwen.ai/api/v2"

CANCEL_EVENTS = {}

def get_base_headers(content_type: str = "application/json", is_app: bool = True) -> dict:
    headers = {}
    if is_app:
        headers['User-Agent'] = "Dalvik/2.1.0 (Linux; U; Android 16; CPH2631 Build/BP2A.250605.015) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite"
    else:
        headers['User-Agent'] = generate_user_agent()
    
    if content_type:
        headers['Content-Type'] = content_type
    return headers

def load_accounts_data() -> dict:
    if os.path.exists(ACCOUNTS_FILE):
        try:
            with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"accounts": [], "active_image_index": -1, "active_video_index": -1}

def save_accounts_data(data: dict):
    with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def is_rate_limited_response(response_obj) -> bool:
    if isinstance(response_obj, dict):
        if response_obj.get("code") == "RateLimited" or response_obj.get("data", {}).get("code") == "RateLimited":
            return True
        if "RateLimited" in json.dumps(response_obj):
            return True
    elif isinstance(response_obj, str):
        if "RateLimited" in response_obj:
            return True
    return False

def create_temp_email() -> str:
    try:
        r = requests.post(
            f"{TEMP_API_URL}/email/new",
            headers=get_base_headers(is_app=False),
            json={"min_name_length": 10, "max_name_length": 10},
            timeout=15
        )
        if r.ok:
            return r.json().get("email")
    except Exception:
        pass
    return None

def signup_qwen(email: str, name: str, password: str) -> bool:
    url = f"{BASE_QWEN_URL}/auths/signup"
    headers = get_base_headers()
    payload = {
        "name": name,
        "email": email,
        "password": password,
        "profile_image_url": "",
        "oauth_sub": "",
        "oauth_token": ""
    }
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=15)
        return r.status_code in [200, 201]
    except Exception:
        return False

def get_activation_link(email: str, max_attempts=8, delay=3) -> str:
    ua = generate_user_agent()
    for _ in range(max_attempts):
        try:
            r = requests.get(f"{TEMP_API_URL}/email/{email}/messages", headers={"User-Agent": ua}, timeout=10)
            if r.ok:
                for m in r.json():
                    body = m.get("body_text") or m.get("body_html") or m.get("body") or ""
                    match = re.search(r'https://chat\.qwen\.ai/api/v1/auths/activate\?[^\s\)\"\']+', body)
                    if match:
                        return match.group(0)
        except Exception:
            pass
        time.sleep(delay)
    return None

def activate_account(activation_url: str) -> bool:
    try:
        r = requests.get(activation_url, headers=get_base_headers(content_type=None, is_app=False), timeout=15)
        return r.status_code in [200, 201]
    except Exception:
        return False

# @FF_MZ
def signin_qwen(email: str, password: str) -> str:
    url = f"{BASE_QWEN_URL}/auths/signin"
    headers = get_base_headers()
    payload = {"email": email, "password": password}
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=15)
        if r.ok:
            data = r.json()
            if data.get("success") and "data" in data:
                return data["data"].get("token")
    except Exception:
        pass
    return None

def create_and_save_new_account() -> str:
    password = "899409576f885e962bb8aecc95ed24efc9b46a0872fdd8e79ed1d6fd72aeb358"
    name = "User_" + uuid.uuid4().hex[:6]

    for attempt in range(5):
        email = create_temp_email()
        if not email:
            continue
        
        if not signup_qwen(email, name, password):
            continue
            
        act_link = get_activation_link(email)
        if not act_link:
            continue
            
        if activate_account(act_link):
            token = signin_qwen(email, password)
            if token:
                data = load_accounts_data()
                new_acc = {
                    "email": email,
                    "password": password,
                    "token": token,
                    "image_limit_until": 0,
                    "video_limit_until": 0
                }
                data["accounts"].append(new_acc)
                data["active_image_index"] = len(data["accounts"]) - 1
                data["active_video_index"] = len(data["accounts"]) - 1
                save_accounts_data(data)
                return token
    raise Exception("فشل إنشاء حساب جديد بعد عدة محاولات.")

def get_valid_qwen_token(service_type: str = "image") -> str:
    data = load_accounts_data()
    now_ts = int(time.time())
    limit_key = "image_limit_until" if service_type == "image" else "video_limit_until"
    active_key = "active_image_index" if service_type == "image" else "active_video_index"

    for idx, acc in enumerate(data["accounts"]):
        if acc.get(limit_key, 0) <= now_ts:
            data[active_key] = idx
            save_accounts_data(data)
            return acc["token"]

    return create_and_save_new_account()

def mark_account_rate_limited(service_type: str = "image"):
    data = load_accounts_data()
    limit_key = "image_limit_until" if service_type == "image" else "video_limit_until"
    active_key = "active_image_index" if service_type == "image" else "active_video_index"
    
    active_idx = data.get(active_key, -1)
    if 0 <= active_idx < len(data["accounts"]):
        unban_time = int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp())
        data["accounts"][active_idx][limit_key] = unban_time
        data[active_key] = -1
        save_accounts_data(data)

def get_qwen_headers(service_type: str = "image") -> dict:
    token = get_valid_qwen_token(service_type)
    headers = get_base_headers(content_type="application/json; charset=UTF-8")
    headers.update({
        'Accept': "*/*,text/event-stream" if service_type == "image" else "application/json",
        'Authorization': f"Bearer {token}",
        'x-device-id': "0",
        'source': "app",
        'Accept-Language': "en-US",
        'Cookie': f"x-ap=eu-central-1; token={token}"
    })
    return headers

def generate_oss_signature(secret_key, method, content_md5, content_type, date, canonical_headers, canonical_resource):
    string_to_sign = f"{method}\n{content_md5}\n{content_type}\n{date}\n{canonical_headers}{canonical_resource}"
    h = hmac.new(secret_key.encode('utf-8'), string_to_sign.encode('utf-8'), hashlib.sha1)
    return base64.b64encode(h.digest()).decode('utf-8')

# @FF_MZ
def upload_image_to_qwen_oss(photo_bytes: bytes, service_type: str = "image") -> dict:
    file_size = str(len(photo_bytes))
    filename = f"{uuid.uuid4()}_IMG.jpg"

    sts_url = "https://chat.qwen.ai/api/v2/files/getstsToken"
    payload = {"filename": filename, "filetype": "image", "filesize": file_size}
    headers = get_qwen_headers(service_type)
    headers['x-request-id'] = str(uuid.uuid4())
    
    res = requests.post(sts_url, json=payload, headers=headers).json()
    if is_rate_limited_response(res):
        mark_account_rate_limited(service_type)
        return upload_image_to_qwen_oss(photo_bytes, service_type)
        
    if "data" not in res:
        raise Exception(f"فشل تصريح الرفع:\n{json.dumps(res, ensure_ascii=False)}")
    
    sts_res = res["data"]
    access_key_id = sts_res["access_key_id"]
    access_key_secret = sts_res["access_key_secret"]
    security_token = sts_res["security_token"]
    file_path = sts_res["file_path"]
    file_id = sts_res["file_id"]
    bucket = sts_res["bucketname"]
    host = f"{bucket}.{sts_res['endpoint']}"

    init_url = f"https://{host}/{file_path}?uploads"
    gmt_date = datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')
    canon_headers = f"x-oss-security-token:{security_token}\n"
    canon_resource = f"/{bucket}/{file_path}?uploads"
    
    sig = generate_oss_signature(access_key_secret, "POST", "", "image/jpeg", gmt_date, canon_headers, canon_resource)
    init_headers = {
        'Authorization': f'OSS {access_key_id}:{sig}',
        'User-Agent': 'aliyun-sdk-android/2.9.21',
        'Host': host,
        'x-oss-security-token': security_token,
        'Date': gmt_date,
        'Content-Type': 'image/jpeg',
        'Content-Length': '0'
    }
    init_res = requests.post(init_url, headers=init_headers)
    root = ET.fromstring(init_res.text)
    upload_id = root.find('{*}UploadId').text

    part_url = f"https://{host}/{file_path}?uploadId={upload_id}&partNumber=1"
    gmt_date = datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')
    content_md5 = base64.b64encode(hashlib.md5(photo_bytes).digest()).decode('utf-8')
    canon_resource = f"/{bucket}/{file_path}?partNumber=1&uploadId={upload_id}"
    
    sig = generate_oss_signature(access_key_secret, "PUT", content_md5, "image/jpeg", gmt_date, canon_headers, canon_resource)
    part_headers = {
        'Authorization': f'OSS {access_key_id}:{sig}',
        'User-Agent': 'aliyun-sdk-android/2.9.21',
        'Host': host,
        'x-oss-security-token': security_token,
        'Date': gmt_date,
        'Content-MD5': content_md5,
        'Content-Type': 'image/jpeg',
        'Content-Length': file_size
    }
    part_res = requests.put(part_url, data=photo_bytes, headers=part_headers)
    etag = part_res.headers.get("ETag", "").replace('"', '')

    complete_url = f"https://{host}/{file_path}?uploadId={upload_id}"
    gmt_date = datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')
    complete_body = f"<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{etag}</ETag></Part></CompleteMultipartUpload>"
    canon_resource = f"/{bucket}/{file_path}?uploadId={upload_id}"
    
    sig = generate_oss_signature(access_key_secret, "POST", "", "image/jpeg", gmt_date, canon_headers, canon_resource)
    complete_headers = {
        'Authorization': f'OSS {access_key_id}:{sig}',
        'User-Agent': 'aliyun-sdk-android/2.9.21',
        'Host': host,
        'x-oss-security-token': security_token,
        'Date': gmt_date,
        'Content-Type': 'image/jpeg',
        'Content-Length': str(len(complete_body))
    }
    requests.post(complete_url, data=complete_body, headers=complete_headers)

    signed_url = sts_res.get("file_url", f"https://{host}/{file_path}")
    return {
        "type": "image",
        "file": {
            "data": {},
            "filename": filename,
            "id": file_id,
            "meta": {"name": filename}
        },
        "id": file_id,
        "filename": filename,
        "name": filename,
        "url": signed_url
    }

def create_new_chat(service_type: str = "image") -> str:
    url = "https://chat.qwen.ai/api/v2/chats/new"
    payload = {"chat_mode": "normal", "project_id": ""}
    headers = get_qwen_headers(service_type)
    headers['x-request-id'] = str(uuid.uuid4())
    
    res = requests.post(url, json=payload, headers=headers).json()
    if is_rate_limited_response(res):
        mark_account_rate_limited(service_type)
        return create_new_chat(service_type)
        
    if "data" not in res:
        raise Exception(f"فشل إنشاء المحادثة:\n{json.dumps(res, ensure_ascii=False)}")
    return res["data"]["id"]

def delete_chat(chat_id: str, service_type: str = "image") -> bool:
    if not chat_id:
        return False
    url = f"https://chat.qwen.ai/api/v2/chats/{chat_id}"
    headers = get_qwen_headers(service_type)
    headers['x-request-id'] = str(uuid.uuid4())
    headers['Content-Type'] = "application/x-www-form-urlencoded"
    try:
        r = requests.delete(url, headers=headers, timeout=15)
        return r.status_code in [200, 204]
    except Exception:
        return False

# @FF_MZ
def generate_qwen_image(prompt: str, chat_id: str, uploaded_files: list = None) -> str:
    url = f"https://chat.qwen.ai/api/v2/chat/completions?chat_id={chat_id}"
    headers = get_qwen_headers("image")
    headers['x-request-id'] = str(uuid.uuid4())

    files_payload = []
    if uploaded_files:
        for item in uploaded_files:
            files_payload.append({
                "type": "image",
                "file": {
                    "data": {},
                    "filename": item["filename"],
                    "id": item["id"],
                    "meta": {"name": item["filename"]}
                },
                "id": item["id"],
                "url": item["url"],
                "name": item["filename"],
                "image_width": 1024,
                "image_height": 1024
            })

    now_ts = int(time.time())
    message_data = {
        "chat_type": "t2i",
        "content": prompt if prompt else "",
        "role": "user",
        "feature_config": {
            "output_schema": "phase",
            "thinking_enabled": False,
            "thinking_format": "summary",
            "auto_thinking": True,
            "auto_search": True
        },
        "timestamp": now_ts,
        "sub_chat_type": "t2i",
        "models": ["qwen3.8-max"],
        "user_action": "chat",
        "extra": {"meta": {"subChatType": "t2i"}}
    }
    
    if files_payload:
        message_data["files"] = files_payload

    payload = {
        "stream": True,
        "incremental_output": True,
        "chat_id": chat_id,
        "chat_mode": "normal",
        "model": "qwen3.8-max",
        "messages": [message_data],
        "timestamp": now_ts,
        "size": "16:9",
        "share_id": "",
        "version": "2.1",
        "origin_branch_message_id": ""
    }

    response = requests.post(url, json=payload, headers=headers, stream=True, timeout=120)
    image_url = None

    for line in response.iter_lines():
        if not line:
            continue
        line_str = line.decode('utf-8')

        if is_rate_limited_response(line_str):
            mark_account_rate_limited("image")
            new_chat_id = create_new_chat("image")
            return generate_qwen_image(prompt, new_chat_id, uploaded_files)

        if line_str.startswith("data: "):
            data_content = line_str[6:].strip()
            if data_content == "[DONE]":
                break
            try:
                data_json = json.loads(data_content)
                if is_rate_limited_response(data_json):
                    mark_account_rate_limited("image")
                    new_chat_id = create_new_chat("image")
                    return generate_qwen_image(prompt, new_chat_id, uploaded_files)

                if "choices" in data_json and len(data_json["choices"]) > 0:
                    delta = data_json["choices"][0].get("delta", {})
                    content = delta.get("content", "")
                    if content.startswith("http"):
                        image_url = content
            except json.JSONDecodeError:
                continue

    return image_url

async def send_video_request(chat_id: str, prompt_text: str, image_obj=None):
    url = "https://chat.qwen.ai/api/v2/chat/completions"
    current_ts = int(time.time())
    sub_type = "i2v" if image_obj else "t2v"
    
    message_content = {
        "chat_type": sub_type,
        "content": prompt_text,
        "role": "user",
        "feature_config": {
            "output_schema": "phase",
            "thinking_enabled": True,
            "thinking_format": "summary",
            "auto_thinking": True,
            "auto_search": True
        },
        "timestamp": current_ts,
        "sub_chat_type": sub_type,
        "models": ["qwen3.8-max"],
        "user_action": "chat",
        "extra": {"meta": {"subChatType": sub_type}}
    }

    if image_obj:
        message_content["files"] = [image_obj]

    payload = {
        "stream": False,
        "incremental_output": True,
        "chat_id": chat_id,
        "chat_mode": "normal",
        "model": "qwen3.8-max",
        "messages": [message_content],
        "timestamp": current_ts,
        "size": "16:9",
        "share_id": "",
        "version": "2.1",
        "origin_branch_message_id": ""
    }

    headers = await asyncio.to_thread(get_qwen_headers, "video")
    async with httpx.AsyncClient(timeout=45.0) as client:
        res = await client.post(url, params={'chat_id': chat_id}, json=payload, headers=headers)
        res_json = res.json()
        
        if is_rate_limited_response(res_json):
            await asyncio.to_thread(mark_account_rate_limited, "video")
            new_chat_id = await asyncio.to_thread(create_new_chat, "video")
            return await send_video_request(new_chat_id, prompt_text, image_obj)

    messages = res_json.get("data", {}).get("messages", [])
    if messages and "extra" in messages[0]:
        task_id = messages[0]["extra"].get("wanx", {}).get("task_id")
        if task_id:
            return task_id
            
    raise Exception("لم يتم العثور على task_id الخاص بتوليد الفيديو.")

def extract_video_url(data):
    if isinstance(data, str) and data.startswith("http") and (".mp4" in data or "aliyun" in data or "cdn.qwenlm.ai" in data):
        return data
    if isinstance(data, dict):
        if data.get("status") in ["FAILED", "ERROR", "CANCELED"]:
            raise Exception(f"فشلت عملية توليد الفيديو: {data.get('error_message', 'خطأ غير معروف')}")
        for k in ["url", "video_url", "file_url"]:
            if k in data and isinstance(data[k], str) and data[k].startswith("http"):
                return data[k]
        for v in data.values():
            res = extract_video_url(v)
            if res: return res
    elif isinstance(data, list):
        for item in data:
            res = extract_video_url(item)
            if res: return res
    return None

# @FF_MZ
async def poll_for_video(task_id, cancel_event: asyncio.Event = None, max_attempts=90):
    url = f"https://chat.qwen.ai/api/v1/tasks/status/{task_id}"
    headers = await asyncio.to_thread(get_qwen_headers, "video")
    
    async with httpx.AsyncClient(timeout=20.0) as client:
        for _ in range(max_attempts):
            if cancel_event and cancel_event.is_set():
                raise asyncio.CancelledError("تم إلغاء العمليه بواسطة المستخدم.")
                
            await asyncio.sleep(10)
            try:
                res = await client.get(url, headers=headers)
                if res.status_code != 200:
                    continue
                
                res_data = res.json()
                if is_rate_limited_response(res_data):
                    await asyncio.to_thread(mark_account_rate_limited, "video")
                    headers = await asyncio.to_thread(get_qwen_headers, "video")
                    continue

                if res_data.get("success") is False:
                    raise Exception(f"فشل الطلب: {res_data.get('message', 'خطأ غير معروف')}")
                    
                video_url = extract_video_url(res_data)
                if video_url:
                    return video_url
            except httpx.HTTPError:
                pass
            except Exception as e:
                raise e
    raise Exception("انتهت مهلة التوليد ولم يكتمل الفيديو.")

def download_file_bytes(url: str, is_video: bool = False) -> bytes:
    headers = get_base_headers(content_type=None)
    headers['Referer'] = 'https://chat.qwen.ai/'
    res = requests.get(url, headers=headers, timeout=120 if is_video else 60)
    res.raise_for_status()
    return res.content

async def send_result_photo(message_obj, photo_url: str):
    try:
        await message_obj.reply_photo(photo=photo_url)
    except Exception:
        img_bytes = await asyncio.to_thread(download_file_bytes, photo_url, False)
        await message_obj.reply_photo(photo=io.BytesIO(img_bytes))

async def send_result_video(message_obj, video_url: str):
    try:
        await message_obj.reply_video(video=video_url)
    except Exception:
        video_bytes = await asyncio.to_thread(download_file_bytes, video_url, True)
        await message_obj.reply_video(video=io.BytesIO(video_bytes))

async def update_timer_status(status_msg, start_time: float, stop_event: asyncio.Event, target_seconds: int = 60, process_id: str = None):
    spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    idx = 0
    bar_length = 10
    
    reply_markup = None
    if process_id:
        keyboard = [[InlineKeyboardButton("🚫 إيقاف العملية", callback_data=f"cancel_{process_id}")]]
        reply_markup = InlineKeyboardMarkup(keyboard)
    
    while not stop_event.is_set():
        elapsed = int(time.time() - start_time)
        mins, secs = divmod(elapsed, 60)
        time_str = f"{mins:02d}:{secs:02d}"
        
        progress = min(elapsed / target_seconds, 1.0)
        filled = int(bar_length * progress)
        bar = "█" * filled + "░" * (bar_length - filled)
        spin = spinner[idx % len(spinner)]
        
        text = f"{spin} **جاري المعالجة...**\n`{time_str}` `[{bar}]`"
        try:
            await status_msg.edit_text(text, parse_mode="Markdown", reply_markup=reply_markup)
        except Exception:
            pass
            
        idx += 1
        await asyncio.sleep(2)

# @FF_MZ
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if "mode" not in context.user_data:
        context.user_data["mode"] = "image"

    keyboard = [
        [
            InlineKeyboardButton("🖼️ إنشاء صورة", callback_data="set_mode_image"),
            InlineKeyboardButton("🎬 إنشاء فيديو", callback_data="set_mode_video"),
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    current_mode_str = "🖼️ إنشاء صورة" if context.user_data["mode"] == "image" else "🎬 إنشاء فيديو"

    raw_text = (
        f"👋 اهلا بيك\n\n"
        f"الوضع الحالي المختار: {current_mode_str}\n\n"
        f"يرجى تحديد الخيار المطلوب من الأزرار أدناه:\n\n"
        f"تمت الانشاء بواسطة @FF_MZ"
    )
    
    safe_text = escape_markdown(raw_text, version=2)

    await update.message.reply_text(
        safe_text,
        reply_markup=reply_markup,
        parse_mode="MarkdownV2"
    )

async def button_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.data.startswith("cancel_"):
        proc_id = query.data.replace("cancel_", "")
        if proc_id in CANCEL_EVENTS:
            CANCEL_EVENTS[proc_id].set()
            await query.edit_message_text("🛑 تم إلغاء العملية بناءً على طلبك.")
        return

    if query.data == "set_mode_image":
        context.user_data["mode"] = "image"
        txt = "✅ تم تحديد الوضع: 🖼️ إنشاء صورة\n\n• أرسل نصاً لوصف الصورة المطلوب إنشاءها.\n• أو أرسل حتى 3 صور مع الوصف النصي للتعديل عليها."
        await query.edit_message_text(escape_markdown(txt, version=2), parse_mode="MarkdownV2")
    elif query.data == "set_mode_video":
        context.user_data["mode"] = "video"
        txt = "✅ تم تحديد الوضع: 🎬 إنشاء فيديو\n\n• أرسل نصاً لوصف الفيديو المطلوب (Text-to-Video).\n• أو أرسل صورة واحدة كحد أقصى مع الوصف لتحريكها (Image-to-Video)."
        await query.edit_message_text(escape_markdown(txt, version=2), parse_mode="MarkdownV2")

async def task_generate_image_text(message_obj, prompt: str):
    process_id = uuid.uuid4().hex[:8]
    cancel_event = asyncio.Event()
    CANCEL_EVENTS[process_id] = cancel_event

    start_time = time.time()
    status_msg = await message_obj.reply_text("⠋ **جاري التجهيز...**", parse_mode="Markdown")
    stop_event = asyncio.Event()
    timer_task = asyncio.create_task(update_timer_status(status_msg, start_time, stop_event, target_seconds=30, process_id=process_id))
    
    chat_id = None
    try:
        chat_id = await asyncio.to_thread(create_new_chat, "image")
        if cancel_event.is_set(): raise asyncio.CancelledError()

        img_url = await asyncio.to_thread(generate_qwen_image, prompt, chat_id)
        if cancel_event.is_set(): raise asyncio.CancelledError()

        stop_event.set()
        await timer_task
        
        if img_url:
            await send_result_photo(message_obj, img_url)
            await status_msg.delete()
        else:
            await status_msg.edit_text("تعذر استخراج رابط الصورة.")
    except asyncio.CancelledError:
        stop_event.set()
        await timer_task
    except Exception as e:
        stop_event.set()
        await timer_task
        await status_msg.edit_text(escape_markdown(f"حدث خطأ: {str(e)}", version=2), parse_mode="MarkdownV2")
    finally:
        CANCEL_EVENTS.pop(process_id, None)
        if chat_id:
            await asyncio.to_thread(delete_chat, chat_id, "image")

# @FF_MZ
async def task_generate_video_text(message_obj, prompt: str):
    process_id = uuid.uuid4().hex[:8]
    cancel_event = asyncio.Event()
    CANCEL_EVENTS[process_id] = cancel_event

    start_time = time.time()
    status_msg = await message_obj.reply_text("⠋ **جاري التجهيز...**", parse_mode="Markdown")
    stop_event = asyncio.Event()
    timer_task = asyncio.create_task(update_timer_status(status_msg, start_time, stop_event, target_seconds=90, process_id=process_id))
    
    chat_id = None
    try:
        chat_id = await asyncio.to_thread(create_new_chat, "video")
        if cancel_event.is_set(): raise asyncio.CancelledError()

        task_id = await send_video_request(chat_id, prompt)
        if cancel_event.is_set(): raise asyncio.CancelledError()

        video_url = await poll_for_video(task_id, cancel_event=cancel_event)
        
        stop_event.set()
        await timer_task
        
        await send_result_video(message_obj, video_url)
        await status_msg.delete()
    except asyncio.CancelledError:
        stop_event.set()
        await timer_task
    except Exception as e:
        stop_event.set()
        await timer_task
        await status_msg.edit_text(escape_markdown(f"❌ حدث خطأ أثناء توليد الفيديو:\n{str(e)}", version=2), parse_mode="MarkdownV2")
    finally:
        CANCEL_EVENTS.pop(process_id, None)
        if chat_id:
            await asyncio.to_thread(delete_chat, chat_id, "video")

async def handle_text_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE):
    mode = context.user_data.get("mode", "image")
    prompt = update.message.text

    if mode == "image":
        asyncio.create_task(task_generate_image_text(update.message, prompt))
    else:
        asyncio.create_task(task_generate_video_text(update.message, prompt))

async def task_process_single_photo_image(message_obj, photo_bytes: bytes, caption: str):
    process_id = uuid.uuid4().hex[:8]
    cancel_event = asyncio.Event()
    CANCEL_EVENTS[process_id] = cancel_event

    start_time = time.time()
    status_msg = await message_obj.reply_text("⠋ **جاري المعالجة...**", parse_mode="Markdown")
    stop_event = asyncio.Event()
    timer_task = asyncio.create_task(update_timer_status(status_msg, start_time, stop_event, target_seconds=30, process_id=process_id))
    
    chat_id = None
    try:
        uploaded = await asyncio.to_thread(upload_image_to_qwen_oss, photo_bytes, "image")
        if cancel_event.is_set(): raise asyncio.CancelledError()

        chat_id = await asyncio.to_thread(create_new_chat, "image")
        if cancel_event.is_set(): raise asyncio.CancelledError()

        img_url = await asyncio.to_thread(generate_qwen_image, caption, chat_id, [uploaded])
        if cancel_event.is_set(): raise asyncio.CancelledError()

        stop_event.set()
        await timer_task
        
        if img_url:
            await send_result_photo(message_obj, img_url)
            await status_msg.delete()
        else:
            await status_msg.edit_text("لم يتم إرجاع رابط الصورة.")
    except asyncio.CancelledError:
        stop_event.set()
        await timer_task
    except Exception as e:
        stop_event.set()
        await timer_task
        await status_msg.edit_text(escape_markdown(f"حدث خطأ أثناء المعالجة: {str(e)}", version=2), parse_mode="MarkdownV2")
    finally:
        CANCEL_EVENTS.pop(process_id, None)
        if chat_id:
            await asyncio.to_thread(delete_chat, chat_id, "image")

# @FF_MZ
async def task_process_single_photo_video(message_obj, photo_bytes: bytes, caption: str):
    process_id = uuid.uuid4().hex[:8]
    cancel_event = asyncio.Event()
    CANCEL_EVENTS[process_id] = cancel_event

    start_time = time.time()
    status_msg = await message_obj.reply_text("⠋ **جاري المعالجة...**", parse_mode="Markdown")
    stop_event = asyncio.Event()
    timer_task = asyncio.create_task(update_timer_status(status_msg, start_time, stop_event, target_seconds=110, process_id=process_id))
    
    chat_id = None
    try:
        image_obj = await asyncio.to_thread(upload_image_to_qwen_oss, photo_bytes, "video")
        if cancel_event.is_set(): raise asyncio.CancelledError()

        chat_id = await asyncio.to_thread(create_new_chat, "video")
        if cancel_event.is_set(): raise asyncio.CancelledError()

        task_id = await send_video_request(chat_id, caption, image_obj)
        if cancel_event.is_set(): raise asyncio.CancelledError()

        video_url = await poll_for_video(task_id, cancel_event=cancel_event)
        
        stop_event.set()
        await timer_task
        
        await send_result_video(message_obj, video_url)
        await status_msg.delete()
    except asyncio.CancelledError:
        stop_event.set()
        await timer_task
    except Exception as e:
        stop_event.set()
        await timer_task
        await status_msg.edit_text(escape_markdown(f"❌ حدث خطأ أثناء المعالجة: {str(e)}", version=2), parse_mode="MarkdownV2")
    finally:
        CANCEL_EVENTS.pop(process_id, None)
        if chat_id:
            await asyncio.to_thread(delete_chat, chat_id, "video")

async def handle_photo_media_group(update: Update, context: ContextTypes.DEFAULT_TYPE):
    mode = context.user_data.get("mode", "image")
    media_group_id = update.message.media_group_id

    if mode == "video" and media_group_id:
        await update.message.reply_text("⚠️ في وضع توليد الفيديو يُسمح بإرسال صورة واحدة فقط كحد أقصى لتحريكها.")
        return

    if media_group_id:
        if "album_store" not in context.bot_data:
            context.bot_data["album_store"] = {}
            
        if media_group_id not in context.bot_data["album_store"]:
            context.bot_data["album_store"][media_group_id] = {
                "messages": [],
                "task": None
            }
            
        context.bot_data["album_store"][media_group_id]["messages"].append(update.message)
        
        if context.bot_data["album_store"][media_group_id]["task"]:
            context.bot_data["album_store"][media_group_id]["task"].schedule_removal()
            
        context.bot_data["album_store"][media_group_id]["task"] = context.job_queue.run_once(
            process_album_images_job, 1.5, data={"media_group_id": media_group_id, "chat_id": update.effective_chat.id}
        )
    else:
        photo_file = await update.message.photo[-1].get_file()
        photo_bytes = bytes(await photo_file.download_as_bytearray())
        caption = update.message.caption or ""

        if mode == "image":
            asyncio.create_task(task_process_single_photo_image(update.message, photo_bytes, caption))
        else:
            asyncio.create_task(task_process_single_photo_video(update.message, photo_bytes, caption))

async def task_process_album_images(context, chat_id: int, messages: list):
    process_id = uuid.uuid4().hex[:8]
    cancel_event = asyncio.Event()
    CANCEL_EVENTS[process_id] = cancel_event

    start_time = time.time()
    status_msg = await context.bot.send_message(chat_id=chat_id, text="⠋ **جاري المعالجة...**", parse_mode="Markdown")
    stop_event = asyncio.Event()
    timer_task = asyncio.create_task(update_timer_status(status_msg, start_time, stop_event, target_seconds=45, process_id=process_id))
    
    caption = ""
    qwen_chat_id = None
    for msg in messages:
        if msg.caption:
            caption = msg.caption
            break
            
    try:
        uploaded_files = []
        for msg in messages[:3]:
            if cancel_event.is_set(): raise asyncio.CancelledError()
            photo_file = await msg.photo[-1].get_file()
            photo_bytes = bytes(await photo_file.download_as_bytearray())
            uploaded = await asyncio.to_thread(upload_image_to_qwen_oss, photo_bytes, "image")
            uploaded_files.append(uploaded)

        if cancel_event.is_set(): raise asyncio.CancelledError()
        qwen_chat_id = await asyncio.to_thread(create_new_chat, "image")

        if cancel_event.is_set(): raise asyncio.CancelledError()
        img_url = await asyncio.to_thread(generate_qwen_image, caption, qwen_chat_id, uploaded_files)
        
        stop_event.set()
        await timer_task
        
        if img_url:
            await send_result_photo(status_msg, img_url)
            await status_msg.delete()
        else:
            await status_msg.edit_text("لم يتم إرجاع رابط الصورة.")
    except asyncio.CancelledError:
        stop_event.set()
        await timer_task
    except Exception as e:
        stop_event.set()
        await timer_task
        await status_msg.edit_text(escape_markdown(f"حدث خطأ أثناء المعالجة: {str(e)}", version=2), parse_mode="MarkdownV2")
    finally:
        CANCEL_EVENTS.pop(process_id, None)
        if qwen_chat_id:
            await asyncio.to_thread(delete_chat, qwen_chat_id, "image")

async def process_album_images_job(context: ContextTypes.DEFAULT_TYPE):
    job_data = context.job.data
    media_group_id = job_data["media_group_id"]
    chat_id = job_data["chat_id"]
    
    album_info = context.bot_data["album_store"].pop(media_group_id, None)
    if not album_info:
        return

    asyncio.create_task(task_process_album_images(context, chat_id, album_info["messages"]))

async def global_error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    pass

# @FF_MZ
def main():
    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .read_timeout(300)
        .write_timeout(300)
        .connect_timeout(300)
        .pool_timeout(300)
        .build()
    )
    
    app.add_error_handler(global_error_handler)
    
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CallbackQueryHandler(button_callback_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text_prompt))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo_media_group))
    
    app.run_polling()

if __name__ == "__main__":
    main()
