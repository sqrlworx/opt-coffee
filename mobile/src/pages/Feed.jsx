import { Pressable, StyleSheet, View } from 'react-native';
import { api } from '../api.js';
import { fmtDate, plural, relative } from '../format.js';
import { useLoad } from '../hooks.js';
import { go } from '../router.js';
import { color, radius } from '../theme.js';
import { Avatar, Button, Empty, H1, H2, Loading, Row, Serif, Small, StatusBadge, T, TopicChip, UserLink } from '../ui/index.jsx';
import { HostLink } from '../officehour/common.jsx';

export default function FeedPage() {
  const { data, error } = useLoad(() => api('GET', '/api/feed'), []);
  if (error) return <Empty message={error.message} />;
  if (!data) return <Loading />;
  return (
    <View style={{ gap: 24 }}>
      <View style={{ gap: 8 }}>
        <H1>Your feed</H1>
        <HostLink />
      </View>
      {data.items.length === 0 ? (
        <Empty message="Nothing here yet. Subscribe to experts or office hours and they'll show up here.">
          <Button title="Explore office hours" onPress={() => go('#/explore')} />
        </Empty>
      ) : (
        <View style={{ gap: 14 }}>
          {data.items.map((item) => (
            <FeedItem key={`${item.type}-${item.officeHour.id}`} item={item} />
          ))}
        </View>
      )}
    </View>
  );
}

// Feed cards are teasers: no asking or reading answers here, just enough to tap through.
function FeedItem({ item }) {
  const oh = item.officeHour;
  const open = () => go(`#/oh/${oh.id}`);
  const announced = item.type === 'announced';
  let cta = ['Read the answers →', true];
  if (announced && oh.status !== 'published') {
    if (oh.isExpert) cta = ['View office hour →', false];
    else if (oh.status === 'open') cta = ['Ask a question →', true];
    else cta = ['View questions →', false];
  }
  // Once it's published, readers are only told about the questions that were answered.
  const counted = oh.status === 'open' ? 'so far' : oh.status === 'published' && !oh.isExpert ? 'answered' : 'asked';
  const more = announced ? 0 : item.answerCount - item.preview.length;
  return (
    <View style={styles.card}>
      <Row gap={12}>
        <Avatar name={oh.expert.displayName} />
        <View style={{ flex: 1 }}>
          <T>
            <UserLink user={oh.expert} style={{ fontWeight: '600' }} />
            {announced ? ' announced office hours' : ` answered ${plural(item.answerCount, 'question')}`}
          </T>
          <Small style={{ color: color.muted }}>{relative(item.at)}</Small>
        </View>
      </Row>
      <Pressable onPress={open} role="link" href={`#/oh/${oh.id}`} style={{ gap: 10 }}>
        <H2>{oh.title}</H2>
        <Row wrap gap={8}>
          <TopicChip oh={oh} />
          {announced ? <StatusBadge oh={oh} /> : null}
        </Row>
      </Pressable>
      {announced ? (
        <>
          {oh.description ? <T numberOfLines={3}>{oh.description}</T> : null}
          <Small style={{ color: color.muted }}>
            {plural(oh.questionCount, 'question')} {counted} · questions until {fmtDate(oh.questionsDeadline)} · answers expected {fmtDate(oh.answersExpectedAt)}
          </Small>
        </>
      ) : (
        <View style={{ gap: 6 }}>
          {item.preview.map((q) => (
            <Row key={q.id} gap={10} style={{ alignItems: 'flex-start' }}>
              <Serif style={{ color: color.muted, fontSize: 18, lineHeight: 25 }}>•</Serif>
              <Serif style={{ flex: 1, fontSize: 18, lineHeight: 25 }}>{q.body}</Serif>
            </Row>
          ))}
          {more > 0 ? <Small style={{ color: color.muted }}>+ {plural(more, 'more question')}</Small> : null}
        </View>
      )}
      <Button kind={cta[1] ? 'primary' : 'soft'} title={cta[0]} onPress={open} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.raised, borderRadius: radius.lg, padding: 20, gap: 16 },
});
