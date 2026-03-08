import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, TextInput, Animated, StatusBar, Modal, Alert, Linking, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
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
function NotificationsTab() {
  const [notifs, setNotifs] = useState(DATA.notifications);
  const unread = notifs.filter(n => !n.read);
  const read = notifs.filter(n => n.read);

  function markRead(id) { setNotifs(p => p.map(n => n.id === id ? { ...n, read: true } : n)); }
  function markAll() { setNotifs(p => p.map(n => ({ ...n, read: true }))); }

  function Card({ n }) {
    return (
      <TouchableOpacity style={[s.notifCard, !n.read && s.notifCardUnread]} onPress={() => markRead(n.id)} activeOpacity={0.8}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={s.notifBubble}><Text style={{ fontSize: 18 }}>{n.sourceIcon}</Text></View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Text style={s.notifTitle} numberOfLines={1}>{n.title}</Text>
              {!n.read && <View style={s.unreadDot} />}
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
          <Text style={s.dashSubtitle}>{unread.length} unread · {notifs.length} total</Text>
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

function mapCalendarEvent(e) {
  const start = new Date(e.start_utc);
  const end = new Date(e.end_utc);
  const dateStr = start.toISOString().slice(0, 10);
  const timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const durationMinutes = Math.round((end - start) / 60000);
  const duration = durationMinutes > 0
    ? durationMinutes >= 60
      ? `${Math.floor(durationMinutes / 60)} hr${durationMinutes % 60 ? ` ${durationMinutes % 60} min` : ''}`
      : `${durationMinutes} min`
    : null;
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

function CalendarTab({ ingestDates = [], calendarEvents = [], onRefreshCalendar }) {
  const [selected, setSelected] = useState(null);
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
      const dateStr = addStartDate.toISOString().slice(0, 10);
      const timeStr = addStartDate.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      const h = Math.max(0, parseInt(addDurationHours, 10) || 0);
      const m = Math.min(59, Math.max(0, parseInt(addDurationMinutes, 10) || 0));
      const s = Math.min(59, Math.max(0, parseInt(addDurationSeconds, 10) || 0));
      const durationMinutes = Math.round(h * 60 + m + s / 60) || 60;

      const res = await fetch(`${CALENDAR_API}/calendar/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: addTitle.trim(),
          date: dateStr,
          time: timeStr,
          duration_minutes: durationMinutes,
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

  const ingestEvents = ingestDates
    .filter(d => {
      const raw = `${d.raw_span || ''}`.toLowerCase();
      const iso = d.resolved_date || d.parsed_at_utc || '';
      if (raw.includes('tomorrow')) return false;
      if (iso.startsWith('2026-02-22')) return false;
      return true;
    })
    .map(d => {
      const iso = d.resolved_date || d.parsed_at_utc || '';
      const dt = iso ? new Date(iso) : null;
      const dateStr = dt ? dt.toISOString().slice(0, 10) : 'Unknown date';
      const timeStr = dt
        ? dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : '';

      return {
        id: `ing-${d.id}`,
        title: d.raw_span,
        date: dateStr,
        time: timeStr,
        duration: null,
        attendees: [],
        source: 'Gmail',
        sourceIcon: '✉️',
        videoLink: null,
        notes: `From message ${d.message_id}`,
      };
    });

  const allEvents = [...calendarEvents, ...ingestEvents];
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

  function EventCard({ e }) {
    return (
      <TouchableOpacity style={s.eventCard} onPress={() => setSelected(e)} activeOpacity={0.8}>
        <View style={{ width: 56, alignItems: 'flex-end' }}>
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
        <Text style={{ fontSize: 18 }}>{e.sourceIcon}</Text>
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
          <TouchableOpacity
            style={[s.eventCard, { opacity: 0.85 }]}
            onPress={() => setPastExpanded(!pastExpanded)}
            activeOpacity={0.8}
          >
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
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
            </View>
          </TouchableOpacity>

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

// ─── Dashboard: TODO Tab (links & attachments) ───────────────────────────────
function TodoTab({ ingestLinks = [], ingestAttachments = [] }) {
  const links = ingestLinks.slice(0, 3);
  const attachments = ingestAttachments.slice(0, 20);
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
          <Text style={s.dashTitle}>TODO</Text>
          <Text style={s.dashSubtitle}>{links.length} links · {attachments.length} attachments</Text>
        </View>
      </View>

      <Text style={s.groupLabel}>Links</Text>
      {links.length === 0 && <Text style={{ color: C.textMuted, fontSize: 13, marginBottom: 12 }}>No links yet.</Text>}
      {links.map(l => (
        <TouchableOpacity key={`l-${l.id}`} style={s.notifCard} activeOpacity={0.8} onPress={() => openLink(l.url)}>
          <View style={{ flex: 1 }}>
            <Text style={s.notifTitle} numberOfLines={1}>{l.url}</Text>
            <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Msg {l.message_id}</Text>
          </View>
        </TouchableOpacity>
      ))}

      <Text style={[s.groupLabel, { marginTop: 16 }]}>Attachments</Text>
      {attachments.length === 0 && <Text style={{ color: C.textMuted, fontSize: 13 }}>No attachments yet.</Text>}
      {attachments.map(a => (
        <TouchableOpacity key={`a-${a.id}`} style={s.notifCard} activeOpacity={0.8} onPress={() => openAttachment(a)}>
          <View style={{ flex: 1 }}>
            <Text style={s.notifTitle} numberOfLines={1}>{a.filename || 'Attachment'}</Text>
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
function ThreadsTab() {
  const [selected, setSelected] = useState(null);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Threads</Text>
          <Text style={s.dashSubtitle}>{DATA.threads.filter(t => t.unread > 0).length} need attention</Text>
        </View>
      </View>

      {DATA.threads.map(t => (
        <TouchableOpacity key={t.id} style={s.threadCard} onPress={() => setSelected(t)} activeOpacity={0.8}>
          <View style={[s.avatar, { backgroundColor: t.avatarColor }]}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>{t.avatar}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.textPrimary }}>{t.contact}</Text>
              <Text style={{ fontSize: 11, color: C.textMuted }}>{timeAgo(t.timestamp)}</Text>
            </View>
            <Text style={{ fontSize: 13, color: C.textSecondary }} numberOfLines={1}>{t.lastMessage}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <Text style={{ fontSize: 12 }}>{t.sourceIcon}</Text>
              <Text style={{ fontSize: 11, color: C.textMuted }}>{t.source}</Text>
              {t.openItems.length > 0 && (
                <View style={s.openBadge}>
                  <Text style={{ fontSize: 10, color: C.yellow, fontWeight: '700' }}>{t.openItems.length} open</Text>
                </View>
              )}
            </View>
          </View>
          {t.unread > 0 && (
            <View style={s.unreadBadge}><Text style={{ fontSize: 11, color: '#fff', fontWeight: '800' }}>{t.unread}</Text></View>
          )}
        </TouchableOpacity>
      ))}

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            {selected && <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={[s.avatar, { backgroundColor: selected.avatarColor }]}>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: '#fff' }}>{selected.avatar}</Text>
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
              <View style={{ backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 12, marginBottom: 14 }}>
                <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 6 }}>SUMMARY</Text>
                <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>{selected.summary}</Text>
              </View>
              <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 8 }}>OPEN ITEMS</Text>
              {selected.openItems.map(item => (
                <View key={item} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent, marginTop: 6 }} />
                  <Text style={{ flex: 1, fontSize: 13, color: C.textPrimary, lineHeight: 20 }}>{item}</Text>
                </View>
              ))}
              <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginTop: 14, marginBottom: 8 }}>RELATED DATES</Text>
              {selected.relatedDates.map(d => (
                <View key={d} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <Text style={{ fontSize: 14 }}>📅</Text>
                  <Text style={{ fontSize: 13, color: C.textSecondary }}>{d}</Text>
                </View>
              ))}
            </>}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Dashboard Shell ──────────────────────────────────────────────────────────
const TABS = [
  { key: 'notifications', label: 'Inbox', icon: '🔔' },
  { key: 'calendar', label: 'Calendar', icon: '📅' },
  { key: 'todo', label: 'TODO', icon: '📌' },
];

function Dashboard({ ingestData, loadSummary }) {
  const [tab, setTab] = useState('notifications');
  const [calendarEvents, setCalendarEvents] = useState([]);
  const unreadCount = DATA.notifications.filter(n => !n.read).length;

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

  useEffect(() => {
    loadSummary?.();
    if (tab === 'calendar') {
      loadCalendarEvents();
    }
  }, [tab]);

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        {tab === 'notifications' && <NotificationsTab />}
        {tab === 'calendar' && (
          <CalendarTab
            ingestDates={ingestData.dates}
            calendarEvents={calendarEvents}
            onRefreshCalendar={loadCalendarEvents}
          />
        )}
        {tab === 'todo' && <TodoTab ingestLinks={ingestData.links} ingestAttachments={ingestData.attachments} />}
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
      const response = await fetch(`${CALENDAR_API}/ingest`, {
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
      const response = await fetch(`${CALENDAR_API}/summary`);
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
