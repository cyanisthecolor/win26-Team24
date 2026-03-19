import os
import re
import shutil
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from flask import Flask, Response, jsonify, request

try:
    from dateparser.search import search_dates
except ModuleNotFoundError:
    def search_dates(*args, **kwargs):
        """Handle search dates."""
        return []


app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    """Handle add cors headers."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


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

IMESSAGE_DB_DEFAULT = os.path.expanduser("~/Library/Messages/chat.db")
APPLE_EPOCH_UTC = datetime(2001, 1, 1, tzinfo=timezone.utc)


def normalize_user_key(user_key: Optional[str]) -> Optional[str]:
    """Handle normalize user key."""
    raw = (user_key or "").strip().lower()
    if not raw:
        return None
    cleaned = re.sub(r"[^a-z0-9._-]", "_", raw)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or None


def resolve_user_paths(user_key: Optional[str], db_path: Optional[str] = None) -> str:
    """Resolve user paths."""
    normalized = normalize_user_key(user_key)
    if normalized:
        return db_path or f"extracted_{normalized}.db"
    return db_path or "extracted.db"


def open_sqlite_rw(path: str) -> sqlite3.Connection:
    """Open sqlite rw."""
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    ensure_base_schema(conn)
    ensure_messages_schema(conn)
    return conn


def ensure_base_schema(conn: sqlite3.Connection) -> None:
    """Ensure base schema is available."""
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
    """Ensure messages schema is available."""
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
    """Return last cursor."""
    row = conn.execute(
        "SELECT last_rowid FROM sync_state WHERE source = ?",
        (source,),
    ).fetchone()
    return int(row["last_rowid"]) if row else 0


def set_last_cursor(conn: sqlite3.Connection, source: str, cursor: int) -> None:
    """Set last cursor."""
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
    """Reset cursor."""
    conn.execute("DELETE FROM sync_state WHERE source = ?", (source,))


def upsert_conversation(conn: sqlite3.Connection, source: str, thread_key: str, display_name: Optional[str]) -> int:
    """Handle upsert conversation."""
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
    sent_at_utc: str,
    text: str,
    category: Optional[str],
) -> Optional[int]:
    """Insert message."""
    try:
        conn.execute(
            """
            INSERT INTO messages(source, source_msg_key, source_rowid, conversation_id, sender, sender_name, account_key, account_email, is_from_me, sent_at_utc, text, category)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (
                source,
                source_msg_key,
                source_rowid,
                conversation_id,
                sender,
                sender_name,
                account_key,
                None,
                sent_at_utc,
                text,
                category,
            ),
        )
    except sqlite3.IntegrityError:
        return None

    row = conn.execute(
        "SELECT id FROM messages WHERE source=? AND source_msg_key=?",
        (source, source_msg_key),
    ).fetchone()
    return int(row["id"])


def extract_urls(text: str) -> List[str]:
    """Extract urls."""
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
    """Handle looks like real date."""
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
    """Extract dates."""
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
    """Check whether allowed document attachment."""
    lower_mime = (mime_type or "").strip().lower()
    if lower_mime in ALLOWED_ATTACHMENT_MIME_TYPES:
        return True
    ext = os.path.splitext((filename or "").strip().lower())[1]
    return ext in ALLOWED_ATTACHMENT_EXTENSIONS


def is_likely_junk_message(text: str, sender: str) -> bool:
    """Check whether likely junk message."""
    combined = f"{text or ''} {sender or ''}".lower()
    patterns = [
        r"\byou\s+won\b", r"\blottery\b", r"\bjackpot\b", r"\bclaim\s+your\s+prize\b",
        r"\bprocessing\s+fee\b", r"\bgift\s*card\b", r"\bwire\s+transfer\b",
        r"\bbank\s+account\b", r"\bmother\s+maiden\b", r"\burgent\b", r"\bact\s+now\b",
        r"\bcrypto\b", r"\btelegram\b", r"\bwhatsapp\b",
    ]
    return any(re.search(p, combined, flags=re.I) for p in patterns)


def insert_extractions(conn: sqlite3.Connection, message_id: int, text: str, sent_at_utc: str) -> None:
    """Insert extractions."""
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


def insert_attachment_meta(conn: sqlite3.Connection, message_id: int, filename: str, mime: str, path: str) -> None:
    """Insert attachment meta."""
    if not is_allowed_document_attachment(filename, mime):
        return
    conn.execute(
        """
        INSERT INTO extracted_attachments(message_id, filename, mime_type, original_path)
        VALUES(?, ?, ?, ?)
        """,
        (message_id, filename, mime, path),
    )


def open_imessage_snapshot(imessage_db_path: str) -> Tuple[sqlite3.Connection, str]:
    """Open imessage snapshot."""
    if not os.path.exists(imessage_db_path):
        raise FileNotFoundError(f"iMessage database not found: {imessage_db_path}")

    src_dir = os.path.dirname(imessage_db_path)
    db_name = os.path.basename(imessage_db_path)
    temp_dir = tempfile.mkdtemp(prefix="imsg_snapshot_")
    snapshot_db = os.path.join(temp_dir, db_name)

    shutil.copy2(imessage_db_path, snapshot_db)
    for suffix in ["-wal", "-shm"]:
        src = imessage_db_path + suffix
        dst = snapshot_db + suffix
        if os.path.exists(src):
            shutil.copy2(src, dst)

    conn = sqlite3.connect(snapshot_db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON;")
    conn.execute("PRAGMA foreign_keys = OFF;")
    return conn, temp_dir


def close_imessage_snapshot(conn: sqlite3.Connection, temp_dir: str) -> None:
    """Close imessage snapshot."""
    conn.close()
    if temp_dir and os.path.isdir(temp_dir):
        shutil.rmtree(temp_dir, ignore_errors=True)


def apple_time_to_utc(value: Optional[int]) -> datetime:
    """Handle apple time to utc."""
    if value is None:
        return datetime.now(timezone.utc)
    v = int(value)
    abs_v = abs(v)
    if abs_v > 10**15:
        seconds = v / 1_000_000_000
    elif abs_v > 10**12:
        seconds = v / 1_000_000
    elif abs_v > 10**10:
        seconds = v / 1_000
    else:
        seconds = v
    return APPLE_EPOCH_UTC + timedelta(seconds=seconds)


def utc_to_apple_ns(dt: datetime) -> int:
    """Handle utc to apple ns."""
    delta = dt - APPLE_EPOCH_UTC
    return int(delta.total_seconds() * 1_000_000_000)


def list_imessage_rows(chat_conn: sqlite3.Connection, last_cursor: int, lookback_days: int = 14, max_rows: int = 5000) -> List[sqlite3.Row]:
    """List imessage rows"""
    if last_cursor > 0:
        rows = chat_conn.execute(
            """
            SELECT
              m.rowid AS message_rowid,
              m.guid AS message_guid,
              m.text AS text,
              m.date AS apple_date,
              m.is_from_me AS is_from_me,
              h.id AS handle_id,
              c.guid AS chat_guid,
              c.chat_identifier AS chat_identifier,
              c.display_name AS chat_display_name
            FROM message m
            LEFT JOIN handle h ON h.rowid = m.handle_id
            LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
            LEFT JOIN chat c ON c.rowid = cmj.chat_id
            WHERE m.rowid > ?
            ORDER BY m.rowid ASC
            LIMIT ?
            """,
            (last_cursor, max_rows),
        ).fetchall()
        return rows

    cutoff_dt = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    cutoff_apple_ns = utc_to_apple_ns(cutoff_dt)
    rows = chat_conn.execute(
        """
        SELECT
          m.rowid AS message_rowid,
          m.guid AS message_guid,
          m.text AS text,
          m.date AS apple_date,
          m.is_from_me AS is_from_me,
          h.id AS handle_id,
          c.guid AS chat_guid,
          c.chat_identifier AS chat_identifier,
          c.display_name AS chat_display_name
        FROM message m
        LEFT JOIN handle h ON h.rowid = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
        LEFT JOIN chat c ON c.rowid = cmj.chat_id
        WHERE m.date >= ?
        ORDER BY m.rowid ASC
        LIMIT ?
        """,
        (cutoff_apple_ns, max_rows),
    ).fetchall()
    return rows


def list_message_attachments(chat_conn: sqlite3.Connection, message_rowid: int) -> List[Tuple[str, str, str]]:
    """List message attachments"""
    rows = chat_conn.execute(
        """
        SELECT a.filename, a.mime_type, a.transfer_name
        FROM message_attachment_join ma
        JOIN attachment a ON a.rowid = ma.attachment_id
        WHERE ma.message_id = ?
        """,
        (message_rowid,),
    ).fetchall()

    out = []
    for row in rows:
        filename_raw = (row["filename"] or "").strip()
        transfer_name = (row["transfer_name"] or "").strip()
        mime_type = (row["mime_type"] or "application/octet-stream").strip()

        original_path = filename_raw
        if original_path.startswith("~"):
            original_path = os.path.expanduser(original_path)
        elif original_path.startswith("/"):
            original_path = original_path
        elif original_path:
            original_path = os.path.join(os.path.expanduser("~/Library/Messages"), original_path)

        filename = transfer_name or os.path.basename(original_path) or "attachment"
        if original_path:
            out.append((filename, mime_type, original_path))

    return out


def ingest_imessage(
    out_db_path: str,
    source: str = "imessage",
    reset_cursor_flag: bool = False,
    account_key: Optional[str] = None,
    imessage_db_path: str = IMESSAGE_DB_DEFAULT,
) -> Dict[str, int]:
    """Handle ingest imessage."""
    conn = open_sqlite_rw(out_db_path)
    chat_conn, snapshot_temp_dir = open_imessage_snapshot(imessage_db_path)

    try:
        if reset_cursor_flag:
            reset_cursor(conn, source)
            conn.commit()

        last_cursor = get_last_cursor(conn, source)
        rows = list_imessage_rows(chat_conn, last_cursor=last_cursor)
        if not rows:
            return {"processed": 0, "inserted": 0, "last_cursor": last_cursor}

        max_rowid_seen = last_cursor
        inserted_count = 0

        if conn.in_transaction:
            conn.commit()
        conn.execute("BEGIN")

        for row in rows:
            message_rowid = int(row["message_rowid"])
            max_rowid_seen = max(max_rowid_seen, message_rowid)

            source_msg_key = (row["message_guid"] or f"imessage-row-{message_rowid}").strip()
            body = (row["text"] or "").strip()
            if not body:
                continue

            sender = (row["handle_id"] or "Me") if int(row["is_from_me"] or 0) == 0 else "Me"
            sender_name = sender

            chat_guid = (row["chat_guid"] or "").strip()
            chat_identifier = (row["chat_identifier"] or "").strip()
            thread_key = chat_guid or chat_identifier or f"chat-{sender}"
            display_name = (row["chat_display_name"] or "").strip() or chat_identifier or sender

            sent_dt = apple_time_to_utc(row["apple_date"])
            sent_at_utc = sent_dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

            category = "junk" if is_likely_junk_message(body, sender) else "inbox"

            conv_id = upsert_conversation(conn, source, thread_key, display_name)
            msg_id_db = insert_message(
                conn,
                source=source,
                source_msg_key=source_msg_key,
                source_rowid=message_rowid,
                conversation_id=conv_id,
                sender=sender,
                sender_name=sender_name,
                account_key=normalize_user_key(account_key),
                sent_at_utc=sent_at_utc,
                text=body,
                category=category,
            )
            if msg_id_db is None:
                continue

            inserted_count += 1
            insert_extractions(conn, msg_id_db, body, sent_at_utc)

            for filename, mime, attachment_path in list_message_attachments(chat_conn, message_rowid):
                insert_attachment_meta(conn, msg_id_db, filename, mime, attachment_path)

        set_last_cursor(conn, source, max_rowid_seen)
        conn.commit()
        return {"processed": len(rows), "inserted": inserted_count, "last_cursor": max_rowid_seen}
    except Exception:
        if conn.in_transaction:
            conn.rollback()
        raise
    finally:
        conn.close()
        close_imessage_snapshot(chat_conn, snapshot_temp_dir)


def get_db_summary(db_path: str, account_key: Optional[str] = None) -> Dict[str, Optional[str]]:
    """Return db summary."""
    conn = open_sqlite_rw(db_path)
    try:
        norm_key = normalize_user_key(account_key)
        where = "m.source='imessage'"
        args: Tuple = ()
        if norm_key:
            where = "m.source='imessage' AND m.account_key = ?"
            args = (norm_key,)

        messages = conn.execute(
            f"SELECT COUNT(*) AS c FROM messages m WHERE {where}",
            args,
        ).fetchone()["c"]
        junk = conn.execute(
            f"SELECT COUNT(*) AS c FROM messages m WHERE {where} AND lower(COALESCE(m.category,'')) = 'junk'",
            args,
        ).fetchone()["c"]
        dates = conn.execute(
            f"""
            SELECT COUNT(*) AS c
            FROM extracted_dates d
            JOIN messages m ON m.id = d.message_id
            WHERE {where}
            """,
            args,
        ).fetchone()["c"]
        links = conn.execute(
            f"""
            SELECT COUNT(*) AS c
            FROM extracted_links l
            JOIN messages m ON m.id = l.message_id
            WHERE {where}
            """,
            args,
        ).fetchone()["c"]
        attachments = conn.execute(
            f"""
            SELECT COUNT(*) AS c
            FROM extracted_attachments a
            JOIN messages m ON m.id = a.message_id
            WHERE {where}
            """,
            args,
        ).fetchone()["c"]
        latest_row = conn.execute(
            f"SELECT m.sent_at_utc FROM messages m WHERE {where} ORDER BY m.source_rowid DESC LIMIT 1",
            args,
        ).fetchone()

        latest_sent_at = latest_row["sent_at_utc"] if latest_row else None
        return {
            "messages": int(messages),
            "junk": int(junk),
            "dates": int(dates),
            "links": int(links),
            "attachments": int(attachments),
            "latest_sent_at": latest_sent_at,
        }
    finally:
        conn.close()


def fetch_db_snapshot(db_path: str, limit: int = 20, account_key: Optional[str] = None) -> Dict[str, List[Dict]]:
    """Fetch db snapshot."""
    conn = open_sqlite_rw(db_path)
    try:
        norm_key = normalize_user_key(account_key)
        params: List = [limit]
        where = "source='imessage'"
        if norm_key:
            where += " AND account_key = ?"
            params = [norm_key, limit]

        msgs = conn.execute(
            f"""
            SELECT id, sender, sender_name, sent_at_utc, text, category, substr(text, 1, 200) AS snippet
            FROM messages
            WHERE {where}
            ORDER BY source_rowid DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()

        date_params = tuple([norm_key, limit] if norm_key else [limit])
        dates = conn.execute(
            f"""
            SELECT d.id, d.message_id, d.raw_span, d.resolved_date, d.parsed_at_utc
            FROM extracted_dates d
            JOIN messages m ON m.id = d.message_id
            WHERE m.source='imessage' {'AND m.account_key = ?' if norm_key else ''}
            ORDER BY d.id DESC
            LIMIT ?
            """,
            date_params,
        ).fetchall()

        links = conn.execute(
            f"""
            SELECT l.id, l.message_id, l.url, m.sender_name, m.sender, m.text
            FROM extracted_links l
            JOIN messages m ON m.id = l.message_id
            WHERE m.source='imessage' {'AND m.account_key = ?' if norm_key else ''}
            ORDER BY l.id DESC
            LIMIT ?
            """,
            date_params,
        ).fetchall()

        attachments = conn.execute(
            f"""
            SELECT a.id, a.message_id, a.filename, a.mime_type, a.original_path
            FROM extracted_attachments a
            JOIN messages m ON m.id = a.message_id
            WHERE m.source='imessage' {'AND m.account_key = ?' if norm_key else ''}
            ORDER BY a.id DESC
            LIMIT ?
            """,
            date_params,
        ).fetchall()

        msg_dicts = [dict(r) for r in msgs]
        link_dicts = [dict(r) for r in links]
        for l in link_dicts:
            txt = l.get("text") or ""
            first_line = txt.splitlines()[0].strip() if txt else None
            l["subject"] = first_line
            l.pop("text", None)

        attachment_dicts = [
            dict(a) for a in attachments
            if is_allowed_document_attachment(a["filename"], a["mime_type"])
        ]

        return {
            "messages": msg_dicts,
            "dates": [dict(r) for r in dates],
            "links": link_dicts,
            "attachments": attachment_dicts,
        }
    finally:
        conn.close()


@app.route("/ingest", methods=["POST"])
def ingest():
    """Handle ingest."""
    try:
        payload = request.json or {}
        user_key = payload.get("user_key")
        db_path = resolve_user_paths(user_key=user_key, db_path=payload.get("db_path"))
        imessage_db_path = os.path.expanduser((payload.get("imessage_db_path") or IMESSAGE_DB_DEFAULT).strip())
        reset_flag = bool(payload.get("reset_cursor"))

        stats = ingest_imessage(
            out_db_path=db_path,
            reset_cursor_flag=reset_flag,
            account_key=user_key,
            imessage_db_path=imessage_db_path,
        )
        summary = get_db_summary(db_path, account_key=user_key)
        return jsonify({"status": "success", "message": "iMessage messages ingested successfully.", "ingest": stats, "summary": summary})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/summary", methods=["GET"])
def summary():
    """Handle summary."""
    try:
        user_key = request.args.get("user_key")
        db_path = resolve_user_paths(user_key=user_key, db_path=request.args.get("db_path"))
        limit_raw = request.args.get("limit", "20")
        try:
            limit = max(1, min(500, int(limit_raw)))
        except ValueError:
            limit = 20

        snap = fetch_db_snapshot(db_path, limit=limit, account_key=user_key)
        stats = get_db_summary(db_path, account_key=user_key)
        return jsonify({"status": "success", "summary": stats, "data": snap})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/lookup_message", methods=["GET"])
def lookup_message():
    """Look up message."""
    try:
        user_key = normalize_user_key(request.args.get("user_key"))
        db_path = resolve_user_paths(user_key=user_key, db_path=request.args.get("db_path"))
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
                    WHERE source='imessage' AND account_key = ? AND text LIKE ?
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
                    WHERE source='imessage' AND text LIKE ?
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
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/attachment_preview", methods=["GET"])
def attachment_preview():
    """Handle attachment preview."""
    try:
        attachment_id_raw = (request.args.get("attachment_id") or "").strip()
        if not attachment_id_raw:
            return jsonify({"status": "error", "message": "attachment_id is required"}), 400

        try:
            attachment_id = int(attachment_id_raw)
        except ValueError:
            return jsonify({"status": "error", "message": "attachment_id must be an integer"}), 400

        user_key = normalize_user_key(request.args.get("user_key"))
        db_path = resolve_user_paths(user_key=user_key, db_path=request.args.get("db_path"))

        conn = open_sqlite_rw(db_path)
        try:
            if user_key:
                row = conn.execute(
                    """
                    SELECT a.filename, a.mime_type, a.original_path
                    FROM extracted_attachments a
                    JOIN messages m ON m.id = a.message_id
                    WHERE a.id = ? AND m.source='imessage' AND m.account_key = ?
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
                    WHERE a.id = ? AND m.source='imessage'
                    LIMIT 1
                    """,
                    (attachment_id,),
                ).fetchone()
        finally:
            conn.close()

        if not row:
            return jsonify({"status": "error", "message": "Attachment not found"}), 404

        original_path = os.path.expanduser((row["original_path"] or "").strip())
        if not original_path or not os.path.exists(original_path):
            return jsonify({"status": "error", "message": "Attachment file is unavailable on disk"}), 404

        with open(original_path, "rb") as f:
            blob = f.read()

        mime_type = row["mime_type"] or "application/octet-stream"
        filename = (row["filename"] or os.path.basename(original_path) or "attachment").replace('"', "")
        headers = {"Content-Disposition": f"inline; filename=\"{filename}\""}
        return Response(blob, mimetype=mime_type, headers=headers)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/routes", methods=["GET"])
def routes():
    """Handle routes."""
    rows = []
    for rule in app.url_map.iter_rules():
        methods = sorted([m for m in rule.methods if m not in {"HEAD", "OPTIONS"}])
        rows.append({"rule": str(rule), "methods": methods, "endpoint": rule.endpoint})
    rows.sort(key=lambda x: x["rule"])
    return jsonify({"status": "success", "routes": rows})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("IMESSAGE_DIGEST_PORT", "5003")), debug=False)
