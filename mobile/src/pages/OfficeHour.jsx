// An office hour's page: its masthead, then the ask form and the questions while it's open, or the
// published answers once they're out.
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { fmtDate, plural } from '../format.js';
import { useLoad } from '../hooks.js';
import { go } from '../router.js';
import { color, font } from '../theme.js';
import { Button, Card, Chip, Countdown, Empty, H1, Label, Link, Loading, Row, Serif, SectionTitle, Small, StatusBadge, TopicChip, UserLink } from '../ui/index.jsx';
import { AskForm } from '../officehour/Ask.jsx';
import { ExpertName, SubscribeButton } from '../officehour/common.jsx';
import { ProcessingNote, PublishedAnswers } from '../officehour/Published.jsx';
import { QuestionRow } from '../officehour/questions.jsx';

export default function OfficeHourPage({ params }) {
  const { data, error, reload } = useLoad(() => api('GET', `/api/office-hours/${params.id}`), [params.id]);
  if (error && !data) return <Empty message={error.message}><Link to="#/">Go home</Link></Empty>;
  if (!data) return <Loading />;
  const oh = data.officeHour;
  // While the answers are being joined into one video, the page stays as it was when questions
  // closed (readers see it as closed); the expert gets a note, and the page updates once it's ready.
  const published = oh.status === 'published' && !oh.processing;
  return (
    <View style={{ gap: 40 }}>
      <Masthead oh={oh} followUps={data.followUps} />
      {published ? (
        <PublishedAnswers oh={oh} data={data} />
      ) : (
        <>
          {oh.processing ? <ProcessingNote oh={oh} onReady={reload} /> : null}
          {oh.status === 'open' && !oh.isExpert ? (
            <Card style={{ padding: 22 }}>
              <AskForm oh={oh} onAsked={reload} />
            </Card>
          ) : null}
          <Questions oh={oh} groups={data.groups} />
        </>
      )}
    </View>
  );
}

function Masthead({ oh, followUps }) {
  return (
    <View style={{ gap: 16 }}>
      <Row wrap gap={14} style={{ alignItems: 'baseline' }}>
        <TopicChip oh={oh} accent />
        <StatusBadge oh={oh} />
        {oh.allowAnonymous ? <Chip muted>Anonymous OK</Chip> : null}
      </Row>
      <H1 style={styles.title}>{oh.title}</H1>
      <Serif style={styles.byline}>with {oh.isExpert ? <UserLink user={oh.expert} style={{ fontStyle: 'normal' }} /> : <ExpertName oh={oh} />}</Serif>
      {oh.followUpOf ? (
        <Small style={{ color: color.muted }}>
          Follows up on <Link to={`#/oh/${oh.followUpOf.id}`}>{oh.followUpOf.title}</Link>
        </Small>
      ) : null}
      {oh.description ? <Serif style={styles.desc}>{oh.description}</Serif> : null}
      {followUps.length ? (
        <Small style={{ color: color.muted }}>
          Followed up in{' '}
          {followUps.map((f, i) => (
            <Text key={f.id}>
              {i ? ', ' : ''}
              <Link to={`#/oh/${f.id}`}>{f.title}</Link>
            </Text>
          ))}
        </Small>
      ) : null}
      <Facts oh={oh} />
      <View style={{ gap: 10 }}>
        {oh.isExpert && oh.status !== 'published' ? <Button kind="primary" title="Plan & answer" onPress={() => go(`#/oh/${oh.id}/manage`)} /> : null}
        {oh.isExpert && oh.status === 'published' && !oh.processing ? <Button title="Create follow-up Q&A" onPress={() => go(`#/oh/new?followUp=${oh.id}`)} /> : null}
        {!oh.isExpert ? <SubscribeButton type="office_hour" id={oh.id} subscribed={oh.subscribed} label="this off hour" /> : null}
      </View>
    </View>
  );
}

// When questions close (a countdown in the last week, the date before that, and once they've
// closed, when that was), when answers are expected, and how many questions there are: a stack of
// rows on a phone, each fact on its own line.
function Facts({ oh }) {
  let closes;
  if (oh.status !== 'open') {
    const closed = [oh.closedAt, oh.questionsDeadline].filter(Boolean).sort()[0];
    closes = ['Questions closed', <Serif style={styles.factValue}>{fmtDate(closed)}</Serif>];
  } else if (new Date(oh.questionsDeadline) - Date.now() <= 7 * 86400_000) {
    closes = ['Questions open', <Countdown deadline={oh.questionsDeadline} style={styles.factValue} />];
  } else {
    closes = ['Questions open', <Serif style={styles.factValue}>until {fmtDate(oh.questionsDeadline)}</Serif>];
  }
  const rows = [closes, ['Answers expected', <Serif style={styles.factValue}>{fmtDate(oh.answersExpectedAt)}</Serif>], ['Questions', <Serif style={styles.factValue}>{oh.questionCount}</Serif>]];
  return (
    <View style={styles.facts}>
      {rows.map(([label, value], i) => (
        <View key={label} style={[styles.fact, i > 0 && { borderTopWidth: 1, borderTopColor: color.line }]}>
          <Label>{label}</Label>
          {value}
        </View>
      ))}
    </View>
  );
}

// Grouped by the moderator: numbered sections, each label over its questions.
function Questions({ oh, groups }) {
  const canVote = oh.status === 'open';
  return (
    <View>
      <SectionTitle aside="✦ grouped by the moderator">Questions</SectionTitle>
      {groups.length === 0 ? (
        <Empty message={oh.status === 'open' ? 'No questions yet — be the first to ask.' : 'No questions were asked.'} />
      ) : (
        groups.map((g, i) => (
          <View key={g.label + i} style={[styles.group, i === 0 && { borderTopWidth: 0 }]}>
            <Row gap={14} style={{ alignItems: 'flex-start' }}>
              <Text style={styles.groupNum}>{String(i + 1).padStart(2, '0')}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.groupLabel}>{g.label}</Text>
                <Label>{plural(g.questions.length, 'question')}</Label>
              </View>
            </Row>
            <View>
              {g.questions.map((q, j) => (
                <QuestionRow key={q.id} q={q} canVote={canVote} first={j === 0} />
              ))}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 44, lineHeight: 44, letterSpacing: -1.2 },
  byline: { fontStyle: 'italic', fontSize: 20, lineHeight: 26, color: color.muted },
  desc: { fontSize: 19, lineHeight: 28, color: color.ink2, whiteSpace: 'pre-wrap' },
  facts: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: color.line, marginTop: 4 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, paddingVertical: 12 },
  factValue: { fontSize: 18, lineHeight: 24, textAlign: 'right', flexShrink: 1, fontVariant: ['lining-nums'] },
  group: { gap: 16, paddingVertical: 26, borderTopWidth: 1, borderTopColor: color.line },
  groupNum: { fontFamily: font.serif, fontSize: 36, lineHeight: 38, color: color.accent, fontVariant: ['lining-nums', 'tabular-nums'] },
  groupLabel: { fontFamily: font.serif, fontSize: 23, lineHeight: 28, color: color.ink },
});
