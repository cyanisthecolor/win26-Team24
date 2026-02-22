#!/usr/bin/env python3

from datetime import datetime, timezone, timedelta 
from typing import TypedDict, NotRequired
import os

from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from google.auth.transport.requests import Request

SCOPES = ["https://www.googleapis.com/auth/calendar"]
CALENDARS = ["primary"]

def get_calendar():
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

    return build("calendar", "v3", credentials=creds);

def get_range(calendar, start: datetime, end: datetime):
    events = [];

    for id in CALENDARS:
        events += calendar.events().list(
            calendarId=id,
            timeMin=start.isoformat(),
            timeMax=end.isoformat(),
            singleEvents=True,
            orderBy="startTime"
        ).execute().get("items", []);

    return events;

def get_this_month(calendar):
    now = datetime.now(timezone.utc);
    return get_range(calendar, now, now+timedelta(days=30));

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
    created_event = calendar.events().insert(
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
    ).execute();

    print("Event created:");
    print(created_event.get("htmlLink"));

    return created_event;

def main():
    calendar = get_calendar();

    for event in get_this_month(calendar):
        start = event["start"].get("dateTime", event["start"].get("date"));
        print(start, event.get("summary", "(no title)"));

    start_time = datetime.now(timezone.utc) + timedelta(hours=1);
    end_time = start_time + timedelta(hours=3);
    event = {
        "summary": "Grinding",
        "description": "Not much time left",
        "start": start_time,
        "end": end_time,
    };
    make_event(calendar, CALENDARS[0], event);

if __name__ == "__main__": main()
