import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { plural } from '../format.js';
import { useLoad } from '../hooks.js';
import { searchHash } from '../router.js';
import { Card, Chip, Empty, Field, H1, H3, Link, Loading, Marked, Row, SectionTitle, Segmented, Small, T } from '../ui/index.jsx';
import { CardList, HostLink, SubscribeButton } from '../officehour/common.jsx';
import { color, radius, TOUCH } from '../theme.js';

// Explore lists what's open, what's been answered and who's hosting. Searching swaps those for what
// matches, best first, as it's typed, narrowed to off hours taking questions or answered if asked,
// with topics suggested under the box to complete it. The search is kept in the URL
// (#/explore?q=…&status=…), as on the page.
export default function ExplorePage({ query }) {
  const { me, fail } = useApp();
  const { data, error } = useLoad(() => api('GET', '/api/explore'), []);
  const [q, setQ] = useState(() => query.get('q') ?? '');
  const [status, setStatus] = useState(() => (['open', 'answered'].includes(query.get('status')) ? query.get('status') : 'all'));
  const [found, setFound] = useState(null); // { q, status, officeHours, people, counts, suggestions } for the search shown
  const [suggesting, setSuggesting] = useState(false); // something's been typed since a suggestion was picked
  const searching = Boolean(q.trim());

  useEffect(() => {
    history.replaceState(null, '', searching ? searchHash(q, status) : '#/explore');
    if (!searching) return setFound(null);
    let current = true;
    const timer = setTimeout(() => {
      api('GET', `/api/search?q=${encodeURIComponent(q)}${status === 'all' ? '' : `&status=${status}`}`).then(
        (res) => current && setFound({ q, status, ...res }),
        (err) => current && fail(err),
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, status, searching, fail]);

  // A suggested topic is searched for.
  const pick = (item) => {
    setSuggesting(false);
    setQ(item.text);
  };
  const suggestions = suggesting && searching ? found?.suggestions ?? [] : [];

  if (error) return <Empty message={error.message} />;
  if (!data) return <Loading />;
  const { open, published, people } = data;
  return (
    <View style={{ gap: 40 }}>
      <View style={{ gap: 8 }}>
        <H1>Explore</H1>
        {me ? <HostLink /> : null}
      </View>
      <View style={{ gap: 12, marginTop: -16 }}>
        <Field
          value={q}
          onChangeText={(text) => (setQ(text), setSuggesting(true))}
          // A moment later, so a tap on a suggestion lands first.
          onBlur={() => setTimeout(() => setSuggesting(false), 200)}
          onSubmitEditing={() => setSuggesting(false)}
          placeholder="Search topics, hosts and off hours"
          aria-label="Search topics, hosts and off hours"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {suggestions.length ? (
          <View role="listbox" aria-label="Suggestions" style={styles.suggestions}>
            {suggestions.map((item, i) => (
              <Pressable key={i} role="option" onPress={() => pick(item)} style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: color.surface }]}>
                <T numberOfLines={2}>
                  <Marked text={item.text} ranges={item.ranges} />
                </T>
              </Pressable>
            ))}
          </View>
        ) : null}
        {searching && found ? (
          <Segmented
            label="Show"
            value={status}
            onChange={setStatus}
            options={[
              ['all', 'All'],
              ['open', `Open · ${found.counts.open}`],
              ['answered', `Answered · ${found.counts.answered}`],
            ]}
          />
        ) : null}
      </View>
      {searching ? (
        found ? (
          <SearchResults found={found} />
        ) : (
          <Loading />
        )
      ) : (
        <>
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
            <PersonList people={people} />
          </View>
        </>
      )}
    </View>
  );
}

function SearchResults({ found: { q, status, officeHours, people } }) {
  if (!officeHours.length && !people.length) {
    return <Empty message={status === 'all' ? `Nothing matches “${q.trim()}”.` : `No off hours ${status === 'open' ? 'taking questions' : 'answered'} match “${q.trim()}”.`} />;
  }
  return (
    <>
      {officeHours.length ? (
        <View style={{ gap: 16 }}>
          <SectionTitle>Off hours</SectionTitle>
          <CardList items={officeHours} />
        </View>
      ) : null}
      {people.length ? (
        <View style={{ gap: 16 }}>
          <SectionTitle>People</SectionTitle>
          <PersonList people={people} />
        </View>
      ) : null}
    </>
  );
}

function PersonList({ people }) {
  const { me } = useApp();
  return (
    <View style={{ gap: 12 }}>
      {people.map((p) => (
        <Card key={p.id}>
          <Link to={`#/u/${p.username}`} style={{ textDecorationLine: 'none' }}>
            <H3>
              <Marked text={p.displayName} ranges={p.match?.displayName} />
            </H3>
          </Link>
          <Small style={{ color: color.muted }}>
            @{p.username} · {plural(p.subscribers, 'subscriber')} · {plural(p.hosted, 'off hour')}
          </Small>
          {p.expertise.length ? (
            <Row wrap gap={6}>
              {p.expertise.map((t, i) => (
                <Chip key={t} to={searchHash(t)}>
                  <Marked text={t} ranges={p.match?.expertise[i]} />
                </Chip>
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
  );
}

const styles = StyleSheet.create({
  suggestions: { backgroundColor: color.raised, borderRadius: radius.sm, padding: 6, boxShadow: '0 18px 48px -18px rgba(40,28,16,0.4), 0 0 0 1px rgba(40,28,16,0.06)' },
  suggestion: { minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, cursor: 'pointer' },
});
