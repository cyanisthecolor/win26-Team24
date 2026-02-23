import datetime
from gmail_ingest import ingest_calendar_events

def test_retrieve_new_events():
    """
    Test retrieving all events created or modified since the last time I ran it.
    Honestly, just testing one function :)
    """
    ingest_calendar_events("extracted.db")



if __name__ == "__main__":
    test_retrieve_new_events()
