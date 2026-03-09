import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, TextInput, Animated, StatusBar, Modal, Alert, Linking, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
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
  { id: 'slack', label: 'Slack', icon: '💬', desc: 'Bring channel context into your inbox.' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '📱', desc: 'Keep personal threads synced.' },
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
const ONBOARDING_STEPS = ['welcome', 'connect', 'whitelist', 'privacy', 'notifications', 'done'];

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
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
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
  const unread = notifs.filter(n => !n.read && !isDeleted(`notif-${n.id}`));
  const read = notifs.filter(n => n.read && !isDeleted(`notif-${n.id}`));

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
        return !dateMessageIds.has(m?.id) || isActionLike;
      })
      .slice(0, 8)
      .map(m => ({
        id: `ing-msg-${m.id}`,
        junkKey: `gmail-${m.id}`,
        title: (m.subject || 'Gmail Message').trim(),
        body: (m.snippet || '').trim(),
        source: 'Gmail',
        sourceIcon: '✉️',
        timestamp: m.sent_at_utc ? new Date(m.sent_at_utc).getTime() : Date.now(),
      }))
      .filter(n => !isDeleted(n.junkKey));
  }, [ingestMessages, dateMessageIds, isDeleted]);

  function markRead(id) { setNotifications(p => p.map(n => n.id === id ? { ...n, read: true } : n)); }
  function markAll() { setNotifications(p => p.map(n => ({ ...n, read: true }))); }

  function Card({ n }) {
    return (
      <TouchableOpacity style={[s.notifCard, !n.read && s.notifCardUnread]} onPress={() => markRead(n.id)} activeOpacity={0.8}>
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
          <Text style={s.dashSubtitle}>{unread.length} unread · {notifs.length + inboxFromGmail.length} total</Text>
        </View>
        {unread.length > 0 && (
          <TouchableOpacity onPress={markAll} style={s.markAllBtn}>
            <Text style={{ fontSize: 12, color: C.textSecondary, fontWeight: '600' }}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>
      {unread.length > 0 && <>
        <Text style={s.groupLabel}>UNREAD</Text>
        {unread.map(n => <Card key={n.id} n={n} />)}
      </>}
      {read.length > 0 && <>
        <Text style={[s.groupLabel, { marginTop: 16 }]}>EARLIER</Text>
        {read.map(n => <Card key={n.id} n={n} />)}
      </>}

      {inboxFromGmail.length > 0 && <>
        <Text style={[s.groupLabel, { marginTop: 16 }]}>FROM GMAIL</Text>
        {inboxFromGmail.map(n => (
          <View key={n.id} style={s.notifCard}>
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
                <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>{n.source} · {timeAgo(n.timestamp)}</Text>
              </View>
            </View>
          </View>
        ))}
      </>}
    </ScrollView>
  );
}

function toDateLocal(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toTimeLocal(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseEventTime(dateStr, timeStr) {
  if (!dateStr || dateStr === 'Unknown date') return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!timeStr) return new Date(y, (m || 1) - 1, d || 1);
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return new Date(y, (m || 1) - 1, d || 1);
  let [, h, min, ampm] = match;
  h = parseInt(h, 10);
  min = parseInt(min, 10);
  if (ampm.toUpperCase() === 'PM' && h < 12) h += 12;
  if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
  return new Date(y, (m || 1) - 1, d || 1, h, min, 0);
}

const CALENDAR_API = 'http://localhost:5001';

const webPickerInputStyle = {
  flex: 1,
  backgroundColor: C.surfaceAlt,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: '12px 14px',
  color: C.textPrimary,
  fontSize: 14,
  cursor: 'pointer',
  minHeight: 48,
  boxSizing: 'border-box',
};

function formatDurationFromSeconds(seconds) {
  if (seconds == null || seconds <= 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s} sec`;
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  if (mins < 60) {
    if (secs === 0) return `${mins} min`;
    return `${mins} min ${secs} sec`;
  }
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (remainMins === 0) return `${hrs} hr`;
  return `${hrs} hr ${remainMins} min`;
}

function mapCalendarEvent(e) {
  const start = new Date(e.start_utc);
  const dateStr = start.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const durationSeconds = e.duration_seconds != null ? Number(e.duration_seconds) : null;
  const duration = durationSeconds != null
    ? formatDurationFromSeconds(durationSeconds)
    : (() => {
        const end = new Date(e.end_utc);
        const mins = Math.round((end - start) / 60000);
        return formatDurationFromSeconds(mins * 60);
      })();
  return {
    id: `cal-${e.id}`,
    title: e.summary,
    date: dateStr,
    time: timeStr,
    duration,
    attendees: [],
    source: 'Google Calendar',
    sourceIcon: '📅',
    videoLink: null,
    notes: e.description,
  };
}

function CalendarTab({ ingestDates = [], calendarEvents = [], ingestMessages = [], onRefreshCalendar, isDeleted, onMoveToJunk }) {
  const [selected, setSelected] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [removingAllPast, setRemovingAllPast] = useState(false);
  const [pastExpanded, setPastExpanded] = useState(false);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addStartDate, setAddStartDate] = useState(() => {
    const d = new Date();
    d.setMinutes(0);
    d.setSeconds(0);
    return d;
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [addDurationHours, setAddDurationHours] = useState('1');
  const [addDurationMinutes, setAddDurationMinutes] = useState('0');
  const [addDurationSeconds, setAddDurationSeconds] = useState('0');
  const [addNotes, setAddNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  const handleAddEvent = async () => {
    if (!addTitle.trim()) {
      setAddError('Title is required');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const h = Math.max(0, parseInt(addDurationHours, 10) || 0);
      const m = Math.min(59, Math.max(0, parseInt(addDurationMinutes, 10) || 0));
      const s = Math.min(59, Math.max(0, parseInt(addDurationSeconds, 10) || 0));
      const durationSeconds = h * 3600 + m * 60 + s;

      const res = await fetch(`${CALENDAR_API}/calendar/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: addTitle.trim(),
          start_utc: addStartDate.toISOString(),
          duration_seconds: durationSeconds || 3600,
          notes: addNotes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setAddModalVisible(false);
        setShowDatePicker(false);
        setShowTimePicker(false);
        setAddTitle('');
        const next = new Date();
        next.setMinutes(0);
        next.setSeconds(0);
        setAddStartDate(next);
        setAddDurationHours('1');
        setAddDurationMinutes('0');
        setAddDurationSeconds('0');
        setAddNotes('');
        onRefreshCalendar?.();
      } else {
        setAddError(data.message || 'Failed to add event');
      }
    } catch (err) {
      setAddError(err.message || 'Network error');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveEvent = async () => {
    if (!selected || !selected.id?.startsWith('cal-')) return;
    const eventId = parseInt(selected.id.replace('cal-', ''), 10);
    if (isNaN(eventId)) return;
    setRemoving(true);
    try {
      const res = await fetch(`${CALENDAR_API}/calendar/events/${eventId}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setSelected(null);
        onRefreshCalendar?.();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRemoving(false);
    }
  };

  const msgById = React.useMemo(() => {
    const m = {};
    (ingestMessages || []).forEach(msg => { m[msg.id] = msg; });
    return m;
  }, [ingestMessages]);

  const seenByMessage = new Set();
  const ingestEvents = (ingestDates || [])
    .filter(d => {
      if (!d || !(d.resolved_date || d.parsed_at_utc)) return false;
      const raw = `${d.raw_span || ''}`.toLowerCase();
      const iso = d.resolved_date || d.parsed_at_utc || '';
      if (raw.includes('tomorrow')) return false;
      if (iso.startsWith('2026-02-22')) return false;
      if (d.message_id && seenByMessage.has(d.message_id)) return false;
      if (d.message_id) seenByMessage.add(d.message_id);
      return true;
    })
    .map(d => {
      const isoRaw = d.resolved_date || d.parsed_at_utc || '';
      const dt = new Date(isoRaw);
      const dateStr = Number.isNaN(dt.getTime())
        ? (isoRaw.includes('T') ? isoRaw.split('T')[0] : isoRaw.slice(0, 10))
        : dt.toISOString().slice(0, 10);
      const timeStr = Number.isNaN(dt.getTime())
        ? ''
        : dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      const msg = msgById[d.message_id];
      const title = (msg?.subject && msg.subject.trim()) || (msg?.snippet && msg.snippet.trim()) || (d.raw_span && d.raw_span.trim()) || 'Event';
      const rawNote = d.raw_span && d.raw_span.trim();
      const note = (msg?.snippet && msg.snippet.trim()) || rawNote || `From message ${d.message_id}`;

      return {
        id: `ing-${d.id}`,
        junkKey: `cal-${d.id}`,
        title,
        date: dateStr,
        time: timeStr,
        duration: null,
        attendees: [],
        source: 'Gmail',
        sourceIcon: '✉️',
        videoLink: null,
        notes: note,
      };
    });

  const allEvents = [...calendarEvents, ...ingestEvents.filter(e => !isDeleted || !isDeleted(e.junkKey))];
  const now = new Date();

  const { upcoming, past } = allEvents.reduce(
    (acc, e) => {
      const eventTime = parseEventTime(e.date, e.time);
      if (eventTime && eventTime < now) {
        acc.past.push(e);
      } else {
        acc.upcoming.push(e);
      }
      return acc;
    },
    { upcoming: [], past: [] }
  );

  const sortByDateDesc = (a, b) => {
    const da = parseEventTime(a.date, a.time)?.getTime() ?? 0;
    const db = parseEventTime(b.date, b.time)?.getTime() ?? 0;
    return db - da;
  };
  const sortByDateAsc = (a, b) => {
    const da = parseEventTime(a.date, a.time)?.getTime() ?? 0;
    const db = parseEventTime(b.date, b.time)?.getTime() ?? 0;
    return da - db;
  };

  const upcomingSorted = [...upcoming].sort(sortByDateAsc);
  const pastSorted = [...past].sort(sortByDateDesc);

  const groupByDate = (events) =>
    events.reduce((acc, e) => {
      if (!acc[e.date]) acc[e.date] = [];
      acc[e.date].push(e);
      return acc;
    }, {});

  const upcomingGrouped = groupByDate(upcomingSorted);
  const pastGrouped = groupByDate(pastSorted);

  const sortedUpcomingDates = Object.keys(upcomingGrouped).sort();
  const sortedPastDates = Object.keys(pastGrouped).sort().reverse();

  const handleRemoveAllPast = async () => {
    const calendarPastEvents = past.filter(e => e.id?.startsWith('cal-'));
    if (calendarPastEvents.length === 0) return;
    setRemovingAllPast(true);
    try {
      for (const e of calendarPastEvents) {
        const eventId = parseInt(e.id.replace('cal-', ''), 10);
        if (isNaN(eventId)) continue;
        const res = await fetch(`${CALENDAR_API}/calendar/events/${eventId}/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (data.status !== 'success') break;
      }
      onRefreshCalendar?.();
    } catch (err) {
      console.error(err);
    } finally {
      setRemovingAllPast(false);
    }
  };

  function EventCard({ e }) {
    return (
      <TouchableOpacity style={s.eventCard} onPress={() => setSelected(e)} activeOpacity={0.8}>
        <View style={{ width: 84, alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: C.textPrimary }}>{e.time}</Text>
          {e.duration && (
            <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{e.duration}</Text>
          )}
        </View>
        <View style={{ width: 2, height: 40, backgroundColor: C.accent, borderRadius: 2, opacity: 0.5 }} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: C.textPrimary, marginBottom: 6 }}>
            {e.title}
          </Text>
        </View>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: 8 }}>
          <Text style={{ fontSize: 18 }}>{e.sourceIcon}</Text>
          {e.junkKey && onMoveToJunk && (
            <TouchableOpacity onPress={() => onMoveToJunk({ key: e.junkKey, from: 'Calendar', title: e.title, subtitle: e.notes, timestamp: Date.now() })}>
              <Text style={{ color: C.textMuted, fontSize: 18, fontWeight: '700' }}>×</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Calendar</Text>
          <Text style={s.dashSubtitle}>{upcoming.length} upcoming · {past.length} past</Text>
        </View>
        <TouchableOpacity
          style={[s.addEventBtn, adding && { opacity: 0.6 }]}
          onPress={() => setAddModalVisible(true)}
          disabled={adding}
        >
          <Text style={s.addEventBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {sortedUpcomingDates.map((date) => (
        <View key={date} style={{ marginBottom: 6 }}>
          <Text style={s.calDateLabel}>{formatDate(date)}</Text>
          {upcomingGrouped[date].map((e) => (
            <EventCard key={e.id} e={e} />
          ))}
        </View>
      ))}

      {past.length > 0 && (
        <View style={{ marginTop: 16 }}>
          <View style={[s.eventCard, { opacity: 0.85, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }]}>
            <TouchableOpacity
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}
              onPress={() => setPastExpanded(!pastExpanded)}
              activeOpacity={0.8}
            >
              <Text style={{ fontSize: 20 }}>📂</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: C.textPrimary }}>
                  Past events
                </Text>
                <Text style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {past.length} event{past.length !== 1 ? 's' : ''} · Tap to {pastExpanded ? 'collapse' : 'expand'}
                </Text>
              </View>
              <Text style={{ fontSize: 18, color: C.textMuted }}>{pastExpanded ? '▼' : '▶'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ paddingVertical: 8, paddingHorizontal: 12, backgroundColor: C.red + '33', borderRadius: 8 }}
              onPress={handleRemoveAllPast}
              disabled={removingAllPast}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: C.red }}>{removingAllPast ? 'Removing…' : 'Delete all past'}</Text>
            </TouchableOpacity>
          </View>

          {pastExpanded && (
            <View style={{ marginTop: 4, marginLeft: 12, paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: C.border }}>
              {sortedPastDates.map((date) => (
                <View key={date} style={{ marginBottom: 6, marginTop: 8 }}>
                  <Text style={[s.calDateLabel, { opacity: 0.8 }]}>{formatDate(date)}</Text>
                  {pastGrouped[date].map((e) => (
                    <EventCard key={e.id} e={e} />
                  ))}
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            {selected && <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 }}>
                <Text style={s.modalTitle}>{selected.title}</Text>
                <TouchableOpacity onPress={() => setSelected(null)}>
                  <Text style={{ fontSize: 22, color: C.textMuted }}>×</Text>
                </TouchableOpacity>
              </View>

              {[
                ['🕐', `${selected.time}${selected.duration ? ` · ${selected.duration}` : ''}`],
                ['📅', formatDate(selected.date)],
                [selected.sourceIcon, selected.source],
              ].map(([icon, text]) => (
                <View key={text} style={s.modalRow}>
                  <Text style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{icon}</Text>
                  <Text style={{ fontSize: 14, color: C.textSecondary, flex: 1 }}>{text}</Text>
                </View>
              ))}

              {selected.notes && (
                <View style={{ marginTop: 16, backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 12 }}>
                  <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 4 }}>
                    NOTES
                  </Text>
                  <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>
                    {selected.notes}
                  </Text>
                </View>
              )}

              {selected.id?.startsWith('cal-') && (
                <TouchableOpacity
                  style={[s.addEventSubmitBtn, { marginTop: 20, backgroundColor: C.red }]}
                  onPress={handleRemoveEvent}
                  disabled={removing}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{removing ? 'Removing…' : 'Remove from calendar'}</Text>
                </TouchableOpacity>
              )}
            </>}
          </View>
        </View>
      </Modal>

      <Modal visible={addModalVisible} transparent animationType="slide" onRequestClose={() => { if (!adding) { setAddModalVisible(false); setShowDatePicker(false); setShowTimePicker(false); } }}>
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={s.modalTitle}>Add Event</Text>
              <TouchableOpacity onPress={() => { if (!adding) { setAddModalVisible(false); setShowDatePicker(false); setShowTimePicker(false); } }} disabled={adding}>
                <Text style={{ fontSize: 22, color: C.textMuted }}>×</Text>
              </TouchableOpacity>
            </View>

            {addError && (
              <View style={{ backgroundColor: C.red + '22', borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: C.red }}>
                <Text style={{ fontSize: 13, color: C.red }}>{addError}</Text>
              </View>
            )}

            <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 6 }}>TITLE</Text>
            <TextInput
              style={s.addEventInput}
              placeholder="Event name"
              placeholderTextColor={C.textMuted}
              value={addTitle}
              onChangeText={setAddTitle}
              editable={!adding}
            />

            <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 6, marginTop: 14 }}>START DATE & TIME</Text>
            {Platform.OS === 'web' ? (
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  {React.createElement('input', {
                    type: 'date',
                    value: toDateLocal(addStartDate),
                    onChange: (e) => {
                      const v = e.target.value;
                      if (v) {
                        const [y, m, d] = v.split('-').map(Number);
                        const next = new Date(addStartDate);
                        next.setFullYear(y);
                        next.setMonth(m - 1);
                        next.setDate(d);
                        setAddStartDate(next);
                      }
                    },
                    onFocus: (e) => {
                      try {
                        e.target.showPicker?.();
                      } catch (_) {}
                    },
                    disabled: adding,
                    style: { ...webPickerInputStyle, width: '100%' },
                  })}
                </View>
                <View style={{ flex: 1 }}>
                  {React.createElement('input', {
                    type: 'time',
                    value: toTimeLocal(addStartDate),
                    onChange: (e) => {
                      const v = e.target.value;
                      if (v) {
                        const [h, m] = v.split(':').map(Number);
                        const next = new Date(addStartDate);
                        next.setHours(h);
                        next.setMinutes(m);
                        setAddStartDate(next);
                      }
                    },
                    onFocus: (e) => {
                      try {
                        e.target.showPicker?.();
                      } catch (_) {}
                    },
                    disabled: adding,
                    style: { ...webPickerInputStyle, width: '100%' },
                  })}
                </View>
              </View>
            ) : (
              <>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <TouchableOpacity
                    style={[s.addEventInput, { flex: 1 }]}
                    onPress={() => { if (!adding) { setShowTimePicker(false); setShowDatePicker(true); } }}
                    disabled={adding}
                  >
                    <Text style={{ color: C.textPrimary, fontSize: 14 }}>
                      {addStartDate.toLocaleDateString('en-US', {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.addEventInput, { flex: 1 }]}
                    onPress={() => { if (!adding) { setShowDatePicker(false); setShowTimePicker(true); } }}
                    disabled={adding}
                  >
                    <Text style={{ color: C.textPrimary, fontSize: 14 }}>
                      {addStartDate.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      })}
                    </Text>
                  </TouchableOpacity>
                </View>

                {showDatePicker && (
                  <View style={{ marginTop: 8 }}>
                    <DateTimePicker
                      value={addStartDate}
                      mode="date"
                      display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                      onChange={(event, date) => {
                        if (Platform.OS === 'android') setShowDatePicker(false);
                        if (event.type === 'set' && date) setAddStartDate(date);
                      }}
                    />
                    {Platform.OS === 'ios' && (
                      <TouchableOpacity
                        style={{ marginTop: 12, paddingVertical: 10, alignItems: 'center', backgroundColor: C.accent, borderRadius: 10 }}
                        onPress={() => setShowDatePicker(false)}
                      >
                        <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>Done</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {showTimePicker && (
                  <View style={{ marginTop: 8 }}>
                    <DateTimePicker
                      value={addStartDate}
                      mode="time"
                      display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                      onChange={(event, date) => {
                        if (Platform.OS === 'android') setShowTimePicker(false);
                        if (event.type === 'set' && date) setAddStartDate(date);
                      }}
                    />
                    {Platform.OS === 'ios' && (
                      <TouchableOpacity
                        style={{ marginTop: 12, paddingVertical: 10, alignItems: 'center', backgroundColor: C.accent, borderRadius: 10 }}
                        onPress={() => setShowTimePicker(false)}
                      >
                        <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>Done</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </>
            )}

            <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 6, marginTop: 14 }}>DURATION</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Hours</Text>
                <TextInput
                  style={s.addEventInput}
                  placeholder="0"
                  placeholderTextColor={C.textMuted}
                  value={addDurationHours}
                  onChangeText={(v) => setAddDurationHours(v.replace(/\D/g, '').slice(0, 3))}
                  keyboardType="number-pad"
                  editable={!adding}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Minutes (0–59)</Text>
                <TextInput
                  style={s.addEventInput}
                  placeholder="0"
                  placeholderTextColor={C.textMuted}
                  value={addDurationMinutes}
                  onChangeText={(v) => {
                    const n = v.replace(/\D/g, '').slice(0, 2);
                    const val = parseInt(n, 10);
                    setAddDurationMinutes(isNaN(val) ? '' : String(Math.min(59, val)));
                  }}
                  keyboardType="number-pad"
                  editable={!adding}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Seconds (0–59)</Text>
                <TextInput
                  style={s.addEventInput}
                  placeholder="0"
                  placeholderTextColor={C.textMuted}
                  value={addDurationSeconds}
                  onChangeText={(v) => {
                    const n = v.replace(/\D/g, '').slice(0, 2);
                    const val = parseInt(n, 10);
                    setAddDurationSeconds(isNaN(val) ? '' : String(Math.min(59, val)));
                  }}
                  keyboardType="number-pad"
                  editable={!adding}
                />
              </View>
            </View>

            <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 6, marginTop: 14 }}>NOTES (optional)</Text>
            <TextInput
              style={[s.addEventInput, { minHeight: 60, textAlignVertical: 'top' }]}
              placeholder="Description or notes"
              placeholderTextColor={C.textMuted}
              value={addNotes}
              onChangeText={setAddNotes}
              multiline
              editable={!adding}
            />

            <TouchableOpacity
              style={[s.addEventSubmitBtn, adding && { opacity: 0.6 }]}
              onPress={handleAddEvent}
              disabled={adding}
            >
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{adding ? 'Adding…' : 'Add Event'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Dashboard: Emails Tab ───────────────────────────────────────────────────
function EmailsTab({ emails = [], onRefresh, onSync }) {
  const [selected, setSelected] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [responseDraft, setResponseDraft] = useState('');
  const [showSentFeedback, setShowSentFeedback] = useState(false);

  useEffect(() => {
    if (!selected) setResponseDraft('');
  }, [selected]);

  const handleDeleteConversation = async () => {
    if (!selected) return;
    Alert.alert(
      'Delete conversation',
      `Remove this conversation (${selected.count} message${selected.count !== 1 ? 's' : ''})? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              const isSingle = String(selected.key || '').startsWith('single-');
              const body = isSingle
                ? { message_ids: (selected.messages || []).map(m => m.id).filter(Boolean) }
                : { thread_id: selected.key };
              const res = await fetch(`${CALENDAR_API}/conversations/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              const data = await res.json().catch(() => ({}));
              if (data.status === 'success') {
                setSelected(null);
                onRefresh?.();
              } else {
                Alert.alert('Delete failed', data.message || 'Could not delete');
              }
            } catch (err) {
              Alert.alert('Delete failed', err.message || 'Network error');
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  const handleSendResponse = async () => {
    if (!selected || !responseDraft.trim()) return;
    const lastMsg = selected.last ?? selected;
    setSending(true);
    try {
      const subject = (lastMsg.subject || selected.subject || '(no subject)');
      const replySubject = subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
      const res = await fetch(`${CALENDAR_API}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: lastMsg.sender,
          subject: replySubject,
          content: responseDraft.trim(),
          thread_id: lastMsg.thread_id || undefined,
          gmail_message_id: lastMsg.gmail_message_id || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.status === 'success') {
        setResponseDraft('');
        setShowSentFeedback(true);
        setTimeout(() => setShowSentFeedback(false), 2500);
      } else {
        Alert.alert('Send failed', data.message || 'Could not send email');
      }
    } catch (err) {
      Alert.alert('Send failed', err.message || 'Network error');
    } finally {
      setSending(false);
    }
  };

  const handleSync = async () => {
    if (!onSync) return;
    setSyncing(true);
    try {
      const res = await fetch(`${CALENDAR_API}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db_path: 'extracted.db', max_messages: 200 }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.status === 'success') {
        onSync?.();
      } else {
        Alert.alert('Sync failed', data.message || 'Could not fetch emails');
      }
    } catch (err) {
      Alert.alert('Sync failed', err.message || 'Network error');
    } finally {
      setSyncing(false);
    }
  };

  const formatEmailDate = (sentAt) => {
    if (!sentAt) return '';
    const d = new Date(sentAt);
    if (Number.isNaN(d.getTime())) return sentAt;
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  };

  const safeEmails = Array.isArray(emails) ? emails : [];
  const conversations = useMemo(() => {
    const byThread = {};
    for (const e of safeEmails) {
      if (!e || typeof e !== 'object') continue;
      const key = e.thread_id || `single-${e.id}`;
      if (!byThread[key]) byThread[key] = [];
      byThread[key].push(e);
    }
    return Object.entries(byThread)
      .map(([threadKey, msgs]) => {
        const sorted = [...msgs].sort((a, b) => (new Date(a?.sent_at_utc || 0)).getTime() - (new Date(b?.sent_at_utc || 0)).getTime());
        const last = sorted[sorted.length - 1];
        if (!last) return null;
        const subject = ((sorted[0]?.subject || last?.subject || '(no subject)') + '').replace(/^Re:\s*/i, '');
        return { key: threadKey, messages: sorted, subject, last, count: sorted.length };
      })
      .filter(Boolean)
      .sort((a, b) => (new Date(b?.last?.sent_at_utc || 0)).getTime() - (new Date(a?.last?.sent_at_utc || 0)).getTime());
  }, [safeEmails]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Emails</Text>
          <Text style={s.dashSubtitle}>
            {conversations.length} conversation{conversations.length !== 1 ? 's' : ''} · {safeEmails.length} message{safeEmails.length !== 1 ? 's' : ''}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {onSync && (
            <TouchableOpacity style={s.markAllBtn} onPress={handleSync} disabled={syncing}>
              <Text style={{ color: C.textSecondary, fontSize: 12, fontWeight: '600' }}>{syncing ? 'Syncing…' : 'Sync from Gmail'}</Text>
            </TouchableOpacity>
          )}
          {onRefresh && (
            <TouchableOpacity style={s.markAllBtn} onPress={onRefresh}>
              <Text style={{ color: C.textSecondary, fontSize: 12, fontWeight: '600' }}>Refresh</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {conversations.length === 0 && (
        <Text style={{ color: C.textMuted, fontSize: 14, marginTop: 8 }}>No emails yet. Run ingestion to sync your inbox.</Text>
      )}

      {conversations.map((conv) => (
        <TouchableOpacity
          key={conv.key}
          style={s.notifCard}
          activeOpacity={0.8}
          onPress={() => setSelected(conv)}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.notifTitle} numberOfLines={1}>{conv.subject || '(no subject)'}</Text>
            <Text style={{ fontSize: 12, color: C.textSecondary, marginTop: 4 }} numberOfLines={1}>{conv.last?.sender || 'Unknown'}</Text>
            {conv.last?.snippet ? (
              <Text style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }} numberOfLines={2}>{conv.last.snippet}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 8 }}>
              <Text style={{ fontSize: 11, color: C.textMuted }}>{formatEmailDate(conv.last?.sent_at_utc)}</Text>
              {conv.count > 1 && (
                <Text style={{ fontSize: 11, color: C.textMuted }}>· {conv.count} messages</Text>
              )}
            </View>
          </View>
          <Text style={{ fontSize: 18, marginLeft: 8 }}>✉️</Text>
        </TouchableOpacity>
      ))}

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={s.modalOverlay}>
          <View style={[s.modalSheet, { maxHeight: '80%' }]}>
            {selected && (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.modalTitle}>{selected.subject || '(no subject)'}</Text>
                    <Text style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{selected.count} message{selected.count !== 1 ? 's' : ''}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <TouchableOpacity onPress={handleDeleteConversation} disabled={deleting} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                      <Text style={{ fontSize: 18, color: deleting ? C.textMuted : C.red }}>🗑</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setSelected(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                      <Text style={{ fontSize: 22, color: C.textMuted }}>×</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={true}>
                  {(selected.messages || []).map((msg, i) => (
                    <View key={msg.id || i} style={{ marginBottom: 16, paddingBottom: 16, borderBottomWidth: i < (selected.messages?.length || 0) - 1 ? 1 : 0, borderBottomColor: C.border }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: C.textPrimary }}>{msg.sender || 'Unknown'}</Text>
                        <Text style={{ fontSize: 11, color: C.textMuted }}>{formatEmailDate(msg.sent_at_utc)}</Text>
                      </View>
                      <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }} selectable>
                        {msg.text || msg.snippet || 'No content'}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
                <View style={{ marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: C.textMuted, marginBottom: 8 }}>RESPONSE</Text>
                  <TextInput
                    style={[s.addEventInput, { minHeight: 80 }]}
                    placeholder="Type your reply..."
                    placeholderTextColor={C.textMuted}
                    value={responseDraft}
                    onChangeText={setResponseDraft}
                    multiline
                    editable={!sending}
                  />
                  <TouchableOpacity
                    style={[s.addEventSubmitBtn, { marginTop: 10 }, sending && { opacity: 0.6 }]}
                    onPress={handleSendResponse}
                    disabled={sending || !responseDraft.trim()}
                  >
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{sending ? 'Sending…' : 'Send'}</Text>
                  </TouchableOpacity>
                  {showSentFeedback && (
                    <View style={{ backgroundColor: C.green, borderRadius: 10, padding: 12, marginTop: 12, alignItems: 'center' }}>
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Email sent!</Text>
                    </View>
                  )}
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Dashboard: TODO Tab (links & attachments) ───────────────────────────────
function TodoTab({ ingestLinks = [], ingestAttachments = [], isDeleted, onMoveToJunk }) {
  const links = ingestLinks.filter(l => !isDeleted(`link-${l.id}`)).slice(0, 3);
  const attachments = ingestAttachments.filter(a => !isDeleted(`att-${a.id}`)).slice(0, 20);
  const openLink = (url) => {
    const target = url?.startsWith('http') ? url : `http://${url}`;
    Linking.openURL(target).catch(() => Alert.alert('Unable to open link', target));
  };
  const openAttachment = (a) => {
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
      {links.map((l, idx) => {
        const friendly = ['Williams Sonoma Main Website', 'Williams Sonoma User Pravacy', 'Williams Sonoma Email Option'][idx] || l.url;
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
      const rawSender = `${msg?.sender_name || msg?.sender || ''}`.trim();
      let sender = rawSender;
      if (!sender) sender = 'Unknown Sender';
      if (sender.includes('<')) sender = sender.split('<')[0].trim() || sender;

      const ts = msg?.sent_at_utc ? new Date(msg.sent_at_utc).getTime() : 0;
      const item = {
        id: msg.id,
        subject: msg.subject || 'No subject',
        snippet: msg.snippet || '',
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
      out.push({
        id: `th-${sender}`,
        contact: sender,
        source: 'Gmail',
        sourceIcon: '✉️',
        timestamp: latest?.ts || 0,
        latestSubject: latest?.subject || 'No subject',
        latestSnippet: latest?.snippet || '',
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
              <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 8 }}>RECENT EMAILS</Text>
              {selected.messages.slice(0, 8).map(m => (
                <View key={`m-${m.id}`} style={{ backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                  <Text style={{ fontSize: 13, color: C.textPrimary, fontWeight: '700' }} numberOfLines={1}>{m.subject}</Text>
                  {!!m.snippet && <Text style={{ fontSize: 12, color: C.textSecondary, marginTop: 4 }} numberOfLines={2}>{m.snippet}</Text>}
                  <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{m.sentAt ? new Date(m.sentAt).toLocaleString() : ''}</Text>
                </View>
              ))}
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
  { key: 'emails', label: 'Emails', icon: '✉️' },
  { key: 'threads', label: 'Threads', icon: '🧵' },
  { key: 'calendar', label: 'Calendar', icon: '📅' },
  { key: 'todo', label: 'Links & Attachments', icon: '📌' },
  { key: 'junk', label: 'Junk', icon: '🗑️' },
];

function Dashboard({ ingestData, loadSummary }) {
  const [notifItems, setNotifItems] = useState(DATA.notifications);
  const [deletedMap, setDeletedMap] = useState({});
  const [deletedItems, setDeletedItems] = useState([]);
  const [tab, setTab] = useState('notifications');
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [emails, setEmails] = useState([]);
  const unreadCount = notifItems.filter(n => !n.read).length;

  const isDeleted = (key) => !!deletedMap[key];
  const onMoveToJunk = (item) => {
    if (!item?.key) return;
    setDeletedMap(prev => (prev[item.key] ? prev : { ...prev, [item.key]: true }));
    setDeletedItems(prev => (prev.some(i => i.key === item.key)
      ? prev
      : [{ ...item, deletedAt: Date.now() }, ...prev]));
  };

  const loadCalendarEvents = () => {
    fetch(`${CALENDAR_API}/calendar/events`)
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          setCalendarEvents(data.events.map(mapCalendarEvent));
        }
      })
      .catch(err => console.error(err));
  };

  const loadEmails = () => {
    fetch(`${CALENDAR_API}/emails`)
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          setEmails(Array.isArray(data.emails) ? data.emails : []);
        }
      })
      .catch(err => console.error(err));
  };

  useEffect(() => {
    loadSummary?.();
    if (tab === 'calendar') {
      loadCalendarEvents();
    } else if (tab === 'emails') {
      loadEmails();
    }
  }, [tab]);

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={{ flex: 1, paddingHorizontal: 20 }}>
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
        {tab === 'emails' && (
          <EmailsTab
            emails={emails.length ? emails : (Array.isArray(ingestData?.messages) ? ingestData.messages : [])}
            onRefresh={loadEmails}
            onSync={() => { loadSummary?.(); loadEmails(); }}
          />
        )}
        {tab === 'threads' && <ThreadsTab ingestMessages={ingestData.messages} isDeleted={isDeleted} onMoveToJunk={onMoveToJunk} />}
        {tab === 'calendar' && (
          <CalendarTab
            ingestDates={ingestData.dates}
            ingestMessages={ingestData.messages}
            calendarEvents={calendarEvents}
            onRefreshCalendar={loadCalendarEvents}
            isDeleted={isDeleted}
            onMoveToJunk={onMoveToJunk}
          />
        )}
        {tab === 'todo' && <TodoTab ingestLinks={ingestData.links} ingestAttachments={ingestData.attachments} isDeleted={isDeleted} onMoveToJunk={onMoveToJunk} />}
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
      case 'whitelist': return <WhitelistScreen contacts={contacts} inputValue={contactInput} onChangeInput={setContactInput}
        onAdd={() => { const t = contactInput.trim(); if (t && !contacts.includes(t)) setContacts(p => [...p, t]); setContactInput(''); }}
        onRemove={name => setContacts(p => p.filter(c => c !== name))} />;
      case 'privacy': return <PrivacyScreen privacyValues={privacyValues} onToggle={(id, val) => setPrivacyValues(p => ({ ...p, [id]: val }))} />;
      case 'notifications': return <NotificationsOnboarding notifEnabled={notifEnabled} onToggleNotif={setNotifEnabled} leadTime={leadTime} onSelectLeadTime={setLeadTime} />;
      case 'done': return <DoneScreen connectedCount={selectedApps.length} contactCount={contacts.length} />;
    }
  }

  const triggerIngestion = async () => {
    try {
      const response = await fetch(`${getBaseUrl()}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db_path: 'extracted.db' }),
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

      Alert.alert('Success', lines.join('\n'));
    } catch (error) {
      Alert.alert('Error', error.message || 'Failed to trigger ingestion');
      console.error(error);
    }
  };

  const loadSummary = async () => {
    try {
      const response = await fetch(`${getBaseUrl()}/summary`);
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

  // Pull summary right away so the dashboard has backend data without waiting on onboarding state.
  useEffect(() => {
    loadSummary();
  }, []);

  useEffect(() => {
    if (done) {
      fetch(`${CALENDAR_API}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db_path: 'extracted.db' }),
      }).catch(err => console.error(err));
    }
  }, [done]);

  if (done) return (
    <SafeAreaProvider>
      <Dashboard ingestData={ingestData} loadSummary={loadSummary} />
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
          {!isFirst && !isDone && (
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
            <TouchableOpacity style={[s.nextBtn, { flex: 1, backgroundColor: C.green }]} onPress={() => setDone(true)}>
              <Text style={{ color: '#0D1A14', fontSize: 15, fontWeight: '800' }}>Open Dashboard →</Text>
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
  calDateLabel: { fontSize: 12, fontWeight: '700', color: C.textMuted, letterSpacing: 1, marginBottom: 8, marginTop: 8 },
  addEventBtn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14, alignSelf: 'flex-end' },
  addEventBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  addEventInput: { backgroundColor: C.surfaceAlt, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: C.textPrimary, fontSize: 14, borderWidth: 1, borderColor: C.border },
  addEventSubmitBtn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
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
