import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { babble, blinkAt, character } from '../../../public/fox.js';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { plural } from '../format.js';
import { useLoad } from '../hooks.js';
import { go, searchHash } from '../router.js';
import { color } from '../theme.js';
import { Avatar, Button, Card, Chip, Disclosure, Empty, Field, H1, Hint, Loading, Muted, Notice, Row, SectionTitle, Serif } from '../ui/index.jsx';
import { CardList, SubscribeButton } from '../officehour/common.jsx';

export default function ProfilePage({ params }) {
  const { me, setMe, avatarsOn } = useApp();
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
          <Avatar name={u.displayName} uri={u.avatar} size={64} />
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
              <Chip key={t} to={searchHash(t)}>
                {t}
              </Chip>
            ))}
          </Row>
        ) : null}
        {data.isMe ? null : (
          <View style={{ alignSelf: 'flex-start' }}>
            <SubscribeButton type="expert" id={u.id} subscribed={data.subscribed} primary />
          </View>
        )}
      </View>
      {data.isMe && avatarsOn ? <CharacterMaker onPicked={(user) => (setMe(user), reload())} /> : null}
      {data.isMe ? (
        <Card style={{ paddingVertical: 8 }}>
          <Disclosure title="Edit profile">
            <ProfileEditor user={u} onSaved={(user) => (setMe(user), reload())} />
          </Disclosure>
        </Card>
      ) : null}
      <View style={{ gap: 16 }}>
        <SectionTitle>Upcoming & open</SectionTitle>
        {upcoming.length ? <CardList items={upcoming} /> : <Empty message="No upcoming off hours.">{data.isMe ? <Button title="Host one" onPress={() => go('#/oh/new')} /> : null}</Empty>}
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

// Making a character for the user's profile picture, which also says their questions in the video of
// the answers (see JointPlayer). They say what it should be, or leave it to their profile; three are
// drawn in the background, which takes a minute or so, and they pick one. Each is animated as the
// player will animate it, blinking, and the one they're looking at talks.
function CharacterMaker({ onPicked }) {
  const { toast } = useApp();
  const { data } = useLoad(() => api('GET', '/api/me/avatar'), []);
  const [state, setState] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [pickedId, setPickedId] = useState(null);
  const avatar = state ?? data?.avatar;
  const pending = avatar?.status === 'pending';

  // While they're being drawn, checks back every few seconds until it's done.
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const res = await api('GET', '/api/me/avatar', null, { timeout: 10_000 });
        if (stopped) return;
        if (res.avatar.status !== 'pending') return setState(res.avatar);
      } catch {
        // failed or hung: try again on the next tick
      }
      if (!stopped) timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);

  if (!avatar) return null;
  const { options } = avatar;
  const picked = options.find((o) => o.id === pickedId) ?? options[0];
  return (
    <Card style={{ paddingVertical: 8 }}>
      {/* Open from the start when there's something to see: them being drawn, some to pick from, or why it failed. */}
      <Disclosure title="Your character" initiallyOpen={avatar.status != null}>
        <View style={{ gap: 16, paddingBottom: 12 }}>
          <Hint>A cartoon character drawn for your profile picture. When you type a question, it says it in the video of the answers.</Hint>
          {options.length ? (
            <>
              <Row gap={10} role="radiogroup" aria-label="Pick a character">
                {options.map((o, i) => (
                  <Pressable key={o.id} onPress={() => setPickedId(o.id)} role="radio" aria-checked={o === picked} aria-label={`Character ${i + 1}`} style={{ flex: 1, maxWidth: 128, padding: 2, borderRadius: 999, borderWidth: 3, borderColor: o === picked ? color.accent : 'transparent' }}>
                    <CharacterPreview rig={o.rig} talking={o === picked} />
                  </Pressable>
                ))}
              </Row>
              <Button
                kind="primary"
                title="Use this one"
                onPress={async () => {
                  const res = await api('PUT', '/api/me/avatar', { id: picked.id });
                  toast('Your profile picture is your new character', 'success');
                  setState(res.avatar);
                  onPicked(res.user);
                }}
              />
            </>
          ) : null}
          <Field label="What should it be?" value={prompt ?? avatar.prompt ?? ''} onChangeText={setPrompt} multiline rows={3} maxLength={300} placeholder="Like “an owl in a green scarf”, or leave it empty for ideas from your profile" />
          <Button
            kind={options.length ? 'ring' : 'primary'}
            title={options.length || avatar.current ? 'Draw three more' : 'Draw three characters'}
            disabled={pending}
            onPress={async () => {
              const res = await api('POST', '/api/me/avatar', { prompt: prompt ?? avatar.prompt ?? '' });
              setState(res.avatar);
            }}
          />
          {pending ? <Hint>Drawing three characters… this takes a minute or so.</Hint> : null}
          {avatar.error ? <Notice>{avatar.error}</Notice> : null}
          {avatar.current && !options.length ? (
            <Button
              kind="link"
              title="Go back to my initial"
              onPress={async () => {
                const res = await api('DELETE', '/api/me/avatar');
                setState(res.avatar);
                onPicked(res.user);
              }}
            />
          ) : null}
        </View>
      </Disclosure>
    </Card>
  );
}

// A character drawn from its `rig`, its head in a circle, as the bubble in the player shows it: it
// blinks and sways, and talks while `talking`. It's as wide as its place.
function CharacterPreview({ rig, talking }) {
  const canvas = useRef(null);
  const talks = useRef(talking);
  talks.current = talking;
  useEffect(() => {
    const drawer = character(canvas.current, rig, 'bubble');
    const seed = Math.floor(Math.random() * 2 ** 31);
    const start = performance.now();
    let frame = 0;
    const loop = (now) => {
      const t = (now - start) / 1000;
      drawer.draw(talks.current ? babble(t) : [0, 1, 0], blinkAt(seed, t % 60), t);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [rig]);
  return <canvas ref={canvas} aria-hidden="true" style={{ display: 'block', width: '100%', aspectRatio: '1', borderRadius: '50%', background: rig.backdrop }} />;
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
