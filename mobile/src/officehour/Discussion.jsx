// The Q&A as text, with the discussion after it: each question, the transcript of its answer, then
// people's replies to the answer. Anyone can reply to the answer; only the expert can respond to a
// reply, and that's as deep as it goes. The expert's own replies to the answer add to it, so they go
// right under it, before everyone else's, with the box to write them.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { askedBy, fmtDate, plural, relative } from '../format.js';
import { AnswerParagraphs, TranscriptEditor } from '../media/transcript.jsx';
import { color, font } from '../theme.js';
import { Button, Field, Label, Row, Serif, SectionTitle, Small, T, Tag, UserLink } from '../ui/index.jsx';

// `onChange(q)` hears when an answer's transcript becomes ready or is corrected.
export function Discussion({ oh, answers, onChange }) {
  return (
    <View>
      <SectionTitle>Discussion</SectionTitle>
      {answers.map((q, i) => (
        <View key={q.id} style={[styles.item, i === 0 && { borderTopWidth: 0 }]}>
          <Serif style={styles.question}>
            <Text style={{ color: color.accent }}>{String(i + 1).padStart(2, '0')}  </Text>
            {q.body}
            {askedBy(q) ? <Text style={styles.by}> — {askedBy(q)}</Text> : null}
          </Serif>
          <AnswerBlock oh={oh} q={q} onChange={onChange} />
          <ReplyThread oh={oh} q={q} />
        </View>
      ))}
    </View>
  );
}

// One answer, as its transcript. The expert can correct it here too.
function AnswerBlock({ oh, q, onChange }) {
  const [editing, setEditing] = useState(false);
  const t = q.transcript;
  const changed = (next) => onChange({ ...q, transcript: next });
  const canEdit = oh.isExpert && t?.status === 'ready' && t.cues.length > 0;
  return (
    <View style={styles.answer}>
      <Row gap={12}>
        <Label style={{ color: color.ink2, fontWeight: '700' }}>{oh.expert.displayName}</Label>
        {canEdit && !editing ? <Button kind="link" small title="Edit transcript" onPress={() => setEditing(true)} /> : null}
      </Row>
      {editing ? (
        <TranscriptEditor
          cues={t.cues}
          save={async (lines) => (await api('PUT', `/api/questions/${q.id}/answer-transcript`, { cues: lines })).transcript}
          done={(next) => {
            setEditing(false);
            if (next) changed(next);
          }}
        />
      ) : (
        <AnswerParagraphs question={q} transcript={t} onReady={changed} />
      )}
    </View>
  );
}

function ReplyThread({ oh, q }) {
  const { me, requireLogin } = useApp();
  const [all, setAll] = useState(() => (q.discussion ?? []).map((r) => ({ ...r, responses: r.responses ?? [] })));
  const [composing, setComposing] = useState(false);
  const additions = all.filter((r) => r.byExpert);
  const replies = all.filter((r) => !r.byExpert);
  const post = async (body) => {
    const { reply } = await api('POST', `/api/questions/${q.id}/replies`, { body });
    setAll((list) => [...list, { ...reply, responses: [] }]);
  };
  const respond = (parent) => async (body) => {
    const { reply } = await api('POST', `/api/questions/${q.id}/replies`, { body, parentId: parent.id });
    setAll((list) => list.map((r) => (r.id === parent.id ? { ...r, responses: [...r.responses, reply] } : r)));
  };
  const count = replies.length ? plural(replies.length, 'reply', 'replies') : '';
  return (
    <View style={{ gap: 12 }}>
      {additions.length ? (
        <View style={{ marginLeft: 18 }}>
          {additions.map((r) => (
            <ReplyItem key={r.id} oh={oh} r={r} respond={respond(r)} addition />
          ))}
        </View>
      ) : null}
      {oh.isExpert ? (
        <View style={{ marginLeft: 18 }}>
          <ReplyOpener label="Add to your answer" placeholder="Add to your answer…" submit="Add" send={post} />
        </View>
      ) : (
        // Everyone else replies from beside the count; the box opens under it, above the replies.
        <Row gap={14}>
          {count ? <Label>{count}</Label> : null}
          <Button small title="Add Reply" onPress={() => (me ? setComposing(true) : requireLogin())} />
        </Row>
      )}
      {composing ? <ReplyForm placeholder={`Reply to ${oh.expert.displayName}’s answer…`} submit="Reply" send={async (body) => (await post(body), setComposing(false))} cancel={() => setComposing(false)} /> : null}
      {oh.isExpert && count ? <Label>{count}</Label> : null}
      {replies.length ? (
        <View>
          {replies.map((r) => (
            <ReplyItem key={r.id} oh={oh} r={r} respond={respond(r)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// A button that opens a reply box; it closes again once the reply is sent, or on Cancel.
function ReplyOpener({ label, placeholder, submit, send }) {
  const { me, requireLogin } = useApp();
  const [open, setOpen] = useState(false);
  if (!open) return <Button small title={label} onPress={() => (me ? setOpen(true) : requireLogin())} style={{ alignSelf: 'flex-start' }} />;
  return <ReplyForm placeholder={placeholder} submit={submit} send={async (body) => (await send(body), setOpen(false))} cancel={() => setOpen(false)} />;
}

function ReplyItem({ oh, r, respond, addition = false }) {
  const [responding, setResponding] = useState(false);
  const canRespond = oh.isExpert && !r.byExpert;
  return (
    <View style={[styles.reply, addition && styles.indented]}>
      <ReplyHead r={r} />
      <T style={styles.replyBody}>{r.body}</T>
      {canRespond && !responding ? <Button kind="link" small title="Respond" onPress={() => setResponding(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      {r.responses.map((x) => (
        <View key={x.id} style={[styles.indented, { marginLeft: 18, marginVertical: 4 }]}>
          <ReplyHead r={x} />
          <T style={styles.replyBody}>{x.body}</T>
        </View>
      ))}
      {responding ? <ReplyForm placeholder={`Respond to ${r.author.displayName}…`} submit="Respond" send={async (body) => (await respond(body), setResponding(false))} cancel={() => setResponding(false)} /> : null}
    </View>
  );
}

function ReplyHead({ r }) {
  return (
    <Row wrap gap={10}>
      <LikeButton r={r} />
      <UserLink user={r.author} style={{ fontWeight: '600', fontSize: 15 }} />
      {r.byExpert ? <Tag expert>Expert</Tag> : null}
      {r.mine ? <Tag you>you</Tag> : null}
      <Small style={{ color: color.muted }} accessibilityLabel={fmtDate(r.createdAt)}>
        {relative(r.createdAt)}
      </Small>
    </Row>
  );
}

// Liked once each, and not your own.
function LikeButton({ r }) {
  const { me, requireLogin, fail } = useApp();
  const [state, setState] = useState({ liked: r.liked, likes: r.likes });
  const press = async () => {
    if (!me) return requireLogin();
    try {
      const res = await api(state.liked ? 'DELETE' : 'POST', `/api/replies/${r.id}/like`);
      Object.assign(r, res);
      setState({ liked: res.liked, likes: res.likes });
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Pressable onPress={press} disabled={r.mine} role="button" aria-pressed={state.liked} aria-label={r.mine ? 'Your reply' : state.liked ? 'Unlike' : 'Like'} hitSlop={6} style={[styles.like, state.liked && { backgroundColor: color.accentSoft }, r.mine && { opacity: 0.7 }]}>
      <Text style={[styles.likeText, state.liked && { color: color.accent }]}>♥{state.likes ? ` ${state.likes}` : ''}</Text>
    </Pressable>
  );
}

// A text box for a reply. `send(body)` posts it.
function ReplyForm({ placeholder, submit, send, cancel }) {
  const [body, setBody] = useState('');
  return (
    <View style={{ gap: 8 }}>
      <Field value={body} onChangeText={setBody} multiline rows={2} maxLength={2000} placeholder={placeholder} autoFocus />
      <Row gap={10}>
        <Button
          kind="primary"
          small
          title={submit}
          disabled={!body.trim()}
          onPress={async () => {
            await send(body);
            setBody('');
          }}
        />
        {cancel ? <Button kind="link" small title="Cancel" onPress={cancel} /> : null}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  item: { gap: 14, paddingVertical: 28, borderTopWidth: 1, borderTopColor: color.line },
  question: { fontSize: 22, lineHeight: 30 },
  by: { fontFamily: font.sans, fontSize: 14, color: color.muted },
  answer: { gap: 10, paddingLeft: 16, borderLeftWidth: 2, borderLeftColor: color.lineStrong },
  reply: { gap: 6, paddingVertical: 14, borderTopWidth: 1, borderTopColor: color.line },
  indented: { paddingLeft: 16, paddingVertical: 10, borderTopWidth: 0, borderLeftWidth: 2, borderLeftColor: color.lineStrong },
  replyBody: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  like: { flexDirection: 'row', alignItems: 'center', minHeight: 30, paddingHorizontal: 10, borderRadius: 999, backgroundColor: color.surface, cursor: 'pointer' },
  likeText: { fontFamily: font.sans, fontSize: 13, color: color.muted },
});
