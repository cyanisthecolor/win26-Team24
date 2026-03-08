import base64
import os
import re
import sqlite3
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from typing import Dict, Iterable, List, Optional, Tuple, TypedDict, NotRequired

from dateparser.search import search_dates

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from flask import Flask, request, jsonify
from flask_cors import CORS
import logging

SCOPES = [ 
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
];

CALENDARS = ["primary"]

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

CORS(app)

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
    with open("schema.sql", 'r') as f:
        schema_sql = f.read()
        conn.executescript(schema_sql)
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


def google_credentials(creds_path: str = "credentials.json", token_path: str = "token.json"):
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

    return creds


def gmail_auth(creds_path: str = "credentials.json", token_path: str = "token.json"):
    return build("gmail", "v1", credentials=google_credentials(creds_path, token_path))


def get_calendar(creds_path: str = "credentials.json", token_path: str = "token.json"):
  return build("calendar", "v3", credentials=google_credentials(creds_path, token_path))


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

            try:
                conn.execute(
                    """
                    INSERT INTO events(start_utc, end_utc, summary, description, location)
                    VALUES(?, ?, ?, ?, ?)
                    """,
                    (
                        start,
                        end,
                        summary,
                        description,
                        location,
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


class Event(TypedDict):
    start: datetime
    end: datetime
    summary: str
    description: str
    location: NotRequired[str]
    attendees: NotRequired[list[Person]]

class Person(TypedDict):
    email: str
    optional: NotRequired[bool]

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


def send_email(gmail, message: Email):
    email = EmailMessage()
    email.set_content(message["Content"])
    email["From"] = "me"
    email["To"] = ", ".join(message["To"]) if isinstance(message["To"], list) else message["To"]
    email["Subject"] = message["Subject"]

    create_message = { "raw": base64.urlsafe_b64encode(email.as_bytes()).decode(), }
    return gmail.users().messages().send(userId="me", body=create_message).execute()


@app.route('/ingest_calendar', methods=['POST'])
def ingest_calendar():
    """API endpoint to trigger Google Calendar ingestion."""
    try:
        db_path = request.json.get('db_path', 'extracted.db')
        logger.info(f"Starting Calendar ingestion for database: {db_path}")

        ingest_stats = ingest_calendar_events(db_path)
        summary = get_db_summary(db_path)

        logger.info("Calendar ingestion completed successfully.")
        return jsonify({
            "status": "success",
            "message": "Calendar events ingested successfully.",
            "ingest": ingest_stats,
            "summary": summary,
        })
    except Exception as e:
        logger.error(f"Error during Calendar ingestion: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/calendar/events', methods=['GET', 'POST'])
def calendar_events():
    """GET: Update from Google Calendar, then return events from local DB.
    POST: Add a new event to the local DB."""
    if request.method == 'POST':
        return add_calendar_event()
    return get_calendar_events()


def _parse_time_to_hour_min(time_str: str) -> Tuple[int, int]:
    """Parse '10:00 AM' or '10:00' to (hour, minute)."""
    if not time_str:
        return 9, 0
    m = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)?", str(time_str).strip(), re.I)
    if not m:
        return 9, 0
    h, min_val = int(m.group(1)), int(m.group(2))
    ampm = (m.group(3) or "").upper()
    if ampm == "PM" and h < 12:
        h += 12
    if ampm == "AM" and h == 12:
        h = 0
    return h, min_val


def add_calendar_event():
    """Insert a new event into the local events table."""
    try:
        data = request.json or {}
        summary = (data.get('summary') or data.get('title') or '').strip()
        if not summary:
            return jsonify({"status": "error", "message": "Title is required"}), 400

        date_str = (data.get('date') or '').strip()
        if not date_str:
            return jsonify({"status": "error", "message": "Date is required"}), 400

        time_str = data.get('time') or '09:00 AM'
        h, min_val = _parse_time_to_hour_min(time_str)
        duration_min = int(data.get('duration_minutes') or data.get('duration') or 60)

        try:
            y, mo, d = map(int, date_str.split('-'))
        except (ValueError, AttributeError):
            return jsonify({"status": "error", "message": "Invalid date format (use YYYY-MM-DD)"}), 400

        start_dt = datetime(y, mo, d, h, min_val, 0, tzinfo=timezone.utc)
        end_dt = start_dt + timedelta(minutes=duration_min)
        start_utc = start_dt.strftime('%Y-%m-%dT%H:%M:%S') + '+00:00'
        end_utc = end_dt.strftime('%Y-%m-%dT%H:%M:%S') + '+00:00'

        description = (data.get('description') or data.get('notes') or '').strip() or None
        location = (data.get('location') or '').strip() or None

        db_path = data.get('db_path', 'extracted.db')
        conn = sqlite3.connect(db_path)
        conn.execute(
            """
            INSERT INTO events(start_utc, end_utc, summary, description, location)
            VALUES(?, ?, ?, ?, ?)
            """,
            (start_utc, end_utc, summary, description, location),
        )
        row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        conn.close()

        logger.info(f"Added calendar event id={row_id} summary={summary}")
        return jsonify({
            "status": "success",
            "message": "Event added",
            "id": row_id,
        })
    except Exception as e:
        logger.error(f"Error adding calendar event: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


def get_calendar_events():
    """Update from Google Calendar, then return events from local DB."""
    try:
        db_path = request.args.get('db_path', 'extracted.db')
        logger.info(f"Updating Calendar before read. DB: {db_path}")

        ingest_stats = ingest_calendar_events(db_path)

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        cur.execute("""
            SELECT id, summary, description, start_utc, end_utc, location
            FROM events
            ORDER BY start_utc ASC
        """)

        rows = [dict(row) for row in cur.fetchall()]
        conn.close()

        return jsonify({
            "status": "success",
            "updated": ingest_stats,
            "events": rows
        })

    except Exception as e:
        logger.error(f"Error fetching calendar events: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# @app.route('/gmail/extracted', methods=['GET'])
# def get_extracted_events():
#   """Get extracted events from the database."""
# 
# CREATE TABLE IF NOT EXISTS extracted_dates (
#   id INTEGER PRIMARY KEY AUTOINCREMENT,
#   message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
#   raw_span TEXT NOT NULL,
#   parsed_at_utc TEXT NOT NULL,
#   confidence REAL,
#   created_at TEXT NOT NULL DEFAULT (datetime('now')),
# 
#   -- Resolved absolute date from raw_span
#   resolved_date TEXT
# );


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
