import base64
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from email.mime.text import MIMEText
from email.utils import parseaddr
from datetime import datetime, timezone, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

from dateparser.search import search_dates

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from flask import Flask, request, jsonify, Response
import logging

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.readonly",
]

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
    "week", "month", "year",
    "am", "pm",
    "due", "deadline", "submit", "meet", "meeting", "call", "interview"
]

ALLOWED_ATTACHMENT_EXTENSIONS = {".pdf", ".doc", ".docx"}
ALLOWED_ATTACHMENT_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Flask app for API integration
app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

AUTO_INGEST_INTERVAL_SECONDS = int(os.environ.get("AUTO_INGEST_INTERVAL_SECONDS", "60"))


def normalize_user_key(user_key: Optional[str]) -> Optional[str]:
    raw = (user_key or "").strip().lower()
    if not raw:
        return None
    cleaned = re.sub(r"[^a-z0-9._-]", "_", raw)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or None


def resolve_user_paths(user_key: Optional[str], db_path: Optional[str] = None) -> Tuple[str, str]:
    normalized = normalize_user_key(user_key)
    if normalized:
        token_path = f"token_{normalized}.json"
        resolved_db_path = db_path or f"extracted_{normalized}.db"
    else:
        token_path = "token.json"
        resolved_db_path = db_path or "extracted.db"
    return token_path, resolved_db_path


def datetime_to_rfc3339_utc(dt: datetime) -> str:
    """Convert a datetime into RFC3339 UTC form (e.g. 2026-01-01T12:00:00Z)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso_datetime_to_utc(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO/RFC3339 datetime string into a timezone-aware UTC datetime."""
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    # datetime.fromisoformat doesn't handle trailing "Z" well.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fallback_reply_suggestions(subject: str, body: str) -> List[str]:
    text = f"{subject} {body}".lower()
    if any(k in text for k in ["verify", "security", "password", "login", "sign-in"]):
        return [
            "Thanks for the heads-up. I verified this on my side.",
            "I did not initiate this. Please lock the account and share next steps.",
            "Received. I completed the verification successfully.",
        ]
    if any(k in text for k in ["meeting", "schedule", "calendar", "time"]):
        return [
            "Thanks! That time works for me.",
            "Could we move this by 30 minutes due to a conflict?",
            "Confirmed, I will join and come prepared.",
        ]
    return [
        "Thanks for the update. I will follow up shortly.",
        "Received — I reviewed this and will respond with details soon.",
        "Got it. I will take care of this today.",
    ]


def ai_reply_suggestions(subject: str, body: str, sender_name: str = "") -> List[str]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return fallback_reply_suggestions(subject, body)

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    url = f"{base_url.rstrip('/')}/chat/completions"

    system_prompt = (
        "You generate short, professional email reply suggestions. "
        "Return strictly JSON array of 3 strings. No markdown, no extra keys."
    )
    user_prompt = (
        f"Sender: {sender_name or 'Unknown'}\n"
        f"Subject: {subject}\n"
        f"Body: {body}\n\n"
        "Write 3 concise reply options."
    )

    payload = {
        "model": model,
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8")
        parsed = json.loads(raw)
        content = parsed.get("choices", [{}])[0].get("message", {}).get("content", "[]")
        suggestions = json.loads(content)
        if isinstance(suggestions, list):
            cleaned = [str(x).strip() for x in suggestions if str(x).strip()]
            return cleaned[:3] if cleaned else fallback_reply_suggestions(subject, body)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError, KeyError, IndexError, ValueError) as e:
        logger.warning(f"AI suggestion API failed, using fallback: {e}")

    return fallback_reply_suggestions(subject, body)

# Modify the `looks_like_real_date` function to ensure valid spans like "tomorrow" and "Feb 22nd" are not filtered out.
def looks_like_real_date(raw: str) -> bool:
    s = (raw or "").lower().strip()

    # Too short means almost always garbage
    if len(s) < 3:  # Reduced the minimum length to 3
        return False

    # Pure stopword-ish junk often shows up
    if s in {"to to", "on in", "in on", "we may"}:
        return False

    # If it has a digit, require date-ish context (separators or keywords)
    if any(c.isdigit() for c in s):
        has_sep = any(sep in s for sep in ["/", "-", ":", "."])
        has_keyword = any(k in s for k in DATE_KEYWORDS)
        if has_sep or has_keyword:
            return True
        # otherwise treat naked numbers as noise
        return False

    # If it contains a known date word, keep it
    if any(k in s for k in DATE_KEYWORDS):
        return True

    # Allow relative terms like "tomorrow" explicitly
    if s in {"tomorrow", "today", "tonight", "yesterday"}:
        return True

    return False



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

    # Best-effort backfill for existing rows
    rows = conn.execute(
        "SELECT id, sender FROM messages WHERE (sender_name IS NULL OR sender_name = '') AND sender IS NOT NULL"
    ).fetchall()
    for r in rows:
        name, email = parseaddr(r["sender"])
        sender_name = (name or "").strip() or (email or "").strip() or r["sender"]
        conn.execute("UPDATE messages SET sender_name = ? WHERE id = ?", (sender_name, r["id"]))
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
    source_rowid: int,  # Gmail internalDate (ms)
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

    msg_id = conn.execute(
        "SELECT id FROM messages WHERE source=? AND source_msg_key=?",
        (source, source_msg_key),
    ).fetchone()["id"]
    return int(msg_id)


def extract_urls(text: str) -> List[str]:
    urls = []
    for m in URL_RE.finditer(text):
        u = m.group(1).strip().rstrip(".,;:!)\"]}")
        if u.startswith("www."):
            u = "https://" + u
        urls.append(u)
    seen = set()
    out = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


# Modify the `extract_dates` function to improve `search_dates` settings for better handling of relative terms.
def extract_dates(text: str, base_dt: datetime) -> List[Tuple[str, datetime, datetime]]:
    """
    Extract date-like spans from text and resolve them to absolute dates.

    Returns a list of tuples: (raw_span, resolved_date_utc, resolved_date_local).
    """
    text = (text or "")[:10000]  # Truncate to avoid performance issues

    settings = {
        "RELATIVE_BASE": base_dt,
        "PREFER_DATES_FROM": "current_period",  # Prefer dates close to base_dt
        "SKIP_TOKENS": ["http", "https", "www"],
        "RETURN_AS_TIMEZONE_AWARE": True,
        "STRICT_PARSING": False,  # Relax strict parsing to allow more flexible date recognition
    }

    try:
        results = search_dates(text, languages=["en"], settings=settings) or []
        logger.info(f"Raw search_dates output: {results}")  # Debug log
    except Exception as e:
        logger.error(f"Error during date parsing: {e}")
        return []

    out: List[Tuple[str, datetime, datetime]] = []
    for raw, dt in results:
        raw = (raw or "").strip()
        logger.info(f"Raw span identified: {raw}, Parsed datetime: {dt}")  # Debug log

        # Drop extremely long spans (usually false positives / whole sentences)
        if len(raw) > 50:
            logger.info(f"Skipping raw span due to length: {raw}")
            continue

        # Filter out invalid spans
        if not looks_like_real_date(raw):
            logger.info(f"Skipping raw span due to invalidity: {raw}")
            continue

        # Ensure timezone-aware datetimes
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=base_dt.tzinfo)

        # Post-process to adjust dates based on base_dt
        if dt.year > base_dt.year + 1:  # If the year is far in the future
            dt = dt.replace(year=base_dt.year)
            logger.info(f"Adjusted future date to current year: {dt}")

        # Convert to UTC and local timezone
        resolved_date_utc = dt.astimezone(timezone.utc)
        resolved_date_local = dt.astimezone(base_dt.tzinfo)

        logger.info(f"Resolved date: raw_span={raw}, UTC={resolved_date_utc}, Local={resolved_date_local}")
        out.append((raw, resolved_date_utc, resolved_date_local))

    return out


# Ensure the `insert_extractions` function handles all extracted dates properly.
def insert_extractions(conn: sqlite3.Connection, message_id: int, text: str, sent_at_utc: str) -> None:
    base_dt = datetime.fromisoformat(sent_at_utc.replace("Z", "+00:00")).astimezone(timezone.utc)

    for url in extract_urls(text):
        conn.execute("INSERT INTO extracted_links(message_id, url) VALUES(?, ?)", (message_id, url))

    for raw, resolved_date_utc, resolved_date_local in extract_dates(text, base_dt):
        logger.info(f"Inserting into database: raw_span={raw}, resolved_date_utc={resolved_date_utc}, resolved_date_local={resolved_date_local}")
        conn.execute(
            "INSERT INTO extracted_dates(message_id, raw_span, parsed_at_utc, resolved_date, confidence) VALUES(?, ?, ?, ?, ?)",
            (
                message_id,
                raw,
                resolved_date_utc.isoformat(timespec="seconds").replace("+00:00", "Z"),
                resolved_date_local.isoformat(timespec="seconds"),
                None,
            ),
        )


def insert_attachment_meta(conn: sqlite3.Connection, message_id: int, filename: str, mime: str, attachment_id: str) -> None:
    if not is_allowed_document_attachment(filename, mime):
        return

    conn.execute(
        """
        INSERT INTO extracted_attachments(message_id, filename, mime_type, original_path)
        VALUES(?, ?, ?, ?)
        """,
        (message_id, filename, mime, f"gmail_attachment_id:{attachment_id}"),
    )

def normalize_user_key(k):
    return k.strip().lower() if k else None

def is_allowed_document_attachment(filename: Optional[str], mime_type: Optional[str]) -> bool:
    lower_mime = (mime_type or "").strip().lower()
    if lower_mime in ALLOWED_ATTACHMENT_MIME_TYPES:
        return True

    ext = os.path.splitext((filename or "").strip().lower())[1]
    return ext in ALLOWED_ATTACHMENT_EXTENSIONS


def get_db_summary(
    db_path: str,
    account_key: Optional[str] = None,
    service: Optional[str] = None,
) -> Dict[str, Optional[str]]:
    """Return high-level counts from the ingestion database."""
    conn = open_sqlite_rw(db_path)
    try:
        norm_key = normalize_user_key(account_key)
        norm_service = (service or "").strip().lower() or None

        def service_suffix(prefix_alias: str, include_service_filter: bool) -> str:
            if include_service_filter:
                return f" AND {prefix_alias}.source = ?"
            return ""

        if norm_key:
            messages = conn.execute("SELECT COUNT(*) AS c FROM messages WHERE account_key = ?", (norm_key,)).fetchone()["c"]
            dates = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_dates d
                LEFT JOIN messages m ON CAST(m.id AS TEXT) = d.message_id OR m.source_msg_key = d.message_id
                WHERE m.account_key = ? OR d.message_id LIKE 'outlook_cal_%'
                """,
                (norm_key,),
            ).fetchone()["c"]
            links = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_links l
                JOIN messages m ON m.id = l.message_id
                WHERE m.account_key = ?
                """,
                (norm_key,),
            ).fetchone()["c"]
            attachments = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_attachments a
                JOIN messages m ON m.id = a.message_id
                                WHERE m.account_key = ?
                                    AND (
                                        LOWER(COALESCE(a.mime_type, '')) IN (
                                            'application/pdf',
                                            'application/msword',
                                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                        )
                                        OR LOWER(COALESCE(a.filename, '')) LIKE '%.pdf'
                                        OR LOWER(COALESCE(a.filename, '')) LIKE '%.doc'
                                        OR LOWER(COALESCE(a.filename, '')) LIKE '%.docx'
                                    )
                """,
                (norm_key,),
            ).fetchone()["c"]
            latest_row = conn.execute(
                "SELECT sent_at_utc FROM messages WHERE account_key = ? ORDER BY source_rowid DESC LIMIT 1",
                (norm_key,),
            ).fetchone()
        else:
            messages = conn.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"]
            dates = conn.execute("SELECT COUNT(*) AS c FROM extracted_dates").fetchone()["c"]
            links = conn.execute("SELECT COUNT(*) AS c FROM extracted_links").fetchone()["c"]
            attachments = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM extracted_attachments a
                WHERE
                    LOWER(COALESCE(a.mime_type, '')) IN (
                        'application/pdf',
                        'application/msword',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    )
                    OR LOWER(COALESCE(a.filename, '')) LIKE '%.pdf'
                    OR LOWER(COALESCE(a.filename, '')) LIKE '%.doc'
                    OR LOWER(COALESCE(a.filename, '')) LIKE '%.docx'
                )
            """
            attachments = conn.execute(attachments_sql, tuple(attachments_params)).fetchone()["c"]

            # Latest
            latest_sql = "SELECT sent_at_utc FROM messages WHERE account_key = ?"
            latest_params = [norm_key]
            if norm_service:
                latest_sql += " AND source = ?"
                latest_params.append(norm_service)
            latest_sql += " ORDER BY source_rowid DESC LIMIT 1"
            latest_row = conn.execute(latest_sql, tuple(latest_params)).fetchone()
        else:
            # Global counts (not used by the app, but keep functional).
            messages_sql = "SELECT COUNT(*) AS c FROM messages"
            params: List[str] = []
            if norm_service:
                messages_sql += " WHERE source = ?"
                params.append(norm_service)
            messages = conn.execute(messages_sql, tuple(params)).fetchone()["c"]

            dates_sql = "SELECT COUNT(*) AS c FROM extracted_dates d"
            dates_params = []
            if norm_service:
                dates_sql = (
                    "SELECT COUNT(*) AS c FROM extracted_dates d "
                    "JOIN messages m ON m.id = d.message_id "
                    "WHERE m.source = ?"
                )
                dates_params = [norm_service]
            dates = conn.execute(dates_sql, tuple(dates_params)).fetchone()["c"]

            links_sql = "SELECT COUNT(*) AS c FROM extracted_links l"
            links_params = []
            if norm_service:
                links_sql = (
                    "SELECT COUNT(*) AS c FROM extracted_links l "
                    "JOIN messages m ON m.id = l.message_id "
                    "WHERE m.source = ?"
                )
                links_params = [norm_service]
            links = conn.execute(links_sql, tuple(links_params)).fetchone()["c"]

            # Attachment counting uses extracted_attachments only.
            attachments_sql = """
                SELECT COUNT(*) AS c
                FROM extracted_attachments a
            """
            attachments = conn.execute(attachments_sql).fetchone()["c"]

            if norm_service:
                latest_row = conn.execute(
                    "SELECT sent_at_utc FROM messages WHERE source = ? ORDER BY source_rowid DESC LIMIT 1",
                    (norm_service,),
                ).fetchone()
            else:
                latest_row = conn.execute(
                    "SELECT sent_at_utc FROM messages ORDER BY source_rowid DESC LIMIT 1"
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


def fetch_db_snapshot(
    db_path: str,
    limit: int = 20,
    account_key: Optional[str] = None,
    service: Optional[str] = None,
) -> Dict[str, List[Dict]]:
    """Return recent rows from messages, extracted_dates, extracted_links, and attachments."""
    conn = open_sqlite_rw(db_path)
    norm_key = normalize_user_key(account_key)
    try:
        if norm_key:
            msgs = conn.execute(
                """
                SELECT m.id, m.sender, m.sent_at_utc, substr(m.text, 1, 200) AS snippet,
                       c.thread_key AS thread_id, m.source_msg_key AS gmail_message_id,
                       m.source, m.category, m.priority, m.summary_phrase, m.description
                FROM messages m
                LEFT JOIN conversations c ON m.conversation_id = c.id
                WHERE m.account_key = ?
                ORDER BY m.source_rowid DESC
                LIMIT ?
                """,
                (norm_key, limit),
            ).fetchall()

                attachments = conn.execute(
                    """
                    SELECT a.id, a.message_id, a.filename, a.mime_type, a.original_path
                    FROM extracted_attachments a
                    JOIN messages m ON m.id = a.message_id
                                    WHERE m.account_key = ?
                                      AND m.source = ?
                                      AND (
                                          LOWER(COALESCE(a.mime_type, '')) IN (
                                              'application/pdf',
                                              'application/msword',
                                              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                          )
                                          OR LOWER(COALESCE(a.filename, '')) LIKE '%.pdf'
                                          OR LOWER(COALESCE(a.filename, '')) LIKE '%.doc'
                                          OR LOWER(COALESCE(a.filename, '')) LIKE '%.docx'
                                      )
                    ORDER BY a.id DESC
                    LIMIT ?
                    """,
                    (norm_key, norm_service, limit),
                ).fetchall()

                dates = conn.execute(
                    """
                    SELECT d.id, d.message_id, d.raw_span, d.resolved_date, d.parsed_at_utc
                    FROM extracted_dates d
                    JOIN messages m ON m.id = d.message_id
                    WHERE m.account_key = ?
                      AND m.source = ?
                    ORDER BY d.id DESC
                    LIMIT ?
                    """,
                    (norm_key, norm_service, limit),
                ).fetchall()

                links = conn.execute(
                    """
                    SELECT l.id, l.message_id, l.url, m.sender_name, m.sender, m.text
                    FROM extracted_links l
                    JOIN messages m ON m.id = l.message_id
                    WHERE m.account_key = ?
                      AND m.source = ?
                    ORDER BY l.id DESC
                    LIMIT ?
                    """,
                    (norm_key, norm_service, limit),
                ).fetchall()
            else:
                msgs = conn.execute(
                    """
                    SELECT id, sender, sender_name, sent_at_utc, text, substr(text, 1, 200) AS snippet
                    FROM messages
                    WHERE account_key = ?
                    ORDER BY source_rowid DESC
                    LIMIT ?
                    """,
                    (norm_key, limit),
                ).fetchall()

                attachments = conn.execute(
                    """
                    SELECT a.id, a.message_id, a.filename, a.mime_type, a.original_path
                    FROM extracted_attachments a
                    JOIN messages m ON m.id = a.message_id
                                    WHERE m.account_key = ?
                                    AND (
                                        LOWER(COALESCE(a.mime_type, '')) IN (
                                            'application/pdf',
                                            'application/msword',
                                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                        )
                                        OR LOWER(COALESCE(a.filename, '')) LIKE '%.pdf'
                                        OR LOWER(COALESCE(a.filename, '')) LIKE '%.doc'
                                        OR LOWER(COALESCE(a.filename, '')) LIKE '%.docx'
                                    )
                    ORDER BY a.id DESC
                    LIMIT ?
                    """,
                    (norm_key, limit),
                ).fetchall()

            dates = conn.execute(
                """
                SELECT d.id, d.message_id, d.raw_span, d.resolved_date, d.parsed_at_utc
                FROM extracted_dates d
                LEFT JOIN messages m ON CAST(m.id AS TEXT) = d.message_id OR m.source_msg_key = d.message_id
                WHERE m.account_key = ? OR d.message_id LIKE 'outlook_cal_%'
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
                    WHERE m.account_key = ?
                    ORDER BY l.id DESC
                    LIMIT ?
                    """,
                    (norm_key, limit),
                ).fetchall()
        else:
            msgs = conn.execute(
                """
                SELECT id, sender, sender_name, sent_at_utc, text, substr(text, 1, 200) AS snippet
                FROM messages
                ORDER BY source_rowid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

            attachments = conn.execute(
                """
                SELECT id, message_id, filename, mime_type, original_path
                                FROM extracted_attachments a
                                WHERE
                                    LOWER(COALESCE(a.mime_type, '')) IN (
                                        'application/pdf',
                                        'application/msword',
                                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                    )
                                    OR LOWER(COALESCE(a.filename, '')) LIKE '%.pdf'
                                    OR LOWER(COALESCE(a.filename, '')) LIKE '%.doc'
                                    OR LOWER(COALESCE(a.filename, '')) LIKE '%.docx'
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

            dates = conn.execute(
                """
                SELECT id, message_id, raw_span, resolved_date, parsed_at_utc
                FROM extracted_dates
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

            links = conn.execute(
                """
                SELECT l.id, l.message_id, l.url, m.sender_name, m.sender, m.text
                FROM extracted_links l
                LEFT JOIN messages m ON m.id = l.message_id
                ORDER BY l.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        def rows_to_dict(rows: List[sqlite3.Row]) -> List[Dict]:
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
            # fallback: use first non-empty line
            for line in text_val.splitlines():
                line = line.strip()
                if line:
                    return line
            return None

        msg_dicts = rows_to_dict(msgs)
        for m in msg_dicts:
            m['subject'] = derive_subject(m.get('text'))

        link_dicts = rows_to_dict(links)
        for l in link_dicts:
            l['subject'] = derive_subject(l.get('text'))
            l.pop('text', None)

        attachment_dicts = rows_to_dict(attachments)
        attachment_dicts = [
            a for a in attachment_dicts
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


def gmail_auth(creds_path: str = "credentials.json", token_path: str = "token.json", force_reauth: bool = False):
    # Reauth only when explicitly requested.
    if force_reauth and os.path.exists(token_path):
        os.remove(token_path)

    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_path, "w") as f:
            f.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)


def calendar_auth(creds_path: str = "credentials.json", token_path: str = "token.json", force_reauth: bool = False):
    """Authenticate and return a Google Calendar v3 service client."""
    # Reauth only when explicitly requested.
    if force_reauth and os.path.exists(token_path):
        os.remove(token_path)

    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_path, "w") as f:
            f.write(creds.to_json())

    return build("calendar", "v3", credentials=creds)


def header_map(headers: List[Dict[str, str]]) -> Dict[str, str]:
    out = {}
    for h in headers:
        k = (h.get("name") or "").lower()
        v = h.get("value") or ""
        if k:
            out[k] = v
    return out


def b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def walk_parts(payload: Dict) -> Iterable[Dict]:
    stack = [payload]
    while stack:
        p = stack.pop()
        yield p
        for child in p.get("parts", []) or []:
            stack.append(child)


def extract_best_text(payload: Dict) -> str:
    text_plain = []
    text_html = []

    for part in walk_parts(payload):
        mime = part.get("mimeType", "")
        body = part.get("body") or {}
        data = body.get("data")
        if not data:
            continue

        decoded = b64url_decode(data).decode("utf-8", errors="replace")

        if mime == "text/plain":
            text_plain.append(decoded)
        elif mime == "text/html":
            text_html.append(decoded)

    if text_plain:
        return "\n".join(text_plain)

    if text_html:
        s = "\n".join(text_html)
        s = re.sub(r"(?is)<(script|style).*?>.*?</\\1>", "", s)
        s = re.sub(r"(?is)<br\\s*/?>", "\\n", s)
        s = re.sub(r"(?is)</p\\s*>", "\\n", s)
        s = re.sub(r"(?is)<[^>]+>", "", s)
        s = re.sub(r"\\n{3,}", "\\n\\n", s)
        return s.strip()

    return ""


def extract_attachment_metas(payload: Dict) -> List[Tuple[str, str, str]]:
    out = []
    for part in walk_parts(payload):
        filename = part.get("filename") or ""
        mime = part.get("mimeType") or ""
        body = part.get("body") or {}
        attachment_id = body.get("attachmentId") or ""
        if filename and attachment_id:
            out.append((filename, mime, attachment_id))
    return out


# Modify the `list_message_ids_since` function to ensure it retrieves the correct emails.
def list_message_ids_since(service, user_id: str, after_seconds: int, max_pages: int = 25) -> Tuple[List[str], str]:
    def run_query(query: Optional[str], include_spam_trash: bool) -> List[str]:
        ids: List[str] = []
        page_token = None
        for _ in range(max_pages):
            kwargs = {
                "userId": user_id,
                "includeSpamTrash": include_spam_trash,
                "pageToken": page_token,
                "maxResults": 200,
            }
            if query:
                kwargs["q"] = query

            resp = service.users().messages().list(**kwargs).execute()
            ids.extend([m["id"] for m in resp.get("messages", []) or []])

            page_token = resp.get("nextPageToken")
            if not page_token:
                break
        return ids

    two_weeks_seconds = 14 * 24 * 60 * 60
    two_week_floor_seconds = int(datetime.now(tz=timezone.utc).timestamp()) - two_weeks_seconds
    effective_after = max(after_seconds, two_week_floor_seconds)
    after_date_str = datetime.fromtimestamp(effective_after, tz=timezone.utc).strftime("%Y/%m/%d")

    # Primary: only Gmail Primary category in the last two weeks.
    primary_q = f"category:primary -category:social -category:promotions -category:updates after:{after_date_str}"
    primary_ids = run_query(primary_q, include_spam_trash=False)
    if primary_ids:
        return list(dict.fromkeys(primary_ids)), primary_q

    # Fallback 1: primary category with explicit 14-day relative query.
    fallback_q = "category:primary -category:social -category:promotions -category:updates newer_than:14d"
    fallback_ids = run_query(query=fallback_q, include_spam_trash=False)
    if fallback_ids:
        return list(dict.fromkeys(fallback_ids)), fallback_q

    return [], primary_q


# Ensure the `ingest_gmail` function uses the correct `after_seconds` value.
def ingest_gmail(
    out_db_path: str,
    source: str = "gmail",
    user_id: str = "me",
    reset_cursor_flag: bool = False,
    force_reauth: bool = False,
    token_path: str = "token.json",
    account_key: Optional[str] = None,
) -> Dict[str, int]:
    conn = open_sqlite_rw(out_db_path)
    service = gmail_auth(token_path=token_path, force_reauth=force_reauth)

    account_email = None
    try:
        profile = service.users().getProfile(userId=user_id).execute()
        account_email = profile.get('emailAddress')
        logger.info(f"Authenticated Gmail account: {account_email}")
    except Exception as e:
        logger.warning(f"Unable to read Gmail profile: {e}")

    if reset_cursor_flag:
        reset_cursor(conn, source)
        conn.commit()
    last_ms = get_last_cursor(conn, source)
    last_dt = datetime.fromtimestamp(last_ms / 1000, tz=timezone.utc) if last_ms else datetime(1970, 1, 1, tzinfo=timezone.utc)

    # Use a safety lookback window so late-arriving or re-labeled mail is not missed.
    safety_lookback_seconds = 3 * 24 * 60 * 60
    after_seconds = max(0, int(last_dt.timestamp()) - safety_lookback_seconds)

    msg_ids, query_used = list_message_ids_since(service, user_id=user_id, after_seconds=after_seconds)
    if not msg_ids:
        logger.info(f"No new Gmail messages to ingest. account={account_email} query='{query_used}' after_seconds={after_seconds}")
        conn.close()
        return {
            "processed": 0,
            "inserted": 0,
            "account_email": account_email,
            "query_used": query_used,
            "after_seconds": after_seconds,
        }

    max_internal_ms_seen = last_ms

    inserted_count = 0
    try:
        if conn.in_transaction:
            conn.commit()
        conn.execute("BEGIN")
        for mid in msg_ids:
            msg = service.users().messages().get(userId=user_id, id=mid, format="full").execute()

            internal_ms = int(msg.get("internalDate", "0"))
            if internal_ms <= 0:
                continue
            max_internal_ms_seen = max(max_internal_ms_seen, internal_ms)

            payload = msg.get("payload") or {}
            headers = header_map(payload.get("headers", []) or [])
            sender = headers.get("from")
            sender_name_hdr, sender_email_hdr = parseaddr(sender or "")
            sender_name = (sender_name_hdr or "").strip() or (sender_email_hdr or "").strip() or (sender or "")
            subject = headers.get("subject") or ""

            thread_id = msg.get("threadId") or mid
            sent_at_utc = datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

            body_text = extract_best_text(payload)
            combined = (f"Subject: {subject}\n" if subject else "") + body_text

            if not combined.strip():
                continue

            conv_id = upsert_conversation(conn, source, thread_id, display_name=subject)
            msg_id_db = insert_message(
                conn,
                source=source,
                source_msg_key=mid,
                source_rowid=internal_ms,
                conversation_id=conv_id,
                sender=sender,
                sender_name=sender_name,
                account_key=normalize_user_key(account_key),
                account_email=account_email,
                sent_at_utc=sent_at_utc,
                text=combined,
            )

            if msg_id_db is None:
                continue

            inserted_count += 1

            insert_extractions(conn, msg_id_db, combined, sent_at_utc)

            for filename, mime, attachment_id in extract_attachment_metas(payload):
                insert_attachment_meta(conn, msg_id_db, filename, mime, attachment_id)

        set_last_cursor(conn, source, max_internal_ms_seen)
        conn.commit()
        logger.info(f"Done. ingested={len(msg_ids)} cursor_ms={max_internal_ms_seen}")
        return {
            "processed": len(msg_ids),
            "inserted": inserted_count,
            "account_email": account_email,
            "query_used": query_used,
            "after_seconds": after_seconds,
        }
    except Exception:
        if conn.in_transaction:
            conn.rollback()
        raise
    finally:
        conn.close()


def start_auto_ingest_worker(db_path: str = "extracted.db", interval_seconds: int = 300) -> None:
    def _worker() -> None:
        while True:
            try:
                stats = ingest_gmail(db_path, reset_cursor_flag=False, force_reauth=False)
                logger.info(f"Auto-ingest tick: processed={stats.get('processed', 0)} inserted={stats.get('inserted', 0)}")
            except Exception as e:
                logger.error(f"Auto-ingest tick failed: {e}")
            time.sleep(max(10, interval_seconds))

    t = threading.Thread(target=_worker, daemon=True, name="gmail-auto-ingest")
    t.start()


def process_email(
    conn: sqlite3.Connection,
    source: str,
    thread_key: str,
    source_msg_key: str,
    source_rowid: int,
    sender: Optional[str],
    sent_at_utc: str,
    text: str,
    subject: Optional[str] = None,
):
    """
    Process an email: insert the message and extract dates/links.
    """
    # Upsert the conversation
    conversation_id = upsert_conversation(conn, source=source, thread_key=thread_key, display_name=subject)

    # Insert the message
    sender_name_hdr, sender_email_hdr = parseaddr(sender or "")
    sender_name = (sender_name_hdr or "").strip() or (sender_email_hdr or "").strip() or (sender or "")
    message_id = insert_message(
        conn,
        source=source,
        source_msg_key=source_msg_key,
        source_rowid=source_rowid,
        conversation_id=conversation_id,
        sender=sender,
        sender_name=sender_name,
        account_key=None,
        account_email=None,
        sent_at_utc=sent_at_utc,
        text=text,
    )

    if message_id is None:
        logger.info(f"Message already exists: source={source}, source_rowid={source_rowid}")
        return

    # Extract and insert dates/links
    insert_extractions(conn, message_id=message_id, text=text, sent_at_utc=sent_at_utc)
    logger.info(f"Processed email: message_id={message_id}")


def get_range(calendar, start: datetime, end: Optional[datetime] = None):
    events = []

    if end is not None:
        for id in CALENDARS:
            events += calendar.events().list(
                calendarId=id,
                timeMin=start.isoformat(),
                timeMax=end.isoformat(),
                singleEvents=True,
                orderBy="startTime"
            ).execute().get("items", [])
    else:
        for id in CALENDARS:
            events += calendar.events().list(
                calendarId=id,
                timeMin=start.isoformat(),
                singleEvents=True,
                orderBy="startTime"
            ).execute().get("items", [])

    return events


def get_this_month(calendar):
    now = datetime.now(timezone.utc)
    return get_range(calendar, now, now+timedelta(days=30))


def get_new_events(calendar, updated_after: datetime):
    """
    Return events created or modified after `updated_after`.
    """
    events = []

    for id in CALENDARS:
        events += calendar.events().list(
            calendarId=id,
            updatedMin=updated_after.isoformat(),
            singleEvents=True,
            showDeleted=False,
            orderBy="updated"
        ).execute().get("items", [])

    return events


def ingest_calendar_events(out_db_path: str, source: str = "gcal") -> Dict[str, int]:
    conn = open_sqlite_rw(out_db_path)
    _ensure_events_duration_seconds_column(conn)

    calendar = get_calendar()

    last_cursor = get_last_cursor(conn, source)
    last_dt = (
        datetime.fromtimestamp(last_cursor / 1000, tz=timezone.utc)
        if last_cursor
        else datetime(1970, 1, 1, tzinfo=timezone.utc)
    )

    events = get_new_events(calendar, last_dt)
    if not events:
        logger.info("No new calendar events to ingest.")
        conn.close()
        return {"processed": 0, "inserted": 0}

    inserted = 0
    max_updated_ms = last_cursor

    conn.execute("BEGIN;")
    try:
        for e in events:
            event_id = e.get("id")
            updated = e.get("updated")
            if not event_id or not updated:
                continue

            updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            updated_ms = int(updated_dt.timestamp() * 1000)

            if updated_ms <= last_cursor:
                continue

            max_updated_ms = max(max_updated_ms, updated_ms)

            start_raw = e.get("start", {})
            end_raw = e.get("end", {})

            start = start_raw.get("dateTime") or start_raw.get("date")
            end = end_raw.get("dateTime") or end_raw.get("date")
            if not start or not end:
                continue

            summary = e.get("summary")
            description = e.get("description")
            location = e.get("location")

            duration_seconds = None
            try:
                start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
                end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
                duration_seconds = int((end_dt - start_dt).total_seconds())
            except (ValueError, TypeError):
                pass

            try:
                conn.execute(
                    """
                    INSERT INTO events(start_utc, end_utc, summary, description, location, duration_seconds)
                    VALUES(?, ?, ?, ?, ?, ?)
                    """,
                    (
                        start,
                        end,
                        summary,
                        description,
                        location,
                        duration_seconds,
                    ),
                )
                inserted += 1
            except sqlite3.IntegrityError:
                continue

        set_last_cursor(conn, source, max_updated_ms)
        conn.execute("COMMIT;")
        logger.info(f"Calendar ingestion complete. processed={len(events)} inserted={inserted}")
        return {"processed": len(events), "inserted": inserted}
    except Exception:
        conn.execute("ROLLBACK;")
        raise
    finally:
        conn.close()


class Person(TypedDict):
    email: str
    optional: NotRequired[bool]

class Event(TypedDict):
    start: datetime
    end: datetime
    summary: str
    description: str
    location: NotRequired[str]
    attendees: NotRequired[list[Person]]

def make_event(calendar, calendarId: str, event: Event):
    return calendar.events().insert(
        calendarId=calendarId,
        body=event | {
            "start": {
                "dateTime": event["start"].isoformat(),
                "timeZone": str(event["start"].tzinfo), 
            },
            "end": {
                "dateTime": event["end"].isoformat(),
                "timeZone": str(event["end"].tzinfo), 
            },
        },
    ).execute()


class Email(TypedDict):
    Subject: str
    To: str | list[str]
    # TODO: add cc, bcc, etc
    Content: str


def send_email(gmail, message: Email, thread_id: Optional[str] = None):
    email = EmailMessage()
    email.set_content(message["Content"])
    email["From"] = "me"
    email["To"] = ", ".join(message["To"]) if isinstance(message["To"], list) else message["To"]
    email["Subject"] = message["Subject"]

    create_message = {"raw": base64.urlsafe_b64encode(email.as_bytes()).decode()}
    if thread_id:
        create_message["threadId"] = thread_id
    return gmail.users().messages().send(userId="me", body=create_message).execute()


def send_reply_in_thread(
    gmail,
    to_addr: str,
    subject: str,
    content: str,
    thread_id: str,
    gmail_message_id: str,
) -> dict:
    """
    Send a reply in the same thread by fetching the original message's Message-ID
    and setting In-Reply-To and References headers. Required for proper threading.
    """
    msg = gmail.users().messages().get(userId="me", id=gmail_message_id, format="full").execute()
    payload = msg.get("payload") or {}
    headers = header_map(payload.get("headers", []) or [])
    orig_message_id = (headers.get("message-id") or headers.get("message_id") or "").strip()

    email = EmailMessage()
    email.set_content(content)
    email["From"] = "me"
    email["To"] = to_addr
    email["Subject"] = subject
    if orig_message_id:
        email["In-Reply-To"] = orig_message_id
        email["References"] = orig_message_id

    create_message = {
        "raw": base64.urlsafe_b64encode(email.as_bytes()).decode(),
        "threadId": thread_id,
    }
    return gmail.users().messages().send(userId="me", body=create_message).execute()


def extract_email_from_sender(sender: Optional[str]) -> str:
    """Extract email address from 'Name <email@example.com>' or return as-is if plain email."""
    if not sender or not sender.strip():
        return ""
    s = sender.strip()
    m = re.search(r"<([^>]+)>", s)
    if m:
        return m.group(1).strip()
    if "@" in s:
        return s
    return s


@app.route('/send-email', methods=['POST'])
def api_send_email():
    """Send an email via Gmail API. Expects to (or reply_to/sender), subject, content in JSON body."""
    try:
        payload = request.json or {}
        user_key = payload.get('user_key')
        service_raw = (payload.get('service') or payload.get('source') or 'gmail').strip().lower()
        service = 'calendar' if service_raw in {'calendar', 'gcal'} else 'gmail'
        if service_raw in {'gmail', 'mail', 'email'}:
            service = 'gmail'
        db_path_payload = payload.get('db_path')
        token_path, db_path = resolve_user_paths(user_key=user_key, db_path=db_path_payload)
        reset_flag = bool(payload.get('reset_cursor'))
        # By default, reuse token and only force reauth when explicitly requested.
        force_reauth_flag = payload.get('force_reauth')
        if force_reauth_flag is None:
            force_reauth_flag = False
        else:
            force_reauth_flag = bool(force_reauth_flag)

        logger.info(
            f"Starting ingestion(service={service}) for database: {db_path} token_path={token_path} "
            f"reset_cursor={reset_flag} force_reauth={force_reauth_flag}"
        )

        if service == 'calendar':
            ingest_stats = ingest_calendar_events(
                db_path,
                reset_cursor_flag=reset_flag,
                force_reauth=force_reauth_flag,
                token_path=token_path,
                account_key=user_key,
            )
            summary = get_db_summary(db_path, account_key=user_key, service=service)
            logger.info("Calendar ingestion completed successfully.")
            msg = "Calendar events ingested successfully."
        else:
            ingest_stats = ingest_gmail(
                db_path,
                reset_cursor_flag=reset_flag,
                force_reauth=force_reauth_flag,
                token_path=token_path,
                account_key=user_key,
            )
            summary = get_db_summary(db_path, account_key=user_key, service='gmail')
            logger.info("Gmail ingestion completed successfully.")
            msg = "Emails ingested successfully."

        return jsonify({
            "status": "success",
            "message": msg,
            "ingest": ingest_stats,
            "summary": summary,
        })
    except Exception as e:
        logger.error(f"Error during ingestion: {e}")
        msg = str(e)
        if "invalid_scope" in msg.lower() or "invalid_grant" in msg.lower():
            msg = (
                "Re-authorization required: your saved sign-in is missing permissions. "
                "Delete the token file (token.json or token_<your-email>.json in the backend folder) and sign in again when the app asks."
            )
        return jsonify({"status": "error", "message": msg}), 500


@app.route('/summary', methods=['GET'])
def summary():
    """Return recent messages/dates/links from the ingestion DB (optionally filtered by `service`)."""
    try:
        user_key = request.args.get('user_key')
        service_raw = (request.args.get('service') or '').strip().lower()
        service = 'calendar' if service_raw in {'calendar', 'gcal'} else ('gmail' if service_raw in {'gmail', 'mail', 'email'} else None)
        db_path_raw = request.args.get('db_path')
        _, db_path = resolve_user_paths(user_key=user_key, db_path=db_path_raw)
        limit_raw = request.args.get('limit', '20')
        try:
            limit = max(1, min(500, int(limit_raw)))
        except ValueError:
            limit = 20
        snap = fetch_db_snapshot(db_path, limit=limit, account_key=user_key, service=service)
        stats = get_db_summary(db_path, account_key=user_key, service=service)
        return jsonify({"status": "success", "summary": stats, "data": snap})
    except Exception as e:
        logger.error(f"Error during summary fetch: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/attachment_preview', methods=['GET'])
def attachment_preview():
    """Stream attachment bytes for preview by extracted_attachments row id."""
    try:
        attachment_id_raw = (request.args.get('attachment_id') or '').strip()
        if not attachment_id_raw:
            return jsonify({"status": "error", "message": "attachment_id is required"}), 400

        try:
            attachment_id = int(attachment_id_raw)
        except ValueError:
            return jsonify({"status": "error", "message": "attachment_id must be an integer"}), 400

        user_key = normalize_user_key(request.args.get('user_key'))
        db_path_raw = request.args.get('db_path')
        _, db_path = resolve_user_paths(user_key=user_key, db_path=db_path_raw)

        conn = open_sqlite_rw(db_path)
        try:
            if user_key:
                row = conn.execute(
                    """
                    SELECT a.id, a.filename, a.mime_type, a.original_path, m.source_msg_key, m.account_key
                    FROM extracted_attachments a
                    JOIN messages m ON m.id = a.message_id
                    WHERE a.id = ? AND m.account_key = ?
                    LIMIT 1
                    """,
                    (attachment_id, user_key),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT a.id, a.filename, a.mime_type, a.original_path, m.source_msg_key, m.account_key
                    FROM extracted_attachments a
                    JOIN messages m ON m.id = a.message_id
                    WHERE a.id = ?
                    LIMIT 1
                    """,
                    (attachment_id,),
                ).fetchone()
        finally:
            conn.close()

        if not row:
            return jsonify({"status": "error", "message": "Attachment not found"}), 404

        original_path = (row["original_path"] or "").strip()
        prefix = "gmail_attachment_id:"
        if not original_path.startswith(prefix):
            return jsonify({"status": "error", "message": "Attachment preview source is unsupported"}), 400

        gmail_attachment_id = original_path[len(prefix):].strip()
        if not gmail_attachment_id:
            return jsonify({"status": "error", "message": "Missing Gmail attachment id"}), 400

        message_id = (row["source_msg_key"] or "").strip()
        if not message_id:
            return jsonify({"status": "error", "message": "Missing source message id for attachment"}), 400

        effective_key = user_key or row["account_key"]
        token_path, _ = resolve_user_paths(user_key=effective_key, db_path=db_path_raw)
        service = gmail_auth(token_path=token_path, force_reauth=False)

        attachment = service.users().messages().attachments().get(
            userId='me', messageId=message_id, id=gmail_attachment_id
        ).execute()

        data_b64 = attachment.get('data') or ''
        if not data_b64:
            return jsonify({"status": "error", "message": "Attachment data is empty"}), 404

        padding = '=' * (-len(data_b64) % 4)
        blob = base64.urlsafe_b64decode(data_b64 + padding)

        filename = (row["filename"] or "attachment").replace('"', '')
        mime_type = row["mime_type"] or 'application/octet-stream'
        headers = {
            'Content-Disposition': f'inline; filename="{filename}"'
        }
        return Response(blob, mimetype=mime_type, headers=headers)
    except Exception as e:
        logger.error(f"Error during attachment preview fetch: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/routes', methods=['GET'])
def routes():
    """Debug endpoint: list all registered Flask routes."""
    rule_rows = []
    for rule in app.url_map.iter_rules():
        methods = sorted([m for m in rule.methods if m not in {"HEAD", "OPTIONS"}])
        rule_rows.append({
            "rule": str(rule),
            "methods": methods,
            "endpoint": rule.endpoint,
        })
    rule_rows.sort(key=lambda x: x["rule"])
    return jsonify({"status": "success", "routes": rule_rows})


@app.route('/lookup_message', methods=['GET'])
def lookup_message():
    """Find ingested messages by keyword and include extracted date rows for each message."""
    try:
        db_path = request.args.get('db_path', 'extracted.db')
        user_key = normalize_user_key(request.args.get('user_key'))
        q = (request.args.get('q') or '').strip()
        if not q:
            return jsonify({"status": "error", "message": "Query parameter q is required."}), 400

        conn = open_sqlite_rw(db_path)
        try:
            if user_key:
                rows = conn.execute(
                    """
                    SELECT id, sender, sent_at_utc, substr(text, 1, 300) AS snippet
                    FROM messages
                    WHERE account_key = ? AND text LIKE ?
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
                    WHERE text LIKE ?
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
                out.append({
                    "message": dict(r),
                    "dates": [dict(d) for d in dates],
                })

            return jsonify({"status": "success", "count": len(out), "results": out})
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Error during lookup_message: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/suggest_reply', methods=['POST'])
@app.route('/suggest-reply', methods=['POST'])
@app.route('/reply_suggestions', methods=['POST'])
@app.route('/api/suggest_reply', methods=['POST'])
def suggest_reply():
    """Generate AI reply suggestions for a message payload."""
    try:
        payload = request.json or {}
        subject = (payload.get('subject') or '').strip()
        body = (payload.get('body') or '').strip()
        sender_name = (payload.get('sender_name') or '').strip()

        if not subject and not body:
            return jsonify({"status": "error", "message": "subject or body is required"}), 400

        suggestions = ai_reply_suggestions(subject, body, sender_name)
        return jsonify({"status": "success", "suggestions": suggestions})
    except Exception as e:
        logger.error(f"Error during suggest_reply: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/send_reply', methods=['POST'])
@app.route('/api/send_reply', methods=['POST'])
def send_reply():
    """Send an email reply in the same Gmail thread. Requires message_id (e.g. gmail-123), user_key, body, optional subject."""
    try:
        payload = request.json or {}
        user_key = (payload.get('user_key') or '').strip()
        message_id_composite = (payload.get('message_id') or '').strip()
        body = (payload.get('body') or '').strip()
        subject = (payload.get('subject') or '').strip()

        if not user_key or not message_id_composite:
            return jsonify({"status": "error", "message": "user_key and message_id are required"}), 400
        if not body:
            return jsonify({"status": "error", "message": "body is required"}), 400

        parts = message_id_composite.split("-", 1)
        if len(parts) != 2:
            return jsonify({"status": "error", "message": "message_id must be like gmail-123"}), 400
        source, db_id_str = parts[0].strip().lower(), parts[1].strip()
        if source != "gmail":
            return jsonify({"status": "error", "message": "Only Gmail replies are supported"}), 400
        try:
            db_id = int(db_id_str)
        except ValueError:
            return jsonify({"status": "error", "message": "message_id must be like gmail-123"}), 400

        token_path, db_path = resolve_user_paths(user_key=user_key, db_path=payload.get('db_path'))
        norm_key = normalize_user_key(user_key)

        conn = open_sqlite_rw(db_path)
        try:
            row = conn.execute(
                """
                SELECT m.source_msg_key, m.sender, m.text, m.conversation_id
                FROM messages m
                WHERE m.id = ? AND m.source = 'gmail' AND m.account_key = ?
                LIMIT 1
                """,
                (db_id, norm_key),
            ).fetchone()
            if not row:
                return jsonify({"status": "error", "message": "Message not found"}), 404
            thread_row = conn.execute(
                "SELECT thread_key FROM conversations WHERE id = ? LIMIT 1",
                (row["conversation_id"],),
            ).fetchone()
        finally:
            conn.close()

        if not thread_row:
            return jsonify({"status": "error", "message": "Conversation not found"}), 404

@app.route('/summary', methods=['GET'])
def summary():
    """Return recent messages, dates, and links from the ingestion DB."""
    try:
        user_key = request.args.get('user_key')
        db_path_raw = request.args.get('db_path')
        db_path = db_path_raw or "extracted.db"
        limit_raw = request.args.get('limit', '20')
        try:
            limit = max(1, min(500, int(limit_raw)))
        except ValueError:
            limit = 20
        snap = fetch_db_snapshot(db_path, limit=limit, account_key=user_key)
        stats = get_db_summary(db_path, account_key=user_key)
        return jsonify({"status": "success", "summary": stats, "data": snap})
    except Exception as e:
        logger.error(f"Error during send_reply: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    # Do not auto-ingest on startup by default; onboarding-triggered /ingest should control auth prompts.
    if os.environ.get("ENABLE_STARTUP_AUTO_INGEST", "0") == "1":
        try:
            logger.info("Auto-start ingest on startup: force_reauth=False reset_cursor=False")
            ingest_gmail("extracted.db", reset_cursor_flag=False, force_reauth=False)
        except Exception as e:
            logger.error(f"Auto ingest on startup failed: {e}")

    if os.environ.get("ENABLE_BACKGROUND_INGEST", "0") == "1":
        start_auto_ingest_worker("extracted.db", AUTO_INGEST_INTERVAL_SECONDS)

    app.run(debug=False, host="0.0.0.0", port=5001)