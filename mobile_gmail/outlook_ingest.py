import base64
import html
import json
import logging
import os
import re
import sqlite3
import time
import webbrowser
from datetime import datetime, timezone
from email.utils import parseaddr
from typing import Dict, List, Optional, Tuple

import requests
from dateparser.search import search_dates
from flask import Flask, Response, jsonify, request


logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)
app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


OUTLOOK_CLIENT_ID = os.environ.get("OUTLOOK_CLIENT_ID", "").strip()
OUTLOOK_TENANT_ID = os.environ.get("OUTLOOK_TENANT_ID", "common").strip() or "common"
OUTLOOK_SCOPES = os.environ.get(
    "OUTLOOK_SCOPES",
    "offline_access User.Read Mail.Read",
).strip()
OUTLOOK_TIMEOUT_SECONDS = int(os.environ.get("OUTLOOK_TIMEOUT_SECONDS", "30"))

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

URL_RE = re.compile(
    r"""(?xi)
    \b(
      https?://[^\s<>()"]+ |
      www\.[^\s<>()"]+
    )
    """
)

DATE_KEYWORDS = [
    "today", "tomorrow", "tonight", "yesterday",
    "morning", "noon", "afternoon", "evening", "night", "now",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "week", "month", "year", "am", "pm", "due", "deadline", "submit", "meet", "meeting",
]

ALLOWED_ATTACHMENT_EXTENSIONS = {".pdf", ".doc", ".docx"}
ALLOWED_ATTACHMENT_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def normalize_user_key(user_key: Optional[str]) -> Optional[str]:
    raw = (user_key or "").strip().lower()
    if not raw:
        return None
    cleaned = re.sub(r"[^a-z0-9._-]", "_", raw)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or None


def resolve_outlook_client_id(override_client_id: Optional[str] = None) -> str:
    values = [
        (override_client_id or "").strip(),
        (os.environ.get("OUTLOOK_CLIENT_ID") or "").strip(),
        (os.environ.get("AZURE_CLIENT_ID") or "").strip(),
        (os.environ.get("MS_CLIENT_ID") or "").strip(),
        OUTLOOK_CLIENT_ID,
    ]
    for value in values:
        if value:
            return value
    return ""


def resolve_user_paths(user_key: Optional[str], db_path: Optional[str] = None) -> Tuple[str, str]:
    normalized = normalize_user_key(user_key)
    if normalized:
        token_path = f"token_outlook_{normalized}.json"
        resolved_db_path = db_path or f"extracted_{normalized}.db"
    else:
        token_path = "token_outlook.json"
        resolved_db_path = db_path or "extracted.db"
    return token_path, resolved_db_path


def open_sqlite_rw(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    ensure_base_schema(conn)
    ensure_messages_schema(conn)
    return conn


def ensure_base_schema(conn: sqlite3.Connection) -> None:
    has_messages = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
    ).fetchone()
    if has_messages:
        return

    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    if not os.path.exists(schema_path):
        raise FileNotFoundError(f"schema.sql not found at {schema_path}")

    with open(schema_path, "r", encoding="utf-8") as f:
        schema_sql = f.read()
    conn.executescript(schema_sql)
    conn.commit()


def ensure_messages_schema(conn: sqlite3.Connection) -> None:
    cols = conn.execute("PRAGMA table_info(messages)").fetchall()
    col_names = {c["name"] for c in cols}
    changed = False

    if "sender_name" not in col_names:
        conn.execute("ALTER TABLE messages ADD COLUMN sender_name TEXT")
        changed = True
    if "account_key" not in col_names:
        conn.execute("ALTER TABLE messages ADD COLUMN account_key TEXT")
        changed = True
    if "account_email" not in col_names:
        conn.execute("ALTER TABLE messages ADD COLUMN account_email TEXT")
        changed = True

    if changed:
        conn.commit()


def get_last_cursor(conn: sqlite3.Connection, source: str) -> int:
    row = conn.execute(
        "SELECT last_rowid FROM sync_state WHERE source = ?",
        (source,),
    ).fetchone()
    return int(row["last_rowid"]) if row else 0


def set_last_cursor(conn: sqlite3.Connection, source: str, cursor: int) -> None:
    conn.execute(
        """
        INSERT INTO sync_state(source, last_rowid, updated_at)
        VALUES(?, ?, datetime('now'))
        ON CONFLICT(source) DO UPDATE SET
          last_rowid=excluded.last_rowid,
          updated_at=datetime('now')
        """,
        (source, cursor),
    )


def reset_cursor(conn: sqlite3.Connection, source: str) -> None:
    conn.execute("DELETE FROM sync_state WHERE source = ?", (source,))


def upsert_conversation(conn: sqlite3.Connection, source: str, thread_key: str, display_name: Optional[str]) -> int:
    conn.execute(
        """
        INSERT INTO conversations(source, thread_key, display_name)
        VALUES(?, ?, ?)
        ON CONFLICT(source, thread_key) DO UPDATE SET
          display_name=COALESCE(excluded.display_name, conversations.display_name)
        """,
        (source, thread_key, display_name),
    )
    row = conn.execute(
        "SELECT id FROM conversations WHERE source=? AND thread_key=?",
        (source, thread_key),
    ).fetchone()
    return int(row["id"])


def insert_message(
    conn: sqlite3.Connection,
    source: str,
    source_msg_key: str,
    source_rowid: int,
    conversation_id: int,
    sender: Optional[str],
    sender_name: Optional[str],
    account_key: Optional[str],
    account_email: Optional[str],
    sent_at_utc: str,
    text: str,
) -> Optional[int]:
    try:
        conn.execute(
            """
            INSERT INTO messages(source, source_msg_key, source_rowid, conversation_id, sender, sender_name, account_key, account_email, is_from_me, sent_at_utc, text)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (source, source_msg_key, source_rowid, conversation_id, sender, sender_name, account_key, account_email, sent_at_utc, text),
        )
    except sqlite3.IntegrityError:
        return None

    row = conn.execute(
        "SELECT id FROM messages WHERE source=? AND source_msg_key=?",
        (source, source_msg_key),
    ).fetchone()
    return int(row["id"])


def extract_urls(text: str) -> List[str]:
    urls = []
    for m in URL_RE.finditer(text or ""):
        value = m.group(1).strip().rstrip(".,;:!)]}\"")
        if value.startswith("www."):
            value = "https://" + value
        urls.append(value)
    out = []
    seen = set()
    for value in urls:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def looks_like_real_date(raw_span: str) -> bool:
    s = (raw_span or "").strip().lower()
    if len(s) < 3:
        return False
    if any(c.isdigit() for c in s):
        has_sep = any(sep in s for sep in ["/", "-", ":", "."])
        has_keyword = any(k in s for k in DATE_KEYWORDS)
        return has_sep or has_keyword
    if any(k in s for k in DATE_KEYWORDS):
        return True
    return s in {"tomorrow", "today", "tonight", "yesterday"}


def extract_dates(text: str, base_dt: datetime):
    text = (text or "")[:10000]
    settings = {
        "RELATIVE_BASE": base_dt,
        "PREFER_DATES_FROM": "current_period",
        "SKIP_TOKENS": ["http", "https", "www"],
    }
    found = search_dates(text, settings=settings, languages=["en"])
    if not found:
        return []

    out = []
    for raw, dt in found:
        if not looks_like_real_date(raw):
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=base_dt.tzinfo)
        resolved_utc = dt.astimezone(timezone.utc)
        resolved_local = dt.astimezone(base_dt.tzinfo)
        out.append((raw, resolved_utc, resolved_local))
    return out


def is_allowed_document_attachment(filename: Optional[str], mime_type: Optional[str]) -> bool:
    lower_mime = (mime_type or "").strip().lower()
    if lower_mime in ALLOWED_ATTACHMENT_MIME_TYPES:
        return True
    ext = os.path.splitext((filename or "").strip().lower())[1]
    return ext in ALLOWED_ATTACHMENT_EXTENSIONS


def insert_extractions(conn: sqlite3.Connection, message_id: int, text: str, sent_at_utc: str) -> None:
    base_dt = datetime.fromisoformat(sent_at_utc.replace("Z", "+00:00")).astimezone(timezone.utc)
    for url in extract_urls(text):
        conn.execute("INSERT INTO extracted_links(message_id, url) VALUES(?, ?)", (message_id, url))
    for raw, resolved_utc, resolved_local in extract_dates(text, base_dt):
        conn.execute(
            "INSERT INTO extracted_dates(message_id, raw_span, parsed_at_utc, resolved_date, confidence) VALUES(?, ?, ?, ?, ?)",
            (
                message_id,
                raw,
                resolved_utc.isoformat(timespec="seconds").replace("+00:00", "Z"),
                resolved_local.isoformat(timespec="seconds"),
                None,
            ),
        )


def insert_attachment_meta(conn: sqlite3.Connection, message_id: int, filename: str, mime: str, outlook_ref: str) -> None:
    if not is_allowed_document_attachment(filename, mime):
        return
    conn.execute(
        """
        INSERT INTO extracted_attachments(message_id, filename, mime_type, original_path)
        VALUES(?, ?, ?, ?)
        """,
        (message_id, filename, mime, outlook_ref),
    )


def strip_html_to_text(content: str) -> str:
    no_script = re.sub(r"<script[\\s\\S]*?</script>", " ", content or "", flags=re.I)
    no_style = re.sub(r"<style[\\s\\S]*?</style>", " ", no_script, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", no_style)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def is_likely_spam_message(subject: str, body_preview: str, body_text: str, sender_name: str, sender_email: str) -> bool:
    subject_l = (subject or "").lower()
    preview_l = (body_preview or "").lower()
    body_l = (body_text or "").lower()
    sender_l = f"{sender_name or ''} {sender_email or ''}".lower()
    text = f"{subject_l} {preview_l} {body_l} {sender_l}"

    high_confidence_patterns = [
        r"\blottery\b", r"\bjackpot\b", r"\byou\s+have\s+won\b", r"\bcongratulation(?:s)?\b",
        r"\bclaim\s+your\s+prize\b", r"\bprocessing\s+fee\b", r"\bgift\s*card\b",
        r"\bwire\s+transfer\b", r"\bbank\s+account\s+number\b", r"\bmother\s+maiden\b",
        r"\bdriver\s+passport\b", r"\bscam\b", r"\bphishing\b", r"\bclick\s+here\s+to\s+verify\b",
        r"\b\$\s*\d+(?:[\.,]\d+)?\s*(?:million|billion)\b", r"\b\d+(?:[\.,]\d+)?\s*(?:million|billion)\s+dollar\b",
        r"\burgent\s*!{0,3}\b", r"\bact\s+now\b", r"\blimited\s+time\b",
    ]
    if any(re.search(p, text, flags=re.I) for p in high_confidence_patterns):
        return True

    suspicious_sender_patterns = [
        r"\bnoreply@", r"\bno-reply@", r"\bmailer-daemon@", r"\bbounce@", r"\bpromo@", r"\bnotification@",
    ]
    if any(re.search(p, sender_l, flags=re.I) for p in suspicious_sender_patterns):
        if re.search(r"offer|deal|sale|discount|verify|security alert|prize|won", text, flags=re.I):
            return True

    return False


def parse_iso_to_utc_ms(value: str) -> int:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def token_endpoint() -> str:
    return f"https://login.microsoftonline.com/{OUTLOOK_TENANT_ID}/oauth2/v2.0/token"


def device_code_endpoint() -> str:
    return f"https://login.microsoftonline.com/{OUTLOOK_TENANT_ID}/oauth2/v2.0/devicecode"


def load_token_file(token_path: str) -> Optional[Dict]:
    if not os.path.exists(token_path):
        return None
    try:
        with open(token_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_token_file(token_path: str, payload: Dict) -> None:
    with open(token_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def request_token_refresh(refresh_token: str, client_id: str) -> Dict:
    data = {
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": OUTLOOK_SCOPES,
    }
    resp = requests.post(token_endpoint(), data=data, timeout=OUTLOOK_TIMEOUT_SECONDS)
    if resp.status_code >= 400:
        raise RuntimeError(f"Outlook token refresh failed: {resp.status_code} {resp.text}")
    return resp.json()


def request_device_code(client_id: str) -> Dict:
    data = {"client_id": client_id, "scope": OUTLOOK_SCOPES}
    resp = requests.post(device_code_endpoint(), data=data, timeout=OUTLOOK_TIMEOUT_SECONDS)
    if resp.status_code >= 400:
        raise RuntimeError(f"Outlook device code start failed: {resp.status_code} {resp.text}")
    return resp.json()


def poll_device_code(device_flow: Dict, client_id: str) -> Dict:
    interval = int(device_flow.get("interval", 5))
    expires_in = int(device_flow.get("expires_in", 900))
    deadline = time.time() + expires_in

    logger.info(device_flow.get("message") or "Open Microsoft device login URL and enter the code.")
    verification_url = (
        (device_flow.get("verification_uri_complete") or "").strip()
        or (device_flow.get("verification_uri") or "").strip()
    )
    if verification_url:
        try:
            webbrowser.open(verification_url, new=2, autoraise=True)
            logger.info(f"Opened browser for Outlook sign-in: {verification_url}")
        except Exception as e:
            logger.warning(f"Could not auto-open browser for Outlook sign-in: {e}")

    while time.time() < deadline:
        time.sleep(max(2, interval))
        data = {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": client_id,
            "device_code": device_flow.get("device_code", ""),
        }
        resp = requests.post(token_endpoint(), data=data, timeout=OUTLOOK_TIMEOUT_SECONDS)
        payload = resp.json()
        if "access_token" in payload:
            return payload
        err = payload.get("error")
        if err in {"authorization_pending", "slow_down"}:
            continue
        raise RuntimeError(f"Outlook device auth failed: {resp.status_code} {payload}")

    raise TimeoutError("Outlook device login timed out")


def get_outlook_access_token(token_path: str, force_reauth: bool = False, client_id: Optional[str] = None) -> Dict:
    effective_client_id = resolve_outlook_client_id(client_id)
    if not effective_client_id:
        raise RuntimeError(
            "Outlook auth requires a client id. Set OUTLOOK_CLIENT_ID (or AZURE_CLIENT_ID/MS_CLIENT_ID), "
            "or pass client_id in POST /ingest."
        )

    if force_reauth and os.path.exists(token_path):
        os.remove(token_path)

    now = int(time.time())
    token_data = load_token_file(token_path) or {}
    access_token = token_data.get("access_token")
    expires_at = int(token_data.get("expires_at", 0) or 0)
    if access_token and expires_at > now + 60:
        return token_data

    refresh_token = token_data.get("refresh_token")
    if refresh_token:
        refreshed = request_token_refresh(refresh_token, effective_client_id)
        refreshed["refresh_token"] = refreshed.get("refresh_token") or refresh_token
        refreshed["expires_at"] = int(time.time()) + int(refreshed.get("expires_in", 3600))
        save_token_file(token_path, refreshed)
        return refreshed

    flow = request_device_code(effective_client_id)
    token_payload = poll_device_code(flow, effective_client_id)
    token_payload["expires_at"] = int(time.time()) + int(token_payload.get("expires_in", 3600))
    save_token_file(token_path, token_payload)
    return token_payload


def graph_get_json(path: str, access_token: str, params: Optional[Dict] = None) -> Dict:
    url = f"{GRAPH_BASE}{path}"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=OUTLOOK_TIMEOUT_SECONDS,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Graph GET failed: {resp.status_code} {resp.text}")
    return resp.json()


def graph_get_bytes(path: str, access_token: str) -> bytes:
    url = f"{GRAPH_BASE}{path}"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=OUTLOOK_TIMEOUT_SECONDS,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Graph bytes GET failed: {resp.status_code} {resp.text}")
    return resp.content


def fetch_outlook_profile(access_token: str) -> Dict:
    data = graph_get_json("/me", access_token, params={"$select": "mail,userPrincipalName,displayName"})
    return {
        "email": data.get("mail") or data.get("userPrincipalName"),
        "display_name": data.get("displayName") or "",
    }


def list_messages_since(access_token: str, after_seconds: int, max_pages: int = 8) -> List[Dict]:
    after_dt = datetime.fromtimestamp(after_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = {
        "$select": "id,conversationId,receivedDateTime,sentDateTime,from,subject,bodyPreview,body,hasAttachments,internetMessageId,parentFolderId",
        "$orderby": "receivedDateTime DESC",
        "$filter": f"receivedDateTime ge {after_dt}",
        "$top": "50",
    }

    def fetch_folder(folder_name: str) -> List[Dict]:
        rows = []
        next_url = f"{GRAPH_BASE}/me/mailFolders/{folder_name}/messages"
        page = 0
        while next_url and page < max_pages:
            page += 1
            resp = requests.get(
                next_url,
                headers={"Authorization": f"Bearer {access_token}"},
                params=params if page == 1 else None,
                timeout=OUTLOOK_TIMEOUT_SECONDS,
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"Graph message list failed ({folder_name}): {resp.status_code} {resp.text}")
            data = resp.json()
            rows.extend(data.get("value", []) or [])
            next_url = data.get("@odata.nextLink")
        return rows

    inbox_rows = fetch_folder("inbox")
    sent_rows = fetch_folder("sentitems")

    out = []
    seen_ids = set()
    for msg in [*inbox_rows, *sent_rows]:
        message_id = (msg.get("id") or "").strip()
        if not message_id or message_id in seen_ids:
            continue
        seen_ids.add(message_id)
        out.append(msg)

    return out


def list_message_attachments(access_token: str, message_id: str) -> List[Tuple[str, str, str]]:
    data = graph_get_json(
        f"/me/messages/{message_id}/attachments",
        access_token,
        params={"$select": "id,name,contentType,isInline"},
    )
    out = []
    for att in data.get("value", []) or []:
        if att.get("isInline"):
            continue
        att_id = (att.get("id") or "").strip()
        name = (att.get("name") or "").strip()
        content_type = (att.get("contentType") or "application/octet-stream").strip()
        if not att_id or not name:
            continue
        out.append((name, content_type, att_id))
    return out


def ingest_outlook(
    out_db_path: str,
    source: str = "outlook",
    reset_cursor_flag: bool = False,
    force_reauth: bool = False,
    token_path: str = "token_outlook.json",
    account_key: Optional[str] = None,
    client_id: Optional[str] = None,
) -> Dict[str, int]:
    conn = open_sqlite_rw(out_db_path)

    token_data = get_outlook_access_token(token_path=token_path, force_reauth=force_reauth, client_id=client_id)
    access_token = token_data.get("access_token", "")
    if not access_token:
        raise RuntimeError("Outlook auth succeeded but access_token is missing")

    profile = fetch_outlook_profile(access_token)
    account_email = profile.get("email")

    if reset_cursor_flag:
        reset_cursor(conn, source)
        conn.commit()

    last_ms = get_last_cursor(conn, source)
    last_dt = datetime.fromtimestamp(last_ms / 1000, tz=timezone.utc) if last_ms else datetime(1970, 1, 1, tzinfo=timezone.utc)
    safety_lookback_seconds = 3 * 24 * 60 * 60
    after_seconds = max(0, int(last_dt.timestamp()) - safety_lookback_seconds)

    messages = list_messages_since(access_token, after_seconds=after_seconds)
    if not messages:
        conn.close()
        return {
            "processed": 0,
            "inserted": 0,
            "account_email": account_email,
            "after_seconds": after_seconds,
        }

    max_internal_ms_seen = last_ms
    inserted_count = 0

    try:
        if conn.in_transaction:
            conn.commit()
        conn.execute("BEGIN")

        for msg in messages:
            received = (msg.get("receivedDateTime") or "").strip()
            if not received:
                continue

            internal_ms = parse_iso_to_utc_ms(received)
            max_internal_ms_seen = max(max_internal_ms_seen, internal_ms)

            from_obj = (msg.get("from") or {}).get("emailAddress") or {}
            sender_name = (from_obj.get("name") or "").strip()
            sender_email = (from_obj.get("address") or "").strip()
            sender = f"{sender_name} <{sender_email}>" if sender_name and sender_email else sender_email or sender_name

            subject = (msg.get("subject") or "").strip()
            body_preview = (msg.get("bodyPreview") or "").strip()
            body_obj = msg.get("body") or {}
            body_content = strip_html_to_text(body_obj.get("content") or "")
            body_text = body_content or body_preview

            if is_likely_spam_message(subject, body_preview, body_text, sender_name, sender_email):
                continue

            combined = (f"Subject: {subject}\n" if subject else "") + body_text
            if not combined.strip():
                continue

            thread_key = (msg.get("conversationId") or msg.get("id") or "").strip()
            source_msg_key = (msg.get("id") or "").strip()
            if not source_msg_key:
                continue

            sent_at_utc = datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

            conv_id = upsert_conversation(conn, source, thread_key, display_name=subject)
            msg_id_db = insert_message(
                conn,
                source=source,
                source_msg_key=source_msg_key,
                source_rowid=internal_ms,
                conversation_id=conv_id,
                sender=sender,
                sender_name=sender_name or sender_email or sender,
                account_key=normalize_user_key(account_key),
                account_email=account_email,
                sent_at_utc=sent_at_utc,
                text=combined,
            )
            if msg_id_db is None:
                continue

            inserted_count += 1
            insert_extractions(conn, msg_id_db, combined, sent_at_utc)

            if msg.get("hasAttachments"):
                for filename, mime, attachment_id in list_message_attachments(access_token, source_msg_key):
                    reference = f"outlook_attachment_id:{source_msg_key}:{attachment_id}"
                    insert_attachment_meta(conn, msg_id_db, filename, mime, reference)

        set_last_cursor(conn, source, max_internal_ms_seen)
        conn.commit()
        return {
            "processed": len(messages),
            "inserted": inserted_count,
            "account_email": account_email,
            "after_seconds": after_seconds,
        }
    except Exception:
        if conn.in_transaction:
            conn.rollback()
        raise
    finally:
        conn.close()


def get_db_summary(db_path: str, account_key: Optional[str] = None) -> Dict[str, Optional[str]]:
    conn = open_sqlite_rw(db_path)
    try:
        norm_key = normalize_user_key(account_key)
        if norm_key:
            messages = conn.execute("SELECT COUNT(*) AS c FROM messages WHERE source='outlook' AND account_key = ?", (norm_key,)).fetchone()["c"]
            dates = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_dates d
                JOIN messages m ON m.id = d.message_id
                WHERE m.source='outlook' AND m.account_key = ?
                """,
                (norm_key,),
            ).fetchone()["c"]
            links = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_links l
                JOIN messages m ON m.id = l.message_id
                WHERE m.source='outlook' AND m.account_key = ?
                """,
                (norm_key,),
            ).fetchone()["c"]
            attachments = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_attachments a
                JOIN messages m ON m.id = a.message_id
                WHERE m.source='outlook' AND m.account_key = ?
                """,
                (norm_key,),
            ).fetchone()["c"]
            latest_row = conn.execute(
                "SELECT sent_at_utc FROM messages WHERE source='outlook' AND account_key = ? ORDER BY source_rowid DESC LIMIT 1",
                (norm_key,),
            ).fetchone()
        else:
            messages = conn.execute("SELECT COUNT(*) AS c FROM messages WHERE source='outlook'").fetchone()["c"]
            dates = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_dates d
                JOIN messages m ON m.id = d.message_id
                WHERE m.source='outlook'
                """
            ).fetchone()["c"]
            links = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_links l
                JOIN messages m ON m.id = l.message_id
                WHERE m.source='outlook'
                """
            ).fetchone()["c"]
            attachments = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_attachments a
                JOIN messages m ON m.id = a.message_id
                WHERE m.source='outlook'
                """
            ).fetchone()["c"]
            latest_row = conn.execute(
                "SELECT sent_at_utc FROM messages WHERE source='outlook' ORDER BY source_rowid DESC LIMIT 1"
            ).fetchone()

        latest_sent_at = latest_row["sent_at_utc"] if latest_row else None
        return {
            "messages": int(messages),
            "dates": int(dates),
            "links": int(links),
            "attachments": int(attachments),
            "latest_sent_at": latest_sent_at,
        }
    finally:
        conn.close()


def fetch_db_snapshot(db_path: str, limit: int = 20, account_key: Optional[str] = None) -> Dict[str, List[Dict]]:
    conn = open_sqlite_rw(db_path)
    try:
        norm_key = normalize_user_key(account_key)
        if norm_key:
            msgs = conn.execute(
                """
                SELECT id, sender, sender_name, sent_at_utc, text, substr(text, 1, 200) AS snippet
                FROM messages
                WHERE source='outlook' AND account_key = ?
                ORDER BY source_rowid DESC
                LIMIT ?
                """,
                (norm_key, limit),
            ).fetchall()
            dates = conn.execute(
                """
                SELECT d.id, d.message_id, d.raw_span, d.resolved_date, d.parsed_at_utc
                FROM extracted_dates d
                JOIN messages m ON m.id = d.message_id
                WHERE m.source='outlook' AND m.account_key = ?
                ORDER BY d.id DESC
                LIMIT ?
                """,
                (norm_key, limit),
            ).fetchall()
            links = conn.execute(
                """
                SELECT l.id, l.message_id, l.url, m.sender_name, m.sender, m.text
                FROM extracted_links l
                JOIN messages m ON m.id = l.message_id
                WHERE m.source='outlook' AND m.account_key = ?
                ORDER BY l.id DESC
                LIMIT ?
                """,
                (norm_key, limit),
            ).fetchall()
            attachments = conn.execute(
                """
                SELECT a.id, a.message_id, a.filename, a.mime_type, a.original_path
                FROM extracted_attachments a
                JOIN messages m ON m.id = a.message_id
                WHERE m.source='outlook' AND m.account_key = ?
                ORDER BY a.id DESC
                LIMIT ?
                """,
                (norm_key, limit),
            ).fetchall()
        else:
            msgs = conn.execute(
                """
                SELECT id, sender, sender_name, sent_at_utc, text, substr(text, 1, 200) AS snippet
                FROM messages
                WHERE source='outlook'
                ORDER BY source_rowid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            dates = conn.execute(
                """
                SELECT d.id, d.message_id, d.raw_span, d.resolved_date, d.parsed_at_utc
                FROM extracted_dates d
                JOIN messages m ON m.id = d.message_id
                WHERE m.source='outlook'
                ORDER BY d.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            links = conn.execute(
                """
                SELECT l.id, l.message_id, l.url, m.sender_name, m.sender, m.text
                FROM extracted_links l
                JOIN messages m ON m.id = l.message_id
                WHERE m.source='outlook'
                ORDER BY l.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            attachments = conn.execute(
                """
                SELECT a.id, a.message_id, a.filename, a.mime_type, a.original_path
                FROM extracted_attachments a
                JOIN messages m ON m.id = a.message_id
                WHERE m.source='outlook'
                ORDER BY a.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        def rows_to_dict(rows):
            return [dict(r) for r in rows]

        def derive_subject(text_val: Optional[str]) -> Optional[str]:
            if not text_val:
                return None
            prefix = "Subject: "
            idx = text_val.find(prefix)
            if idx != -1:
                rest = text_val[idx + len(prefix):]
                first_line = rest.splitlines()[0].strip()
                return first_line or None
            for line in text_val.splitlines():
                line = line.strip()
                if line:
                    return line
            return None

        msg_dicts = rows_to_dict(msgs)
        for m in msg_dicts:
            m["subject"] = derive_subject(m.get("text"))

        link_dicts = rows_to_dict(links)
        for l in link_dicts:
            l["subject"] = derive_subject(l.get("text"))
            l.pop("text", None)

        attachment_dicts = [
            a for a in rows_to_dict(attachments)
            if is_allowed_document_attachment(a.get("filename"), a.get("mime_type"))
        ]

        return {
            "messages": msg_dicts,
            "dates": rows_to_dict(dates),
            "links": link_dicts,
            "attachments": attachment_dicts,
        }
    finally:
        conn.close()


@app.route("/ingest", methods=["POST"])
def ingest():
    try:
        payload = request.json or {}
        user_key = payload.get("user_key")
        client_id = (payload.get("client_id") or "").strip() or None
        db_path_payload = payload.get("db_path")
        token_path, db_path = resolve_user_paths(user_key=user_key, db_path=db_path_payload)

        reset_flag = bool(payload.get("reset_cursor"))
        force_reauth_flag = bool(payload.get("force_reauth"))

        stats = ingest_outlook(
            db_path,
            reset_cursor_flag=reset_flag,
            force_reauth=force_reauth_flag,
            token_path=token_path,
            account_key=user_key,
            client_id=client_id,
        )
        summary = get_db_summary(db_path, account_key=user_key)
        return jsonify({"status": "success", "message": "Outlook emails ingested successfully.", "ingest": stats, "summary": summary})
    except Exception as e:
        logger.error(f"Error during Outlook ingestion: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/summary", methods=["GET"])
def summary():
    try:
        user_key = request.args.get("user_key")
        db_path_raw = request.args.get("db_path")
        _, db_path = resolve_user_paths(user_key=user_key, db_path=db_path_raw)
        limit_raw = request.args.get("limit", "20")
        try:
            limit = max(1, min(500, int(limit_raw)))
        except ValueError:
            limit = 20
        snap = fetch_db_snapshot(db_path, limit=limit, account_key=user_key)
        stats = get_db_summary(db_path, account_key=user_key)
        return jsonify({"status": "success", "summary": stats, "data": snap})
    except Exception as e:
        logger.error(f"Error during summary fetch: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/lookup_message", methods=["GET"])
def lookup_message():
    try:
        user_key = normalize_user_key(request.args.get("user_key"))
        db_path_raw = request.args.get("db_path")
        _, db_path = resolve_user_paths(user_key=user_key, db_path=db_path_raw)
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify({"status": "error", "message": "Query parameter q is required."}), 400

        conn = open_sqlite_rw(db_path)
        try:
            if user_key:
                rows = conn.execute(
                    """
                    SELECT id, sender, sent_at_utc, substr(text, 1, 300) AS snippet
                    FROM messages
                    WHERE source='outlook' AND account_key = ? AND text LIKE ?
                    ORDER BY source_rowid DESC
                    LIMIT 50
                    """,
                    (user_key, f"%{q}%"),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, sender, sent_at_utc, substr(text, 1, 300) AS snippet
                    FROM messages
                    WHERE source='outlook' AND text LIKE ?
                    ORDER BY source_rowid DESC
                    LIMIT 50
                    """,
                    (f"%{q}%",),
                ).fetchall()

            out = []
            for r in rows:
                dates = conn.execute(
                    """
                    SELECT id, raw_span, resolved_date, parsed_at_utc
                    FROM extracted_dates
                    WHERE message_id = ?
                    ORDER BY id DESC
                    """,
                    (r["id"],),
                ).fetchall()
                out.append({"message": dict(r), "dates": [dict(d) for d in dates]})
            return jsonify({"status": "success", "count": len(out), "results": out})
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Error during lookup_message: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/attachment_preview", methods=["GET"])
def attachment_preview():
    try:
        attachment_id_raw = (request.args.get("attachment_id") or "").strip()
        if not attachment_id_raw:
            return jsonify({"status": "error", "message": "attachment_id is required"}), 400

        try:
            attachment_id = int(attachment_id_raw)
        except ValueError:
            return jsonify({"status": "error", "message": "attachment_id must be an integer"}), 400

        user_key = normalize_user_key(request.args.get("user_key"))
        client_id = (request.args.get("client_id") or "").strip() or None
        db_path_raw = request.args.get("db_path")
        _, db_path = resolve_user_paths(user_key=user_key, db_path=db_path_raw)

        conn = open_sqlite_rw(db_path)
        try:
            if user_key:
                row = conn.execute(
                    """
                    SELECT a.filename, a.mime_type, a.original_path
                    FROM extracted_attachments a
                    JOIN messages m ON m.id = a.message_id
                    WHERE a.id = ? AND m.source='outlook' AND m.account_key = ?
                    LIMIT 1
                    """,
                    (attachment_id, user_key),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT a.filename, a.mime_type, a.original_path
                    FROM extracted_attachments a
                    JOIN messages m ON m.id = a.message_id
                    WHERE a.id = ? AND m.source='outlook'
                    LIMIT 1
                    """,
                    (attachment_id,),
                ).fetchone()
        finally:
            conn.close()

        if not row:
            return jsonify({"status": "error", "message": "Attachment not found"}), 404

        original_path = (row["original_path"] or "").strip()
        prefix = "outlook_attachment_id:"
        if not original_path.startswith(prefix):
            return jsonify({"status": "error", "message": "Attachment preview source is unsupported"}), 400

        rest = original_path[len(prefix):]
        parts = rest.split(":", 1)
        if len(parts) != 2:
            return jsonify({"status": "error", "message": "Invalid Outlook attachment reference"}), 400

        message_id, outlook_attachment_id = parts[0], parts[1]
        token_path, _ = resolve_user_paths(user_key=user_key, db_path=db_path_raw)
        token_data = get_outlook_access_token(token_path=token_path, force_reauth=False, client_id=client_id)
        access_token = token_data.get("access_token", "")
        if not access_token:
            return jsonify({"status": "error", "message": "Missing Outlook access token"}), 500

        blob = graph_get_bytes(f"/me/messages/{message_id}/attachments/{outlook_attachment_id}/$value", access_token)
        mime_type = row["mime_type"] or "application/octet-stream"
        filename = (row["filename"] or "attachment").replace('"', "")
        headers = {"Content-Disposition": f"inline; filename=\"{filename}\""}
        return Response(blob, mimetype=mime_type, headers=headers)
    except Exception as e:
        logger.error(f"Error during attachment preview fetch: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/routes", methods=["GET"])
def routes():
    rows = []
    for rule in app.url_map.iter_rules():
        methods = sorted([m for m in rule.methods if m not in {"HEAD", "OPTIONS"}])
        rows.append({"rule": str(rule), "methods": methods, "endpoint": rule.endpoint})
    rows.sort(key=lambda x: x["rule"])
    return jsonify({"status": "success", "routes": rows})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("OUTLOOK_INGEST_PORT", "5002")), debug=False)
