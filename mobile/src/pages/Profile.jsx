import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { plural } from '../format.js';
import { useLoad } from '../hooks.js';
import { go } from '../router.js';
import { color } from '../theme.js';
import { Avatar, Button, Card, Chip, Disclosure, Empty, Field, H1, Loading, Muted, Row, SectionTitle, Serif } from '../ui/index.jsx';
import { CardList, SubscribeButton } from '../officehour/common.jsx';

export default function ProfilePage({ params }) {
  const { me, setMe } = useApp();
  const { data, error, reload } = useLoad(() => api('GET', `/api/users/${encodeURIComponent(params.username)}`), [params.username]);
  if (error) return <Empty message={error.message} />;
  if (!data) return <Loading />;
  const u = data.user;
  const upcoming = data.officeHours.filter((oh) => oh.status !== 'published');
  const past = data.officeHours.filter((oh) => oh.status === 'published');
  return (
    <View style={{ gap: 36 }}>
      <View style={{ gap: 16 }}>
        <Row gap={16}>
          <Avatar name={u.displayName} size={64} />
          <View style={{ flex: 1 }}>
            <H1 style={{ fontSize: 34, lineHeight: 38 }}>{u.displayName}</H1>
            <Muted>
              @{u.username} · {plural(data.subscriberCount, 'subscriber')}
            </Muted>
          </View>
        </Row>
        {u.bio ? <Serif style={{ fontSize: 19, lineHeight: 28, color: color.ink2 }}>{u.bio}</Serif> : null}
        {u.expertise.length ? (
          <Row wrap gap={6}>
            {u.expertise.map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </Row>
        ) : null}
        {data.isMe ? null : (
          <View style={{ alignSelf: 'flex-start' }}>
            <SubscribeButton type="expert" id={u.id} subscribed={data.subscribed} primary />
          </View>
        )}
      </View>
      {data.isMe ? (
        <Card style={{ paddingVertical: 8 }}>
          <Disclosure title="Edit profile">
            <ProfileEditor user={u} onSaved={(user) => (setMe(user), reload())} />
          </Disclosure>
        </Card>
      ) : null}
      <View style={{ gap: 16 }}>
        <SectionTitle>Upcoming & open</SectionTitle>
        {upcoming.length ? <CardList items={upcoming} /> : <Empty message="No upcoming office hours.">{data.isMe ? <Button title="Host one" onPress={() => go('#/oh/new')} /> : null}</Empty>}
      </View>
      {past.length ? (
        <View style={{ gap: 16 }}>
          <SectionTitle>Answered</SectionTitle>
          <CardList items={past} />
        </View>
      ) : null}
      {data.isMe && me ? <LogOut /> : null}
    </View>
  );
}

function ProfileEditor({ user, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState({ displayName: user.displayName, bio: user.bio, expertise: user.expertise.join(', ') });
  const set = (key) => (value) => setF((old) => ({ ...old, [key]: value }));
  return (
    <View style={{ gap: 16, paddingBottom: 12 }}>
      <Field label="Display name" value={f.displayName} onChangeText={set('displayName')} maxLength={60} />
      <Field label="Bio" value={f.bio} onChangeText={set('bio')} multiline rows={3} maxLength={1000} placeholder="Your background — the moderator uses this to suggest questions." />
      <Field label="Expertise" value={f.expertise} onChangeText={set('expertise')} placeholder="Comma-separated, e.g. distributed systems, career growth" />
      <Button
        kind="primary"
        title="Save profile"
        onPress={async () => {
          const { user: saved } = await api('PATCH', '/api/me', f);
          toast('Profile saved', 'success');
          onSaved(saved);
        }}
      />
    </View>
  );
}

function LogOut() {
  const { setMe } = useApp();
  return (
    <Button
      kind="ring"
      title="Log out"
      onPress={async () => {
        await api('POST', '/api/auth/logout');
        setMe(null);
        go('#/explore');
      }}
    />
  );
}
