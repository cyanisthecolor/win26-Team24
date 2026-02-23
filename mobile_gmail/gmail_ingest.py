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
from flask import Flask, request, jsonify
import logging

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

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

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Flask app for API integration
app = Flask(__name__)

# Modify the `looks_like_real_date` function to ensure valid spans like "tomorrow" and "Feb 22nd" are not filtered out.
def looks_like_real_date(raw: str) -> bool:
    s = (raw or "").lower().strip()

    # Too short → almost always garbage
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
    source_msg_key: str,
    source_rowid: int,  # Gmail internalDate (ms)
    conversation_id: int,
    sender: Optional[str],
    sent_at_utc: str,
    text: str,
) -> Optional[int]:
    try:
        conn.execute(
            """
            INSERT INTO messages(source, source_msg_key, source_rowid, conversation_id, sender, is_from_me, sent_at_utc, text)
            VALUES(?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (source, source_msg_key, source_rowid, conversation_id, sender, sent_at_utc, text),
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
    conn.execute(
        """
        INSERT INTO extracted_attachments(message_id, filename, mime_type, original_path)
        VALUES(?, ?, ?, ?)
        """,
        (message_id, filename, mime, f"gmail_attachment_id:{attachment_id}"),
    )


def get_db_summary(db_path: str) -> Dict[str, Optional[str]]:
    """Return high-level counts from the ingestion database."""
    conn = open_sqlite_rw(db_path)
    try:
        messages = conn.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"]
        dates = conn.execute("SELECT COUNT(*) AS c FROM extracted_dates").fetchone()["c"]
        links = conn.execute("SELECT COUNT(*) AS c FROM extracted_links").fetchone()["c"]
        attachments = conn.execute("SELECT COUNT(*) AS c FROM extracted_attachments").fetchone()["c"]
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


def fetch_db_snapshot(db_path: str, limit: int = 20) -> Dict[str, List[Dict]]:
    """Return recent rows from messages, extracted_dates, extracted_links, and attachments."""
    conn = open_sqlite_rw(db_path)
    try:
        msgs = conn.execute(
            """
            SELECT id, sender, sent_at_utc, substr(text, 1, 200) AS snippet
            FROM messages
            ORDER BY source_rowid DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        attachments = conn.execute(
            """
            SELECT id, message_id, filename, mime_type, original_path
            FROM extracted_attachments
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
            SELECT id, message_id, url
            FROM extracted_links
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        def rows_to_dict(rows: List[sqlite3.Row]) -> List[Dict]:
            return [dict(r) for r in rows]

        return {
            "messages": rows_to_dict(msgs),
            "dates": rows_to_dict(dates),
            "links": rows_to_dict(links),
            "attachments": rows_to_dict(attachments),
        }
    finally:
        conn.close()


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


# Modify the `list_message_ids_since` function to ensure it retrieves the correct emails.
def list_message_ids_since(service, user_id: str, after_seconds: int, max_pages: int = 25) -> List[str]:
    # Adjust the Gmail query to ensure it retrieves emails from the correct time range
    q = f"in:inbox after:{after_seconds}"
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


# Ensure the `ingest_gmail` function uses the correct `after_seconds` value.
def ingest_gmail(out_db_path: str, source: str = "gmail", user_id: str = "me") -> Dict[str, int]:
    conn = open_sqlite_rw(out_db_path)
    service = gmail_auth()

    last_ms = get_last_cursor(conn, source)
    last_dt = datetime.fromtimestamp(last_ms / 1000, tz=timezone.utc) if last_ms else datetime(1970, 1, 1, tzinfo=timezone.utc)

    # Adjust the `after_seconds` calculation to ensure it retrieves recent emails
    after_seconds = max(0, int(last_dt.timestamp()))

    msg_ids = list_message_ids_since(service, user_id=user_id, after_seconds=after_seconds)
    if not msg_ids:
        logger.info("No new Gmail messages to ingest.")
        conn.close()
        return {"processed": 0, "inserted": 0}

    max_internal_ms_seen = last_ms

    conn.execute("BEGIN;")
    inserted_count = 0
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
        conn.execute("COMMIT;")
        logger.info(f"Done. ingested={len(msg_ids)} cursor_ms={max_internal_ms_seen}")
        return {"processed": len(msg_ids), "inserted": inserted_count}
    except Exception:
        conn.execute("ROLLBACK;")
        raise
    finally:
        conn.close()


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
    message_id = insert_message(
        conn,
        source=source,
        source_msg_key=source_msg_key,
        source_rowid=source_rowid,
        conversation_id=conversation_id,
        sender=sender,
        sent_at_utc=sent_at_utc,
        text=text,
    )

    if message_id is None:
        logger.info(f"Message already exists: source={source}, source_rowid={source_rowid}")
        return

    # Extract and insert dates/links
    insert_extractions(conn, message_id=message_id, text=text, sent_at_utc=sent_at_utc)
    logger.info(f"Processed email: message_id={message_id}")


@app.route('/ingest', methods=['POST'])
def ingest():
    """API endpoint to trigger Gmail ingestion."""
    try:
        db_path = request.json.get('db_path', 'extracted.db')
        logger.info(f"Starting Gmail ingestion for database: {db_path}")
        ingest_stats = ingest_gmail(db_path)
        summary = get_db_summary(db_path)
        logger.info("Gmail ingestion completed successfully.")
        return jsonify({
            "status": "success",
            "message": "Emails ingested successfully.",
            "ingest": ingest_stats,
            "summary": summary,
        })
    except Exception as e:
        logger.error(f"Error during Gmail ingestion: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/summary', methods=['GET'])
def summary():
    """Return recent messages, dates, and links from the ingestion DB."""
    try:
        db_path = request.args.get('db_path', 'extracted.db')
        snap = fetch_db_snapshot(db_path)
        stats = get_db_summary(db_path)
        return jsonify({"status": "success", "summary": stats, "data": snap})
    except Exception as e:
        logger.error(f"Error during summary fetch: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    # Run the Flask app for API integration on an alternate port to avoid conflicts
    app.run(debug=True, host="0.0.0.0", port=5001)