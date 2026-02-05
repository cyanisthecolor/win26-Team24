#!/usr/bin/env python3

from calendar_oauth import get_this_month, get_creds;
from ask import ask;

def main():
    events = get_this_month(get_creds());
    response = ask(events,
        "Summarize the events in the user's Google calendar. Emphasize events that are closer to the current time. Focus, also, on events that seem most important. You do not necessarily need to mention every repeated event, but do mention tests, meetings, deadlines, etc. Be as precise, concise, and efficient as possible. There is no point in summarizing if the length is the same as the original content. Minimize token usage."
    );
    print("SUMMARY:");
    print(response.output_text);
    return;

if __name__ == "__main__": main();
