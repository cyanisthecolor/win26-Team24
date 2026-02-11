import base64
import os
import re
import sqlite3
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

from dateparser.search import search_dates

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

URL_RE = re.compile(
    r"""(?xi)
    \b(
      https?://[^\s<>()"]+ |
      www\.[^\s<>()"]+
    )
    """
)

import re

DATE_KEYWORDS = [
    "today", "tomorrow", "tonight",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "week", "month", "year",
    "am", "pm",
    "due", "deadline", "submit", "meeting", "call", "interview"
]

def looks_like_real_date(raw: str) -> bool:
    s = (raw or "").lower().strip()

    # Too short → almost always garbage
    if len(s) < 4:
        return False

    # Pure stopword-ish junk often shows up
    if s in {"to to", "on in", "in on", "we may"}:
        return False

    # If it has a digit, it's more likely a real date/time
    if any(c.isdigit() for c in s):
        return True

    # If it contains a known date word, keep it
    if any(k in s for k in DATE_KEYWORDS):
        return True

    return False



def open_sqlite_rw(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    return conn


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
    source_rowid: int,  # Gmail internalDate (ms)
    conversation_id: int,
    sender: Optional[str],
    sent_at_utc: str,
    text: str,
) -> Optional[int]:
    try:
        conn.execute(
            """
            INSERT INTO messages(source, source_rowid, conversation_id, sender, is_from_me, sent_at_utc, text)
            VALUES(?, ?, ?, ?, 0, ?, ?)
            """,
            (source, source_rowid, conversation_id, sender, sent_at_utc, text),
        )
    except sqlite3.IntegrityError:
        return None

    msg_id = conn.execute(
        "SELECT id FROM messages WHERE source=? AND source_rowid=?",
        (source, source_rowid),
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


def extract_dates(text: str, base_dt: datetime) -> List[Tuple[str, datetime]]:
    # Avoid huge email blobs causing slow parsing
    text = (text or "")[:5000]

    settings = {
        "RELATIVE_BASE": base_dt,
        "PREFER_DATES_FROM": "future",
        "SKIP_TOKENS": ["http", "https", "www"],
    }

    # Force English to avoid slow language autodetection
    try:
        results = search_dates(text, languages=["en"], settings=settings) or []
    except Exception:
        return []

    out: List[Tuple[str, datetime]] = []
    for raw, dt in results:
        raw = (raw or "").strip()

        # Drop extremely long spans (usually false positives / whole sentences)
        if len(raw) > 40:
            continue

        # Filter out nonsense spans
        if not looks_like_real_date(raw):
            continue

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=base_dt.tzinfo)

        out.append((raw, dt.astimezone(timezone.utc)))

    return out


def insert_extractions(conn: sqlite3.Connection, message_id: int, text: str, sent_at_utc: str) -> None:
    base_dt = datetime.fromisoformat(sent_at_utc.replace("Z", "+00:00")).astimezone(timezone.utc)

    for url in extract_urls(text):
        conn.execute("INSERT INTO extracted_links(message_id, url) VALUES(?, ?)", (message_id, url))

    for raw, dt_utc in extract_dates(text, base_dt):
        conn.execute(
            "INSERT INTO extracted_dates(message_id, raw_span, parsed_at_utc, confidence) VALUES(?, ?, ?, ?)",
            (message_id, raw, dt_utc.isoformat(timespec="seconds").replace("+00:00", "Z"), None),
        )


def insert_attachment_meta(conn: sqlite3.Connection, message_id: int, filename: str, mime: str, attachment_id: str) -> None:
    conn.execute(
        """
        INSERT INTO extracted_attachments(message_id, filename, mime_type, original_path)
        VALUES(?, ?, ?, ?)
        """,
        (message_id, filename, mime, f"gmail_attachment_id:{attachment_id}"),
    )


def gmail_auth(creds_path: str = "credentials.json", token_path: str = "token.json"):
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


def list_message_ids_since(service, user_id: str, after_seconds: int, max_pages: int = 25) -> List[str]:
    q = "in:inbox newer_than:1d"
    ids = []
    page_token = None

    for _ in range(max_pages):
        resp = service.users().messages().list(
            userId=user_id,
            q=q,
            pageToken=page_token,
            maxResults=200
        ).execute()

        ids.extend([m["id"] for m in resp.get("messages", []) or []])

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return ids


def ingest_gmail(out_db_path: str, source: str = "gmail", user_id: str = "me") -> None:
    conn = open_sqlite_rw(out_db_path)
    service = gmail_auth()

    last_ms = get_last_cursor(conn, source)
    last_dt = datetime.fromtimestamp(last_ms / 1000, tz=timezone.utc) if last_ms else datetime(1970, 1, 1, tzinfo=timezone.utc)

    after_seconds = max(0, int(last_dt.timestamp()) - 120)

    msg_ids = list_message_ids_since(service, user_id=user_id, after_seconds=after_seconds)
    if not msg_ids:
        print("No new Gmail messages to ingest.")
        return

    max_internal_ms_seen = last_ms

    conn.execute("BEGIN;")
    try:
        for mid in msg_ids:
            msg = service.users().messages().get(userId=user_id, id=mid, format="full").execute()

            internal_ms = int(msg.get("internalDate", "0"))
            if internal_ms <= 0:
                continue
            max_internal_ms_seen = max(max_internal_ms_seen, internal_ms)

            payload = msg.get("payload") or {}
            headers = header_map(payload.get("headers", []) or [])
            sender = headers.get("from")
            subject = headers.get("subject") or ""

            thread_id = msg.get("threadId") or mid
            sent_at_utc = datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

            body_text = extract_best_text(payload)
            combined = (f"Subject: {subject}\n" if subject else "") + body_text

            conv_id = upsert_conversation(conn, source, thread_id, display_name=subject)
            msg_id_db = insert_message(conn, source, internal_ms, conv_id, sender, sent_at_utc, combined)

            if msg_id_db is None:
                continue

            insert_extractions(conn, msg_id_db, combined, sent_at_utc)

            for filename, mime, attachment_id in extract_attachment_metas(payload):
                insert_attachment_meta(conn, msg_id_db, filename, mime, attachment_id)

        set_last_cursor(conn, source, max_internal_ms_seen)
        conn.execute("COMMIT;")
        print(f"Done. ingested={len(msg_ids)} cursor_ms={max_internal_ms_seen}")
    except Exception:
        conn.execute("ROLLBACK;")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    ingest_gmail("extracted.db")
