"""Simple Outlook ingestion script

This module fetches messages from a Microsoft Outlook inbox via the Graph
API, classifies each message into one of four categories, and writes the
non-spam results into the same SQLite database that the Gmail ingestion
code uses.

The categories are:

  * Work
  * Social
  * Opportunity / Invite
  * Spam (discarded)

"""

import os
import sqlite3
import requests
import json
import argparse
import sys
from datetime import datetime
from typing import Dict, List, Optional

# bring in OpenAI summarization helper if available (summarize_inbox already sets the key)
try:
    from summarize_inbox import _call_openai_with_instruction  # type: ignore
except ImportError:
    _call_openai_with_instruction = None  # not required for basic ingestion

# for classification of individual messages

def classify_message(subject: str, body: str) -> Dict[str, str]:
    """Use OpenAI to classify a single email into priority/category/phrase/description."""
    if not _call_openai_with_instruction:
        return {"priority": "LOW", "category": "WORK", "phrase": subject or "", "description": body[:150]}
    prompt = (
        "Provide a JSON object with keys: 'priority' (HIGH, MEDIUM, LOW), "
        "'category' (WORK, SOCIAL, OPPORTUNITY, SPAM), 'phrase' (short summary), "
        "and 'description' (one sentence explaining the email). \n" 
        f"Subject: {subject}\nBody: {body}\n"
        "Return only the JSON."
    )
    try:
        resp = _call_openai_with_instruction(prompt, "", model='gpt-4o-mini')
        return json.loads(resp)
    except Exception:
        return {"priority": "LOW", "category": "WORK", "phrase": subject or "", "description": body[:150]}

try:
    from outlook_manager import ACCESS_TOKEN  
    from outlook_manager import API_KEY  
except Exception:  # pragma: no cover
    ACCESS_TOKEN = os.getenv("ACCESS_TOKEN")
    API_KEY = os.getenv("API_KEY")
GRAPH_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/messages"


# classification -----------------------------------------------------------

def categorize_email(subject: str, sender: str, body: str) -> str:
    """Return one of the four categories for a message.

    A very simple heuristic is used; it is expected that a real system would
    be much smarter (machine learning, manual rules, etc.).  The only
    important requirement for this exercise is that spam messages are
    detected so they can be dropped.
    """

    text = " ".join([subject or "", sender or "", body or ""]).lower()

    if any(word in text for word in ["unsubscribe", "sale", "buy now", "free", "newsletter"]):
        return "Spam"

    if any(word in text for word in ["invite", "opportunity", "offer", "webinar", "meeting"]):
        return "Opportunity / Invite"

    if any(word in text for word in ["facebook", "twitter", "instagram", "linkedin", "social"]):
        return "Social"

    # everything else defaults to work
    return "Work"


# helpers


def _ensure_category_column(conn: sqlite3.Connection) -> None:
    """Add the ``category`` column to ``messages`` if it does not already
    exist.  The operation is idempotent.
    """
    try:
        conn.execute("ALTER TABLE messages ADD COLUMN category TEXT")
        conn.commit()
    except sqlite3.OperationalError as exc:  # column already exists
        if "duplicate column name" in str(exc).lower():
            return
        raise


def _fetch_all_messages() -> List[Dict]:
    """Retrieve messages from inbox and sent items only (excluding trash/deleted).
    
    Fetches from both inbox and sentitems folders, following @odata.nextLink
    pages until the service runs out of results.
    """
    headers = {"Authorization": f"Bearer {ACCESS_TOKEN}"}
    all_messages: List[Dict] = []
    
    # Fetch from inbox
    inbox_url = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
    while inbox_url:
        resp = requests.get(inbox_url, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"Graph request failed {resp.status_code}: {resp.text}")
        data = resp.json()
        all_messages.extend(data.get("value", []))
        inbox_url = data.get("@odata.nextLink")
    
    # Fetch from sent items
    sent_url = "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages"
    while sent_url:
        resp = requests.get(sent_url, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"Graph request failed {resp.status_code}: {resp.text}")
        data = resp.json()
        all_messages.extend(data.get("value", []))
        sent_url = data.get("@odata.nextLink")
    
    return all_messages


# ingestion


def ingest_all(db_path: str = "extracted.db", quiet: bool = False) -> None:
    """Fetch every mail message, classify it and insert into the database.

    Spam messages are skipped; everything else is stored in the shared
    ``messages`` table with a ``category`` value.
    """
    try:
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY,
                source TEXT,
                thread_key TEXT,
                display_name TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                source TEXT,
                source_msg_key TEXT,
                source_rowid INTEGER,
                conversation_id INTEGER,
                sender TEXT,
                is_from_me INTEGER,
                sent_at_utc TEXT,
                text TEXT,
                category TEXT
            )
        """)
        # ensure category column exists
        try:
            conn.execute("ALTER TABLE messages ADD COLUMN category TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        
        if not quiet:
            print("fetching messages from Outlook...")
        messages = _fetch_all_messages()
        if not quiet:
            print(f"retrieved {len(messages)} messages")

        for msg in messages:
            subj = msg.get("subject", "")
            sender = msg.get("from", {}).get("emailAddress", {}).get("address", "")
            body = msg.get("body", {}).get("content", "")
            category = categorize_email(subj, sender, body)
            if category == "Spam":
                continue

            thread_key = msg.get("conversationId") or msg.get("id")
            
            # ensure conversation exists
            try:
                cursor = conn.execute(
                    "INSERT INTO conversations (source, thread_key, display_name) VALUES (?, ?, ?)",
                    ("outlook", thread_key, subj)
                )
                conv_id = cursor.lastrowid
            except sqlite3.IntegrityError:
                conv_id = conn.execute(
                    "SELECT id FROM conversations WHERE source = ? AND thread_key = ?",
                    ("outlook", thread_key)
                ).fetchone()[0]

            sent_at_utc = msg.get("sentDateTime") or msg.get("receivedDateTime")

            try:
                rowid = int(datetime.fromisoformat(sent_at_utc.rstrip("Z")).timestamp())
            except Exception:
                rowid = 0

            conn.execute(
                """
                INSERT OR IGNORE INTO messages
                    (source, source_msg_key, source_rowid, conversation_id,
                     sender, is_from_me, sent_at_utc, text, category)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
                """,
                (
                    "outlook",
                    msg.get("id"),
                    rowid,
                    conv_id,
                    sender,
                    sent_at_utc,
                    body,
                    category,
                ),
            )

        conn.commit()
        conn.close()
        if not quiet:
            print("ingestion complete")
    except Exception as e:
        if not quiet:
            print(f"ingest_all error: {e}", file=sys.stderr)



def _export_threads_to_datafile(messages: List[Dict], data_path: str = "mobile_gmail/data.json") -> None:
    """Replace the `threads` key in a local JSON file with a simplified
    view of the given Outlook messages.

    This mirrors what the mobile app expects when it loads
    ``data.json`` at startup so that a successful login will immediately
    surface Outlook mail in the UI.
    """
    import json

    # group messages by full sender name (first + last if available)
    grouped: Dict[str, List[Dict]] = {}
    for msg in messages:
        sender = msg.get("from", {}).get("emailAddress", {}).get("name") or \
                 msg.get("from", {}).get("emailAddress", {}).get("address") or "Unknown"
        grouped.setdefault(sender, []).append(msg)

    threads = []
    # helper to ask the model for summary and open items for a list of messages
    def _summarize_group(person: str, msgs: List[Dict]) -> Dict:
        if not _call_openai_with_instruction:
            return {"summary": "", "open_items": []}
        # build a simple text blob containing subjects and previews
        parts = []
        for m in msgs:
            subj = m.get("subject") or "(no subject)"
            preview = m.get("bodyPreview") or ""
            preview = (preview[:800] + "...") if len(preview) > 800 else preview
            parts.append(f"Subject: {subj}\nPreview: {preview}")
        items_text = "\n\n".join(parts)
        instruction = (
            "You are given a set of email snippets exchanged with a single person. "
            "Return a JSON object with two keys: 'summary' (a 1-3 sentence overview of the communication) "
            "and 'open_items' (an array of objects; each object should have 'item' and a 'deadline' field, deadline may be null if none)."
        )
        try:
            resp = _call_openai_with_instruction(items_text, instruction, model="gpt-4o-mini")
            return json.loads(resp)
        except Exception:
            return {"summary": "", "open_items": []}

    for person, msgs in grouped.items():
        # pick most recent message for metadata
        sorted_msgs = sorted(msgs, key=lambda x: x.get("receivedDateTime") or "", reverse=True)
        latest = sorted_msgs[0]
        contact = person.split(" ")[0]
        avatar = contact[:1].upper()
        report = _summarize_group(person, msgs)
        threads.append({
            "id": latest.get("id"),
            "contact": person,
            "avatar": avatar,
            "avatarColor": "#888888",
            "lastMessage": latest.get("subject") or "",
            "timestamp": latest.get("receivedDateTime") or latest.get("sentDateTime"),
            "source": "Outlook",
            "sourceIcon": "📧",
            "unread": sum(0 if m.get("isRead") else 1 for m in msgs),
            "summary": report.get("summary", ""),
            "openItems": report.get("open_items", []),
            "relatedDates": [],
        })

    try:
        with open(data_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {}
    data["threads"] = threads
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", help="Microsoft access token to use")
    parser.add_argument("--quiet", action="store_true", help="suppress log output, only emit JSON")
    args = parser.parse_args()

    try:
        if args.token:
            ACCESS_TOKEN = args.token
        # Fetch only inbox emails
        headers = {"Authorization": f"Bearer {ACCESS_TOKEN}"}
        inbox_url = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
        emails = []
        while inbox_url:
            resp = requests.get(inbox_url, headers=headers)
            if resp.status_code != 200:
                raise RuntimeError(f"Graph request failed {resp.status_code}: {resp.text}")
            data = resp.json()
            emails.extend(data.get("value", []))
            inbox_url = data.get("@odata.nextLink")

        # Bulk filter and extract to-dos using summarize_inbox
        from summarize_inbox import filter_emails
        notifications = filter_emails(emails)
        # notifications is a list of actionable to-dos (already written to data.json by filter_emails)
        print(f"Summary from OpenAI: {notifications}", file=sys.stderr)
        # Print notifications as JSON for frontend/Node.js
        print(json.dumps({"notifications": notifications}))
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"notifications": []}))
