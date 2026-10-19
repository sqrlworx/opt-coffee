// Pieces shared by the pages that show office hours: cards, subscribe buttons, the expert's sheet.
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { plural } from '../format.js';
import { go } from '../router.js';
import { color, radius } from '../theme.js';
import { Button, Chip, H3, Link, Muted, Row, Serif, Sheet, Small, StatusBadge, TopicChip } from '../ui/index.jsx';

export function SubscribeButton({ type, id, subscribed: initially, label, small = false, primary = false }) {
  const { me, requireLogin } = useApp();
  const [subscribed, setSubscribed] = useState(initially);
  const suffix = label ? ` to ${label}` : '';
  return (
    <Button
      small={small}
      kind={subscribed ? 'ring' : primary ? 'primary' : 'soft'}
      title={subscribed ? `✓ Subscribed${suffix}` : `Subscribe${suffix}`}
      onPress={async () => {
        if (!me) return requireLogin();
        await api(subscribed ? 'DELETE' : 'POST', '/api/subscriptions', { type, id });
        setSubscribed(!subscribed);
      }}
    />
  );
}

// The expert's name in an office hour's byline. On the page, hovering it shows a card about them;
// phones can't hover, so tapping it opens that card as a sheet, with a button to subscribe to them
// and a way on to their profile.
export function ExpertName({ oh }) {
  const [open, setOpen] = useState(false);
  const { expert } = oh;
  return (
    <>
      <Serif role="button" onPress={() => setOpen(true)} style={styles.expertName}>
        {expert.displayName}
      </Serif>
      <Sheet visible={open} onClose={() => setOpen(false)} title={expert.displayName}>
        <Serif style={{ fontSize: 26, lineHeight: 30 }}>{expert.displayName}</Serif>
        <Muted>@{expert.username}</Muted>
        {expert.bio ? <Serif style={{ fontSize: 18, lineHeight: 27, color: color.ink2 }}>{expert.bio}</Serif> : null}
        {expert.expertise?.length ? (
          <Row wrap gap={6}>
            {expert.expertise.map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </Row>
        ) : null}
        <Row wrap gap={8} style={{ marginTop: 4 }}>
          <SubscribeButton type="expert" id={expert.id} subscribed={oh.subscribedToExpert} primary />
          <Button
            kind="ring"
            title="View profile"
            onPress={() => {
              setOpen(false);
              go(`#/u/${expert.username}`);
            }}
          />
        </Row>
      </Sheet>
    </>
  );
}

export function OhCard({ oh }) {
  return (
    <Pressable onPress={() => go(`#/oh/${oh.id}`)} role="link" href={`#/oh/${oh.id}`} style={({ pressed }) => [styles.ohCard, pressed && { transform: [{ scale: 0.99 }] }]}>
      <Row wrap gap={8}>
        <TopicChip oh={oh} />
        <StatusBadge oh={oh} />
      </Row>
      <H3>{oh.title}</H3>
      <Small style={{ color: color.muted }}>
        with {oh.expert.displayName} · {plural(oh.questionCount, 'question')}
      </Small>
    </Pressable>
  );
}

export function CardList({ items }) {
  return (
    <View style={{ gap: 12 }}>
      {items.map((oh) => (
        <OhCard key={oh.id} oh={oh} />
      ))}
    </View>
  );
}

export const HostLink = () => (
  <Link to="#/oh/new" style={{ fontWeight: '600' }}>
    + Host off hours
  </Link>
);

const styles = StyleSheet.create({
  expertName: { color: color.ink, fontStyle: 'normal', textDecorationLine: 'underline', textDecorationColor: color.lineStrong, cursor: 'pointer' },
  ohCard: { backgroundColor: color.raised, borderRadius: radius.lg, padding: 20, gap: 10, cursor: 'pointer', transitionProperty: 'transform', transitionDuration: '150ms' },
});
