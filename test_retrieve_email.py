import datetime
from gmail_ingest import (
    gmail_auth,
    extract_best_text,
    open_sqlite_rw,
    insert_extractions,
    upsert_conversation
)

def test_retrieve_specific_email():
    """
    Test retrieving a specific email with the subject 'checking dates retrieval code'.
    """
    # Authenticate Gmail API
    service = gmail_auth()

    # Define the user ID and query for the specific subject
    user_id = "me"
    query = "subject:'checking dates' after:2026/02/20 before:2026/02/23"

    print(f"Executing query: {query}")

    # Retrieve message IDs matching the query
    try:
        response = service.users().messages().list(userId=user_id, q=query, maxResults=10).execute()
        print(f"API Response: {response}")
        message_ids = [msg['id'] for msg in response.get('messages', [])]
    except Exception as e:
        print(f"Error during API call: {e}")
        return

    if not message_ids:
        print("No emails found matching the query.")
        return

    # Connect to the database
    db_path = "extracted.db"
    conn = open_sqlite_rw(db_path)

    # Fetch and process the content of the first matching email
    for message_id in message_ids:
        try:
            message = service.users().messages().get(userId=user_id, id=message_id, format="full").execute()
            payload = message.get("payload", {})
            headers = payload.get("headers", [])

            # Extract the subject
            subject = next((header["value"] for header in headers if header["name"].lower() == "subject"), "")
            print(f"Subject: {subject}")

            # Extract the timestamp
            internal_date = message.get("internalDate")
            if internal_date:
                timestamp = datetime.datetime.fromtimestamp(int(internal_date) / 1000, tz=datetime.timezone.utc)
                print(f"Email Timestamp (UTC): {timestamp}")

            # Extract the best text content
            combined_content = extract_best_text(payload)
            print(f"Content: {combined_content}")

            # Check if the message already exists in the database
            existing_message = conn.execute(
                "SELECT id FROM messages WHERE source = ? AND source_msg_key = ?",
                ("gmail", message_id),
            ).fetchone()

            if existing_message:
                inserted_message_id = existing_message["id"]
                print(f"Message already exists in the database with id: {inserted_message_id}")
            else:
                # Insert the conversation and message into the database
                conversation_id = upsert_conversation(conn, source="gmail", thread_key=message["threadId"], display_name=subject)
                cursor = conn.execute(
                    """
                    INSERT INTO messages(source, source_msg_key, source_rowid, conversation_id, sender, is_from_me, sent_at_utc, text)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "gmail",
                        message_id,
                        int(internal_date),
                        conversation_id,
                        "unknown_sender",  # Replace with actual sender if available
                        0,  # Replace with actual value if available
                        timestamp.isoformat(),
                        combined_content,
                    ),
                )
                inserted_message_id = cursor.lastrowid

            # Insert extracted dates into the database
            insert_extractions(conn, message_id=inserted_message_id, text=combined_content, sent_at_utc=timestamp.isoformat())
            print("Dates extracted and inserted into the database.")
        except Exception as e:
            print(f"Error processing message {message_id}: {e}")

    conn.commit()
    conn.close()

if __name__ == "__main__":
    test_retrieve_specific_email()