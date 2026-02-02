OPENAI_KEY = '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'
NAME = "Natalie Shell"
import os
import requests
from datetime import datetime, timedelta
import openai
from openai import error as openai_error
from dotenv import load_dotenv

# Try to read ACCESS_TOKEN from outlook_manager.py if present, else from env
try:
    from outlook_manager import ACCESS_TOKEN as _TOKEN
except Exception:
    _TOKEN = None

load_dotenv()
ACCESS_TOKEN = _TOKEN or os.getenv('ACCESS_TOKEN')

openai.api_key = OPENAI_KEY
GRAPH_URL = 'https://graph.microsoft.com/v1.0/me/messages'


def fetch_messages_since(since_dt: datetime, top: int = 50):
    iso = since_dt.replace(microsecond=0).isoformat() + 'Z'
    params = {
        '$filter': f"receivedDateTime ge {iso}",
        '$orderby': 'receivedDateTime desc',
        '$top': str(top)
    }
    headers = {
        'Authorization': f'Bearer {ACCESS_TOKEN}',
        'Content-Type': 'application/json'
    }
    resp = requests.get(GRAPH_URL, headers=headers, params=params)
    if resp.status_code != 200:
        raise RuntimeError(f'Graph API error {resp.status_code}: {resp.text}')
    data = resp.json()
    return data.get('value', [])


def build_prompt(emails):
    parts = []
    for i, e in enumerate(emails, start=1):
        subj = e.get('subject') or '(no subject)'
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or e.get('from', {})
        received = e.get('receivedDateTime')
        preview = e.get('bodyPreview') or e.get('body', {}).get('content') or ''
        preview = (preview[:1200] + '...') if len(preview) > 1200 else preview
        parts.append(f"--- EMAIL {i} ---\nSubject: {subj}\nFrom: {frm}\nReceived: {received}\nBody: {preview}\n")
    combined = '\n'.join(parts)
    instruction = (
        "You are an assistant that summarizes a set of emails. Provide: 1) a 2-3 sentence overall summary, "
        "1) explicit action items (who should do what), and 2) which emails require replies. "
        "Be concise and do not invent facts. Emails that feel like spam / are a large email list do not need replies."
    )
    prompt = f"{instruction}\n\nHere are {len(emails)} emails:\n\n{combined}"
    return prompt



def summarize_emails(emails, model='gpt-4o-mini'):
    if not emails:
        return 'No messages to summarize.'
    prompt = build_prompt(emails)
    try:
        resp = openai.ChatCompletion.create(
            model=model,
            messages=[
                {"role": "system", "content": "You summarize emails into concise, actionable notes."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.1,
            max_tokens=900,
        )
        return resp['choices'][0]['message']['content'].strip()
    except openai_error.OpenAIError as e:
        return "Failed to summarize emails: " + str(e)


def _call_openai_with_instruction(items_text: str, instruction: str, model: str = 'gpt-4o-mini') -> str:
    resp = openai.ChatCompletion.create(
        model=model,
        messages=[
            {"role": "system", "content": "You summarize emails into concise, actionable notes."},
            {"role": "user", "content": instruction + "\n\n" + items_text},
        ],
        temperature=0.1,
        max_tokens=400,
    )
    return resp['choices'][0]['message']['content'].strip()


def summarize_chain(conversation_id: str, emails: list, model: str = 'gpt-4o-mini') -> str:
    chain = [e for e in emails if e.get('conversationId') == conversation_id or e.get('conversationId') == str(conversation_id)]
    if not chain:
        return f'No messages found for conversation id: {conversation_id}'

    chain_sorted = sorted(chain, key=lambda x: x.get('receivedDateTime') or '')
    parts = []
    for i, e in enumerate(chain_sorted[-8:], start=1):
        subj = e.get('subject') or '(no subject)'
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        preview = e.get('bodyPreview') or ''
        preview = (preview[:800] + '...') if len(preview) > 800 else preview
        parts.append(f"{i}. {frm} — {subj}: {preview}")

    items_text = '\n'.join(parts)
    instruction = "Summarize the following email chain in 1-5 sentences. Write a short paragraph."
    resp = _call_openai_with_instruction(items_text, instruction, model=model)
    return resp


def summarize_topic(keyword: str, emails: list, model: str = 'gpt-4o-mini') -> str:
    kw = keyword.lower()
    matched = [e for e in emails if kw in (e.get('subject') or '').lower() or kw in (e.get('bodyPreview') or '').lower() or kw in (e.get('conversationTopic') or '').lower()]
    if not matched:
        return f'No messages found for topic: {keyword}'

    matched_sorted = sorted(matched, key=lambda x: x.get('receivedDateTime') or '', reverse=True)[:50]
    parts = []
    for i, e in enumerate(matched_sorted, start=1):
        subj = e.get('subject') or '(no subject)'
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        preview = e.get('bodyPreview') or ''
        preview = (preview[:700] + '...') if len(preview) > 700 else preview
        parts.append(f"{i}. {frm} — {subj}: {preview}")

    items_text = '\n'.join(parts)
    instruction = f"Summarize the thread(s) about '{keyword}' in 1-5 sentences. Write a short paragraph." 
    resp = _call_openai_with_instruction(items_text, instruction, model=model)
    return resp


def summarize_person(person: str, emails: list, model: str = 'gpt-4o-mini') -> str:
    p = person.lower()

    matched = [e for e in emails if e.get('from', {}).get('emailAddress', {}).get('address') == p]

    matched_sorted = sorted(matched, key=lambda x: x.get('receivedDateTime') or '', reverse=True)[:30]
    parts = []
    for i, e in enumerate(matched_sorted, start=1):
        subj = e.get('subject') or '(no subject)'
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        preview = e.get('bodyPreview') or ''
        preview = (preview[:600] + '...') if len(preview) > 600 else preview
        parts.append(f"{i}. {frm} — {subj}: {preview}")

    items_text = '\n'.join(parts)
    instruction = f"Summarize the recent dialogue with {person} in 1-5 sentences. Discuss number of emails sent, summarize all topics, and any outstanding actions." 
    resp = _call_openai_with_instruction(items_text, instruction, model=model)
    return resp


def draft_response(target, emails: list, tone: str = 'concise and polite', model: str = 'gpt-4o-mini') -> str:
    msg = emails[target]

    conv_id = msg.get('conversationId') or msg.get('conversationId')
    if conv_id:
        context_msgs = [e for e in emails if e.get('conversationId') == conv_id]
    else:
        subj = (msg.get('subject') or '').lower()
        context_msgs = [e for e in emails if subj and subj in (e.get('subject') or '').lower()]

    context_msgs = sorted(context_msgs, key=lambda x: x.get('receivedDateTime') or '')
    parts = []
    for e in context_msgs[-8:]:
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        subj = e.get('subject') or '(no subject)'
        preview = e.get('bodyPreview') or ''
        preview = (preview[:700] + '...') if len(preview) > 700 else preview
        parts.append(f"From: {frm}\nSubject: {subj}\n{preview}\n")

    items_text = '\n'.join(parts)
    sender_name = msg.get('from', {}).get('emailAddress', {}).get('name') or msg.get('from')
    instruction = (
        f"Write a reply to {sender_name} in a {tone} tone. Use the context below and the latest message to produce a professional email reply. "
        f"Include a suggested short subject line and the full reply body. Keep reply to 3-6 sentences. The email should be written by {NAME}."
    )

    resp = _call_openai_with_instruction(items_text, instruction, model=model)
    return resp


if __name__ == '__main__':
    since = datetime.utcnow() - timedelta(days=1)
    emails = fetch_messages_since(since, top=50)
    summary = summarize_emails(emails)
    print('\n----- SUMMARY -----\n')
    print(summary)

    print('\n----- TOPIC: CEE -----\n')
    since = datetime.utcnow() - timedelta(days=50)
    emails = fetch_messages_since(since, top=200)
    print(summarize_topic("CEE", emails))

    print('\n----- PERSON: TLDR -----\n')
    print(summarize_person("dan@tldrnewsletter.com", emails))

    print('\n----- RESPONSE -----\n')
    print(draft_response(0, emails, tone='concise and polite'))