// Questions: who asked and how, the +1 key, and a row with both.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { QuestionText } from '../media/transcript.jsx';
import { color, font, TOUCH } from '../theme.js';
import { Tag, UserLink } from '../ui/index.jsx';

export function QuestionMeta({ q }) {
  const parts = [];
  if (q.askedWith === 'audio') {
    const how = q.askerVideo ? 'Asked on camera' : 'Asked out loud';
    parts.push(<Tag key="how">{q.audioTranscript?.edited ? `${how} · transcript edited` : how}</Tag>);
  }
  if (q.source === 'moderator') parts.push(<Tag key="mod" mod>✦ Suggested by moderator</Tag>);
  else if (q.anonymous) parts.push(<Tag key="anon">Anonymous</Tag>);
  else if (q.author) parts.push(<UserLink key="author" user={q.author} style={{ fontSize: 13, color: color.muted }} />);
  if (q.mine) parts.push(<Tag key="you" you>{q.anonymous ? 'you (hidden)' : 'you'}</Tag>);
  return <View style={styles.meta}>{parts}</View>;
}

// The +1: a soft key that sinks when pressed, and stays tinted once it's yours.
export function VoteButton({ q, enabled }) {
  const { me, requireLogin, fail } = useApp();
  const [state, setState] = useState({ votes: q.votes, voted: q.voted });
  const [busy, setBusy] = useState(false);
  const press = async () => {
    if (!me) return requireLogin();
    setBusy(true);
    try {
      const res = await api(state.voted ? 'DELETE' : 'POST', `/api/questions/${q.id}/vote`);
      Object.assign(q, res);
      setState({ votes: res.votes, voted: res.voted });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Pressable
      onPress={press}
      disabled={!enabled || busy}
      role="button"
      aria-pressed={state.voted}
      aria-label={enabled ? (state.voted ? `Remove +1 (${state.votes})` : `+1 this question (${state.votes})`) : `${state.votes} votes; voting is closed`}
      style={({ pressed }) => [styles.vote, state.voted && styles.voted, !enabled && styles.voteOff, pressed && enabled && { transform: [{ translateY: 1 }] }]}
    >
      <Text style={[styles.voteArrow, state.voted && { color: color.accent }]}>▲</Text>
      <Text style={[styles.voteCount, state.voted && { color: color.accent }]}>{state.votes}</Text>
    </Pressable>
  );
}

export function QuestionRow({ q, canVote, first = false }) {
  return (
    <View style={[styles.row, first && { borderTopWidth: 0, paddingTop: 0 }]}>
      <VoteButton q={q} enabled={canVote} />
      <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
        <QuestionText q={q} />
        <QuestionMeta q={q} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 },
  row: { flexDirection: 'row', gap: 14, paddingVertical: 18, borderTopWidth: 1, borderTopColor: color.line },
  vote: { width: 48, minHeight: 54, borderRadius: 14, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center', gap: 1, alignSelf: 'flex-start', boxShadow: 'inset 0 -1px 0 rgba(40,30,20,0.08)', cursor: 'pointer', minWidth: TOUCH },
  voted: { backgroundColor: color.accentSoft, boxShadow: `inset 0 0 0 1px ${color.accentRing}` },
  voteOff: { backgroundColor: 'transparent', boxShadow: 'none', cursor: 'default' },
  voteArrow: { fontSize: 10, lineHeight: 12, color: color.ink2 },
  voteCount: { fontFamily: font.sans, fontWeight: '700', fontSize: 16, lineHeight: 20, color: color.ink2, fontVariant: ['tabular-nums'] },
});
