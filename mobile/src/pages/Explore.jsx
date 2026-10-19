import { View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { plural } from '../format.js';
import { useLoad } from '../hooks.js';
import { Card, Chip, Empty, H1, H3, Link, Loading, Row, SectionTitle, Small } from '../ui/index.jsx';
import { CardList, HostLink, SubscribeButton } from '../officehour/common.jsx';
import { color } from '../theme.js';

export default function ExplorePage() {
  const { me } = useApp();
  const { data, error } = useLoad(() => api('GET', '/api/explore'), []);
  if (error) return <Empty message={error.message} />;
  if (!data) return <Loading />;
  const { open, published, people } = data;
  return (
    <View style={{ gap: 40 }}>
      <View style={{ gap: 8 }}>
        <H1>Explore</H1>
        {me ? <HostLink /> : null}
      </View>
      <View style={{ gap: 16 }}>
        <SectionTitle>Taking questions now</SectionTitle>
        {open.length ? <CardList items={open} /> : <Empty message="No off hours are open right now." />}
      </View>
      <View style={{ gap: 16 }}>
        <SectionTitle>Recently answered</SectionTitle>
        {published.length ? <CardList items={published} /> : <Empty message="Nothing answered yet." />}
      </View>
      <View style={{ gap: 16 }}>
        <SectionTitle>People</SectionTitle>
        <View style={{ gap: 12 }}>
          {people.map((p) => (
            <Card key={p.id}>
              <Link to={`#/u/${p.username}`} style={{ textDecorationLine: 'none' }}>
                <H3>{p.displayName}</H3>
              </Link>
              <Small style={{ color: color.muted }}>
                @{p.username} · {plural(p.subscribers, 'subscriber')} · {plural(p.hosted, 'off hour')}
              </Small>
              {p.expertise.length ? (
                <Row wrap gap={6}>
                  {p.expertise.map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </Row>
              ) : null}
              {me && me.id !== p.id ? (
                <View style={{ alignSelf: 'flex-start' }}>
                  <SubscribeButton type="expert" id={p.id} subscribed={p.subscribed} small />
                </View>
              ) : null}
            </Card>
          ))}
        </View>
      </View>
    </View>
  );
}
