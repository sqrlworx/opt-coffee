// A queued question's answer in the planner: the take being saved (or that failed to), or the
// recorded answer with its transcript and b-roll; and, apart, the buttons to record it.
import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { fmtDuration } from '../format.js';
import { useWatchQuestion } from '../hooks.js';
import { AnswerVideo } from '../media/AnswerVideo.jsx';
import { AnswerTranscript } from '../media/transcript.jsx';
import { Video } from '../media/Video.jsx';
import { color, font, radius, TOUCH } from '../theme.js';
import { Button, Checkbox, Disclosure, Field, Hint, Label, Row, Small, Warn } from '../ui/index.jsx';

// `plan` is the planner's state (Manage.jsx): what each question has, and what can be done to it.
// Nothing until there's an answer, or a take of one.
export function AnswerBox({ qid, plan }) {
  const { brollOn } = useApp();
  const { m } = plan;
  const videoRef = useRef(null);
  const take = m.uploads.get(qid);
  if (take) return <Video src={take.url} controls style={answerVideo} />;
  const url = m.videos.get(qid);
  if (!url) return null;
  const transcript = m.transcripts.get(qid);
  const brolls = (m.brolls.get(qid) ?? []).filter((b) => b.status === 'ready');
  return (
    <View style={{ gap: 10 }}>
      {/* Takes recorded on this page keep playing from the phone's copy once saved. */}
      <AnswerVideo src={m.local.get(qid) ?? url} captions={transcript?.captions} brolls={brolls} videoRef={videoRef} />
      <AnswerTranscript videoRef={videoRef} transcript={transcript} questionId={qid} pick={(q) => q.answerTranscript} onUpdate={(t) => (m.transcripts.set(qid, t), plan.bump())} editable />
      {brollOn ? <BrollPanel qid={qid} plan={plan} videoRef={videoRef} /> : null}
    </View>
  );
}

// The buttons under an answer, for a row of the planner's: to record it, or the take being saved.
export function AnswerActions({ qid, plan }) {
  const { m } = plan;
  const take = m.uploads.get(qid);
  if (take) {
    if (!take.failed) return <Small style={{ color: color.muted }}>Saving…</Small>;
    return (
      <>
        <Small style={{ color: color.muted }}>Couldn't save this answer.</Small>
        <Button kind="primary" small title="Try again" onPress={() => plan.upload(qid, { ...take, failed: false })} />
        <Button small title="Discard" onPress={() => plan.discardUpload(qid)} />
      </>
    );
  }
  const url = m.videos.get(qid);
  return (
    <>
      <Button kind={url ? 'soft' : 'primary'} small title={url ? 'Re-record' : 'Answer from here'} onPress={() => plan.startSession(qid)} />
      {url ? <Button small title="Remove" onPress={() => plan.removeAnswer(qid)} /> : null}
    </>
  );
}

const MAX_BROLLS = 8; // b-roll clips in one answer, as the server allows

// Under a recorded answer, the expert adds b-roll clips to cut away to while they talk: making one,
// described once Make b-roll opens the box for that, or uploading a video of their own from the
// phone's camera roll. The server makes the shot, which takes a few minutes, or gets the video ready,
// and places it where it fits what they're saying, around the answer's other clips; the answer's
// video above then plays with them cut in. They can then cut in to any clip where the answer's video
// (`videoRef`) is instead. An uploaded video can go full screen, and then keep playing past the end
// of the answer. Change offers making or uploading another in a clip's place. What they've typed is
// kept while the planner redraws.
function BrollPanel({ qid, plan, videoRef }) {
  const { makesBroll, brollModel, fail } = useApp();
  const { m } = plan;
  const clips = m.brolls.get(qid) ?? [];
  const file = useRef(null);
  // Once any clip being made or placed is ready, or failed, it's shown; the rest are watched on.
  const pending = clips.filter((b) => b.status === 'pending').map((b) => b.id).join();
  useWatchQuestion(qid, pending, (q) => q.brolls.filter((b) => b.status === 'pending').map((b) => b.id).join() !== pending, (q) => plan.setBrolls(qid, q.brolls));
  const remove = (clip) => api('DELETE', `/api/questions/${qid}/broll/${clip.id}`).then((res) => plan.setBrolls(qid, res.brolls), fail);
  const patch = (clip, body) => api('PATCH', `/api/questions/${qid}/broll/${clip.id}`, body).then((res) => plan.setBrolls(qid, res.brolls), fail);
  const draft = m.brollDrafts.get(qid); // what's typed in the box, while it's open
  const model = makesBroll && brollModel ? <Hint>model: {brollModel}</Hint> : null;
  const change = (clip) => {
    m.brollReplacing.set(qid, clip.id);
    m.brollAdding.delete(qid);
    m.brollDrafts.delete(qid);
    plan.bump();
  };
  const close = () => {
    m.brollReplacing.delete(qid);
    m.brollAdding.delete(qid);
    m.brollDrafts.delete(qid);
    plan.bump();
  };
  const up = m.brollUploads.get(qid);
  // Each clip is a card of its own, numbered, with everything that's done to it inside it; adding
  // one is apart from them, outlined, and numbered as the next clip.
  const badge = (n, fresh = false) => (
    <View style={[styles.badge, fresh && styles.badgeNew]} aria-hidden="true">
      <Text style={[styles.badgeText, fresh && { color: color.muted }]}>{n}</Text>
    </View>
  );
  const head = (clip, i) => (
    <Row wrap gap={10} style={{ alignItems: 'center' }}>
      {badge(i + 1)}
      <Label>Clip {i + 1}</Label>
      {clip.prompt ? <Text style={styles.prompt}>“{clip.prompt}”</Text> : null}
      {clip.upload ? <Text style={styles.file}>{clip.upload}</Text> : null}
    </Row>
  );

  // How far a video being uploaded has got. Cancel stops sending it; once it's all sent, the
  // server's getting it ready.
  const progress = (u) => (
    <>
      <View style={styles.track}>
        <View style={[styles.progress, { width: `${Math.floor(u.sent * 100)}%` }]} />
      </View>
      <Row wrap gap={10}>
        <Small style={{ color: color.muted }}>{u.sent < 1 ? `Uploading ${u.name}… ${Math.floor(u.sent * 100)}%` : `Getting ${u.name} ready…`}</Small>
        {u.sent < 1 ? <Button kind="link" small title="Cancel" onPress={() => u.stop.abort()} /> : null}
      </Row>
    </>
  );

  // Make b-roll opens the box, with what was asked for last if a clip made from a description is
  // being changed; Upload a video picks one and sends it. Either adds a clip, or with `replacing`,
  // takes its place.
  const choose = (replacing) =>
    draft != null ? (
      <View style={{ gap: 8 }}>
        <Field
          value={draft}
          onChangeText={(text) => (m.brollDrafts.set(qid, text), plan.bump())}
          multiline
          rows={2}
          maxLength={500}
          autoFocus
          aria-label="Describe the b-roll"
          placeholder='What to cut to while you talk, e.g. "Hands sketching a wireframe on paper" or "An animated diagram of a cache going stale"'
        />
        <Row wrap gap={8}>
          <Button
            kind="primary"
            small
            title="Make b-roll"
            disabled={!draft.trim()}
            onPress={async () => {
              const res = await api('POST', `/api/questions/${qid}/broll`, { prompt: draft, ...(replacing ? { replaces: replacing.id } : {}) });
              m.brollDrafts.delete(qid);
              m.brollReplacing.delete(qid);
              m.brollAdding.delete(qid);
              plan.setBrolls(qid, res.brolls);
            }}
          />
          <Button kind="link" small title="Cancel" onPress={() => (clips.length ? close() : (m.brollDrafts.delete(qid), plan.bump()))} />
        </Row>
        {model}
      </View>
    ) : (
      <View style={{ gap: 8 }}>
        <Row wrap gap={8}>
          {makesBroll ? <Button kind="primary" small title="Make b-roll" onPress={() => (m.brollDrafts.set(qid, replacing && !replacing.upload ? (replacing.prompt ?? '') : ''), plan.bump())} /> : null}
          <Button kind={makesBroll ? 'ring' : 'primary'} small title="Upload a video" onPress={() => file.current.click()} />
          {clips.length ? <Button kind="link" small title="Cancel" onPress={close} /> : null}
        </Row>
        <input
          ref={file}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const picked = e.target.files[0];
            e.target.value = ''; // so picking the same file again still counts
            if (picked) plan.uploadBroll(qid, picked, replacing?.id);
          }}
        />
        {makesBroll ? model : <Hint>{"A video of your own. It's cut in where you talk about it, and while it plays your answer moves to the top half of the screen; then you can choose where."}</Hint>}
      </View>
    );

  // A clip: where it's cut in, and what can be done with it. Being changed, the buttons to make or
  // upload another in its place, or the one uploading, are in its card.
  const card = (clip, i) => {
    const cardOf = (children) => (
      <View key={clip.id} style={styles.card} role="group" aria-label={`B-roll clip ${i + 1}`}>
        {head(clip, i)}
        {children}
      </View>
    );
    if (up?.replaces === clip.id) {
      return cardOf(
        <>
          <Small style={{ color: color.muted }}>Replacing this clip:</Small>
          {progress(up)}
        </>,
      );
    }
    if (m.brollReplacing.get(qid) === clip.id && !up) {
      return cardOf(
        <>
          <Small style={{ color: color.muted }}>Replace this clip with a new one:</Small>
          {choose(clip)}
        </>,
      );
    }
    if (clip.status === 'pending') {
      return cardOf(
        <>
          <Small style={{ color: color.muted }}>{clip.upload ? 'Finding the best place for your video…' : 'Making your b-roll and finding the best place for it… This takes a few minutes; you can keep working.'}</Small>
          <Button kind="link" small title="Cancel" onPress={() => remove(clip)} style={{ alignSelf: 'flex-start' }} />
        </>,
      );
    }
    if (clip.status === 'failed') {
      return cardOf(
        <>
          <Warn>{clip.upload ? "Your video couldn't be used. Upload it again, or try another." : "This b-roll couldn't be made. Try again, or describe it differently."}</Warn>
          <Row wrap gap={8}>
            <Button kind="ring" small title="Try again" onPress={() => change(clip)} />
            <Button kind="ring" small title="Remove" onPress={() => remove(clip)} />
          </Row>
        </>,
      );
    }
    const chosen = clip.chosen != null;
    const others = clips.filter((b) => b !== clip && b.start != null);
    return cardOf(
      <>
        {clip.start != null ? (
          <Small style={{ color: color.muted }}>
            Cut in {clip.full ? 'full screen ' : ''}at {fmtDuration(clip.start)}–{fmtDuration(clip.start + clip.length)}, {chosen ? 'where you chose' : "where it fits what you're saying"}. Play your answer to see it.
          </Small>
        ) : chosen ? (
          <Warn>There's no room for this b-roll after {fmtDuration(clip.chosen)}, where you chose. Pick an earlier moment, or let the moderator choose.</Warn>
        ) : others.length ? (
          <Warn>There’s no room left in this answer for this b-roll, so it’s left out. Remove another clip, or choose where it goes.</Warn>
        ) : (
          <Warn>This answer is too short for its b-roll, so it’s left out. Re-record a longer answer{clip.upload ? '' : ', or make new b-roll to fit this one'}.</Warn>
        )}
        {/* Not all of a video they uploaded plays when it's longer than the time it has. */}
        {clip.upload && clip.start != null && clip.clipLength > clip.length + 0.5 ? (
          <Small style={{ color: color.muted }}>
            Only {fmtDuration(clip.length)} of your {fmtDuration(clip.clipLength)} video fits {others.some((b) => b.start > clip.start) ? 'before your next b-roll' : 'before your answer ends'}.
          </Small>
        ) : null}
        {/* Where it cuts in: where the answer's video is, which they play, scrub or tap the transcript to. */}
        <Row wrap gap={8}>
          <Button kind="ring" small title="Cut in here" onPress={() => patch(clip, { start: Math.round(videoRef.current.currentTime * 1000) / 1000 })} />
          {chosen ? <Button kind="link" small title="Let the moderator choose" onPress={() => patch(clip, { start: null })} /> : null}
        </Row>
        {/* An uploaded video can fill the screen instead, and then keep playing past the end of the answer; it's placed again to suit. */}
        {clip.upload ? <Checkbox checked={clip.full} onChange={(full) => patch(clip, { full })} label="Full screen" /> : null}
        {clip.upload && clip.full ? (
          <View style={{ gap: 2 }}>
            <Checkbox checked={clip.pastEnd} onChange={(pastEnd) => patch(clip, { pastEnd })} label="Keep playing past the end of my answer" />
            <Hint>Your answer gets longer, silent under your video.</Hint>
          </View>
        ) : null}
        {/* What was filmed, which may be a scene standing for the idea they described. */}
        {clip.shot && clip.shot !== clip.prompt ? (
          <Disclosure title={<Small style={{ color: color.muted }}>What was filmed</Small>}>
            <Small style={{ color: color.muted }}>{clip.shot}</Small>
          </Disclosure>
        ) : null}
        <Row wrap gap={8}>
          <Button kind="ring" small title="Change" onPress={() => change(clip)} />
          <Button kind="ring" small title="Remove" onPress={() => remove(clip)} />
        </Row>
      </>,
    );
  };

  // Adding a clip: open from the start, and once there are clips, behind a button of its own.
  const next = clips.length + 1;
  const addHead = (
    <Row gap={10} style={{ alignItems: 'center' }}>
      {badge(next, true)}
      <Label>{clips.length ? `New clip ${next}` : 'Add b-roll'}</Label>
    </Row>
  );
  let adding = null;
  if (up && !up.replaces) {
    adding = (
      <View style={styles.add} role="group" aria-label="New b-roll clip">
        {addHead}
        {progress(up)}
      </View>
    );
  } else if (!up && !m.brollReplacing.has(qid) && (!clips.length || m.brollAdding.has(qid) || draft != null)) {
    adding = (
      <View style={styles.add} role="group" aria-label="New b-roll clip">
        {addHead}
        {choose(null)}
      </View>
    );
  } else if (!up && clips.length < MAX_BROLLS) {
    adding = (
      <Pressable role="button" onPress={() => (m.brollReplacing.delete(qid), m.brollAdding.add(qid), plan.bump())} style={styles.addButton}>
        <Text style={styles.addButtonText}>+ Add another b-roll clip</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.panel}>
      {clips.length ? (
        <Row gap={10} style={{ alignItems: 'baseline' }}>
          <Label>B-roll</Label>
          <Small style={{ color: color.muted }}>
            {clips.length} clip{clips.length === 1 ? '' : 's'}
          </Small>
        </Row>
      ) : null}
      {clips.some((b) => b.status === 'ready') ? <Hint>Play your answer, or tap a line of its transcript, to where a clip should start, then tap Cut in here on that clip.</Hint> : null}
      {clips.map(card)}
      {adding}
    </View>
  );
}

const answerVideo = { background: '#111', borderRadius: 12 };

const styles = StyleSheet.create({
  panel: { gap: 12, paddingVertical: 14, paddingHorizontal: 14, borderRadius: radius.sm, backgroundColor: color.surface },
  card: { gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.sm, borderWidth: 1, borderColor: color.line, backgroundColor: color.raised },
  add: { gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.sm, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.lineStrong },
  addButton: { minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.sm, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.lineStrong },
  addButtonText: { fontFamily: font.sans, fontSize: 15, fontWeight: '600', color: color.ink2 },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: color.accentSoft },
  badgeNew: { backgroundColor: 'transparent', borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.lineStrong },
  badgeText: { fontFamily: font.sans, fontSize: 12, fontWeight: '700', color: color.accent },
  prompt: { fontFamily: font.serif, fontStyle: 'italic', fontSize: 16, color: color.ink, flexShrink: 1 },
  file: { fontFamily: font.sans, fontSize: 14, color: color.ink2, flexShrink: 1 },
  track: { height: 4, borderRadius: 2, backgroundColor: color.surface2, overflow: 'hidden' },
  progress: { height: 4, backgroundColor: color.accent },
});
