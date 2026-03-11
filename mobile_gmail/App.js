import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, TextInput, Animated, StatusBar, Modal, Alert, Linking, Platform,
} from 'react-native';
import Constants from 'expo-constants';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const C = {
  bg: '#0B1220',
  surface: '#0F172A',
  surfaceAlt: '#0B1325',
  border: '#1F2A44',
  textPrimary: '#E5E7EB',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  accent: '#7C3AED',
  accentSoft: '#221032',
  green: '#22C55E',
  greenSoft: '#12301F',
  yellow: '#EAB308',
  yellowSoft: '#2D270F',
  red: '#EF4444',
};

const APPS = [
  { id: 'gmail', label: 'Gmail', icon: '✉️', desc: 'Import threads, links, dates, and attachments.' },
  { id: 'calendar', label: 'Calendar', icon: '📅', desc: 'Overlay extracted dates on your calendar.' },
  { id: 'outlook', label: 'Outlook', icon: '📨', desc: 'Bring your Outlook mail and schedule context.' },
  { id: 'imessage', label: 'iMessage', icon: '💬', desc: 'Include your iMessage conversations.' },
];

const PRIVACY_SETTINGS = [
  { id: 'local', label: 'Local-only processing', desc: 'Parsing runs on-device. No raw data leaves your phone.', icon: '🔒', default: true, locked: true },
  { id: 'redact', label: 'PII redaction', desc: 'Names, addresses, and numbers are stripped before analysis.', icon: '🧹', default: true, locked: true },
  { id: 'counterpart', label: 'Respect counterpart privacy', desc: "Don\'t surface other people\'s private info in your context panel.", icon: '👥', default: true, locked: false },
  { id: 'multiphone', label: 'No cross-device data transfer', desc: 'Data stays on each device. No syncing between your phones.', icon: '📵', default: true, locked: false },
];

const DATA = {
  notifications: [
    { id: 'n1', sourceIcon: '✉️', title: 'Follow up with Design', body: 'Mock updates were sent last night. Need your review.', priority: 'high', source: 'Gmail', timestamp: Date.now() - 1000 * 60 * 25, read: false },
    { id: 'n2', sourceIcon: '📅', title: 'Prep deck for Q2', body: 'Reminder to finalize slides before tomorrow.', priority: 'medium', source: 'Calendar', timestamp: Date.now() - 1000 * 60 * 90, read: false },
    { id: 'n3', sourceIcon: '💬', title: 'PM Sync', body: 'Thread summary is ready. Nothing blocking.', priority: 'low', source: 'Slack', timestamp: Date.now() - 1000 * 60 * 60 * 6, read: true },
  ],
  events: [
    { id: 'ev1', title: 'Design review', date: '2026-02-24', time: '10:00 AM', duration: '60m', attendees: ['Ari', 'Maya'], source: 'Calendar', sourceIcon: '📅', videoLink: 'meet.link/review', notes: 'Focus on mobile layout' },
    { id: 'ev2', title: 'Vendor kickoff', date: '2026-02-25', time: '2:30 PM', duration: '45m', attendees: ['Leah'], source: 'Gmail', sourceIcon: '✉️', videoLink: null, notes: 'Confirm SOW and milestones' },
    { id: 'ev3', title: 'Group Meeting', date: '2026-02-21', time: '3:00 PM', duration: '2 hr', attendees: ['CS 194W'], source: 'Calendar', sourceIcon: '📅', videoLink: null, notes: 'CS 194W' },
    { id: 'ev4', title: 'Physics Assignment', date: '2026-02-06', time: '8:00 PM', duration: '—', attendees: [], source: 'Calendar', sourceIcon: '📅', videoLink: null, notes: 'Submit through Gradescope' },
  ],
  threads: [
    {
      id: 't1', avatar: 'N', avatarColor: '#2563EB', contact: 'Natalie Gray', timestamp: Date.now() - 1000 * 60 * 55,
      lastMessage: 'Does Tuesday still work for the board readout?', sourceIcon: '✉️', source: 'Gmail',
      openItems: ['Send updated agenda', 'Share latest metrics deck'], unread: 2,
      summary: 'Board readout scheduling, waiting on agenda + metrics.', relatedDates: ['Feb 25, 2026 at 2:30 PM'],
    },
    {
      id: 't2', avatar: 'J', avatarColor: '#7C3AED', contact: 'Jason Kim', timestamp: Date.now() - 1000 * 60 * 240,
      lastMessage: 'Cool with merging the PR once tests finish.', sourceIcon: '💬', source: 'Slack',
      openItems: ['Re-run failed test suite'], unread: 0,
      summary: 'PR is ready pending tests; follow up after CI.', relatedDates: ['Feb 24, 2026 at 10:00 AM'],
    },
  ],
};

// Set this to your backend URL if auto-detection fails (e.g., real device on LAN)
const BASE_URL_OVERRIDE = '';

const NOTIF_TIMINGS = ['30 min', '1 hour', '3 hours', '1 day'];
const ONBOARDING_STEPS = ['welcome', 'connect', 'accounts', 'whitelist', 'privacy', 'notifications', 'done'];

function timeAgo(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.max(1, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function priorityColor(p) {
  if (p === 'high') return C.red;
  if (p === 'medium') return C.yellow;
  return C.textSecondary;
}

function priorityBg(p) {
  if (p === 'high') return '#2C0F17';
  if (p === 'medium') return '#2B2810';
  return C.surfaceAlt;
}

function localFallbackReplySuggestions(message) {
  const text = `${message?.title || ''} ${message?.body || ''}`.toLowerCase();
  if (text.includes('verify') || text.includes('security') || text.includes('password') || text.includes('login') || text.includes('sign-in')) {
    return [
      'Thanks for the heads-up. I verified this on my side.',
      'I did not initiate this. Please lock the account and share next steps.',
      'Received. I completed the verification successfully.',
    ];
  }
  if (text.includes('meeting') || text.includes('schedule') || text.includes('calendar') || text.includes('time')) {
    return [
      'Thanks! That time works for me.',
      'Could we move this by 30 minutes due to a conflict?',
      'Confirmed, I will join and come prepared.',
    ];
  }
  return [
    'Thanks for the update. I will follow up shortly.',
    'Received — I reviewed this and will respond with details soon.',
    'Got it. I will take care of this today.',
  ];
}

async function fetchReplySuggestions(message) {
  const payload = {
    subject: message?.title || '',
    body: message?.body || '',
    sender_name: message?.senderName || '',
  };
  const paths = ['/suggest_reply', '/suggest-reply', '/reply_suggestions', '/api/suggest_reply'];

  let lastError = null;
  for (const path of paths) {
    const response = await fetch(`${getBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

    if (response.ok) {
      const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
      return suggestions.filter(Boolean);
    }

    if (response.status !== 404) {
      const msg = data?.message || `HTTP ${response.status} ${response.statusText}`;
      throw new Error(msg);
    }

    lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (lastError && `${lastError.message}`.includes('404')) {
    return localFallbackReplySuggestions(message);
  }

  throw lastError || new Error('AI suggestion endpoint not found');
}

function getBaseUrl() {
  if (BASE_URL_OVERRIDE) return BASE_URL_OVERRIDE;
  // Prefer Expo host when available (useful for real devices on LAN)
  const host = Constants.expoConfig?.hostUri?.split(':')[0] || Constants.expoGoConfig?.debuggerHost?.split(':')[0];
  if (host) return `http://${host}:5001`;
  // Emulators and local dev fallbacks
  if (Platform.OS === 'android') return 'http://10.0.2.2:5001';
  return 'http://localhost:5001';
}

// ─── Shared Components ────────────────────────────────────────────────────────
function ProgressBar({ step, total }) {
  return (
    <View style={s.progressBar}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={[s.progressSeg, { backgroundColor: i < step ? C.accent : C.border }, i < total - 1 && { marginRight: 6 }]} />
      ))}
    </View>
  );
}

function InfoBox({ icon, text, style }) {
  return (
    <View style={[s.infoBox, style]}>
      <Text style={{ fontSize: 18 }}>{icon}</Text>
      <Text style={s.infoBoxText}>{text}</Text>
    </View>
  );
}

// ─── Onboarding Screens ───────────────────────────────────────────────────────
function WelcomeScreen() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 24 }}>
      <View style={s.welcomeGlow} />
      <Text style={{ fontSize: 48, marginBottom: 20 }}>🧩</Text>
      <Text style={s.welcomeTitle}>{'Your context,\neverywhere.'}</Text>
      <Text style={s.welcomeBody}>This assistant lives inside Gmail, WhatsApp, and Slack — connecting dots across all of them so you never lose track of what matters.</Text>
      <View style={{ gap: 10 }}>
        {[['📋','Cross-app inbox summaries'],['📅','Date & deadline extraction'],['🔔','Proactive nudges & reminders'],['🔐','End-to-end encrypted']].map(([icon, label]) => (
          <View key={label} style={s.featureRow}>
            <Text style={{ fontSize: 20, marginRight: 12 }}>{icon}</Text>
            <Text style={{ fontSize: 14, color: C.textPrimary, fontWeight: '500' }}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ConnectAppsScreen({ selected, onToggle }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🔗</Text>
        <Text style={s.sectionTitle}>Connect your apps</Text>
        <Text style={s.sectionSubtitle}>Choose which platforms to sync. Change anytime in Settings.</Text>
      </View>
      {APPS.map(app => (
        <TouchableOpacity key={app.id} style={[s.appCard, selected.includes(app.id) && s.appCardOn]} onPress={() => onToggle(app.id)} activeOpacity={0.8}>
          <Text style={{ fontSize: 26, marginRight: 14 }}>{app.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: C.textPrimary, marginBottom: 2 }}>{app.label}</Text>
            <Text style={{ fontSize: 12, color: C.textSecondary }}>{app.desc}</Text>
          </View>
          <View style={[s.checkbox, selected.includes(app.id) && s.checkboxOn]}>
            {selected.includes(app.id) && <Text style={{ fontSize: 12, color: '#fff', fontWeight: '800' }}>✓</Text>}
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function AppAccountsScreen({ selectedApps, accountValues, onChangeAccount, outlookSignedIn, onOutlookSignedIn }) {
  const selectedMeta = APPS.filter(app => selectedApps.includes(app.id));

  const MICROSOFT_CLIENT_ID = 'fde8d6d4-cb6f-4ad5-862f-0ab740a0bec8';

  const openMicrosoftSignIn = async () => {
    if (outlookSignedIn) return;
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        const redirectUri = window.location.origin;
        const authUrl =
          `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` +
          `?client_id=${encodeURIComponent(MICROSOFT_CLIENT_ID)}` +
          `&response_type=token` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_mode=fragment` +
          `&scope=${encodeURIComponent('openid profile email https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read')}` +
          `&prompt=select_account`;

        const popup = window.open(authUrl, 'microsoft-sign-in', 'width=520,height=720,menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes');
        if (!popup) { await Linking.openURL(authUrl); return; }

        const timer = window.setInterval(() => {
          try {
            const href = popup.location?.href || '';
            if (!href.startsWith(window.location.origin)) return;
            const fragment = href.includes('#') ? href.split('#')[1] : '';
            const params = new URLSearchParams(fragment);
            const token = params.get('access_token');
            if (token) {
              window.clearInterval(timer);
              popup.close();
              onOutlookSignedIn(token);
            }
          } catch (_) { /* cross-origin until redirect completes */ }
        }, 400);
        return;
      }
      // Native: open in browser; token capture is not supported without a redirect scheme
      await Linking.openURL(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize`);
    } catch (err) {
      Alert.alert('Unable to open Microsoft sign-in');
    }
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🔐</Text>
        <Text style={s.sectionTitle}>Sign in to selected apps</Text>
        <Text style={s.sectionSubtitle}>Enter account identifiers for the apps you selected on the previous step.</Text>
      </View>

      {selectedMeta.length === 0 && (
        <Text style={{ color: C.textMuted, fontSize: 13 }}>Select apps first, then come back to connect accounts.</Text>
      )}

      {selectedMeta.map((app) => {
        if (app.id === 'outlook') {
          return (
            <View key={app.id} style={[s.appCard, { paddingVertical: 14 }]}> 
              <Text style={{ fontSize: 24, marginRight: 12 }}>{app.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.textPrimary, fontSize: 14, fontWeight: '700', marginBottom: 8 }}>{app.label} account</Text>
                <TouchableOpacity
                  style={[s.addBtn, {
                    alignSelf: 'flex-start',
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    backgroundColor: outlookSignedIn ? C.green : '#2563EB',
                  }]}
                  onPress={openMicrosoftSignIn}
                  disabled={outlookSignedIn}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
                    {outlookSignedIn ? '✓ Microsoft connected' : 'Sign in with Microsoft'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }

        return (
          <View key={app.id} style={[s.appCard, { paddingVertical: 12 }]}> 
            <Text style={{ fontSize: 24, marginRight: 12 }}>{app.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.textPrimary, fontSize: 14, fontWeight: '700', marginBottom: 6 }}>{app.label} account</Text>
              <TextInput
                style={[s.textInput, { paddingVertical: 10 }]}
                placeholder={app.id === 'gmail' || app.id === 'outlook' ? 'you@example.com' : 'Phone number or Apple ID'}
                placeholderTextColor={C.textMuted}
                autoCapitalize="none"
                keyboardType={app.id === 'imessage' ? 'default' : 'email-address'}
                value={accountValues[app.id] || ''}
                onChangeText={(v) => onChangeAccount(app.id, v)}
              />
            </View>
          </View>
        );
      })}

      <InfoBox icon="ℹ️" text="For Gmail, this value is used as your user key and sync source in the dashboard." />
    </ScrollView>
  );
}

function WhitelistScreen({ contacts, inputValue, onChangeInput, onAdd, onRemove }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>✅</Text>
        <Text style={s.sectionTitle}>Whitelist trusted contacts</Text>
        <Text style={s.sectionSubtitle}>The assistant only surfaces cross-app context for people you trust.</Text>
      </View>
      <View style={{ flexDirection: 'row', marginBottom: 16, gap: 10 }}>
        <TextInput style={s.textInput} placeholder="Add name or email..." placeholderTextColor={C.textMuted}
          value={inputValue} onChangeText={onChangeInput} onSubmitEditing={onAdd} returnKeyType="done" autoCapitalize="none" />
        <TouchableOpacity style={s.addBtn} onPress={onAdd}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {contacts.length === 0
          ? <Text style={{ color: C.textMuted, fontSize: 13, fontStyle: 'italic' }}>No contacts added yet.</Text>
          : contacts.map(c => (
            <View key={c} style={s.chip}>
              <Text style={s.chipText}>{c}</Text>
              <TouchableOpacity onPress={() => onRemove(c)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={{ fontSize: 16, color: C.accent, fontWeight: '700', lineHeight: 18 }}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
      </View>
      <InfoBox icon="💡" text="Only whitelisted contacts will have their messages cross-referenced. Everyone else stays siloed." />
    </ScrollView>
  );
}

function PrivacyScreen({ privacyValues, onToggle }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🔐</Text>
        <Text style={s.sectionTitle}>Privacy & security</Text>
        <Text style={s.sectionSubtitle}>Double-sided protection — for you and the people you communicate with.</Text>
      </View>
      {PRIVACY_SETTINGS.map(setting => (
        <View key={setting.id} style={[s.privacyRow, setting.locked && { borderColor: C.greenSoft, backgroundColor: C.greenSoft }]}>
          <Text style={{ fontSize: 22, marginRight: 12 }}>{setting.icon}</Text>
          <View style={{ flex: 1, marginRight: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: C.textPrimary }}>{setting.label}</Text>
              {setting.locked && <View style={s.lockedBadge}><Text style={s.lockedBadgeText}>REQUIRED</Text></View>}
            </View>
            <Text style={{ fontSize: 12, color: C.textSecondary, lineHeight: 18 }}>{setting.desc}</Text>
          </View>
          <Switch value={privacyValues[setting.id]} onValueChange={setting.locked ? undefined : val => onToggle(setting.id, val)}
            disabled={setting.locked} trackColor={{ false: C.border, true: C.accent }}
            thumbColor={privacyValues[setting.id] ? '#fff' : C.textMuted} ios_backgroundColor={C.border} />
        </View>
      ))}
      <InfoBox icon="🔒" text="A rule-based layer runs before any AI processing to catch sensitive patterns." style={{ borderColor: C.accentSoft, backgroundColor: '#0D1A2A' }} />
    </ScrollView>
  );
}

function NotificationsOnboarding({ notifEnabled, onToggleNotif, leadTime, onSelectLeadTime }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🔔</Text>
        <Text style={s.sectionTitle}>Notifications</Text>
        <Text style={s.sectionSubtitle}>Get nudged when something time-sensitive needs your attention.</Text>
      </View>
      <View style={s.privacyRow}>
        <Text style={{ fontSize: 22, marginRight: 12 }}>🔔</Text>
        <View style={{ flex: 1, marginRight: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: C.textPrimary, marginBottom: 3 }}>Enable notifications</Text>
          <Text style={{ fontSize: 12, color: C.textSecondary }}>Reminders for deadlines, replies, and events.</Text>
        </View>
        <Switch value={notifEnabled} onValueChange={onToggleNotif}
          trackColor={{ false: C.border, true: C.accent }} thumbColor={notifEnabled ? '#fff' : C.textMuted} ios_backgroundColor={C.border} />
      </View>
      {notifEnabled && (
        <>
          <Text style={{ fontSize: 14, color: C.textSecondary, marginTop: 16, marginBottom: 10 }}>Notify me ahead of time by:</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
            {NOTIF_TIMINGS.map(t => (
              <TouchableOpacity key={t} style={[s.timingChip, leadTime === t && s.timingChipOn]} onPress={() => onSelectLeadTime(t)}>
                <Text style={[{ fontSize: 14, color: C.textSecondary, fontWeight: '500' }, leadTime === t && { color: C.accent, fontWeight: '700' }]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
      <InfoBox icon="📲" text="All notification processing happens locally. No data sent to external servers." />
    </ScrollView>
  );
}

function DoneScreen({ connectedCount, contactCount }) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingBottom: 24 }}>
      <View style={s.doneGlow} />
      <Text style={{ fontSize: 56, marginBottom: 16 }}>🎉</Text>
      <Text style={s.doneTitle}>You're all set!</Text>
      <Text style={{ fontSize: 14, color: C.textSecondary, lineHeight: 22, textAlign: 'center', marginBottom: 28, paddingHorizontal: 8 }}>
        Your contextual assistant is configured. Look for the extension icon in Gmail, WhatsApp, and Slack.
      </Text>
      <View style={s.doneSummaryCard}>
        {[['🔗', `${connectedCount} apps connected`], ['✅', `${contactCount} trusted contacts`], ['🔐', 'Encryption enabled'], ['🛡️', 'Privacy rules active']].map(([icon, label]) => (
          <View key={label} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
            <Text style={{ fontSize: 18, marginRight: 12 }}>{icon}</Text>
            <Text style={{ fontSize: 14, color: C.textPrimary, fontWeight: '500' }}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── Dashboard: Notifications Tab ─────────────────────────────────────────────
function NotificationsTab({ notifications, setNotifications, ingestMessages = [], ingestDates = [], isDeleted, onMoveToJunk }) {
  const notifs = notifications;
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [replySuggestions, setReplySuggestions] = useState([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState('');
  const [gmailReadMap, setGmailReadMap] = useState({});

  const dateMessageIds = React.useMemo(() => {
    const ids = new Set();
    (ingestDates || []).forEach(d => {
      if (d?.message_id) ids.add(d.message_id);
    });
    return ids;
  }, [ingestDates]);

  const inboxFromGmail = React.useMemo(() => {
    const actionRe = /(verify your device|security alert|action required|please verify|confirm|password|login|sign-in|urgent)/i;
    return (ingestMessages || [])
      .filter(m => {
        const subject = `${m?.subject || ''}`;
        const snippet = `${m?.snippet || ''}`;
        const isActionLike = actionRe.test(subject) || actionRe.test(snippet);
        const isSpam = typeof m.category === 'string' && m.category.toUpperCase() === 'SPAM';
        return (!dateMessageIds.has(m?.id) || isActionLike) && !isSpam;
      })
      .slice(0, 8)
      .map(m => {
        const isOutlook = m.source === 'outlook';
        const p = m.priority ? m.priority.toLowerCase() : undefined;
        return {
          id: `ing-msg-${m.id}`,
          junkKey: `${m.source || 'gmail'}-${m.id}`,
          readKey: `${m.source || 'gmail'}-${m.id}`,
          title: isOutlook ? (m.summary_phrase || m.subject || 'Outlook Message').trim() : (m.subject || 'Gmail Message').trim(),
          body: isOutlook ? (m.description || m.snippet || '').trim() : (m.snippet || '').trim(),
          senderName: (m.sender_name || m.sender || '').trim(),
          source: isOutlook ? 'Outlook' : 'Gmail',
          sourceIcon: isOutlook ? '📨' : '✉️',
          category: m.category || '',
          priority: p || 'low',
          timestamp: m.sent_at_utc ? new Date(m.sent_at_utc).getTime() : Date.now(),
        };
      })
      .filter(n => !isDeleted(n.junkKey));
  }, [ingestMessages, dateMessageIds, isDeleted]);

  const appInbox = React.useMemo(() => {
    return (notifs || [])
      .filter(n => !isDeleted(`notif-${n.id}`))
      .map(n => ({
        ...n,
        readKey: `notif-${n.id}`,
      }));
  }, [notifs, isDeleted]);

  const unreadApp = appInbox.filter(n => !n.read);
  const readApp = appInbox.filter(n => n.read);
  const unreadGmail = inboxFromGmail.filter(n => !gmailReadMap[n.readKey]);
  const readGmail = inboxFromGmail.filter(n => !!gmailReadMap[n.readKey]);
  const unreadCount = unreadApp.length + unreadGmail.length;
  const totalCount = appInbox.length + inboxFromGmail.length;

  function markRead(id) { setNotifications(p => p.map(n => n.id === id ? { ...n, read: true } : n)); }
  function markAll() {
    setNotifications(p => p.map(n => ({ ...n, read: true })));
    setGmailReadMap(prev => {
      const next = { ...prev };
      inboxFromGmail.forEach((item) => {
        next[item.readKey] = true;
      });
      return next;
    });
  }

  async function openMessage(message, readKey) {
    if (readKey?.startsWith('notif-')) {
      markRead(readKey.replace('notif-', ''));
    }
    if (readKey?.startsWith('gmail-')) {
      setGmailReadMap(prev => ({ ...prev, [readKey]: true }));
    }

    setSelectedMessage(message);
    setReplySuggestions([]);
    setSuggestionsError('');
    setIsLoadingSuggestions(true);

    try {
      const suggestions = await fetchReplySuggestions(message);
      setReplySuggestions(suggestions);
    } catch (error) {
      setSuggestionsError(error?.message || 'Failed to load AI suggestions');
      setReplySuggestions([]);
    } finally {
      setIsLoadingSuggestions(false);
    }
  }

  function Card({ n }) {
    return (
      <TouchableOpacity
        style={[s.notifCard, !n.read && s.notifCardUnread]}
        onPress={() => {
          openMessage({
            title: n.title,
            body: n.body,
            source: n.source,
            timestamp: n.timestamp,
            senderName: n.senderName || '',
          }, n.readKey);
        }}
        activeOpacity={0.8}
      >
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={s.notifBubble}><Text style={{ fontSize: 18 }}>{n.sourceIcon}</Text></View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Text style={s.notifTitle} numberOfLines={1}>{n.title}</Text>
              {!n.read && <View style={s.unreadDot} />}
              <TouchableOpacity onPress={() => onMoveToJunk({ key: `notif-${n.id}`, from: 'Inbox', title: n.title, subtitle: n.body, timestamp: n.timestamp })}>
                <Text style={{ color: C.textMuted, marginLeft: 8, fontSize: 18, fontWeight: '700' }}>×</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }} numberOfLines={2}>{n.body}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <View style={[s.badge, { backgroundColor: priorityBg(n.priority) }]}>
                <Text style={[s.badgeText, { color: priorityColor(n.priority) }]}>{n.priority.toUpperCase()}</Text>
              </View>
              <Text style={{ fontSize: 11, color: C.textMuted }}>{n.source} · {timeAgo(n.timestamp)}</Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Notifications</Text>
          <Text style={s.dashSubtitle}>{unreadCount} unread · {totalCount} total</Text>
        </View>
        {unreadCount > 0 && (
          <TouchableOpacity onPress={markAll} style={s.markAllBtn}>
            <Text style={{ fontSize: 12, color: C.textSecondary, fontWeight: '600' }}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>

      {(unreadApp.length > 0 || unreadGmail.length > 0) && <>
        <Text style={s.groupLabel}>UNREAD</Text>
        {unreadApp.length > 0 && <Text style={[s.groupLabel, { marginTop: 8, fontSize: 11 }]}>FROM APPS</Text>}
        {unreadApp.map(n => <Card key={n.readKey} n={n} />)}
        {unreadGmail.length > 0 && <Text style={[s.groupLabel, { marginTop: 12, fontSize: 11 }]}>FROM OUTLOOK</Text>}
        {unreadGmail.map(n => (
          <TouchableOpacity
            key={n.id}
            style={s.notifCard}
            activeOpacity={0.8}
            onPress={() => openMessage({
              title: n.title,
              body: n.body,
              source: n.source,
              timestamp: n.timestamp,
              senderName: n.senderName || '',
            }, n.readKey)}
          >
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={s.notifBubble}><Text style={{ fontSize: 18 }}>{n.sourceIcon}</Text></View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={s.notifTitle} numberOfLines={1}>{n.title}</Text>
                  <View style={s.unreadDot} />
                  <TouchableOpacity onPress={() => onMoveToJunk({ key: n.junkKey, from: 'Inbox', title: n.title, subtitle: n.body, timestamp: n.timestamp })}>
                    <Text style={{ color: C.textMuted, marginLeft: 8, fontSize: 18, fontWeight: '700' }}>×</Text>
                  </TouchableOpacity>
                </View>
                {!!n.body && <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20, marginTop: 4 }} numberOfLines={2}>{n.body}</Text>}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
                  {n.priority && (
                    <View style={[s.badge, { backgroundColor: priorityBg(n.priority) }]}>
                      <Text style={[s.badgeText, { color: priorityColor(n.priority) }]}>
                        {n.priority.toUpperCase()}
                      </Text>
                    </View>
                  )}
                  {n.category && n.category !== 'NONE' && (
                    <View style={[s.badge, { backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border }]}>
                      <Text style={[s.badgeText, { color: C.textMuted }]}>
                        {n.category.toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <Text style={{ fontSize: 11, color: C.textMuted }}>{n.source} · {timeAgo(n.timestamp)}</Text>
                </View>
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </>}

      {(readApp.length > 0 || readGmail.length > 0) && <>
        <Text style={[s.groupLabel, { marginTop: 16 }]}>READ</Text>
        {readApp.length > 0 && <Text style={[s.groupLabel, { marginTop: 8, fontSize: 11 }]}>FROM APPS</Text>}
        {readApp.map(n => <Card key={n.readKey} n={n} />)}
        {readGmail.length > 0 && <Text style={[s.groupLabel, { marginTop: 12, fontSize: 11 }]}>FROM OUTLOOK</Text>}
        {readGmail.map(n => (
          <TouchableOpacity
            key={n.id}
            style={s.notifCard}
            activeOpacity={0.8}
            onPress={() => openMessage({
              title: n.title,
              body: n.body,
              source: n.source,
              timestamp: n.timestamp,
              senderName: n.senderName || '',
            }, n.readKey)}
          >
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={s.notifBubble}><Text style={{ fontSize: 18 }}>{n.sourceIcon}</Text></View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={s.notifTitle} numberOfLines={1}>{n.title}</Text>
                  <TouchableOpacity onPress={() => onMoveToJunk({ key: n.junkKey, from: 'Inbox', title: n.title, subtitle: n.body, timestamp: n.timestamp })}>
                    <Text style={{ color: C.textMuted, marginLeft: 8, fontSize: 18, fontWeight: '700' }}>×</Text>
                  </TouchableOpacity>
                </View>
                {!!n.body && <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20, marginTop: 4 }} numberOfLines={2}>{n.body}</Text>}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
                  {n.priority && (
                    <View style={[s.badge, { backgroundColor: priorityBg(n.priority) }]}>
                      <Text style={[s.badgeText, { color: priorityColor(n.priority) }]}>
                        {n.priority.toUpperCase()}
                      </Text>
                    </View>
                  )}
                  {n.category && n.category !== 'NONE' && (
                    <View style={[s.badge, { backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border }]}>
                      <Text style={[s.badgeText, { color: C.textMuted }]}>
                        {n.category.toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <Text style={{ fontSize: 11, color: C.textMuted }}>{n.source} · {timeAgo(n.timestamp)}</Text>
                </View>
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </>}

      <Modal visible={!!selectedMessage} transparent animationType="slide" onRequestClose={() => setSelectedMessage(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            {selectedMessage && <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 }}>
                <Text style={s.modalTitle}>{selectedMessage.title}</Text>
                <TouchableOpacity onPress={() => setSelectedMessage(null)}>
                  <Text style={{ fontSize: 22, color: C.textMuted }}>×</Text>
                </TouchableOpacity>
              </View>
              <Text style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
                {selectedMessage.source} · {timeAgo(selectedMessage.timestamp)}
              </Text>
              <View style={{ backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 12, marginBottom: 14 }}>
                <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>
                  {selectedMessage.body || 'No content preview available.'}
                </Text>
              </View>

              <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 8 }}>AI SUGGESTED REPLIES</Text>
              {isLoadingSuggestions && (
                <Text style={{ color: C.textSecondary, fontSize: 13, marginBottom: 8 }}>Generating suggestions...</Text>
              )}
              {!isLoadingSuggestions && !!suggestionsError && (
                <Text style={{ color: C.red, fontSize: 13, marginBottom: 8 }}>{suggestionsError}</Text>
              )}
              {!isLoadingSuggestions && !suggestionsError && replySuggestions.length === 0 && (
                <Text style={{ color: C.textSecondary, fontSize: 13, marginBottom: 8 }}>No suggestions available.</Text>
              )}
              {replySuggestions.map((reply, idx) => (
                <TouchableOpacity key={`${idx}-${reply}`} style={{ backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                  <Text style={{ color: C.textPrimary, fontSize: 13, lineHeight: 19 }}>{reply}</Text>
                </TouchableOpacity>
              ))}
            </>}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Dashboard: Calendar Tab ──────────────────────────────────────────────────
function CalendarTab({ ingestDates = [], ingestMessages = [], isDeleted, onMoveToJunk }) {
  const [selected, setSelected] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const msgById = React.useMemo(() => {
    const m = {};
    (ingestMessages || []).forEach(msg => { m[msg.id] = msg; });
    return m;
  }, [ingestMessages, isDeleted]);

  const seenByMessage = new Set();
  const ingestEvents = (ingestDates || [])
    .filter(d => d && (d.resolved_date || d.parsed_at_utc))
    .map(d => {
      // Enforce one event per message_id; always use resolved_date when present.
      if (!d.message_id || seenByMessage.has(d.message_id)) return null;
      seenByMessage.add(d.message_id);

      const isoRaw = String(d.resolved_date || d.parsed_at_utc || '').trim();
      let dateStr = '';
      let timeStr = '';
      if (isoRaw) {
        const parts = isoRaw.split('T');
        dateStr = parts[0].slice(0, 10);
        timeStr = parts.length > 1 && parts[1].length >= 5 ? parts[1].slice(0, 5) : '';
      }

      const msg = msgById[d.message_id];
      if (msg && isDeleted(`${msg.source || 'gmail'}-${msg.id}`)) return null;
      const isOutlook = msg?.source === 'outlook';
      const title = isOutlook ? (msg?.summary_phrase || msg?.subject || 'Event') : ((msg?.subject && msg.subject.trim()) || (msg?.snippet && msg.snippet.trim()) || (d.raw_span && d.raw_span.trim()) || 'Event');
      const rawNote = d.raw_span && d.raw_span.trim();
      const note = isOutlook ? (msg?.description || msg?.snippet || rawNote) : ((msg?.snippet && msg.snippet.trim()) || rawNote || `From message ${d.message_id}`);

      return {
        id: `ing-${d.id}`,
        junkKey: `cal-${d.id}`,
        title,
        date: dateStr,
        time: timeStr,
        duration: null,
        attendees: [],
        source: isOutlook ? 'Outlook' : 'Gmail',
        sourceIcon: isOutlook ? '📨' : '✉️',
        videoLink: null,
        notes: note,
      };
    })
    .filter(Boolean);

  const visibleEvents = ingestEvents.filter(e => !isDeleted(e.junkKey));

  const eventMap = React.useMemo(() => {
    const out = {};
    visibleEvents.forEach((event) => {
      if (!out[event.date]) out[event.date] = [];
      out[event.date].push(event);
    });
    return out;
  }, [visibleEvents]);

  const monthTitle = monthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const firstOfMonth = monthCursor;
  const startDow = firstOfMonth.getUTCDay();
  const gridStart = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth(), 1 - startDow));
  const gridDays = Array.from({ length: 42 }).map((_, i) => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    return d;
  });

  function toDateKey(d) {
    return d.toISOString().slice(0, 10);
  }

  const selectedDateKey = selectedDay ? toDateKey(selectedDay) : null;
  const selectedDayEvents = selectedDateKey ? (eventMap[selectedDateKey] || []) : [];

  function prevMonth() {
    setMonthCursor((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)));
    setSelectedDay(null);
  }

  function nextMonth() {
    setMonthCursor((prev) => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)));
    setSelectedDay(null);
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View style={{ flex: 1 }}>
          <Text style={s.dashTitle}>Calendar</Text>
          <Text style={s.dashSubtitle}>{ingestEvents.length} events from extracted dates</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <TouchableOpacity onPress={prevMonth}><Text style={{ color: C.textSecondary, fontSize: 20 }}>‹</Text></TouchableOpacity>
          <Text style={{ color: C.textPrimary, fontWeight: '700', fontSize: 14, minWidth: 120, textAlign: 'center' }}>{monthTitle}</Text>
          <TouchableOpacity onPress={nextMonth}><Text style={{ color: C.textSecondary, fontSize: 20 }}>›</Text></TouchableOpacity>
        </View>
      </View>

      {ingestEvents.length === 0 && (
        <Text style={{ color: C.textMuted, fontSize: 13, marginBottom: 12 }}>No extracted dates yet.</Text>
      )}

      <View style={s.calGridWrap}>
        <View style={s.calWeekRow}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, idx) => (
            <Text key={`${d}-${idx}`} style={s.calWeekLabel}>{d}</Text>
          ))}
        </View>

        <View style={s.calGrid}>
          {gridDays.map((day) => {
            const key = toDateKey(day);
            const inMonth = day.getUTCMonth() === monthCursor.getUTCMonth();
            const dayEvents = eventMap[key] || [];
            const isSelected = selectedDateKey === key;
            return (
              <TouchableOpacity key={key} style={[s.calCell, !inMonth && s.calCellMuted, isSelected && s.calCellSelected]} onPress={() => setSelectedDay(day)} activeOpacity={0.8}>
                <Text style={[s.calCellNum, !inMonth && s.calCellNumMuted]}>{day.getUTCDate()}</Text>
                <View style={s.calDotRow}>
                  {dayEvents.slice(0, 3).map((ev) => (
                    <View key={`dot-${ev.id}`} style={s.calDot} />
                  ))}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {selectedDateKey && (
        <View style={{ marginTop: 14 }}>
          <Text style={s.groupLabel}>EVENTS · {formatDate(selectedDateKey)}</Text>
          {selectedDayEvents.length === 0 && <Text style={{ color: C.textMuted, fontSize: 13, marginBottom: 12 }}>No events on this day.</Text>}
          {selectedDayEvents.map((e) => (
            <TouchableOpacity key={e.id} style={s.notifCard} onPress={() => setSelected(e)} activeOpacity={0.8}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ color: C.textSecondary, fontSize: 12, minWidth: 44 }}>{e.time || 'All day'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.notifTitle} numberOfLines={1}>{e.title}</Text>
                  {!!e.notes && <Text style={{ color: C.textSecondary, fontSize: 12, marginTop: 4 }} numberOfLines={1}>{e.notes}</Text>}
                </View>
                <TouchableOpacity onPress={() => onMoveToJunk({ key: e.junkKey, from: 'Calendar', title: e.title, subtitle: e.notes, timestamp: Date.now() })}>
                  <Text style={{ color: C.textMuted, fontSize: 18, fontWeight: '700' }}>×</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            {selected && <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 }}>
                <Text style={s.modalTitle}>{selected.title}</Text>
                <TouchableOpacity onPress={() => setSelected(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Text style={{ fontSize: 22, color: C.textMuted }}>×</Text>
                </TouchableOpacity>
              </View>
              {[
                ['🕐', `${selected.time}${selected.duration ? ` · ${selected.duration}` : ''}`],
                ['📅', formatDate(selected.date)],
                [selected.sourceIcon, selected.source],
                selected.attendees.length > 0 ? ['👥', selected.attendees.join(', ')] : null,
              ].filter(Boolean).map(([icon, text]) => (
                <View key={text} style={s.modalRow}>
                  <Text style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{icon}</Text>
                  <Text style={{ fontSize: 14, color: C.textSecondary, flex: 1 }}>{text}</Text>
                </View>
              ))}
              {selected.videoLink && (
                <View style={[s.modalRow, { backgroundColor: C.accentSoft, borderRadius: 10, padding: 10, marginTop: 4 }]}>
                  <Text style={{ fontSize: 16, width: 24, textAlign: 'center' }}>🔗</Text>
                  <Text style={{ fontSize: 13, color: C.accent, flex: 1 }} numberOfLines={1}>{selected.videoLink}</Text>
                </View>
              )}
              {selected.notes && (
                <View style={{ marginTop: 16, backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 12 }}>
                  <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 4 }}>NOTES</Text>
                  <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>{selected.notes}</Text>
                </View>
              )}
            </>}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Dashboard: TODO Tab (links & attachments) ───────────────────────────────
function TodoTab({ ingestLinks = [], ingestAttachments = [], isDeleted, onMoveToJunk, userKey = '' }) {
  const links = ingestLinks.filter(l => !isDeleted(`link-${l.id}`)).slice(0, 3);
  const isAllowedDocAttachment = (a) => {
    const mime = String(a?.mime_type || '').trim().toLowerCase();
    if (
      mime === 'application/pdf' ||
      mime === 'application/msword' ||
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return true;
    }
    const filename = String(a?.filename || '').trim().toLowerCase();
    return /\.(pdf|doc|docx)$/i.test(filename);
  };
  const attachments = ingestAttachments
    .filter(a => !isDeleted(`att-${a.id}`))
    .filter(isAllowedDocAttachment)
    .slice(0, 20);
  const senderDisplay = (link) => {
    if (link?.sender_name && String(link.sender_name).trim()) return String(link.sender_name).trim();
    const raw = String(link?.sender || '').trim();
    if (!raw) return '';
    const m = raw.match(/^(.*)<([^>]+)>$/);
    if (m) {
      const name = (m[1] || '').replace(/\"/g, '').trim();
      return name || (m[2] || '').trim();
    }
    return raw;
  };
  const hostLabel = (url) => {
    const value = String(url || '').trim();
    if (!value) return 'Link';
    try {
      const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      return new URL(withProtocol).hostname.replace(/^www\./i, '');
    } catch {
      return value;
    }
  };
  const linkLabel = (link) => {
    const subject = String(link?.subject || '').trim();
    if (subject) return subject;

    const sender = senderDisplay(link);
    if (sender) return sender;

    return hostLabel(link?.url);
  };
  const openLink = (url) => {
    const target = url?.startsWith('http') ? url : `http://${url}`;
    Linking.openURL(target).catch(() => Alert.alert('Unable to open link', target));
  };
  const openAttachment = (a) => {
    const source = String(a?.original_path || '').trim();

    if (a?.id != null) {
      const normalizedUser = String(userKey || '').trim().toLowerCase();
      const qs = `attachment_id=${encodeURIComponent(String(a.id))}${normalizedUser ? `&user_key=${encodeURIComponent(normalizedUser)}` : ''}`;
      const previewUrl = `${getBaseUrl()}/attachment_preview?${qs}`;
      Linking.openURL(previewUrl).catch(() => Alert.alert('Unable to open attachment', previewUrl));
      return;
    }

    if (source && /^https?:\/\//i.test(source)) {
      Linking.openURL(source).catch(() => Alert.alert('Unable to open attachment', source));
      return;
    }

    Alert.alert('Attachment', a.filename || 'Attachment');
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Links & Attachments</Text>
          <Text style={s.dashSubtitle}>{links.length} links · {attachments.length} attachments</Text>
        </View>
      </View>

      <Text style={s.groupLabel}>Links</Text>
      {links.length === 0 && <Text style={{ color: C.textMuted, fontSize: 13, marginBottom: 12 }}>No links yet.</Text>}
      {links.map((l) => {
        const friendly = linkLabel(l);
        return (
        <TouchableOpacity key={`l-${l.id}`} style={s.notifCard} activeOpacity={0.8} onPress={() => openLink(l.url)}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={s.notifTitle} numberOfLines={1}>{friendly}</Text>
              <TouchableOpacity onPress={() => onMoveToJunk({ key: `link-${l.id}`, from: 'Links & Attachments', title: friendly, subtitle: l.url, timestamp: Date.now() })}>
                <Text style={{ color: C.textMuted, marginLeft: 8, fontSize: 18, fontWeight: '700' }}>×</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }} numberOfLines={1}>{l.url}</Text>
          </View>
        </TouchableOpacity>
        );
      })}

      <Text style={[s.groupLabel, { marginTop: 16 }]}>Attachments</Text>
      {attachments.length === 0 && <Text style={{ color: C.textMuted, fontSize: 13 }}>No attachments yet.</Text>}
      {attachments.map(a => (
        <TouchableOpacity key={`a-${a.id}`} style={s.notifCard} activeOpacity={0.8} onPress={() => openAttachment(a)}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={s.notifTitle} numberOfLines={1}>{a.filename || 'Attachment'}</Text>
              <TouchableOpacity onPress={() => onMoveToJunk({ key: `att-${a.id}`, from: 'Links & Attachments', title: a.filename || 'Attachment', subtitle: a.mime_type || '', timestamp: Date.now() })}>
                <Text style={{ color: C.textMuted, marginLeft: 8, fontSize: 18, fontWeight: '700' }}>×</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 12, color: C.textSecondary }} numberOfLines={1}>{a.mime_type || ''}</Text>
            <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Msg {a.message_id}</Text>
          </View>
          <Text style={{ fontSize: 18 }}>📎</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// ─── Dashboard: Threads Tab ───────────────────────────────────────────────────
function ThreadsTab({ ingestMessages = [], isDeleted, onMoveToJunk }) {
  const [selected, setSelected] = useState(null);

  const threads = React.useMemo(() => {
    const bySender = new Map();

    (ingestMessages || []).forEach((msg) => {
      if (isDeleted(`${msg.source || 'gmail'}-${msg.id}`)) return;
      let sender = 'Unknown Sender';
      let sName = (msg?.sender_name || '').trim();
      let sEmail = (msg?.sender || '').trim();
      
      if (sName) {
        if (sName.includes('<')) sName = sName.split('<')[0].trim();
        sName = sName.replace(/^["']|["']$/g, '').trim();
        sender = (sName !== sEmail && !sName.includes('@')) ? sName : sName.split('@')[0];
      } else if (sEmail) {
        if (sEmail.includes('<')) sEmail = sEmail.split('<')[0].trim();
        sender = sEmail.split('@')[0];
      }

      const ts = msg?.sent_at_utc ? new Date(msg.sent_at_utc).getTime() : 0;
      const item = {
        id: msg.id,
        source: msg.source,
        subject: msg.subject || 'No subject',
        snippet: msg.snippet || '',
        summary_phrase: msg.summary_phrase || '',
        description: msg.description || '',
        sentAt: msg.sent_at_utc || null,
        ts,
      };

      if (!bySender.has(sender)) bySender.set(sender, []);
      bySender.get(sender).push(item);
    });

    const out = [];
    bySender.forEach((items, sender) => {
      const sorted = items.sort((a, b) => b.ts - a.ts);
      const latest = sorted[0];
      const isOutlook = latest?.source === 'outlook';
      out.push({
        id: `th-${sender}`,
        contact: sender,
        source: isOutlook ? 'Outlook' : 'Gmail',
        sourceIcon: isOutlook ? '📨' : '✉️',
        timestamp: latest?.ts || 0,
        latestSubject: isOutlook ? (latest?.summary_phrase || latest?.subject || 'No subject') : (latest?.subject || 'No subject'),
        latestSnippet: isOutlook ? (latest?.description || latest?.snippet || '') : (latest?.snippet || ''),
        count: sorted.length,
        messages: sorted,
      });
    });

    return out.sort((a, b) => b.timestamp - a.timestamp).filter(t => !isDeleted(`thread-${t.id}`));
  }, [ingestMessages]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Threads</Text>
          <Text style={s.dashSubtitle}>{threads.length} senders grouped by latest email</Text>
        </View>
      </View>

      {threads.length === 0 && <Text style={{ color: C.textMuted, fontSize: 13 }}>No threads yet.</Text>}

      {threads.map(t => (
        <TouchableOpacity key={t.id} style={s.threadCard} onPress={() => setSelected(t)} activeOpacity={0.8}>
          <View style={[s.avatar, { backgroundColor: '#334155' }]}> 
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>{(t.contact || '?').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.textPrimary }}>{t.contact}</Text>
              <Text style={{ fontSize: 11, color: C.textMuted }}>{timeAgo(t.timestamp)}</Text>
            </View>
            <Text style={{ fontSize: 13, color: C.textSecondary }} numberOfLines={1}>{t.latestSubject}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <Text style={{ fontSize: 12 }}>{t.sourceIcon}</Text>
              <Text style={{ fontSize: 11, color: C.textMuted }}>{t.source}</Text>
              <View style={s.openBadge}>
                <Text style={{ fontSize: 10, color: C.yellow, fontWeight: '700' }}>{t.count} msgs</Text>
              </View>
            </View>
          </View>
          <TouchableOpacity onPress={() => onMoveToJunk({ key: `thread-${t.id}`, from: 'Threads', title: t.contact, subtitle: t.latestSubject, timestamp: t.timestamp })}>
            <Text style={{ color: C.textMuted, fontSize: 18, fontWeight: '700' }}>×</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      ))}

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            {selected && <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={[s.avatar, { backgroundColor: '#334155' }]}> 
                    <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>{(selected.contact || '?').slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <View>
                    <Text style={s.modalTitle}>{selected.contact}</Text>
                    <Text style={{ fontSize: 12, color: C.textMuted }}>{selected.source}</Text>
                  </View>
                </View>
                <TouchableOpacity onPress={() => setSelected(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Text style={{ fontSize: 22, color: C.textMuted }}>×</Text>
                </TouchableOpacity>
              </View>
              <Text style={{ fontSize: 13, color: C.textPrimary, fontWeight: '700', marginBottom: 12, marginTop: 12, letterSpacing: 0.5, borderBottomWidth: 1, borderBottomColor: C.border, paddingBottom: 4 }}>Recent Dialogues</Text>
              <ScrollView style={{ maxHeight: 400 }}>
                {selected.messages.slice(0, 8).map(m => (
                  <View key={`m-${m.id}`} style={{ backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                    <Text style={{ fontSize: 13, color: C.textPrimary, fontWeight: '700', marginBottom: 4 }} numberOfLines={1}>{m.summary_phrase || m.subject || 'No subject'}</Text>
                    {!!(m.description || m.snippet) && <Text style={{ fontSize: 12, color: C.textSecondary, lineHeight: 18 }} numberOfLines={3}>{m.description || m.snippet}</Text>}
                    <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 8, textAlign: 'right' }}>{m.sentAt ? new Date(m.sentAt).toLocaleString() : ''}</Text>
                  </View>
                ))}
              </ScrollView>
            </>}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function JunkTab({ deletedItems = [] }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Junk</Text>
          <Text style={s.dashSubtitle}>{deletedItems.length} deleted items</Text>
        </View>
      </View>
      {deletedItems.length === 0 && <Text style={{ color: C.textMuted, fontSize: 13 }}>Nothing deleted yet.</Text>}
      {deletedItems.map(item => (
        <View key={item.key} style={s.notifCard}>
          <Text style={s.notifTitle} numberOfLines={1}>{item.title}</Text>
          {!!item.subtitle && <Text style={{ fontSize: 12, color: C.textSecondary, marginTop: 4 }} numberOfLines={2}>{item.subtitle}</Text>}
          <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>{item.from} · {timeAgo(item.timestamp || item.deletedAt)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

// ─── Dashboard Shell ──────────────────────────────────────────────────────────
const TABS = [
  { key: 'notifications', label: 'Inbox', icon: '🔔' },
  { key: 'threads', label: 'Threads', icon: '🧵' },
  { key: 'calendar', label: 'Calendar', icon: '📅' },
  { key: 'todo', label: 'Links & Attachments', icon: '📌' },
  { key: 'junk', label: 'Junk', icon: '🗑️' },
];

function Dashboard({ ingestData, onBackToSetup, userKey = '' }) {
  const [notifItems, setNotifItems] = useState(DATA.notifications.map(n => ({ ...n, read: false })));
  const [deletedMap, setDeletedMap] = useState({});
  const [deletedItems, setDeletedItems] = useState([]);
  const [tab, setTab] = useState('notifications');
  const unreadCount = notifItems.filter(n => !n.read).length;

  const isDeleted = (key) => !!deletedMap[key];
  const onMoveToJunk = (item) => {
    if (!item?.key) return;
    setDeletedMap(prev => (prev[item.key] ? prev : { ...prev, [item.key]: true }));
    setDeletedItems(prev => (prev.some(i => i.key === item.key)
      ? prev
      : [{ ...item, deletedAt: Date.now() }, ...prev]));
  };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        <View style={{ alignItems: 'flex-end', paddingTop: 8, marginBottom: 6 }}>
          <TouchableOpacity style={s.markAllBtn} onPress={onBackToSetup}>
            <Text style={{ fontSize: 12, color: C.textSecondary, fontWeight: '600' }}>← Back to setup</Text>
          </TouchableOpacity>
        </View>
        {tab === 'notifications' && (
          <NotificationsTab
            notifications={notifItems}
            setNotifications={setNotifItems}
            ingestMessages={ingestData.messages}
            ingestDates={ingestData.dates}
            isDeleted={isDeleted}
            onMoveToJunk={onMoveToJunk}
          />
        )}
        {tab === 'threads' && <ThreadsTab ingestMessages={ingestData.messages} isDeleted={isDeleted} onMoveToJunk={onMoveToJunk} />}
        {tab === 'calendar' && <CalendarTab ingestDates={ingestData.dates} ingestMessages={ingestData.messages} isDeleted={isDeleted} onMoveToJunk={onMoveToJunk} />}
        {tab === 'todo' && <TodoTab ingestLinks={ingestData.links} ingestAttachments={ingestData.attachments} isDeleted={isDeleted} onMoveToJunk={onMoveToJunk} userKey={userKey} />}
        {tab === 'junk' && <JunkTab deletedItems={deletedItems} />}
      </View>
      <View style={s.tabBar}>
        {TABS.map(t => {
          const on = tab === t.key;
          return (
            <TouchableOpacity key={t.key} style={s.tabItem} onPress={() => setTab(t.key)} activeOpacity={0.8}>
              <View style={{ position: 'relative' }}>
                <Text style={[s.tabIcon, on && s.tabIconOn]}>{t.icon}</Text>
                {t.key === 'notifications' && unreadCount > 0 && (
                  <View style={s.tabBadge}><Text style={{ fontSize: 9, color: '#fff', fontWeight: '800' }}>{unreadCount}</Text></View>
                )}
              </View>
              <Text style={[s.tabLabel, on && s.tabLabelOn]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [done, setDone] = useState(false);
  const [step, setStep] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;

  const [selectedApps, setSelectedApps] = useState(['gmail', 'calendar']);
  const [contacts, setContacts] = useState(['Natalie', 'Eugenie', 'Jonathan', 'Amanda']);
  const [contactInput, setContactInput] = useState('');
  const [privacyValues, setPrivacyValues] = useState(Object.fromEntries(PRIVACY_SETTINGS.map(p => [p.id, p.default])));
  const [notifEnabled, setNotifEnabled] = useState(true);
  const [leadTime, setLeadTime] = useState('1 hour');
  const [ingestData, setIngestData] = useState({ messages: [], dates: [], links: [], attachments: [], meta: {} });
  const [appAccounts, setAppAccounts] = useState({ gmail: '', calendar: '', outlook: '', imessage: '' });
  const [userKey, setUserKey] = useState('');
  const [isConnectingAccounts, setIsConnectingAccounts] = useState(false);

  const [outlookSignedIn, setOutlookSignedIn] = useState(false);
  const [outlookAccessToken, setOutlookAccessToken] = useState('');

  const normalizedUserKey = (userKey || '').trim().toLowerCase();

  const handleOutlookSignedIn = async (token) => {
    setOutlookAccessToken(token);
    setOutlookSignedIn(true);

    try {
      const response = await fetch(`${getBaseUrl()}/ingest_outlook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });

      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

      if (!response.ok) {
        const msg = data?.message || raw || `HTTP ${response.status}`;
        throw new Error(msg);
      }
      
      // Load summary to update UI with latest from extracted.db
      await loadSummary();
      Alert.alert('Success', 'Outlook connected and data ingested.');
    } catch (e) {
      Alert.alert('Outlook Ingest Error', e.message);
    }
  };

  function transition(fn) {
    Animated.sequence([
      Animated.timing(fade, { toValue: 0, duration: 140, useNativeDriver: true }),
      Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    fn();
  }

  const current = ONBOARDING_STEPS[step];
  const isFirst = step === 0;
  const isDone = current === 'done';
  const TOTAL = ONBOARDING_STEPS.length - 1;

  function renderScreen() {
    switch (current) {
      case 'welcome': return <WelcomeScreen />;
      case 'connect': return <ConnectAppsScreen selected={selectedApps} onToggle={id => setSelectedApps(p => p.includes(id) ? p.filter(a => a !== id) : [...p, id])} />;
      case 'accounts': return <AppAccountsScreen selectedApps={selectedApps} accountValues={appAccounts} onChangeAccount={(appId, value) => setAppAccounts(prev => ({ ...prev, [appId]: value }))} outlookSignedIn={outlookSignedIn} onOutlookSignedIn={handleOutlookSignedIn} />;
      case 'whitelist': return <WhitelistScreen contacts={contacts} inputValue={contactInput} onChangeInput={setContactInput}
        onAdd={() => { const t = contactInput.trim(); if (t && !contacts.includes(t)) setContacts(p => [...p, t]); setContactInput(''); }}
        onRemove={name => setContacts(p => p.filter(c => c !== name))} />;
      case 'privacy': return <PrivacyScreen privacyValues={privacyValues} onToggle={(id, val) => setPrivacyValues(p => ({ ...p, [id]: val }))} />;
      case 'notifications': return <NotificationsOnboarding notifEnabled={notifEnabled} onToggleNotif={setNotifEnabled} leadTime={leadTime} onSelectLeadTime={setLeadTime} />;
      case 'done': return <DoneScreen connectedCount={selectedApps.length} contactCount={contacts.length} />;
    }
  }

  const triggerIngestion = async (showAlert = true) => {
    try {
      if (!normalizedUserKey) {
        if (showAlert) Alert.alert('Connect account', 'Enter your email first.');
        return;
      }
      const response = await fetch(`${getBaseUrl()}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_key: normalizedUserKey }),
      });

      // Read body even on error to surface backend message
      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

      if (!response.ok) {
        const msg = data?.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(msg);
      }

      const result = data || {};
      const ingest = result.ingest || {};
      const summary = result.summary || {};
      const processed = ingest.processed ?? '—';
      const inserted = ingest.inserted ?? '—';
      const msgTotal = summary.messages ?? '—';
      const datesTotal = summary.dates ?? '—';
      const linksTotal = summary.links ?? '—';
      const latest = summary.latest_sent_at ? `Latest email: ${summary.latest_sent_at}` : '';

      const lines = [
        result.message || 'Emails ingested successfully.',
        `Inserted ${inserted} / Processed ${processed}`,
        `Totals — Messages: ${msgTotal}, Dates: ${datesTotal}, Links: ${linksTotal}`,
        latest,
      ].filter(Boolean);

      if (showAlert) Alert.alert('Success', lines.join('\n'));
    } catch (error) {
      if (showAlert) Alert.alert('Error', error.message || 'Failed to trigger ingestion');
      console.error(error);
    }
  };

  const loadSummary = async (overrideUserKey = null) => {
    try {
      const effectiveUserKey = (overrideUserKey || normalizedUserKey || 'outlook_user').trim().toLowerCase();
      const response = await fetch(`${getBaseUrl()}/summary?user_key=${encodeURIComponent(effectiveUserKey)}`);
      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

      if (!response.ok) {
        const msg = data?.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(msg);
      }

      const summary = data?.summary || {};
      const snap = data?.data || {};
      const msgTotal = summary.messages ?? '—';
      const datesTotal = summary.dates ?? '—';
      const linksTotal = summary.links ?? '—';
      const latest = summary.latest_sent_at ? `Latest: ${summary.latest_sent_at}` : '';

      setIngestData({
        messages: snap.messages || [],
        dates: snap.dates || [],
        links: snap.links || [],
        attachments: snap.attachments || [],
        meta: { msgTotal, datesTotal, linksTotal, latest },
      });
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to load summary');
      console.error(error);
    }
  };

  const finishSetupAndConnect = async () => {
    const gmailSelected = selectedApps.includes('gmail');
    const gmailAccount = (appAccounts.gmail || '').trim().toLowerCase();

    if (!gmailSelected) {
      // For pure non-gmail setups (like Outlook only)
      await loadSummary();
      setDone(true);
      return;
    }

    setIsConnectingAccounts(true);
    try {
      setUserKey(gmailAccount);

      const response = await fetch(`${getBaseUrl()}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_key: gmailAccount, force_reauth: false, reset_cursor: true }),
      });

      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

      if (!response.ok) {
        const msg = data?.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(msg);
      }

      await loadSummary(gmailAccount);
      setDone(true);
    } catch (error) {
      Alert.alert('Connect failed', error?.message || 'Unable to connect selected Gmail account.');
      console.error(error);
    } finally {
      setIsConnectingAccounts(false);
    }
  };

  // Pull summary right away so the dashboard has backend data without waiting on onboarding state.
  useEffect(() => {
    if (!done) return;
    loadSummary();
    const id = setInterval(() => {
      if (normalizedUserKey) {
        triggerIngestion(false);
      }
      loadSummary();
    }, 20000);
    return () => clearInterval(id);
  }, [done, normalizedUserKey]);

  if (done) return (
    <SafeAreaProvider>
      <Dashboard ingestData={ingestData} onBackToSetup={() => setDone(false)} userKey={normalizedUserKey} />
    </SafeAreaProvider>
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        {!isDone && <ProgressBar step={step} total={TOTAL} />}
        <Animated.View style={[{ flex: 1, paddingHorizontal: 24, paddingTop: 8 }, { opacity: fade }]}>
          {renderScreen()}
        </Animated.View>
        <View style={s.navRow}>
          {!isFirst && (
            <TouchableOpacity style={s.backBtn} onPress={() => transition(() => setStep(p => p - 1))}>
              <Text style={{ color: C.textSecondary, fontSize: 15, fontWeight: '600' }}>← Back</Text>
            </TouchableOpacity>
          )}
          {!isDone && (
            <TouchableOpacity style={[s.nextBtn, isFirst && { flex: 1 }]} onPress={() => transition(() => setStep(p => p + 1))}>
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                {current === 'notifications' ? 'Finish Setup →' : 'Continue →'}
              </Text>
            </TouchableOpacity>
          )}
          {isDone && (
            <TouchableOpacity
              style={[s.nextBtn, { flex: 1, backgroundColor: C.green }, isConnectingAccounts && { opacity: 0.65 }]}
              onPress={finishSetupAndConnect}
              disabled={isConnectingAccounts}
            >
              <Text style={{ color: '#0D1A14', fontSize: 15, fontWeight: '800' }}>{isConnectingAccounts ? 'Connecting account…' : 'Open Dashboard →'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  progressBar: { flexDirection: 'row', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 4 },
  progressSeg: { flex: 1, height: 3, borderRadius: 2 },

  // Onboarding
  welcomeGlow: { position: 'absolute', top: -80, left: -60, width: 300, height: 300, borderRadius: 150, backgroundColor: C.accent, opacity: 0.06 },
  welcomeTitle: { fontSize: 36, fontWeight: '800', color: C.textPrimary, lineHeight: 44, marginBottom: 16, letterSpacing: -0.5 },
  welcomeBody: { fontSize: 15, color: C.textSecondary, lineHeight: 24, marginBottom: 32 },
  featureRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: C.border },
  sectionTitle: { fontSize: 24, fontWeight: '800', color: C.textPrimary, marginBottom: 8, letterSpacing: -0.3 },
  sectionSubtitle: { fontSize: 14, color: C.textSecondary, lineHeight: 22 },
  appCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border },
  appCardOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { borderColor: C.accent, backgroundColor: C.accent },
  textInput: { flex: 1, backgroundColor: C.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: C.textPrimary, fontSize: 14, borderWidth: 1, borderColor: C.border },
  addBtn: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 18, justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.accentSoft, borderRadius: 20, paddingVertical: 6, paddingLeft: 14, paddingRight: 10, borderWidth: 1, borderColor: C.accent, gap: 6 },
  chipText: { fontSize: 13, color: C.accent, fontWeight: '500' },
  privacyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border },
  lockedBadge: { backgroundColor: C.green, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  lockedBadgeText: { fontSize: 9, fontWeight: '800', color: '#0D1A14', letterSpacing: 0.5 },
  timingChip: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  timingChipOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  infoBox: { flexDirection: 'row', backgroundColor: C.surfaceAlt, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, gap: 10, marginTop: 4 },
  infoBoxText: { flex: 1, fontSize: 12, color: C.textSecondary, lineHeight: 20 },
  doneGlow: { position: 'absolute', top: -60, width: 280, height: 280, borderRadius: 140, backgroundColor: C.green, opacity: 0.07 },
  doneTitle: { fontSize: 32, fontWeight: '800', color: C.textPrimary, marginBottom: 12 },
  doneSummaryCard: { width: '100%', backgroundColor: C.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: C.border },
  ingestPanel: { backgroundColor: C.surfaceAlt, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border, marginHorizontal: 24, marginBottom: 12 },
  ingestTitle: { color: C.textPrimary, fontWeight: '700', fontSize: 15 },
  ingestSection: { color: C.textSecondary, fontWeight: '700', fontSize: 12, marginTop: 10, marginBottom: 6 },
  ingestChip: { backgroundColor: C.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: C.border, marginBottom: 8 },
  ingestChipTitle: { color: C.textPrimary, fontWeight: '700', fontSize: 13 },
  ingestChipSub: { color: C.textSecondary, fontSize: 12, marginTop: 2 },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  // Nav
  navRow: { flexDirection: 'row', paddingHorizontal: 24, paddingBottom: 24, paddingTop: 12, gap: 12 },
  backBtn: { paddingVertical: 14, paddingHorizontal: 20, borderRadius: 14, borderWidth: 1, borderColor: C.border },
  nextBtn: { flex: 1, backgroundColor: C.accent, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },

  // Dashboard
  dashHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20, paddingTop: 8 },
  dashTitle: { fontSize: 26, fontWeight: '800', color: C.textPrimary, letterSpacing: -0.3 },
  dashSubtitle: { fontSize: 13, color: C.textMuted, marginTop: 2 },
  markAllBtn: { backgroundColor: C.surfaceAlt, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: C.border },
  groupLabel: { fontSize: 11, fontWeight: '700', color: C.textMuted, letterSpacing: 1, marginBottom: 10 },
  notifCard: { backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border },
  notifCardUnread: { borderColor: C.accentSoft, backgroundColor: '#111827' },
  notifBubble: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surfaceAlt, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  notifTitle: { fontSize: 14, fontWeight: '700', color: C.textPrimary, flex: 1 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent, marginLeft: 8 },
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  calGridWrap: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 10, marginBottom: 12 },
  calWeekRow: { flexDirection: 'row', marginBottom: 8 },
  calWeekLabel: { flex: 1, textAlign: 'center', color: C.textMuted, fontSize: 11, fontWeight: '700' },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: { width: '14.2857%', height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8, marginBottom: 4 },
  calCellMuted: { opacity: 0.45 },
  calCellSelected: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accent },
  calCellNum: { color: C.textPrimary, fontSize: 12, fontWeight: '600' },
  calCellNumMuted: { color: C.textMuted },
  calDotRow: { flexDirection: 'row', marginTop: 4, minHeight: 6, gap: 2 },
  calDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.accent },
  calDateLabel: { fontSize: 12, fontWeight: '700', color: C.textMuted, letterSpacing: 1, marginBottom: 8, marginTop: 8 },
  eventCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border, gap: 12 },
  attendeeChip: { backgroundColor: C.surfaceAlt, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  threadCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  openBadge: { backgroundColor: C.yellowSoft, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: C.yellow },
  unreadBadge: { backgroundColor: C.accent, borderRadius: 12, minWidth: 22, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  tabBar: { flexDirection: 'row', backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border, paddingBottom: 8, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  tabIcon: { fontSize: 22, opacity: 0.4 },
  tabIconOn: { opacity: 1 },
  tabLabel: { fontSize: 11, color: C.textMuted, marginTop: 4, fontWeight: '500' },
  tabLabelOn: { color: C.accent, fontWeight: '700' },
  tabBadge: { position: 'absolute', top: -4, right: -10, backgroundColor: C.red, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: C.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, borderTopWidth: 1, borderColor: C.border },
  modalTitle: { fontSize: 18, fontWeight: '800', color: C.textPrimary, flex: 1, marginRight: 8 },
  modalRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
});