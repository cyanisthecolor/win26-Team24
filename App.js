import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, TextInput, Animated, Dimensions, StatusBar,
  SafeAreaView, Modal,
} from 'react-native';
import DATA from './data.json';

// pulling screen width for layout calcs - might need this later for responsive stuff?
const { width } = Dimensions.get('window');

// all colors in one place so its easy to swap themes later (dark mode only for now)
// todo: maybe add a light mode at some point idk
const C = {
  bg: '#0D0F14', surface: '#161A22', surfaceAlt: '#1E2330', border: '#2A2F3D',
  accent: '#4F8EF7', accentSoft: '#1E2F4A', green: '#3DD68C', greenSoft: '#1A3028',
  red: '#F75C5C', redSoft: '#3D1A1A', yellow: '#F7C948', yellowSoft: '#382E10',
  textPrimary: '#EDF0F7', textSecondary: '#7A8099', textMuted: '#4A5068',
};

// helper to show relative time - does this handle timezones correctly? probably not lol
function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// formatting date strings for the calendar view - adding T00:00:00 to avoid utc offset weirdness
function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// priority color mapping - red/yellow/muted feels intuitive enough
function priorityColor(p) { return p === 'high' ? C.red : p === 'medium' ? C.yellow : C.textMuted; }
function priorityBg(p) { return p === 'high' ? C.redSoft : p === 'medium' ? C.yellowSoft : C.surfaceAlt; }

// all the apps we're integrating with - would be cool to let users add custom ones later?
const APPS = [
  { id: 'gmail', label: 'Gmail', icon: '✉️', desc: 'Email threads & labels' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬', desc: 'Messages & group chats' },
  { id: 'slack', label: 'Slack', icon: '⚡', desc: 'Channels & DMs' },
  { id: 'calendar', label: 'Google Calendar', icon: '📅', desc: 'Events & reminders' },
  { id: 'drive', label: 'Google Drive', icon: '📁', desc: 'Documents & links' },
  { id: 'outlook', label: 'Outlook', icon: '📧', desc: 'Work email & calendar' },
];

// privacy settings config - locked ones can't be toggled by the user
// end to end encryption? should probably explain this more clearly in the ui
const PRIVACY_SETTINGS = [
  { id: 'encrypt', label: 'End-to-end encryption', desc: 'All synced data is encrypted at rest and in transit.', icon: '🔐', default: true, locked: true },
  { id: 'ssn', label: 'Block sensitive identifiers', desc: 'Automatically redact SSNs, credit cards, and ID numbers.', icon: '🛡️', default: true, locked: false },
  { id: 'health', label: 'Block personal health info', desc: 'Hide medical or health-related data from summaries.', icon: '🏥', default: false, locked: false },
  // this one is interesting - we're protecting OTHER people's data too, not just the user's
  { id: 'counterpart', label: 'Respect counterpart privacy', desc: "Don't surface other people's private info in your context panel.", icon: '👥', default: true, locked: false },
  { id: 'multiphone', label: 'No cross-device data transfer', desc: 'Data stays on each device. No syncing between your phones.', icon: '📵', default: true, locked: false },
];

// notification lead time options - 1 hour feels like the sweet spot default
const NOTIF_TIMINGS = ['30 min', '1 hour', '3 hours', '1 day'];

// step names for the onboarding flow - order matters here
const ONBOARDING_STEPS = ['welcome', 'connect', 'whitelist', 'privacy', 'notifications', 'done'];

// ─── Shared Components ────────────────────────────────────────────────────────

// progress bar at the top - fills left to right as user moves through steps
// not counting the 'done' screen as a step visually which feels right
function ProgressBar({ step, total }) {
  return (
    <View style={s.progressBar}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={[s.progressSeg, { backgroundColor: i < step ? C.accent : C.border }, i < total - 1 && { marginRight: 6 }]} />
      ))}
    </View>
  );
}

// reusable info box with an icon + text - used for tips/warnings throughout onboarding
function InfoBox({ icon, text, style }) {
  return (
    <View style={[s.infoBox, style]}>
      <Text style={{ fontSize: 18 }}>{icon}</Text>
      <Text style={s.infoBoxText}>{text}</Text>
    </View>
  );
}

// ─── Onboarding Screens ───────────────────────────────────────────────────────

// first screen the user sees - selling the value prop before asking for permissions
function WelcomeScreen() {
  return (
    // centering everything and giving space at the bottom for the nav button
    <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 24 }}>
      {/* subtle background glow effect - purely decorative but looks nice */}
      <View style={s.welcomeGlow} />
      <Text style={{ fontSize: 48, marginBottom: 20 }}>🧩</Text>
      <Text style={s.welcomeTitle}>Your context,{'\n'}everywhere.</Text>
      <Text style={s.welcomeBody}>This assistant lives inside Gmail, WhatsApp, and Slack — connecting dots across all of them so you never lose track of what matters.</Text>
      {/* feature list - keeping these short and punchy so people actually read them */}
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

// step 2 - let user pick which apps to sync
// should we require at least one? right now you can proceed with nothing selected
function ConnectAppsScreen({ selected, onToggle }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🔗</Text>
        <Text style={s.sectionTitle}>Connect your apps</Text>
        <Text style={s.sectionSubtitle}>Choose which platforms to sync. Change anytime in Settings.</Text>
      </View>
      {/* each app card toggles on/off - selected state drives border + bg color change */}
      {APPS.map(app => (
        <TouchableOpacity key={app.id} style={[s.appCard, selected.includes(app.id) && s.appCardOn]} onPress={() => onToggle(app.id)} activeOpacity={0.8}>
          <Text style={{ fontSize: 26, marginRight: 14 }}>{app.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: C.textPrimary, marginBottom: 2 }}>{app.label}</Text>
            <Text style={{ fontSize: 12, color: C.textSecondary }}>{app.desc}</Text>
          </View>
          {/* custom checkbox instead of native - more control over styling */}
          <View style={[s.checkbox, selected.includes(app.id) && s.checkboxOn]}>
            {selected.includes(app.id) && <Text style={{ fontSize: 12, color: '#fff', fontWeight: '800' }}>✓</Text>}
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// step 3 - whitelist contacts so we don't accidentally surface anyone's private stuff
// this is the core privacy model - only show cross-app context for trusted people
function WhitelistScreen({ contacts, inputValue, onChangeInput, onAdd, onRemove }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>✅</Text>
        <Text style={s.sectionTitle}>Whitelist trusted contacts</Text>
        <Text style={s.sectionSubtitle}>The assistant only surfaces cross-app context for people you trust.</Text>
      </View>
      {/* input row - submit on return key or tap add button */}
      <View style={{ flexDirection: 'row', marginBottom: 16, gap: 10 }}>
        <TextInput style={s.textInput} placeholder="Add name or email..." placeholderTextColor={C.textMuted}
          value={inputValue} onChangeText={onChangeInput} onSubmitEditing={onAdd} returnKeyType="done" autoCapitalize="none" />
        <TouchableOpacity style={s.addBtn} onPress={onAdd}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Add</Text>
        </TouchableOpacity>
      </View>
      {/* chips for added contacts - tap the x to remove */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {contacts.length === 0
          ? <Text style={{ color: C.textMuted, fontSize: 13, fontStyle: 'italic' }}>No contacts added yet.</Text>
          : contacts.map(c => (
            <View key={c} style={s.chip}>
              <Text style={s.chipText}>{c}</Text>
              {/* hitSlop makes the x easier to tap - small touch targets are annoying */}
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

// step 4 - privacy toggles, some are required and can't be turned off
// wonder if users will actually read these or just tap through
function PrivacyScreen({ privacyValues, onToggle }) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 20 }}>
        <Text style={{ fontSize: 36, marginBottom: 12 }}>🔐</Text>
        <Text style={s.sectionTitle}>Privacy & security</Text>
        <Text style={s.sectionSubtitle}>Double-sided protection — for you and the people you communicate with.</Text>
      </View>
      {PRIVACY_SETTINGS.map(setting => (
        // locked settings get a green tinted bg to show they're always on
        <View key={setting.id} style={[s.privacyRow, setting.locked && { borderColor: C.greenSoft, backgroundColor: C.greenSoft }]}>
          <Text style={{ fontSize: 22, marginRight: 12 }}>{setting.icon}</Text>
          <View style={{ flex: 1, marginRight: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: C.textPrimary }}>{setting.label}</Text>
              {/* "required" badge so user knows why the toggle is greyed out */}
              {setting.locked && <View style={s.lockedBadge}><Text style={s.lockedBadgeText}>REQUIRED</Text></View>}
            </View>
            <Text style={{ fontSize: 12, color: C.textSecondary, lineHeight: 18 }}>{setting.desc}</Text>
          </View>
          {/* disabled switch for locked settings - passing undefined for onValueChange instead of noop */}
          <Switch value={privacyValues[setting.id]} onValueChange={setting.locked ? undefined : val => onToggle(setting.id, val)}
            disabled={setting.locked} trackColor={{ false: C.border, true: C.accent }}
            thumbColor={privacyValues[setting.id] ? '#fff' : C.textMuted} ios_backgroundColor={C.border} />
        </View>
      ))}
      {/* note about the rule-based layer - important to communicate this happens before ai processing */}
      <InfoBox icon="🔒" text="A rule-based layer runs before any AI processing to catch sensitive patterns." style={{ borderColor: C.accentSoft, backgroundColor: '#0D1A2A' }} />
    </ScrollView>
  );
}

// step 5 - notification preferences, conditionally shows timing options
// is 1 hour really the best default? might want to survey users on this
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
      {/* only show timing picker if notifs are on - conditional rendering ftw */}
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
      {/* reassuring users about local processing - this is a big trust signal */}
      <InfoBox icon="📲" text="All notification processing happens locally. No data sent to external servers." />
    </ScrollView>
  );
}

// last onboarding screen - summary of what the user set up
// shows counts from parent state so it reflects their actual choices
function DoneScreen({ connectedCount, contactCount }) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingBottom: 24 }}>
      {/* green glow on done screen vs blue on welcome - nice little detail */}
      <View style={s.doneGlow} />
      <Text style={{ fontSize: 56, marginBottom: 16 }}>🎉</Text>
      <Text style={s.doneTitle}>You're all set!</Text>
      <Text style={{ fontSize: 14, color: C.textSecondary, lineHeight: 22, textAlign: 'center', marginBottom: 28, paddingHorizontal: 8 }}>
        Your contextual assistant is configured. Look for the extension icon in Gmail, WhatsApp, and Slack.
      </Text>
      {/* summary card - hardcoding some values here, should these pull from state? */}
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

// main inbox view - splits notifs into unread/read sections
// note: read state is local only right now, would need to sync this across sessions
function NotificationsTab() {
  const [notifs, setNotifs] = useState(DATA.notifications);
  const unread = notifs.filter(n => !n.read);
  const read = notifs.filter(n => n.read);

  // mark a single notif as read on tap
  function markRead(id) { setNotifs(p => p.map(n => n.id === id ? { ...n, read: true } : n)); }

  // bulk action - mark everything read at once
  function markAll() { setNotifs(p => p.map(n => ({ ...n, read: true }))); }

  // card defined inside the tab so it can close over markRead - is this a perf concern with lots of notifs?
  function Card({ n }) {
    return (
      <TouchableOpacity style={[s.notifCard, !n.read && s.notifCardUnread]} onPress={() => markRead(n.id)} activeOpacity={0.8}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {/* source icon bubble - shows which app the notif came from */}
          <View style={s.notifBubble}><Text style={{ fontSize: 18 }}>{n.sourceIcon}</Text></View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Text style={s.notifTitle} numberOfLines={1}>{n.title}</Text>
              {/* blue dot indicator for unread - disappears when tapped */}
              {!n.read && <View style={s.unreadDot} />}
            </View>
            <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }} numberOfLines={2}>{n.body}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              {/* priority badge - color coded from the helper functions at the top */}
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
        {/* only show mark all button if there's actually unread stuff */}
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

// ─── Dashboard: Calendar Tab ──────────────────────────────────────────────────

// groups events by date and shows a modal with details on tap
// reduce here builds a {date: [events]} map - cleaner than sorting and slicing
function CalendarTab() {
  const [selected, setSelected] = useState(null);

  // grouping events by date key so we can render date headers
  const grouped = DATA.events.reduce((acc, e) => {
    if (!acc[e.date]) acc[e.date] = [];
    acc[e.date].push(e);
    return acc;
  }, {});

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Calendar</Text>
          <Text style={s.dashSubtitle}>{DATA.events.length} upcoming events</Text>
        </View>
      </View>

      {Object.entries(grouped).map(([date, events]) => (
        <View key={date} style={{ marginBottom: 6 }}>
          {/* formatted date header above each group of events */}
          <Text style={s.calDateLabel}>{formatDate(date)}</Text>
          {events.map(e => (
            // tapping an event opens the detail modal
            <TouchableOpacity key={e.id} style={s.eventCard} onPress={() => setSelected(e)} activeOpacity={0.8}>
              <View style={{ width: 56, alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: C.textPrimary }}>{e.time}</Text>
                {e.duration && <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{e.duration}</Text>}
              </View>
              {/* vertical accent line - visual separator between time and event info */}
              <View style={{ width: 2, height: 40, backgroundColor: C.accent, borderRadius: 2, opacity: 0.5 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: C.textPrimary, marginBottom: 6 }}>{e.title}</Text>
                {/* attendee chips - truncates naturally if there are a lot */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                  {e.attendees.map(a => (
                    <View key={a} style={s.attendeeChip}><Text style={{ fontSize: 11, color: C.textSecondary, fontWeight: '500' }}>{a}</Text></View>
                  ))}
                </View>
              </View>
              <Text style={{ fontSize: 18 }}>{e.sourceIcon}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ))}

      {/* bottom sheet modal for event details - slides up from bottom */}
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
              {/* building detail rows from an array so they're easy to add/remove */}
              {[
                ['🕐', `${selected.time}${selected.duration ? ` · ${selected.duration}` : ''}`],
                ['📅', formatDate(selected.date)],
                [selected.sourceIcon, selected.source],
                // filter out null to skip attendees row if the array is empty
                selected.attendees.length > 0 ? ['👥', selected.attendees.join(', ')] : null,
              ].filter(Boolean).map(([icon, text]) => (
                <View key={text} style={s.modalRow}>
                  <Text style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{icon}</Text>
                  <Text style={{ fontSize: 14, color: C.textSecondary, flex: 1 }}>{text}</Text>
                </View>
              ))}
              {/* video link only shows if present - should this be tappable? */}
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

// ─── Dashboard: Threads Tab ───────────────────────────────────────────────────

// cross-app thread view - this is the core feature, showing conversations that span multiple platforms
// how do we handle threads where the same person messages you on 3 different apps?
function ThreadsTab() {
  const [selected, setSelected] = useState(null);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}>
      <View style={s.dashHeader}>
        <View>
          <Text style={s.dashTitle}>Threads</Text>
          {/* "need attention" framing instead of just "unread" - feels more actionable */}
          <Text style={s.dashSubtitle}>{DATA.threads.filter(t => t.unread > 0).length} need attention</Text>
        </View>
      </View>

      {DATA.threads.map(t => (
        <TouchableOpacity key={t.id} style={s.threadCard} onPress={() => setSelected(t)} activeOpacity={0.8}>
          {/* colored avatar circle - color comes from the data, not computed here */}
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
              {/* open items badge - only shows if there's actually stuff to action */}
              {t.openItems.length > 0 && (
                <View style={s.openBadge}>
                  <Text style={{ fontSize: 10, color: C.yellow, fontWeight: '700' }}>{t.openItems.length} open</Text>
                </View>
              )}
            </View>
          </View>
          {/* unread count bubble - only renders if there are unread messages */}
          {t.unread > 0 && (
            <View style={s.unreadBadge}><Text style={{ fontSize: 11, color: '#fff', fontWeight: '800' }}>{t.unread}</Text></View>
          )}
        </TouchableOpacity>
      ))}

      {/* thread detail modal - shows ai summary + open action items + related dates */}
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
              {/* ai-generated summary of the thread - this is where the cross-app magic shows */}
              <View style={{ backgroundColor: C.surfaceAlt, borderRadius: 10, padding: 12, marginBottom: 14 }}>
                <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 6 }}>SUMMARY</Text>
                <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>{selected.summary}</Text>
              </View>
              {/* open items - extracted action items from the thread, should these be checkable? */}
              <Text style={{ fontSize: 12, color: C.textMuted, fontWeight: '600', marginBottom: 8 }}>OPEN ITEMS</Text>
              {selected.openItems.map(item => (
                <View key={item} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                  {/* dot bullet - simple and clean */}
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent, marginTop: 6 }} />
                  <Text style={{ flex: 1, fontSize: 13, color: C.textPrimary, lineHeight: 20 }}>{item}</Text>
                </View>
              ))}
              {/* related dates pulled from thread context - this is the date extraction feature in action */}
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

// tab config - easy to add a 4th tab here if needed later
const TABS = [
  { key: 'notifications', label: 'Inbox', icon: '🔔' },
  { key: 'calendar', label: 'Calendar', icon: '📅' },
  { key: 'threads', label: 'Threads', icon: '💬' },
];

// main dashboard wrapper - handles tab state and renders the active screen
function Dashboard() {
  const [tab, setTab] = useState('notifications');
  // unread count for the tab badge - reads from raw data not state since notif state lives in the tab
  // todo: lift notif state up here so the badge updates when you mark things read?
  const unreadCount = DATA.notifications.filter(n => !n.read).length;
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        {/* conditional rendering for tabs - could use a map but this is readable enough */}
        {tab === 'notifications' && <NotificationsTab />}
        {tab === 'calendar' && <CalendarTab />}
        {tab === 'threads' && <ThreadsTab />}
      </View>
      {/* bottom tab bar - fixed at bottom, above safe area */}
      <View style={s.tabBar}>
        {TABS.map(t => {
          const on = tab === t.key;
          return (
            <TouchableOpacity key={t.key} style={s.tabItem} onPress={() => setTab(t.key)} activeOpacity={0.8}>
              <View style={{ position: 'relative' }}>
                <Text style={[s.tabIcon, on && s.tabIconOn]}>{t.icon}</Text>
                {/* notification badge on the inbox tab icon - only show when there are unreads */}
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

// top level component - controls whether we show onboarding or the dashboard
// done flag in state means onboarding data doesn't persist if the app restarts - is that fine?
export default function App() {
  const [done, setDone] = useState(false);
  const [step, setStep] = useState(0);

  // fade animation ref - persists across renders without causing re-renders
  const fade = useRef(new Animated.Value(1)).current;

  // onboarding state - all collected here at the top level so done screen can summarize it
  const [selectedApps, setSelectedApps] = useState(['gmail', 'calendar']);
  const [contacts, setContacts] = useState(['Natalie', 'Eugenie', 'Jonathan', 'Amanda']);
  const [contactInput, setContactInput] = useState('');
  const [privacyValues, setPrivacyValues] = useState(Object.fromEntries(PRIVACY_SETTINGS.map(p => [p.id, p.default])));
  const [notifEnabled, setNotifEnabled] = useState(true);
  const [leadTime, setLeadTime] = useState('1 hour');

  // fade out -> update state -> fade back in - makes screen transitions feel smoother
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
  const TOTAL = ONBOARDING_STEPS.length - 1; // -1 because we don't show progress bar on done screen

  // renders the right screen based on current step name
  // switch on string feels cleaner than an array of components here
  function renderScreen() {
    switch (current) {
      case 'welcome': return <WelcomeScreen />;
      case 'connect': return <ConnectAppsScreen selected={selectedApps} onToggle={id => setSelectedApps(p => p.includes(id) ? p.filter(a => a !== id) : [...p, id])} />;
      case 'whitelist': return <WhitelistScreen contacts={contacts} inputValue={contactInput} onChangeInput={setContactInput}
        // trim whitespace and check for dupes before adding
        onAdd={() => { const t = contactInput.trim(); if (t && !contacts.includes(t)) setContacts(p => [...p, t]); setContactInput(''); }}
        onRemove={name => setContacts(p => p.filter(c => c !== name))} />;
      case 'privacy': return <PrivacyScreen privacyValues={privacyValues} onToggle={(id, val) => setPrivacyValues(p => ({ ...p, [id]: val }))} />;
      case 'notifications': return <NotificationsOnboarding notifEnabled={notifEnabled} onToggleNotif={setNotifEnabled} leadTime={leadTime} onSelectLeadTime={setLeadTime} />;
      // pass counts so done screen doesn't need to import the state directly
      case 'done': return <DoneScreen connectedCount={selectedApps.length} contactCount={contacts.length} />;
    }
  }

  // skip straight to dashboard if onboarding is finished
  if (done) return <Dashboard />;

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {/* hide progress bar on the done screen since it's a celebration moment not a step */}
      {!isDone && <ProgressBar step={step} total={TOTAL} />}
      <Animated.View style={[{ flex: 1, paddingHorizontal: 24, paddingTop: 8 }, { opacity: fade }]}>
        {renderScreen()}
      </Animated.View>
      {/* nav row at the bottom - back button only shows after step 0 */}
      <View style={s.navRow}>
        {!isFirst && !isDone && (
          <TouchableOpacity style={s.backBtn} onPress={() => transition(() => setStep(p => p - 1))}>
            <Text style={{ color: C.textSecondary, fontSize: 15, fontWeight: '600' }}>← Back</Text>
          </TouchableOpacity>
        )}
        {!isDone && (
          // continue button stretches full width on the first screen since there's no back button
          <TouchableOpacity style={[s.nextBtn, isFirst && { flex: 1 }]} onPress={() => transition(() => setStep(p => p + 1))}>
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
              {current === 'notifications' ? 'Finish Setup →' : 'Continue →'}
            </Text>
          </TouchableOpacity>
        )}
        {isDone && (
          // green button on done screen to match the celebration vibe - sets done=true which swaps to dashboard
          <TouchableOpacity style={[s.nextBtn, { flex: 1, backgroundColor: C.green }]} onPress={() => setDone(true)}>
            <Text style={{ color: '#0D1A14', fontSize: 15, fontWeight: '800' }}>Open Dashboard →</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

// all styles at the bottom to keep components readable - rn stylesheets get optimized at runtime
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  progressBar: { flexDirection: 'row', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 4 },
  progressSeg: { flex: 1, height: 3, borderRadius: 2 },

  // onboarding styles
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

  // nav bar styles - shared between onboarding steps
  navRow: { flexDirection: 'row', paddingHorizontal: 24, paddingBottom: 24, paddingTop: 12, gap: 12 },
  backBtn: { paddingVertical: 14, paddingHorizontal: 20, borderRadius: 14, borderWidth: 1, borderColor: C.border },
  nextBtn: { flex: 1, backgroundColor: C.accent, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },

  // dashboard styles
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