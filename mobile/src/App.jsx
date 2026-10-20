// The app's shell: who's logged in, the top bar, the tabs along the bottom, toasts, and which page
// the hash is on. The pages themselves are in pages/.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from './api.js';
import { AppContext, useApp } from './context.js';
import { go, match, useHash } from './router.js';
import { color, font, MAX_WIDTH, TAB_BAR_HEIGHT, TOP_BAR_HEIGHT } from './theme.js';
import { Icon } from './ui/icons.jsx';
import { Empty, Link, Loading } from './ui/index.jsx';
import ExplorePage from './pages/Explore.jsx';
import FeedPage from './pages/Feed.jsx';
import LoginPage from './pages/Login.jsx';
import ManagePage from './pages/Manage.jsx';
import NewOfficeHourPage from './pages/NewOfficeHour.jsx';
import OfficeHourPage from './pages/OfficeHour.jsx';
import ProfilePage from './pages/Profile.jsx';

const PAGES = { feed: FeedPage, explore: ExplorePage, new: NewOfficeHourPage, officeHour: OfficeHourPage, manage: ManagePage, profile: ProfilePage, login: LoginPage };

export default function App() {
  const [server, setServer] = useState(null); // GET /api/me: the user, and what the server can do
  const [bootError, setBootError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [typing, setTyping] = useState(false);
  const { hash, visit } = useHash();
  const route = match(hash || '#/');

  const loadMe = useCallback(async () => {
    const data = await api('GET', '/api/me');
    setServer(data);
    return data;
  }, []);
  useEffect(() => {
    loadMe().catch(setBootError);
  }, [loadMe]);

  const toast = useCallback((message, kind = 'info') => {
    const id = Math.random();
    setToasts((list) => [...list, { id, message, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3500);
  }, []);
  const requireLogin = useCallback(() => {
    toast('Log in to do that');
    go(`#/login?next=${encodeURIComponent(location.hash)}`);
  }, [toast]);
  const fail = useCallback(
    (err) => {
      if (err?.name === 'AbortError') return;
      if (err?.status === 401) requireLogin();
      else toast(err?.message ?? String(err), 'error');
    },
    [toast, requireLogin],
  );

  const ctx = useMemo(
    () =>
      server && {
        me: server.user,
        devLogin: server.devLogin,
        devSession: server.devSession, // it logged them in, not their password
        speech: server.speech, // the server transcribes recordings and reads typed questions aloud
        brollOn: server.broll, // experts can add b-roll to their answers, by uploading it
        makesBroll: server.makesBroll, // and have it made from a description
        brollModel: server.brollModel, // by this model, which films it
        voices: server.voices ?? [],
        voice: server.voice,
        setMe: (user) => setServer((s) => ({ ...s, user })),
        setVoice: (voice) => setServer((s) => ({ ...s, voice })),
        loadMe,
        toast,
        fail,
        requireLogin,
      },
    [server, loadMe, toast, fail, requireLogin],
  );

  // Logged-out visitors land on Explore instead of an empty feed; other pages that need an account
  // go to the login page and come back.
  const blocked = Boolean(ctx && route.auth && !ctx.me);
  useEffect(() => {
    if (!blocked) return;
    if (route.name === 'feed') go('#/explore');
    else go(`#/login?next=${encodeURIComponent(location.hash)}`);
  }, [blocked, route.name]);

  // A new page starts at the top.
  const pageKey = `${route.path}?${route.query}#${visit}`;
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) firstPage.current = false;
    else window.scrollTo(0, 0);
  }, [pageKey]);

  // The tabs make way for the keyboard while something's being typed.
  useEffect(() => {
    const isField = (el) => el?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select');
    const onIn = (e) => isField(e.target) && setTyping(true);
    const onOut = (e) => isField(e.target) && setTyping(false);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);

  if (bootError) {
    return (
      <View style={styles.page}>
        <Empty message={`Couldn't reach off hours: ${bootError.message}`} />
      </View>
    );
  }
  if (!ctx) return <Loading />;

  const Page = PAGES[route.name];
  return (
    <AppContext.Provider value={ctx}>
      <TopBar route={route} />
      <View style={styles.page} role="main">
        {blocked ? <Loading /> : Page ? <Page key={pageKey} params={route.params} query={route.query} /> : <Empty message="Page not found."><Link to="#/">Go home</Link></Empty>}
      </View>
      {typing ? null : <TabBar route={route} />}
      <View style={styles.toasts} pointerEvents="none" aria-live="polite">
        {toasts.map((t) => (
          <View key={t.id} style={[styles.toast, t.kind === 'error' && { backgroundColor: color.accent }]}>
            <Text style={styles.toastText}>{t.message}</Text>
          </View>
        ))}
      </View>
    </AppContext.Provider>
  );
}

function TopBar({ route }) {
  const { me, devLogin, devSession } = useApp();
  return (
    <View id="topbar" style={styles.topbar}>
      <View style={styles.topbarInner}>
        <Pressable onPress={() => go('#/')} role="link" aria-label="off hours, home">
          <Text style={styles.brand}>
            off hours<Text style={{ color: color.accent }}>.</Text>
          </Text>
        </Pressable>
        {devLogin && (!me || devSession) ? <UserSwitcher route={route} /> : null}
      </View>
    </View>
  );
}

// Dev only: switch between users without logging in. Shown when the server runs with --dev, until
// someone logs in with their password.
function UserSwitcher({ route }) {
  const { me, loadMe, setMe, toast, fail } = useApp();
  const [users, setUsers] = useState(null);
  useEffect(() => {
    api('GET', '/api/dev/users').then(({ users: list }) => setUsers(list), fail);
  }, [fail]);
  const change = async (username) => {
    try {
      let next = null;
      if (username) {
        await api('POST', '/api/dev/login', { username });
        next = (await loadMe()).user;
      } else {
        await api('POST', '/api/auth/logout');
        setMe(null);
      }
      toast(next ? `Now acting as ${next.displayName}` : 'Logged out');
      // Stay on the current page, seen as the new user; leave the login page if we're on it.
      go(route.name === 'login' ? '#/' : location.hash || '#/');
    } catch (err) {
      fail(err);
    }
  };
  return (
    <View style={styles.devSwitch}>
      <Text style={styles.devLabel}>Acting as</Text>
      <select aria-label="Dev mode: switch user without logging in" value={me?.username ?? ''} onChange={(e) => change(e.target.value)} style={selectStyle}>
        <option value="">— logged out —</option>
        {(users ?? []).map((u) => (
          <option key={u.username} value={u.username}>
            {u.displayName}
          </option>
        ))}
      </select>
    </View>
  );
}

function TabBar({ route }) {
  const { me } = useApp();
  const mine = route.name === 'profile' && route.params.username === me?.username;
  const tabs = me
    ? [
        ['feed', 'Feed', '#/', route.name === 'feed'],
        ['explore', 'Explore', '#/explore', route.name === 'explore'],
        ['host', 'Host', '#/oh/new', route.name === 'new'],
        ['person', 'You', `#/u/${me.username}`, mine],
      ]
    : [
        ['explore', 'Explore', '#/explore', route.name === 'explore'],
        ['login', 'Log in', '#/login', route.name === 'login'],
      ];
  return (
    <View style={styles.tabbar} role="navigation">
      <View style={styles.tabbarInner}>
        {tabs.map(([icon, label, to, active]) => (
          <Pressable key={label} onPress={() => go(to)} role="link" aria-current={active ? 'page' : undefined} style={styles.tab}>
            <Icon name={icon} size={22} color={active ? color.ink : color.muted} />
            <Text style={[styles.tabText, active && { color: color.ink, fontWeight: '600' }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const selectStyle = { font: 'inherit', fontSize: 14, border: 'none', background: 'transparent', color: color.ink, maxWidth: 150, minWidth: 0, minHeight: 36, padding: '0 4px' };

const styles = StyleSheet.create({
  page: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: `calc(${TAB_BAR_HEIGHT + 48}px + env(safe-area-inset-bottom))`, flexGrow: 1 },
  topbar: { position: 'sticky', top: 0, zIndex: 10, backgroundColor: 'rgba(248,246,242,0.9)', backdropFilter: 'saturate(1.4) blur(14px)', borderBottomWidth: 1, borderBottomColor: color.line, paddingTop: 'env(safe-area-inset-top)' },
  topbarInner: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', minHeight: TOP_BAR_HEIGHT, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  brand: { fontFamily: font.serif, fontSize: 26, lineHeight: 30, letterSpacing: -0.8, color: color.ink },
  devSwitch: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.surface, borderRadius: 999, paddingLeft: 12, paddingRight: 6, flexShrink: 1 },
  devLabel: { fontFamily: font.sans, fontSize: 12, color: color.muted },
  tabbar: { position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 20, backgroundColor: 'rgba(248,246,242,0.94)', backdropFilter: 'saturate(1.4) blur(14px)', borderTopWidth: 1, borderTopColor: color.line, paddingBottom: 'env(safe-area-inset-bottom)' },
  tabbarInner: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', height: TAB_BAR_HEIGHT, flexDirection: 'row' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, cursor: 'pointer' },
  tabText: { fontFamily: font.sans, fontSize: 11, color: color.muted },
  toasts: { position: 'fixed', left: 16, right: 16, bottom: `calc(${TAB_BAR_HEIGHT + 20}px + env(safe-area-inset-bottom))`, zIndex: 100, alignItems: 'center', gap: 8 },
  toast: { backgroundColor: color.ink, paddingVertical: 11, paddingHorizontal: 20, borderRadius: 22, maxWidth: 480, boxShadow: '0 12px 32px -12px rgba(0,0,0,0.45)' },
  toastText: { fontFamily: font.sans, fontSize: 15, lineHeight: 21, color: '#fff', textAlign: 'center' },
});
