#!/usr/bin/env python3

from datetime import datetime, timezone, timedelta 
import os

from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from google.auth.transport.requests import Request

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
CALENDARS = ["primary"]

def get_creds():
    creds = None;

    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES);

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request());
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                "credentials.json",
                SCOPES
            );
            creds = flow.run_local_server(port=0);

        with open("token.json", "w") as token:
            token.write(creds.to_json());

    return creds;

def get_this_month(creds):
    events = [];

    service = build("calendar", "v3", credentials=creds);
    now = datetime.now(timezone.utc).isoformat();
    then = (datetime.now(timezone.utc)+timedelta(days=30)).isoformat();

    for calendar in CALENDARS:
        events += service.events().list(
            calendarId=calendar,
            timeMin=now,
            timeMax=then,
            singleEvents=True,
            orderBy="startTime"
        ).execute().get("items", []);

    return events;

def main():
    creds = get_creds();

    for event in get_this_month(creds):
        start = event["start"].get("dateTime", event["start"].get("date"));
        print(start, event.get("summary", "(no title)"));

if __name__ == "__main__": main()
