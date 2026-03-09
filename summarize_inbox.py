OPENAI_KEY = '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'
NAME = "Natalie Shell"
import os
import requests
from datetime import datetime, timedelta
import openai
from openai import error as openai_error
from dotenv import load_dotenv
import json
import ast

try:
    from outlook_manager import ACCESS_TOKEN as _TOKEN
except Exception:
    _TOKEN = None

load_dotenv()
ACCESS_TOKEN = _TOKEN or os.getenv('ACCESS_TOKEN')

openai.api_key = OPENAI_KEY
GRAPH_URL = 'https://graph.microsoft.com/v1.0/me/messages'


def fetch_messages_since(since_dt: datetime, top: int = 50):
    """
    API to access information about the user's inbox. Fetches messages received since the given datetime, sorted by most recent.
    """
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

def build_email_json(since_dt: datetime, top: int = 50):
    """
    Stores the fetched emails in a local JSON file for easier access.
    """
    emails = fetch_messages_since(since_dt, top)
    with open('emails.json', 'w') as f:
        json.dump(emails, f, indent=2)
    return emails


def read_data_json(filepath="emails.json"):
    """
    Reads information from a local JSON file.
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
        return data



def filter_emails(emails=None, output_file="filtered_emails.json"):
    """
    Uses OpenAI to filter emails and saves the 'high-signal' results to a JSON file.
    """
    if not emails:
        print("No emails found to filter.")
        return []

    mini_metadata = []
    for i, e in enumerate(emails):
        mini_metadata.append({
            "index": i,
            "subject": e.get('subject'),
            "from": e.get('from'),
            "preview": (e.get('bodyPreview') or "")[:200]
        })

    filter_instruction = (
        "Analyze these email headers and previews. Identify which ones are PERSONALIZED "
        "correspondence or direct conversation chains. EXCLUDE generic newsletters, "
        "automated 'apply now' invitations, mass marketing, registration prompts, generic 'we would love to meet you' emails. "
        "Return a string with NO TEXT, ONLY a list of indices to keep: [0, 2, ...]"
    )

    def safe_eval():
        response_str = _call_openai_with_instruction(str(mini_metadata), filter_instruction, model='gpt-4o-mini')
        indices = ast.literal_eval(response_str)
        filtered_list = [emails[i] for i in indices if i < len(emails)]
        potential_spam = [emails[i] for i in range(len(emails)) if i not in indices]
        return filtered_list, potential_spam

    try: 
        filtered_list, potential_spam = safe_eval()
    except:
        filtered_list, potential_spam = safe_eval()     


    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(filtered_list, f, indent=4, ensure_ascii=False)

    with open("potential_spam.json", 'w', encoding='utf-8') as f:
        json.dump(potential_spam, f, indent=4, ensure_ascii=False)
    
    print(f"Successfully saved {len(filtered_list)} high-signal emails to {output_file}")
    return filtered_list


def build_prompt(emails):
    emails = filter_emails(emails)
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
        "You are an assistant that summarizes a set of emails. Provide: 1) a 2-3 sentence overall summary of personalized emails, "
        "2) for existing conversation chains / personal emails, actionable To-Dos (who should do what, ONLY for direct personal opportunities, not for spam-like emails), and 3) which emails require direct replies. "
        "Be concise and do not invent facts."
        f"Return ONLY a JSON object with this key: 'emails': 'summary': a brief 1-3 sentence summary', 'to_dos': [list of next steps], 'req_replies': [list of emails requiring replies by sender's email and what I need to respond about]. Do not include any text outside the JSON."
        "Do NOT include markdown formatting, backticks, or '```json'. Start your response with '{' and end with '}'"
    )
    prompt = f"{instruction}\n\nHere are {len(emails)} emails:\n\n{combined}"
    return prompt



def summarize_emails(emails, model='gpt-4o-mini'):
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
        resp = resp['choices'][0]['message']['content'].strip()

        summary_dict = json.loads(resp)
        with open("summary_details.json", 'w', encoding='utf-8') as f:
            json.dump(summary_dict, f, indent=4, ensure_ascii=False)
        return resp
    
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
    with open("chain_emails.json", 'w', encoding='utf-8') as f:
        json.dump(chain_sorted, f, indent=4, ensure_ascii=False)

    parts = []
    for i, e in enumerate(chain_sorted[-8:], start=1):
        subj = e.get('subject') or '(no subject)'
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        preview = e.get('bodyPreview') or ''
        preview = (preview[:800] + '...') if len(preview) > 800 else preview
        parts.append(f"{i}. {frm} — {subj}: {preview}")

    items_text = '\n'.join(parts)

    instruction = (
        f"Summarize the recent dialogue in this chain in 1-5 sentences. "
        "Discuss number of emails sent, all topics, and outstanding actions. "
        f"Return ONLY a JSON object with this key: '{conversation_id}: 'topics': [list of topics discussed], 'summary': a brief 1-3 sentence summary'. Do not include any text outside the JSON."
        "Do NOT include markdown formatting, backticks, or '```json'. Start your response with '{' and end with '}'"
    )
    
    resp_text = _call_openai_with_instruction(items_text, instruction, model=model)
    
    summary_dict = json.loads(resp_text)
    with open("chain_details", 'w', encoding='utf-8') as f:
        json.dump(summary_dict, f, indent=4, ensure_ascii=False)
    return summary_dict[conversation_id]['summary']


def summarize_topic(keyword: str, emails: list, model: str = 'gpt-4o-mini') -> str:
    kw = keyword.lower()
    matched = [e for e in emails if kw in (e.get('subject') or '').lower() or kw in (e.get('bodyPreview') or '').lower() or kw in (e.get('conversationTopic') or '').lower()]
    if not matched:
        return f'No messages found for topic: {keyword}'

    matched_sorted = sorted(matched, key=lambda x: x.get('receivedDateTime') or '', reverse=True)

    with open("topic_emails.json", 'w', encoding='utf-8') as f:
        json.dump(matched_sorted, f, indent=4, ensure_ascii=False)

    parts = []
    for i, e in enumerate(matched_sorted, start=1):
        subj = e.get('subject') or '(no subject)'
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        preview = e.get('bodyPreview') or ''
        preview = (preview[:700] + '...') if len(preview) > 700 else preview
        parts.append(f"{i}. {frm} — {subj}: {preview}")

    items_text = '\n'.join(parts)

    instruction = (
        f"Summarize the thread(s) about '{keyword}' in 1-5 sentences. "
        "Discuss number of emails sent, all topics, and outstanding actions. "
        f"Return ONLY a JSON object with this key: '{keyword}: 'topics': [list of topics discussed], 'summary': a brief 1-3 sentence summary'. Do not include any text outside the JSON."
        "Do NOT include markdown formatting, backticks, or '```json'. Start your response with '{' and end with '}'"
    )

    resp_text = _call_openai_with_instruction(items_text, instruction, model=model)
    
    summary_dict = json.loads(resp_text)
    with open("keyword_details", 'w', encoding='utf-8') as f:
        json.dump(summary_dict, f, indent=4, ensure_ascii=False)
    return summary_dict[keyword]['summary']


def summarize_person(person: str, emails: list, model: str = 'gpt-4o-mini') -> str:
    p = person.lower()

    matched = [e for e in emails if e.get('from', {}).get('emailAddress', {}).get('address') == p]

    matched_sorted = sorted(matched, key=lambda x: x.get('receivedDateTime') or '', reverse=True)

    with open("person_emails.json", 'w', encoding='utf-8') as f:
        json.dump(matched_sorted, f, indent=4, ensure_ascii=False)

    parts = []
    for i, e in enumerate(matched_sorted, start=1):
        subj = e.get('subject') or '(no subject)'
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        preview = e.get('bodyPreview') or ''
        preview = (preview[:600] + '...') if len(preview) > 600 else preview
        parts.append(f"{i}. {frm} — {subj}: {preview}")

    items_text = '\n'.join(parts)
    instruction = (
        f"Summarize the recent dialogue with {person} in 1-5 sentences. "
        "Discuss number of emails sent, all topics, and outstanding actions. "
        f"Return ONLY a JSON object with this key: '{person}: 'topics': [list of topics discussed], 'summary': a brief 1-3 sentence summary'. Do not include any text outside the JSON."
        "Do NOT include markdown formatting, backticks, or '```json'. Start your response with '{' and end with '}'"
    )
    
    resp_text = _call_openai_with_instruction(items_text, instruction, model=model)
    
    summary_dict = json.loads(resp_text)
    with open("person_details", 'w', encoding='utf-8') as f:
        json.dump(summary_dict, f, indent=4, ensure_ascii=False)
    return summary_dict[person]['summary']


def draft_response(target, emails: list, tone: str = 'concise and polite', model: str = 'gpt-4o-mini') -> str:
    msg = emails[target]

    conv_id = msg.get('conversationId') or msg.get('conversationId')
    if conv_id:
        context_msgs = [e for e in emails if e.get('conversationId') == conv_id]
    else:
        subj = (msg.get('subject') or '').lower()
        context_msgs = [e for e in emails if subj and subj in (e.get('subject') or '').lower()]

    context_msgs = sorted(context_msgs, key=lambda x: x.get('receivedDateTime') or '')

    with open("context_emails.json", 'w', encoding='utf-8') as f:
        json.dump(context_msgs, f, indent=4, ensure_ascii=False)    

    parts = []
    for e in context_msgs[-8:]:
        frm = e.get('from', {}).get('emailAddress', {}).get('name') or str(e.get('from'))
        subj = e.get('subject') or '(no subject)'
        preview = e.get('bodyPreview') or ''
        preview = (preview[:700] + '...') if len(preview) > 700 else preview
        parts.append(f"From: {frm}\nSubject: {subj}\n{preview}\n")

    sender_name = msg.get('from', {}).get('emailAddress', {}).get('name') or msg.get('from')
    instruction = (
        f"Write a reply to {sender_name} in a {tone} tone. Use the context below and the latest message to produce a professional email reply. "
        f"Include a suggested short subject line and the full reply body. Keep reply to 3-6 sentences. The email should be written by {NAME}."
    )
    items_text = ''.join(parts)
    resp = _call_openai_with_instruction(items_text, instruction, model=model)
    return resp


if __name__ == '__main__':
    since = datetime.utcnow() - timedelta(days=1)
    emails = fetch_messages_since(since, top=50)
    build_email_json(since, top=50)
    emails = read_data_json("emails.json")

    summary = summarize_emails(emails)
    print('\n----- SUMMARY -----\n')
    print(summary)

    print('\n----- TOPIC: Assignment -----\n')
    since = datetime.utcnow() - timedelta(days=50)
    emails = fetch_messages_since(since, top=200)
    print(summarize_topic("Assignment", emails))

    print('\n----- PERSON: TLDR -----\n')
    print(summarize_person("dan@tldrnewsletter.com", emails))

    print('\n----- RESPONSE -----\n')
    print(draft_response(1, emails, tone='concise and polite'))